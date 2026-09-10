#!/usr/bin/env node
// Local retry proxy for Codex CLI.
// Forwards model requests to https://chatgpt.com and transparently retries
// capacity/overload errors with backoff, so codex never surfaces
// "Selected model is at capacity. Please try a different model." for
// transient outages.
//
// These errors arrive in two shapes and both are handled:
//  1. HTTP 429/529 responses
//  2. HTTP 200 SSE streams: structural events (response.created /
//     response.in_progress / response.output_item.added / ...) followed by an
//     `error` + `response.failed` event (code server_is_overloaded /
//     usage_limit_reached / ...). While only such pre-output events have
//     arrived nothing has been forwarded to codex, so the request can be
//     repeated transparently.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PORT || 8317);
const UPSTREAM = process.env.UPSTREAM || "https://chatgpt.com";
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 20); // ~8+ min of retrying at most
const BASE_DELAY_MS = Number(process.env.BASE_DELAY_MS || 3000);
const HEAD_LIMIT = 1048576; // flush-through threshold while holding the stream head

const UPSTREAM_URL = new URL(UPSTREAM);
const HOP_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
]);

// Retryable in-stream / HTTP error codes. Quota-exhausted and auth errors use
// different codes and pass through untouched.
const RETRYABLE_MARK = /server_is_overloaded|usage_limit_reached|model_at_capacity|at capacity|service_unavailable|servers are currently overloaded/i;

const log = (...a) => console.log(`[${new Date().toLocaleString("sv")}]`, ...a);

// Per-request tag to tell parallel codex sessions apart in the log.
//
// Codex sends prompt_cache_key (defaults to its session_id, see codex-rs
// client.rs) in the POST body — the wire carries NO session name. The
// /rename name is only stored locally (never sent upstream), so resolve it
// here:
//   1. ~/.codex/session_index.jsonl  (id -> thread_name, append-only, last
//      entry wins; re-read when the file's mtime changes so a /rename shows
//      up on the next request)
//   2. first user message in the request body (what codex's own auto-title
//      is derived from)
//   3. session id prefix
// Requests without a usable body (GET /models etc.) fall back to #n.
const SESSION_INDEX = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  "session_index.jsonl",
);
let indexMtime = 0;
let indexNames = new Map(); // session id -> thread_name
function loadSessionIndex() {
  let st;
  try { st = fs.statSync(SESSION_INDEX); } catch { return; }
  if (st.mtimeMs === indexMtime) return;
  const names = new Map();
  try {
    for (const line of fs.readFileSync(SESSION_INDEX, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.id && typeof e.thread_name === "string" && e.thread_name.trim()) {
          names.set(e.id, e.thread_name.trim());
        }
      } catch { /* skip malformed line */ }
    }
  } catch { return; }
  indexMtime = st.mtimeMs;
  indexNames = names;
}

function firstUserText(j) {
  if (!Array.isArray(j.input)) return "";
  for (const item of j.input) {
    if (item?.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      const t = c?.text ?? c?.input_text;
      if (typeof t === "string" && t.trim()) return t;
    }
  }
  return "";
}

let reqCounter = 0;
const tagCache = new Map(); // cache key -> { tag, ts }
const TAG_TTL_MS = 5000; // re-resolve occasionally so /rename takes effect
function requestTag(req, body) {
  let key = "";
  let parsed = null;
  if (body) {
    try {
      parsed = JSON.parse(body.toString("utf8"));
      const v = parsed.prompt_cache_key || parsed.session_id || parsed.thread_id
        || parsed.client_metadata?.session_id;
      if (typeof v === "string" && v) key = v;
    } catch { /* non-JSON body */ }
  }
  if (!key) return `#${++reqCounter}`;

  const hit = tagCache.get(key);
  if (hit && Date.now() - hit.ts < TAG_TTL_MS) return hit.tag;

  // Internal sub-agent sessions use "{source}:{parent_thread_id}" as the
  // cache key; resolve the parent id so they get the parent's name.
  const id = key.includes(":") ? key.split(":").pop() : key;
  loadSessionIndex();
  let name = indexNames.get(id) || "";
  if (!name && parsed) name = firstUserText(parsed);
  name = name.replace(/\s+/g, " ").trim().slice(0, 24);
  const tag = name ? `${name}#${id.slice(0, 8)}` : id.slice(0, 8);
  tagCache.set(key, { tag, ts: Date.now() });
  return tag;
}

