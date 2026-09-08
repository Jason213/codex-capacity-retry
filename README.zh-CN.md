# codex-capacity-retry

[English documentation](README.md)

这是一个供 [OpenAI Codex CLI](https://github.com/openai/codex) 使用的本地透明重试代理。它会自动重试临时的“Selected model is at capacity”容量错误，同时保持 Codex 的流式输出体验。

~~~
Codex CLI ──► 127.0.0.1:8317 ──► https://chatgpt.com/backend-api/codex
                    │
                    └─ 重试过载请求，逐事件透传正常 SSE 响应
~~~

## 解决的问题

ChatGPT 暂时过载时，Codex 可能只进行少量客户端重试就终止会话。本代理处理已观察到的几种响应形态：

| 上游响应 | 代理行为 |
| --- | --- |
| HTTP <code>429</code> 或 <code>529</code> | 优先遵守 <code>Retry-After</code>，然后重试。 |
| HTTP <code>200</code>，且输出前收到过载事件 | 暂存结构化 SSE 事件，丢弃失败流并透明重试。 |
| HTTP <code>200</code>，且开始输出后收到过载事件 | 吞掉过载事件并断开连接，让 Codex 按网络中断自动重试。 |
| 其他错误 | 原样转发给 Codex。 |

可重试标记包括 <code>server_is_overloaded</code>、<code>usage_limit_reached</code>、<code>model_at_capacity</code>、<code>service_unavailable</code> 以及包含 “at capacity” 的消息。重试次数耗尽后会正常返回错误，不会无限等待。

## 环境要求

- macOS（安装脚本使用 <code>launchd</code>；代理程序本身也可在 Linux 运行）
- Node.js 18 或更高版本
- Python 3（shell 辅助脚本使用）
- 已登录 ChatGPT 账号的 Codex CLI（存在 <code>~/.codex/auth.json</code>）

不需要 API Key，Codex 仍会自行携带 OAuth 凭证。

## 安装

~~~bash
git clone https://github.com/Jason213/codex-capacity-retry.git
cd codex-capacity-retry
./install.sh
~~~

安装脚本会把代理复制到 <code>~/.codex/capacity-retry-proxy/</code>，创建用户级服务 <code>com.codex.capacity-retry-proxy</code>，备份并修改 <code>~/.codex/config.toml</code>，并把 <code>cx_proxy</code>/<code>cx_office</code> 安装到 <code>~/.local/bin</code>。

如果访问 ChatGPT 必须经过本地网络代理，请在安装前导出 <code>https_proxy</code>（也可设置 <code>http_proxy</code>）；脚本会把这些值写入服务环境。只生成文件、不启动 <code>launchd</code> 时使用 <code>SKIP_LAUNCHD=1 ./install.sh</code>。

启动新的 Codex 会话并查看日志验证：

~~~bash
codex exec --skip-git-repo-check "Reply with exactly: OK"
tail -5 ~/.codex/capacity-retry-proxy/proxy.log
~~~

日志中出现 <code>POST /backend-api/codex/responses -&gt; 200</code>，说明请求已经过代理。

## 切换模式

| 命令 | 作用 |
| --- | --- |
| <code>cx_proxy</code> | 启用服务，让新启动的 Codex 会话经过重试代理。 |
| <code>cx_office</code> | 移除自定义 provider，停止并停用服务，恢复原生直连。 |

切换只对新启动的 Codex 会话生效。

## 配置

编辑 <code>~/Library/LaunchAgents/com.codex.capacity-retry-proxy.plist</code>，然后执行 <code>cx_office &amp;&amp; cx_proxy</code> 重启服务：

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| <code>PORT</code> | <code>8317</code> | 本地监听端口。建议用 <code>CODEX_RETRY_PORT=8318 ./install.sh</code> 一并修改。 |
| <code>MAX_ATTEMPTS</code> | <code>20</code> | 最大尝试次数，包含首次请求。 |
| <code>BASE_DELAY_MS</code> | <code>3000</code> | 首次退避等待时间（毫秒）。 |
| <code>UPSTREAM</code> | <code>https://chatgpt.com</code> | 上游地址，通常不要修改。 |

退避时间逐次翻倍，最多 30 秒；<code>Retry-After</code> 最多遵守 60 秒。

## 日志与排障

~~~bash
tail -f ~/.codex/capacity-retry-proxy/proxy.log
~~~

- <code>in-stream ... will retry</code>：输出前过载，代理正在内部重试。
- <code>mid-stream capacity error swallowed</code>：Codex 应断线重连并自动重试。
- <code>capacity error but retry budget exhausted</code>：已返回最终上游错误。
- <code>stream read error</code> 或 <code>upstream error</code>：检查 ChatGPT 连通性和 <code>https_proxy</code> 设置。

升级 Node.js 或更换安装路径后，请重新运行 <code>./install.sh</code>，让 <code>launchd</code> 使用最新路径。若 Codex 报 TOML 解析错误，可从最新的 <code>~/.codex/config.toml.bak-*</code> 备份恢复。

## Linux

使用你选择的进程管理器运行代理，并手动配置 Codex provider：

~~~bash
mkdir -p ~/.codex/capacity-retry-proxy
cp proxy.mjs ~/.codex/capacity-retry-proxy/
PORT=8317 node ~/.codex/capacity-retry-proxy/proxy.mjs
~~~

可参考 <code>bin/cx_proxy</code> 生成的 provider 配置修改 <code>~/.codex/config.toml</code>，再交给 <code>systemd</code> 或其他进程管理器托管。

## 卸载

~~~bash
./uninstall.sh
~~~

脚本会先备份 <code>config.toml</code>，恢复 Codex 原生直连，移除 <code>launchd</code> 服务，并删除已安装的代理文件和切换命令。

## 安全说明

代理只监听 <code>127.0.0.1</code>，只转发到 <code>https://chatgpt.com</code>，不会解析或持久化 OAuth 凭证。请把 <code>~/.codex/auth.json</code>、代理环境变量、请求头和日志视为敏感信息。

## 许可证

[MIT](LICENSE)
