#!/usr/bin/env node
// Local retry proxy for Codex CLI.
// Forwards model requests to https://chatgpt.com and transparently retries
// capacity/overload errors with backoff, so codex never surfaces
// "Selected model is at capacity. Please try a different model." for
// transient outages.
//
// These errors arrive in two shapes and both are handled:
//  1. HTTP 429/529 responses
//  2. HTTP 200 SSE streams: response.created / response.in_progress followed
//     by an `error` + `response.failed` event (code server_is_overloaded /
//     usage_limit_reached / ...). While only such pre-content events have
//     arrived nothing has been forwarded to codex, so the request can be
//     repeated transparently.

import http from "node:http";
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
//  "meta"   = pre-content metadata (response.created / response.in_progress)
//  "error"  = terminal error event that is NOT retryable
//  "commit" = real content (or anything else): stream has started, forward it
function classifyEvent(block) {
  const m = block.match(/^event:\s*(\S+)/m);
  const name = m ? m[1] : "";
  if (name === "response.created" || name === "response.in_progress") return "meta";
  if (name === "error" || name === "response.failed") {
    return RETRYABLE_MARK.test(block) ? "retry" : "error";
  }
  return "commit";
}

// Relay a successful (2xx) upstream response to the client. Holds the head of
// the stream (metadata events only) until either a retryable error event or
// the first content event arrives. Returns "RETRY" (nothing sent, safe to
// repeat the request) or "DONE". When canRetry is false (retry budget
// exhausted), retryable errors are forwarded to the client instead.
async function relayWithSniff(req, res, upstream, canRetry) {
  const headers = collectHeaders(upstream);
  const contentType = upstream.headers.get("content-type") || "";
  const sniff = req.method === "POST" || contentType.includes("event-stream");

  const reader = upstream.body.getReader();
  let buf = Buffer.alloc(0);
  let sentHead = false;

  const commit = () => {
    if (sentHead) return;
    sentHead = true;
    res.writeHead(upstream.status, headers);
    log(`${req.method} ${req.url} -> ${upstream.status}`);
    res.write(buf);
    buf = null;
  };

  if (!sniff) commit();

  try {
    let examined = 0; // bytes of buf already classified
    let tail = ""; // rolling buffer so terminal events split across chunks are still seen
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);

      if (sentHead || buf === null) {
        // Already streaming: errors after content started cannot be retried
        // here, but log every terminal event for diagnosis.
        const scan = tail + chunk.toString("utf8");
        for (const m of scan.matchAll(/^event: (error|response\.failed|response\.completed|response\.incomplete)\b.*\ndata: [^\n]{0,300}/gm)) {
          const name = m[0].split("\n")[0];
          const data = m[0].split("data: ")[1] ?? "";
          log(`${req.method} ${req.url} .. terminal${name.includes("completed") && !name.includes("incomplete") ? "(ok)" : "(error)"}: ${name} | ${data.slice(0, 200)}`);
        }
        tail = scan.slice(-500);
        res.write(chunk);
        continue;
      }

      buf = Buffer.concat([buf, chunk]);

      // Classify complete SSE events (byte-level: never re-encode partial
      // multibyte characters). Hold the head while only metadata events have
      // arrived; forward as soon as content or a terminal error shows up.
      while (examined < buf.length) {
        const idx = buf.indexOf("\n\n", examined);
        if (idx === -1) break;
        const block = buf.subarray(examined, idx);
        examined = idx + 2;
        if (block.length === 0) continue;

        const kind = classifyEvent(block.toString("utf8"));
        if (kind === "retry" && canRetry) {
          try { await reader.cancel(); } catch { /* ignore */ }
          log(`${req.method} ${req.url} -> 200 (in-stream ${block.toString("utf8").match(/"code":"(\w+)"/)?.[1] ?? "error"}), will retry`);
          return "RETRY";
        }
        if (kind === "retry") {
          log(`${req.method} ${req.url} !! capacity error but retry budget exhausted, forwarding to codex`);
          commit(); // let codex see the error and surface it
          break;
        }
        if (kind !== "meta") {
          commit(); // real content, or a terminal non-retryable error
          break;
        }
      }
      if (sentHead) continue;
      if (buf.length > HEAD_LIMIT) commit();
    }

    if (!sentHead) {
      // Body ended without any content event (plain JSON / empty / meta only)
      const text = buf.toString("utf8");
      if (RETRYABLE_MARK.test(text) && /"type":"(error|response.failed)"/.test(text)) {
        if (canRetry) {
          log(`${req.method} ${req.url} -> 200 (capacity error body), will retry`);
          return "RETRY";
        }
        log(`${req.method} ${req.url} !! capacity error body but retry budget exhausted, forwarding to codex`);
      }
      commit();
    }
    res.end();
    return "DONE";
  } catch (err) {
    log(`stream read error on ${req.url}: ${err.message}`);
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
      log(`upstream error (${err.message}), retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
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
        log(`${upstream.status} on ${req.url}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${waitMs}ms`);
        await sleep(waitMs);
        delay = Math.min(delay * 2, 30000);
        continue;
      }

      res.writeHead(upstream.status, collectHeaders(upstream));
      res.end(buf);
      return;
    }

    const result = await relayWithSniff(req, res, upstream, attempt < MAX_ATTEMPTS);
    if (result === "RETRY" && attempt < MAX_ATTEMPTS) {
      log(`retrying ${req.url}, attempt ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
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
