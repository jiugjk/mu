# QQ 机器人通道（`mu qqbot`）

mu 内置 QQ 机器人通道：在 QQ 里私聊机器人，或在群里 @ 它，由 mu 来回答和干活。每个私聊、每个群各有一个独立的 mu 会话，照常加载 mu 的判断层（权限审批、风险命令守卫、经验等），需要你批准的操作会以按钮消息发到 QQ。

这个通道移植自 [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)（MIT），QQ 侧的逻辑（网关、收发、切分、流式、富媒体、限额、msgid 缓存等）原样保留，只把与 OpenClaw 的耦合换成了 mu 的接口。原版许可证见 [packages/mu-channels/LICENSE.openclaw-qqbot](../packages/mu-channels/LICENSE.openclaw-qqbot)，与原版的差异见文末[与原版的差异](#与原版的差异)，逐项验收结果与真机走查清单见 [qqbot-acceptance.md](qqbot-acceptance.md)。

- [快速开始](#快速开始)
- [绑定与凭据](#绑定与凭据)
- [配置](#配置)
- [会话、目录与会话池](#会话目录与会话池)
- [权限与审批](#权限与审批)
- [QQ 里的命令](#qq-里的命令)
- [AI 可用的 QQ 工具](#ai-可用的-qq-工具)
- [语音转文字](#语音转文字)
- [Webhook 模式](#webhook-模式)
- [本地调试](#本地调试)
- [环境变量](#环境变量)
- [与原版的差异](#与原版的差异)

## 快速开始

```bash
npm i -g mu-agent          # 需要 Node 22.19+
mu                         # 先让 mu 能用一个模型：在 mu 里 /login，或 mu auth login <provider>
mu qqbot login             # 手机 QQ 扫码，创建并绑定一个 QQ 机器人
mu qqbot start             # 前台运行，Ctrl+C 停止
```

扫码的人会自动加入 `allowFrom`（白名单），可以直接私聊机器人。`mu qqbot status` 查看账户与运行状态。

在仓库里开发时用 `./kyrn/bin/mu.mjs qqbot start`（启动器会用 tsx 直接跑源码）。

## 绑定与凭据

凭据只从配置文件或环境变量读取，不会写进日志（日志会把 AppSecret、access token 等打码），`mu qqbot` 也不会在终端打印 AppSecret。

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| 扫码（推荐） | `mu qqbot login` | 终端显示二维码（显示不了时打印链接），手机 QQ 扫码后在手机上确认。AppSecret 在服务端用本机生成的一次性 AES-256 密钥加密，在本机解密后写入配置 |
| 已有机器人 | `mu qqbot login --token <AppID>:<AppSecret>` | 在 [q.qq.com](https://q.qq.com) 机器人管理页查看 AppID 与 AppSecret |
| 环境变量 | `export QQBOT_APP_ID=… QQBOT_CLIENT_SECRET=…`，再 `mu qqbot login --use-env` | 只适用于 default 账户；AppSecret 不写入配置 |
| 密钥文件 | 配置里写 `"clientSecretFile": "/path/to/secret"` | 文件内容即 AppSecret |

- 凭据写在 `~/.mu/agent/mu.json` 的 `channels.qqbot` 下，文件以 0600 权限原子写入。
- `--account <id>` 写入指定账户；不指定时，同一 AppID 刷新原账户，第一个账户记为 `default`，之后的以 AppID 为账户名（与原版相同）。
- `mu qqbot logout [--account <id>]` 从配置中删除 AppSecret。
- 扫码链接的 `source` 参数取 `clawType`（默认 `mu`），可用 `--source <值>` 覆盖。

## 配置

配置在 `~/.mu/agent/mu.json` 的 `channels.qqbot` 下，结构与原版在 OpenClaw 里的 `channels.qqbot` 相同。`mu qqbot start` 运行时修改文件会自动生效：策略类设置立即生效，凭据、传输方式、webhook、限流、超时、markdown 的变化会让该账户重新连接。

```json
{
  "channels": {
    "qqbot": {
      "appId": "102xxxxxx",
      "clientSecret": "……",
      "allowFrom": ["你的 openid"],
      "dmPolicy": "allowlist",
      "streaming": { "mode": "partial" },
      "model": "anthropic/claude-sonnet-4-5",
      "groups": {
        "*": { "requireMention": true, "toolPolicy": "restricted" },
        "群的 group_openid": { "name": "开发群", "toolPolicy": "full", "prompt": "只回答技术问题。" }
      },
      "accounts": {
        "work": { "appId": "…", "clientSecret": "…" }
      }
    }
  }
}
```

顶层即 `default` 账户，`accounts.<id>` 为其他账户，账户里可以写下表的所有项。

### 连接与账户

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启动这个账户 |
| `appId` / `clientSecret` / `clientSecretFile` | — | 凭据，见上 |
| `name` | — | 账户显示名 |
| `transport` | `"websocket"` | `"webhook"` 见 [Webhook 模式](#webhook-模式) |
| `webhook.host` / `webhook.port` / `webhook.path` | `0.0.0.0` / `8787` / `/qqbot/webhook` | webhook 监听地址 |
| `markdownSupport` | `true` | 以 QQ Markdown 发送回复 |
| `userAgentSuffix` | — | 追加在 User-Agent 末尾（私有化部署标识） |
| `processingTimeoutMs` | `0`（不限） | 单条消息最长处理时间，超时中止这一轮 |
| `clawType` | `"mu"` | 群配置面板回包里的 `claw_type`，可改回 `"openclaw"` |
| `mentionPatterns` | `[]` | 群配置面板回包里的 @ 文本匹配 |

### 谁能用

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `allowFrom` | `[]` | 私聊白名单（openid）。为空或含 `"*"` 时所有人都能私聊；审批按钮也只有这里的人能点 |
| `dmPolicy` | `"allowlist"` | `open` 所有人 / `allowlist` 按 allowFrom / `pairing` 陌生人获得配对码，由 allowFrom 中的人批准 / `disabled` 不响应私聊 |
| `groupPolicy` | `"open"` | `open` / `allowlist`（按 `groupAllowFrom`）/ `disabled` |
| `groupAllowFrom` | `[]` | 群白名单（group_openid） |
| `rateLimit` | 见下 | 入站限流，`false` 关闭 |

`rateLimit` 默认 `{ "perSender": { "max": 20, "windowMs": 60000 }, "perGroup": { "max": 60, "windowMs": 60000 }, "global": { "max": 300, "windowMs": 60000 } }`：同一发送者每分钟 20 条、同一群每分钟 60 条、全局每分钟 300 条，超出的消息丢弃并记日志。每档可以单独改或设为 `false` 关闭。

### 群

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `groups.<group_openid 或 "*">.requireMention` | `true` | 是否要 @ 机器人才回答。优先级：该群 > `"*"` > `defaultRequireMention` > true |
| `defaultRequireMention` | `true` | 群的默认 @ 设置；`/bot-group-always` 修改它 |
| `groups.<…>.ignoreOtherMentions` | `false` | 丢弃 @ 了别人但没 @ 机器人的消息 |
| `groups.<…>.historyLimit` | `20` | 没 @ 机器人的群消息缓存多少条，被 @ 时作为上下文一起给 mu；`0` 关闭 |
| `groups.<…>.toolPolicy` | `"restricted"` | `full` 全部工具 / `restricted` 只读工具（read、grep、find、ls、qqbot_send_media、qqbot_remind）/ `none` 不给工具 |
| `groups.<…>.name` | — | 群名，写进系统提示 |
| `groups.<…>.prompt` | 内置群聊提示 | 该群的行为提示，追加到系统提示 |

### 回答

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `model` | mu 的默认模型 | QQ 会话用的模型，`"provider/model-id"` |
| `systemPrompt` | — | 追加到每个 QQ 会话的系统提示 |
| `streaming` | 关（扫码绑定后为开） | `{ "mode": "partial" }` 私聊流式输出（`stream_messages`），`{ "mode": "off" }` 关闭；群聊始终是普通消息 |
| `deliverDebounce` | `{ "enabled": true, "windowMs": 1500, "maxWaitMs": 8000, "separator": "\n\n---\n\n" }` | 短时间内的多段文本合并发送 |
| `permissions` | `"jev"` | QQ 会话的 mu 权限模式，见[权限与审批](#权限与审批) |
| `approvalTimeoutSeconds` | `600` | 审批 / 选择多久没人回答就按拒绝处理 |
| `stt` | — | 语音转文字，见[语音转文字](#语音转文字) |
| `audioFormatPolicy` | — | 同原版：`sttDirectFormats`（直接交给 STT 的格式）等 |
| `upgradeUrl` | 本文档 | `/bot-upgrade` 给出的升级指引链接 |

### 会话

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `workspace` | `~/.mu/qqbot/workspace` | QQ 会话工作目录的根，每个私聊 / 群各占一个子目录 |
| `sessions.idleMinutes` | `30` | 会话闲置多久后关闭（下次来消息时自动接着之前的对话），`0` 不回收 |
| `sessions.maxSessions` | `32` | 同时打开的会话上限；满了先关闭最久没用的空闲会话，都在忙时回复「会话数已达上限」 |

## 会话、目录与会话池

每个私聊（按用户 openid）和每个群（按 group_openid）是一个独立的 mu 会话，各自的目录互不相通：

```
~/.mu/qqbot/
  workspace/<账户>/<c2c|group>/<openid>/   会话的工作目录（mu 的 cwd）
  media/<账户>/<c2c|group>/<openid>/downloads/   收到的图片、语音、文件
  sessions/<账户>/<c2c|group>/<openid>/    会话记录（重启后接着聊）
  data/        配对、已知用户、提醒、运行状态（status.json）
  <账户>/session.json   网关会话（断线后 resume）
  logs/qqbot.log   日志（已脱敏）
```

AI 用 `qqbot_send_media` 发本地文件时，只允许本会话的 workspace、下载目录和系统临时目录里的文件；其他私聊或群的目录不在其中。

## 权限与审批

QQ 会话和终端里的 mu 一样受权限模式约束，默认 `jev`（Jev 审批：项目内改文件直接做，其余由 Jev 判断，拿不准就问你），不继承你在终端里选的模式。需要你批准时，机器人会在该私聊或群里发一条带按钮的消息：

```
🔐 mu 想运行命令，需要你授权
npm install
…
1. 允许这一次
2. 这次对话都允许（npm）
3. 不允许

点击按钮或回复序号作答。
⏱️ 10 分钟内未作答按拒绝处理。
```

- 点按钮或回复序号都可以（机器人没开通按钮权限时回复序号）。
- 只有 `allowFrom` 里的人能作答（`allowFrom` 为空或含 `"*"` 时所有人都能）；群里按点击者本人判断，别人点会收到「你没有权限处理这个审批」。
- 超过 `approvalTimeoutSeconds` 没人回答按拒绝处理。

`/bot-approve` 在 QQ 里切换权限模式（写入 `channels.qqbot.permissions`，并立即作用于已打开的会话）。整个命令只允许 `allowFrom` 中明确列出的用户执行（`"*"` 不算）：

| 命令 | mu 模式 | 含义 |
| --- | --- | --- |
| `/bot-approve on` | `jev` | Jev 审批（默认） |
| `/bot-approve always` | `ask` | 最小权限：读以外的操作每次都问 |
| `/bot-approve off` | `full` | 完全访问：不再询问。**只能在私聊中、由 `allowFrom` 里明确列出的用户执行（`"*"` 不算），并且要在 2 分钟内发送 `/bot-approve off --confirm` 二次确认** |
| `/bot-approve reset` | — | 删除配置，回到默认 `jev` |
| `/bot-approve status` | — | 查看当前模式 |

群的 `toolPolicy` 与权限模式叠加：`restricted` 的群只有只读工具，所以默认情况下群里的人无法让 mu 改动主机。

## QQ 里的命令

以下命令在 QQ 里直接回答，不经过模型。`/bot-help`、`/bot-ping`、`/bot-version` 与 `/stop` 私聊和群里都能用（群里要 @ 机器人），其余只在私聊中可用。

谁能执行：
- 一般命令需要 `allowFrom` 授权；`allowFrom` 为空、含 `"*"` 或 `dmPolicy` 为 `open` 时所有人都能用（与原版相同）。
- **`/bot-logs`、`/bot-clear-storage`、`/bot-approve` 只允许 `allowFrom` 中明确列出 openid 的用户执行，`"*"` 不算**（导出的日志含其他人的对话，另两个会删文件、改审批）。只配了 `"*"` 时，这三条在 QQ 里不可用：先私聊发 `/bot-me` 查看自己的 openid，把它加入 `allowFrom`（可以与 `"*"` 并存）。任何命令后加 ` ?` 查看用法，例如 `/bot-streaming ?`。

| 命令 | 作用 |
| --- | --- |
| `/bot-help` | 命令列表 |
| `/bot-ping` | 测试连通与延迟 |
| `/bot-version` | mu 与通道版本、是否有新版本 |
| `/bot-me` | 你的 openid（填 `allowFrom` 用） |
| `/bot-upgrade` | 检查更新，给出升级命令 `npm i -g mu-agent@latest` |
| `/bot-logs` | 把最近的通道日志以文件发给你（已脱敏）。仅明确列出的用户 |
| `/bot-streaming [on\|off]` | 私聊流式开关 |
| `/bot-clear-storage [--force]` | 列出 / 删除本账户下载的文件。仅明确列出的用户 |
| `/bot-approve …` | 权限模式，见上。仅明确列出的用户 |
| `/bot-group-always [on\|off]` | 所有群是否不用 @ 也回答（`defaultRequireMention`） |
| `/bot-pairing approve <配对码>` | 批准私聊配对（也可在主机上 `mu qqbot pairing approve <码>`） |
| `/stop` | 中止当前正在进行的回答（插队处理） |

mu 自己的命令（`/permissions`、`/status`、`/review` 等）只对 `allowFrom` 中明确列出的用户生效；其他人发的 `/xxx` 当作普通文字交给模型。

## AI 可用的 QQ 工具

| 工具 | 作用 |
| --- | --- |
| `qqbot_send_media` | 把图片、语音、视频、文件发到当前会话。来源可以是公网 URL、本会话目录里的文件或 data URL；语音被 QQ 拒收时改发文件；失败时通知用户 |
| `qqbot_remind` | 定时提醒：`time` 为相对时间（`5m`、`1h30m`、`2d`，至少 30 秒）或 cron 表达式（`0 8 * * *`，默认时区 `Asia/Shanghai`）。提醒保存在 `~/.mu/qqbot/data/reminders.json`，`mu qqbot start` 重启后继续；到点由模型写一句提醒语发出（失败时直接发「⏰ 内容」）。只在 `mu qqbot start` 运行时触发 |
| `qqbot_platform_api` | 调用 QQ 开放平台 HTTP 接口（自动带机器人 token），配合 `qqbot-channel` 技能查询频道、群信息等 |

主机上也可以直接发消息，不需要机器人在运行：

```bash
mu qqbot send qqbot:c2c:<openid> "构建完成"
mu qqbot send qqbot:group:<group_openid> "日报" --media ./report.pdf
```

## 语音转文字

- 不配置 `stt` 时，使用 QQ 自带的语音识别文字（`asr_refer_text`）。
- 配置后调用 OpenAI 兼容的 `/audio/transcriptions`：

```json
"stt": { "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-…", "model": "whisper-1" }
```

- 只写 `"stt": { "provider": "openai" }`（或 mu 里配置的其他 provider）时，baseUrl 与 key 取自 mu 自己的凭据（`/login` 或 `mu auth login` 存下的 auth.json、环境变量、models.json）。`"enabled": false` 关闭。

## Webhook 模式

默认用 WebSocket 连接 QQ，不需要公网地址。需要 webhook 时：

```json
"transport": "webhook",
"webhook": { "host": "0.0.0.0", "port": 8787, "path": "/qqbot/webhook" }
```

在 QQ 开放平台把回调地址设为 `https://你的域名/qqbot/webhook`（前面放一个 HTTPS 反向代理）。请求用 Ed25519 验签，只收 JSON，body 上限 1MB，每路径每分钟 600 次、同时处理 8 个；多个账户可以共用一个端口和路径（按签名区分）。

## 本地调试

- **日志**：`~/.mu/qqbot/logs/qqbot.log`，`MU_QQBOT_LOG_LEVEL=debug mu qqbot start` 输出更详细的收发与会话事件（工具只记名字，不记参数）。
- **单独的 home**：`MU_QQBOT_HOME=/tmp/qq mu qqbot start`，不碰 `~/.mu/qqbot`。
- **沙箱 / 私有化**：`QQBOT_BASE_URL`、`QQBOT_TOKEN_BASE_URL` 改 QQ 开放平台地址（如沙箱 `https://sandbox.api.sgroup.qq.com`）。
- **只看某个账户**：`mu qqbot start --account work`。
- **测试**：`cd packages/mu-channels && npx vitest --run`。测试在本进程里起一个假的 QQ 开放平台（HTTP + WebSocket，`test/support/fake-qq.ts`）和一个 OpenAI 兼容的假模型（`test/support/fake-llm.ts`），跑真实的 `mu qqbot start` 流程，不需要网络和密钥。
- **不经过 QQ 试 mu 的行为**：QQ 会话就是普通的 mu 会话，cwd 为 `~/.mu/qqbot/workspace/<账户>/<c2c|group>/<openid>`，可以在那里 `mu -c` 接着看。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `QQBOT_APP_ID` / `QQBOT_CLIENT_SECRET` | default 账户的凭据（配置里没有时使用） |
| `QQBOT_BASE_URL` / `QQBOT_TOKEN_BASE_URL` | QQ 开放平台 API / token 地址 |
| `MU_QQBOT_HOME` | 通道数据目录，默认 `~/.mu/qqbot` |
| `MU_QQBOT_LOG_LEVEL` | `debug` / `info`（默认）/ `warn` / `error` |
| `MU_QQBOT_PROCESSING_TIMEOUT_MS` | 全局默认的 `processingTimeoutMs` |
| `MU_QQBOT_OUTBOUND_TIMEOUT_MS` / `MU_QQBOT_OUTBOUND_MEDIA_TIMEOUT_MS` | 发送文本 / 媒体的超时（默认 30s / 300s） |
| `MU_QQBOT_CONNECT_URL` | 扫码绑定接口地址（调试用，默认 `https://q.qq.com`） |
| `MU_PERMISSIONS` | QQ 会话的初始权限模式，`mu qqbot start` 未设置时为 `jev`（账户的 `permissions` 优先） |
| `MU_LANG` | mu 提示与按钮的语言，`mu qqbot start` 未设置时为 `zh-CN` |
| `PI_CODING_AGENT_DIR` | mu 的 home（默认 `~/.mu/agent`），mu.json 在其中 |

## 与原版的差异

按移植原则，QQ 侧行为与原版一致；以下是有意的差异、降级与修正。

**按确认的方案调整**

- 群 `toolPolicy: "restricted"` 在 mu 中只给只读工具（read、grep、find、ls 及两个 QQ 工具）。原版在 OpenClaw 中 `restricted` 实际不做限制。
- 默认开启入站限流（每发送者 20 / 群 60 / 全局 300 条每分钟），可配置、可关闭。原版调用了限流器但没配任何档位，等于不限流。
- 群的 `prompt`（及内置群聊提示）会追加到系统提示。原版只把它放进策略对象，没有任何代码读取。
- 群配置面板回包的 `claw_type` 默认 `"mu"`，可用 `clawType` 改回 `"openclaw"`。
- 不移植凭据备份（原版把明文 AppSecret 另存一份用于恢复）。
- mu 自己的斜杠命令只对 `allowFrom` 中明确列出的用户生效。
- `/bot-approve off` 只能在私聊中由明确列出的用户执行，并需二次确认。
- `/bot-logs`、`/bot-clear-storage`、`/bot-approve` 只允许 `allowFrom` 中明确列出的用户执行（`"*"` 与 `dmPolicy: open` 都不算）。原版这三条与其他命令一样，`dmPolicy` 为 open 或 `allowFrom` 含 `"*"` 时所有人都能执行，包括导出含他人对话的日志。
- 会话池：闲置 30 分钟回收，最多 32 个会话，超出先回收最久未用的。
- 媒体下载目录与工作目录按会话隔离；AI 可发送的本地文件范围缩小到本会话的目录与临时目录（原版为 OpenClaw 的媒体目录与 agent 工作区）。

**mu 没有对应能力而做的替换**

- 审批：原版转发 OpenClaw 网关的 exec / plugin 审批事件；mu 中是 mu 扩展（权限模式、风险命令守卫、MCP 等）的询问，按钮形态与授权规则相同。`/bot-approve` 的 on / always / off 分别对应 mu 的 jev / ask / full。
- AI 发媒体：原版靠 OpenClaw 的 message 工具 / 回复中的 MEDIA 指令；mu 中为 `qqbot_send_media` 工具，调用原版的发送入口。
- 定时提醒：原版 `qqbot_remind` 只生成参数交给 OpenClaw 的 cron 工具；mu 中由通道自带的持久化调度器完成，一步注册；`list` / `remove` 只作用于当前会话。
- 扫码绑定：原版用 `@tencent-connect/qqbot-connector`；mu 中按 qqbot-agent-sdk 的 onboard.py（MIT）用 TypeScript 重新实现同一协议，无额外依赖。
- Webhook：原版挂在 OpenClaw 网关的 HTTP 服务上；mu 自带 HTTP 服务，新增 `webhook.host` / `webhook.port`。
- STT 的回退凭据来自 mu 的 provider 凭据（原版为 OpenClaw 的 `models.providers` / `tools.media.audio`）。
- `mentionPatterns` 从通道配置读取（原版读 OpenClaw 的 agent / messages 配置）。
- 配置在 mu.json；数据在 `~/.mu/qqbot`；环境变量改为 `MU_QQBOT_*`，不再识别 `OPENCLAW_*`。
- `/bot-upgrade` 给出 `npm i -g mu-agent@latest`，版本检查查询 mu-agent；`upgradeMode` / `upgradePkg` 不生效（原版代码里本来也只有文档模式）。`/bot-logs` 只收集 `~/.mu/qqbot/logs`。
- 原版的 agent 事件监控（reply-options）改为监控 mu 会话事件，只记日志。
- mu 的提示与按钮默认中文（`MU_LANG=zh-CN`）；mu 扩展在会话打开时的提示（如「继承了多少技能」）只写日志，不发到 QQ。
- 流式：mu 的事件不能让模型等待发送，写作中的中间文本在上一帧未发完时只保留最新一份（每条消息的最终文本一定发出）；SDK 本身也会给流式更新节流（默认 500ms，最短 300ms）。

**降级**

- TTS：mu 没有语音合成。回复要求以语音发送时降级为文字（原版在 TTS 不可用时的同一降级路径）；AI 仍可用 `qqbot_send_media` 发送已有的音频文件。
- 信封格式与 webBody：mu 没有 Web UI，走原版在框架不提供格式化时的回退（`标签: 内容`）。

**修正的原版问题**

- 被动回复超过 4 次后应转为主动消息，原版因 msgid 缓存又把 msg_id 加回去，转换从未生效。
- `clientSecretFile` 原版只记录来源，从未读取文件。
- 群里点审批按钮的人在 `group_member_openid` 中，原版没读，设置了 `allowFrom` 时群内审批总被拒。
- 群的 `historyLimit` 原版不生效（SDK 始终缓存 50 条）。
- 配对请求达到上限时原版回复空的配对码。
- `/bot-streaming`：原版在未配置 streaming 时显示「已启用」（实际不流式），且无法用 `on` 打开。
- `/指令名 ?`：原版 `/bot-help` 写着可以查看用法，但没有实现。