function shouldRetryStatus(status) {
  return status === 429 || status === 529;
}

async function forwardOnce(req, body) {
  const headers = { ...req.headers };
  for (const h of HOP_HEADERS) delete headers[h];
  headers.host = UPSTREAM_URL.host;

  return fetch(UPSTREAM + req.url, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    // @ts-expect-error node fetch streaming request
    duplex: "half",
    redirect: "manual",
  });
}

function collectHeaders(upstream) {
  const headers = {};
  upstream.headers.forEach((v, k) => {
    if (!HOP_HEADERS.has(k)) headers[k] = v;
  });
  return headers;
}

// Classify one complete SSE event block for head-holding:
//  "retry"  = terminal error event with a retryable code
//  "meta"   = structural events with no user-visible output yet; safe to hold
//             (observed failure shape: created, in_progress, output_item.added,
//              then server_is_overloaded error — all before any real output)
//  "error"  = terminal error event that is NOT retryable
//  "commit" = real output (deltas / completed items / anything else): forward
function classifyEvent(block) {
  const m = block.match(/^event:\s*(\S+)/m);
  const name = m ? m[1] : "";
  if ([
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.reasoning_summary_part.added",
  ].includes(name)) return "meta";
  if (name === "error" || name === "response.failed") {
    return RETRYABLE_MARK.test(block) ? "retry" : "error";
  }
  return "commit";
}

