# codex-capacity-retry

[English intro](#english) | 中文说明

给 [OpenAI Codex CLI](https://github.com/openai/codex) 加一个本地透明重试代理，自动重试 `⚠ Selected model is at capacity. Please try a different model.`（模型容量满）错误——后端过载时 codex 会静默等待并重试，直到成功，全程无感。

```
没有这个工具:  codex ──► ChatGPT 后端过载 ──► ❌ 直接报错，会话中断
有了这个工具:  codex ──► 本地代理(拦截+退避重试) ──► ✅ 等后端恢复后正常返回
```

## 背景

ChatGPT 计划的 codex 用户在高峰期经常遇到：

```
⚠ Selected model is at capacity. Please try a different model.
```

抓包分析发现，这个错误来自后端的 `server_is_overloaded` / `usage_limit_reached`，属于**瞬时过载**，通常几秒到几分钟后重试就能成功。但 codex CLI 内部只重试约 2 次就放弃并报错，把一个临时状态变成了会话中断。

本工具在本地起一个 HTTP 代理（默认 `127.0.0.1:8317`），通过 codex 的自定义 `model_providers` 配置把模型请求导向它，由它完成带退避的自动重试：

```
codex CLI ──► 127.0.0.1:8317 (本代理) ──► https://chatgpt.com/backend-api/codex
                    │
                    ├─ 流首容量错误 ──► 代理静默重试(3s,6s,12s...最多20次), codex 无感
                    ├─ 输出中途容量错误 ► 吞掉错误+断连, codex 以断线重试机制自动重发
                    └─ 正常响应 ──────► 逐事件透传(保持 SSE 流式)
```

### 处理的错误形态

实测后端返回「容量满」有三种形态，均已处理：

| 形态 | 表现 | 处理 |
|---|---|---|
| HTTP 429/529 | 错误码在响应状态行 | 直接重试，遵守 `Retry-After` |
| **HTTP 200 + 流首错误事件**（最常见） | `response.created` → `response.in_progress` → `error`(code: `server_is_overloaded`) | 代理扣留流头部，识别到可重试错误就丢弃该流并重新发起请求，codex 完全无感 |
| **HTTP 200 + 输出中途错误事件** | 模型已输出部分推理/文本后 `error` 过载 | 代理吞掉错误事件并断开连接，伪装成网络中断；codex 对断线会自动重试，新请求再次经过代理 |

代理对 SSE 流做**逐事件转发**，分两个阶段：

**阶段一（扣留头部）**：结构事件（`response.created`、`response.in_progress`、`response.output_item.added`、`response.content_part.added`、`response.reasoning_summary_part.added`）没有任何用户可见输出，全部扣留不转发，直到看到二者之一——

- **可重试错误事件** → 这条流从未到达 codex，可以完全无感地重新请求；
- **第一个真实增量输出**（delta 类事件 / 条目 done）→ 放行全部缓冲并进入阶段二。

**阶段二（逐事件透传）**：内容事件逐个转发，保持流式体验；若中途出现可重试的过载错误，代理会**吞掉错误事件并断开与 codex 的连接**——codex 把它当作网络中断处理（codex 对流内容量错误是直接放弃的，但对断线会自动重试），重发的新请求又回到代理，形成第二层防护。

可重试错误码：`server_is_overloaded`、`usage_limit_reached`、`model_at_capacity`、`service_unavailable`、`at capacity` 等。参数错误、配额耗尽、认证失败等不可重试错误原样透传给 codex。

## 环境要求

- macOS（安装脚本基于 launchd；Linux 可参考文末手动运行代理 + systemd 自行托管）
- Node.js >= 18
- 已安装 Codex CLI 并用 ChatGPT 账号登录（`~/.codex/auth.json` 存在）
- python3（macOS 自带）

## 快速开始

```bash
git clone https://github.com/Jason213/codex-capacity-retry.git
cd codex-capacity-retry
./install.sh
```

安装脚本会：

1. 把 `proxy.mjs` 装到 `~/.codex/capacity-retry-proxy/`；
2. 创建 launchd 常驻服务（开机自启、崩溃自动拉起）；
3. **备份并修改** `~/.codex/config.toml`，把默认 provider 切到本地代理（`requires_openai_auth = true`，继续使用你已有的 ChatGPT 登录态，无需任何 API Key）；
4. 安装 `cx_proxy` / `cx_office` 两个切换命令到 `~/.local/bin`。

如果你的机器需要通过本地代理访问 chatgpt.com（如中国大陆网络环境），在设置了 `https_proxy` 的终端里运行安装脚本即可自动识别并写入服务配置。

装完验证一下：

```bash
codex exec --skip-git-repo-check "Reply with exactly: OK"
tail -5 ~/.codex/capacity-retry-proxy/proxy.log
```

日志里出现 `POST /backend-api/codex/responses -> 200` 即表示请求已走代理。

## 日常使用

| 命令 | 作用 |
|---|---|
| `cx_office` | 切回**原生直连**：codex 不走代理，并停止+停用本地代理服务 |
| `cx_proxy` | 切回**代理模式**：重新启用代理服务并让 codex 走代理 |

注意：切换只对**新启动的** codex 会话生效，正在运行的会话不会热更新。

## 工作细节

### 安全性

- 代理只监听 `127.0.0.1`，不对外网开放；
- 你的 ChatGPT 凭证**不离开本机**：codex 仍然自己携带 OAuth 凭证发起请求，代理只做转发，不解析、不存储任何凭证；
- 上游固定为 `https://chatgpt.com`，不会把请求发往任何第三方。

### 为什么不用 `OPENAI_BASE_URL` 环境变量？

实测在 ChatGPT 登录态（OAuth）下该环境变量不生效（只对 API Key 认证有效），且新版 codex 禁止覆盖内置 `openai` provider 的定义，所以采用新增自定义 provider + `requires_openai_auth = true` 的方式，这是目前对 ChatGPT 计划用户唯一可行的透明转发方案。

### 重试策略（两层防护）

- **第一层（代理内部）**：流首过载错误，代理静默重试——退避 3s → 6s → 12s → 24s → 之后每次 30s（429 带 `Retry-After` 时优先遵守，上限 60s），最多 20 次尝试（纯等待约 8 分钟）。期间 codex 只表现为这次请求等得久，无任何报错；
- **第二层（codex 重试）**：输出中途过载，代理吞掉错误并断连，codex 以断线重试机制自动重发；重发请求如再遇流首过载，又回到第一层；
- 重试预算耗尽后：把错误原样转发给 codex 正常报错，不会挂死；
- **限制**：中途过载时模型已输出的部分内容会被丢弃重来（codex 断线重试的天然行为），界面上偶尔会看到输出重新开始，属正常现象。

### 调整参数

编辑 `~/Library/LaunchAgents/com.codex.capacity-retry-proxy.plist`，在 `EnvironmentVariables` 的 `<dict>` 中加入（值一律是字符串），然后重启服务（`cx_office && cx_proxy`）：

```xml
<key>MAX_ATTEMPTS</key>
<string>40</string>
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8317` | 监听端口（改了要同步改 config.toml 里的 base_url，建议重跑 install.sh：`CODEX_RETRY_PORT=8318 ./install.sh`） |
| `MAX_ATTEMPTS` | `20` | 最大尝试次数 |
| `BASE_DELAY_MS` | `3000` | 首次重试等待毫秒数 |
| `UPSTREAM` | `https://chatgpt.com` | 上游地址（一般不用动） |

## 日志与排障

```bash
tail -f ~/.codex/capacity-retry-proxy/proxy.log
```

| 日志 | 含义 |
|---|---|
| `POST ... -> 200` | 请求正常透传 |
| `-> 200 (in-stream server_is_overloaded), will retry` + `retrying, attempt N` | 流首容量错误被拦截，正在静默重试（第一层，正常工作） |
| `.. mid-stream capacity error swallowed, dropping connection so codex retries` | 输出中途过载，已吞掉错误并断连，等待 codex 自动重发（第二层，正常工作） |
| `.. terminal(ok): response.completed` | 请求成功完成 |
| `!! capacity error but retry budget exhausted` | 重试约 8 分钟仍失败，错误已透传给 codex |
| `stream read error` / `upstream error` | 网络层问题（如本机代理未运行） |

常见问题：

- **升级 Node / 换了 node 安装路径后服务起不来**：重跑 `./install.sh`（会重新解析 node 路径）。
- **升级 codex CLI 不影响本工具**：它工作在 `config.toml` 层，与 npm 包无关。
- **codex 报 config.toml 解析错误**：从 `~/.codex/config.toml.bak-*` 恢复备份。
- **中国网络环境**：确保安装时 shell 里有 `https_proxy`，或手动编辑 plist 加入 `NODE_USE_ENV_PROXY=1` 与 `https_proxy`。

## Linux 用户

代理本身跨平台，只是安装脚本用了 launchd。手动方式：

```bash
mkdir -p ~/.codex/capacity-retry-proxy && cp proxy.mjs $_/
PORT=8317 node ~/.codex/capacity-retry-proxy/proxy.mjs &
# 然后参照 bin/cx_proxy 中的 config.toml 片段手动修改配置，并用 systemd 托管进程
```

## 卸载

```bash
./uninstall.sh
```

会恢复 codex 原生直连、停止并删除 launchd 服务和所有文件（config.toml 会先备份）。

## English

A tiny local transparent retry proxy for the OpenAI Codex CLI that automatically retries the `Selected model is at capacity. Please try a different model.` error (backend `server_is_overloaded` / `usage_limit_reached`).

It works by defining a custom `model_provider` in `~/.codex/config.toml` pointing at a local Node.js HTTP proxy (`127.0.0.1:8317`). The proxy relays SSE responses event by event: structural head events (`response.created` / `response.in_progress` / `response.output_item.added` / ...) are held back, so when a capacity error arrives before any model output the whole request is retried transparently with exponential backoff (3s→30s, up to 20 attempts). If an overload error strikes *after* output has started, the proxy swallows the error event and drops the connection, which codex treats as a network failure and retries on its own — the fresh request comes back through the proxy. Plain HTTP 429/529 responses are retried too. Your ChatGPT credentials never leave your machine — the proxy only relays to `https://chatgpt.com`.

Requires macOS + Node.js ≥ 18 + Codex CLI signed in with a ChatGPT account. Install with `./install.sh`, toggle with `cx_proxy` / `cx_office`, uninstall with `./uninstall.sh`. See the Chinese sections above for details.

## License

[MIT](./LICENSE)