// Relay a successful (2xx) upstream response to the client, one SSE event at
// a time:
//
//  Phase 1 (head holding): structural events (response.created etc.) are held
//  back. On a retryable error event the request is repeated transparently
//  (nothing was sent). On the first real output event, everything held so far
//  INCLUDING that event is flushed to the client and phase 2 begins.
//
//  Phase 2 (streaming): events are forwarded as they complete. A retryable
//  overload error can no longer be replayed (codex already consumed partial
//  output) — and codex treats in-stream capacity errors as FATAL — so the
//  error event is swallowed and the connection is dropped instead: codex
//  auto-retries network-level stream failures (request_max_retries), and the
//  fresh request comes back through this proxy.
//
// Returns "RETRY" (nothing sent, safe to repeat the request) or "DONE".
async function relayWithSniff(req, res, upstream, canRetry, tag) {
  const headers = collectHeaders(upstream);
  const contentType = upstream.headers.get("content-type") || "";
  const sniff = req.method === "POST" || contentType.includes("event-stream");

  const rlog = (...a) => log(`[${tag}]`, ...a);
  const reader = upstream.body.getReader();
  let pending = Buffer.alloc(0); // received bytes, events before `cursor` are handled
  let cursor = 0;
  let sentHead = false;

  const sendHead = () => {
    if (sentHead) return;
    sentHead = true;
    res.writeHead(upstream.status, headers);
    rlog(`${req.method} ${req.url} -> ${upstream.status}`);
  };

  try {
    if (!sniff) {
      // Non-SSE traffic: straight through, chunk by chunk.
      sendHead();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return "DONE";
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = Buffer.concat([pending, Buffer.from(value)]);

      // Process every COMPLETE event in the buffer, byte-level (never
      // re-encode partial multibyte characters).
      while (cursor < pending.length) {
        const idx = pending.indexOf("\n\n", cursor);
        if (idx === -1) break;
        const eventEnd = idx + 2;
        const blockBytes = pending.subarray(cursor, eventEnd);
        const block = blockBytes.toString("utf8");
        const eventStart = cursor;
        cursor = eventEnd;
        if (block.trim().length === 0) continue;

        if (!sentHead) {
          // ---- Phase 1: head holding ----
          const kind = classifyEvent(block);
          if (kind === "meta") continue; // hold

          if (kind === "retry" && canRetry) {
            try { await reader.cancel(); } catch { /* ignore */ }
            rlog(`${req.method} ${req.url} -> 200 (in-stream ${block.match(/"code":"(\w+)"/)?.[1] ?? "error"}), will retry`);
            return "RETRY";
          }
          if (kind === "retry") {
            rlog(`${req.method} ${req.url} !! capacity error but retry budget exhausted, forwarding to codex`);
          }
          // First real output (or terminal error / budget exhausted):
          // flush everything held so far INCLUDING this event, then stream.
          sendHead();
          res.write(pending.subarray(0, eventEnd));
          pending = pending.subarray(eventEnd);
          cursor = 0;
          continue;
        }

        // ---- Phase 2: streaming, event by event ----
        const name = block.match(/^event:\s*(\S+)/)?.[1] ?? "";
        if ((name === "error" || name === "response.failed") && RETRYABLE_MARK.test(block)) {
          rlog(`${req.method} ${req.url} .. mid-stream capacity error swallowed, dropping connection so codex retries | ${(block.split("data: ")[1] ?? "").slice(0, 160).replace(/\n/g, " ")}`);
          try { await reader.cancel(); } catch { /* ignore */ }
          res.destroy();
          return "DONE";
        }
        if (name === "error" || name === "response.failed" || name === "response.completed" || name === "response.incomplete") {
          rlog(`${req.method} ${req.url} .. terminal${name.includes("completed") && !name.includes("incomplete") ? "(ok)" : "(error)"}: event: ${name} | ${(block.split("data: ")[1] ?? "").slice(0, 200).replace(/\n/g, " ")}`);
        }
        res.write(blockBytes);
      }

      // Keep memory bounded: drop the processed prefix.
      if (cursor > 65536) {
        pending = pending.subarray(cursor);
        cursor = 0;
      }
      // Pathological: huge head with no event boundary / no commit trigger.
      if (!sentHead && pending.length - cursor > HEAD_LIMIT) {
        sendHead();
        res.write(pending.subarray(cursor));
        pending = Buffer.alloc(0);
        cursor = 0;
      }
    }

    if (!sentHead) {
      // Stream ended with only structural events (or a plain body)
      const text = pending.toString("utf8");
      if (RETRYABLE_MARK.test(text) && /"type":"(error|response.failed)"/.test(text)) {
        if (canRetry) {
          rlog(`${req.method} ${req.url} -> 200 (capacity error body), will retry`);
          return "RETRY";
        }
        rlog(`${req.method} ${req.url} !! capacity error body but retry budget exhausted, forwarding to codex`);
      }
      sendHead();
      res.write(pending.subarray(cursor));
    }
    res.end();
    return "DONE";
  } catch (err) {
    rlog(`stream read error on ${req.url}: ${err.message}`);
    if (!sentHead) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `proxy stream error: ${err.message}` } }));
    } else {
      res.end();
    }
    return "DONE";
  }
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const tag = requestTag(req, body);
  const rlog = (...a) => log(`[${tag}]`, ...a);

  let delay = BASE_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    let upstream;
    try {
      upstream = await forwardOnce(req, body);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `proxy upstream error: ${err.message}` } }));
        return;
      }
      rlog(`upstream error (${err.message}), retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
      continue;
    }

    if (!upstream.ok) {
      // Error responses are small and complete: buffer to decide on retry.
      const buf = Buffer.from(await upstream.arrayBuffer());

      if (shouldRetryStatus(upstream.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(upstream.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60000)
          : delay;
        rlog(`${upstream.status} on ${req.url}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${waitMs}ms`);
        await sleep(waitMs);
        delay = Math.min(delay * 2, 30000);
        continue;
      }

      res.writeHead(upstream.status, collectHeaders(upstream));
      res.end(buf);
      return;
    }

    const result = await relayWithSniff(req, res, upstream, attempt < MAX_ATTEMPTS, tag);
    if (result === "RETRY" && attempt < MAX_ATTEMPTS) {
      rlog(`retrying ${req.url}, attempt ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
      continue;
    }
    return;
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`codex retry proxy listening on http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
});
