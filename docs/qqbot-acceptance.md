# QQ 机器人通道：验收表与真机走查清单

对象：`packages/mu-channels`（`mu qqbot`），移植自 tencent-connect/openclaw-qqbot。功能编号 F1–F58 对应移植前的功能盘点，M1–M11 为 mu 新增或按确认的方案调整的部分。

自动化测试都在 `packages/mu-channels/test/` 下，运行 `cd packages/mu-channels && npx vitest --run`。端到端测试跑的是真实的 `mu qqbot start` 流程：会话宿主、mu 会话、kyrn-judge 扩展都是真的，QQ 开放平台（HTTP + WebSocket）和模型（OpenAI 兼容接口）是本地假服务。所以凡是依赖 QQ 客户端真实表现的（按钮渲染、流式的打字机效果、真实限额等），另外列在后面的真机走查清单里。

状态说明：**通过** = 与原版行为一致（或按确认的方案实现），并有自动化测试；**降级** = mu 缺少对应能力，改用替代行为；**未实现** = 未移植，原因见备注。

## 验收表

### A. 连接与账号

| 功能 | 状态 | 验证方式 | 备注 |
| --- | --- | --- | --- |
| F1 WebSocket 接入（token 预取、identify/READY、会话持久化 `session.json`、重连 resume） | 通过 | 所有端到端测试都走完整连接流程；`misc.test.ts` 检查 `session.json`；断线 resume 见走查 #13 | 网关、重连逻辑在 SDK 中，原样使用 |
| F2 Webhook（Ed25519 验签、op:13 地址校验、多账号同路径按签名匹配、1MB/30s、600 次/分钟、8 并发） | 通过 | `webhook.test.ts`：op 13、签名事件 + op 12 回执、伪造签名与非 JSON 被拒、两个账号共用路径 | mu 自带 HTTP 服务，新增 `webhook.host/port`（原版挂在 OpenClaw 网关上）。限流与并发上限未单独做压测 |
| F3 多账号（顶层 = default、`accounts.<id>`、启停） | 通过 | `config.test.ts`；`cli-login-send.test.ts`（第二个 AppID 成为独立账号）；`webhook.test.ts`（两个账号同时运行） | |
| F4 凭据来源（配置 / 环境变量 / `clientSecretFile`） | 通过 | `config.test.ts` | 修正：原版从不读取 `clientSecretFile` |
| F5 凭据备份与恢复 | 未实现 | — | 按确认的方案（Q7a）不移植：原版把明文 AppSecret 再存一份，mu 只从配置或环境变量读取凭据 |
| F6 登出 | 通过 | `cli-login-send.test.ts`：`mu qqbot logout` 删除 AppSecret、保留其余配置 | |
| F7 运行状态 | 通过 | `misc.test.ts`（`data/status.json`，不含密钥）；npm 冒烟测试 `mu qqbot status` | |
| F8 私有化参数与 User-Agent | 通过 | 所有测试经 `QQBOT_BASE_URL` / `QQBOT_TOKEN_BASE_URL` 连到假服务；`misc.test.ts` 检查 UA 为 `QQBotPlugin/… (…; mu/…)` | UA 中 `OpenClaw/x` 改为 `mu/x` |

### B. 入站

| 功能 | 状态 | 验证方式 | 备注 |
| --- | --- | --- | --- |
| F9 私聊交给 AI | 通过 | `c2c-text.test.ts` | 每个私聊一个 mu 会话，重启后接着聊 |
| F10 群聊交给 AI（`[昵称 (openid)]`、`(@you)`） | 通过 | `group-and-access.test.ts` | |
| F11 群 @ 门控（requireMention 优先级、ignoreOtherMentions） | 通过 | `group-and-access.test.ts`（未 @ 不回、`requireMention: false`、`/bot-group-always`）；`config.test.ts`（优先级） | `ignoreOtherMentions` 由 SDK mentionGate 实现，没有单独测试，见走查 #4 |
| F12 群历史缓冲（historyLimit，0 关闭，处理后清空） | 通过 | `group-and-access.test.ts` | 修正：原版 historyLimit 不生效（SDK 固定 50 条） |
| F13 访问控制（dmPolicy / allowFrom、groupPolicy / groupAllowFrom） | 通过 | `group-and-access.test.ts`；`commands-more.test.ts` | |
| F14 私聊配对 | 通过 | `group-and-access.test.ts`（配对码 → `/bot-pairing approve` → 可用）；走查 #6 | 修正：队列满时原版回复空配对码。`mu qqbot pairing approve` 与 QQ 内命令共用同一存储 |
| F15 入站清洗（去重、表情标签、@ 处理） | 通过 | `misc.test.ts`（同一消息推两次只回一次、表情转文字）；`group-and-access.test.ts`（去掉 `<@!bot>`） | |
| F16 限流 | 通过 | `group-and-access.test.ts`（超出每人档位的消息被丢弃）；`config.test.ts`（默认档位、单档关闭、整体关闭） | 偏离：默认开启（每人 20 / 群 60 / 全局 300 条每分钟）。原版实际不限流 |
| F17 串行、合并、超时、`/stop` 插队 | 通过 | `group-and-access.test.ts`（忙时合并）；`misc.test.ts`（processingTimeoutMs）；`streaming-and-delivery.test.ts`、`commands-basic.test.ts`（`/stop`）；`body-assembler.test.ts`（合并格式，移植） | |
| F18 私聊"正在输入" | 通过 | `misc.test.ts` | |
| F19 引用消息（REFIDX、`[Quoted message]`、持久化） | 通过 | `group-and-access.test.ts`（引用机器人自己的消息）；重启后引用见走查 #13 | |
| F20 入站图片 | 通过 | `media.test.ts`：下载到本会话目录、图片内容直接给模型看、下载失败时交给模型远端 URL | 新增：10MB 以内的图片作为图片内容给模型 |
| F21 入站语音（STT、voice_wav_url、SILK→WAV、asr 兜底） | 通过 | `media.test.ts`：无 STT 时用 QQ 识别文字、配置的 STT、mu provider 凭据；`config.test.ts` | SILK→WAV 转换依赖真实语音文件，见走查 #7。STT 回退凭据改为 mu 的 provider 凭据 |
| F22 入站视频与文件 | 通过 | `media.test.ts`（文件，`[Attachment: 路径]`） | 视频走同一路径 |
| F23 已知用户记录 | 通过 | `misc.test.ts` | |
| F24 被动回复 msgid 缓存 | 通过 | `misc.test.ts`（没有 msg_id 的发送借用群里最近一条的 msg_id） | |

### C. 出站

| 功能 | 状态 | 验证方式 | 备注 |
| --- | --- | --- | --- |
| F25 Markdown 回复、剥离内部标签 | 通过 | `c2c-text.test.ts`；`sanitize.test.ts`（移植） | |
| F26 5000 字切分、表格完整 | 通过 | `c2c-text.test.ts`；`chunker-table.test.ts`（移植） | |
| F27 被动回复限额（每条 4 次、1 小时），超出转主动 | 通过 | `c2c-text.test.ts`（第 5 条起不带 msg_id） | 修正：原版因 msgid 缓存把 msg_id 加回去，转换从未生效。见走查 #3 |
| F28 合并发送（debounce） | 通过 | `streaming-and-delivery.test.ts`（合并、maxWait、flushAll、窗口 0、默认开启时按序送达） | 投递是串行的，与原版一样，实际效果主要是延迟 1.5 秒，很少真正合并 |
| F29 流式消息（仅私聊） | 通过 | `streaming-and-delivery.test.ts`（stream_messages、DONE 帧、群里走普通消息、失败回退、工具调用后开新流、`/stop`）；`streaming-controller.test.ts`（状态机） | 原版的 streaming-controller 测试针对已删除的旧实现，无法运行，已按现行代码重写。打字机效果见走查 #2 |
| F30 投递车道（block / tool / final） | 通过 | `dispatch-deliver.test.ts`（移植，16 例） | |
| F31 富媒体发送（类型推断、路径白名单、SSRF、语音失败改发文件、失败提示、分片上传） | 通过 | `media.test.ts`（工作区图片被动回复、白名单外路径被拒并提示、语音被拒改发文件）；`misc.test.ts`（SSRF）；`cli-login-send.test.ts`（主机发文件） | AI 的入口改为 `qqbot_send_media` 工具（原版为 OpenClaw 的 MEDIA 指令）。大文件分片上传在 SDK 中，见走查 #8 |
| F32 TTS 语音回复 | 降级 | 代码路径：没有 TTS 时发文字（原版自带的降级分支） | mu 没有语音合成。AI 仍可以用 `qqbot_send_media` 发送已有的音频文件 |
| F33 主动发消息 | 通过 | `cli-login-send.test.ts`（`mu qqbot send` 文字与文件，不需要机器人在运行）；`reminders.test.ts` | |
| F34 `qqbot_platform_api` | 通过 | `commands-more.test.ts`（带机器人 token 调接口、拒绝 `..` 路径、token 不进模型上下文） | |

### D. 按钮交互

| 功能 | 状态 | 验证方式 | 备注 |
| --- | --- | --- | --- |
| F35 审批按钮 | 通过 | `approvals.test.ts`（kyrn-judge 真实加载：按钮消息、点击允许、回复序号拒绝、无权限者作答被拒、群里按点击者判断、超时按拒绝）；`approval-auth.test.ts`（移植，改为测试实际函数） | 审批来源改为 mu 扩展的询问（原版是 OpenClaw 网关的审批事件），按钮形态与授权规则相同。修正：原版没读 `group_member_openid`。见走查 #1 |
| F36 群配置面板 2001 / 2002 | 通过 | `approvals.test.ts`（claw_type 默认 "mu"、可配为 "openclaw"、2002 写入 mu.json） | Q9a |
| F37 交互回执 | 通过 | `approvals.test.ts`（PUT `/interactions/:id`） | |

### E. 斜杠命令

| 功能 | 状态 | 验证方式 | 备注 |
| --- | --- | --- | --- |
| F38 `/bot-help` | 通过 | `commands-basic.test.ts` | |
| F39 `/bot-ping` | 通过 | `commands-basic.test.ts` | |
| F40 `/bot-version`（含新版本检查） | 通过 | `commands-basic.test.ts`（离线时说明检查失败） | 联网检查的是 mu-agent 的 npm 版本，见走查 #12 |
| F41 `/bot-me` | 通过 | `commands-basic.test.ts` | |
| F42 `/bot-upgrade` | 通过 | `commands-more.test.ts` | 给出 `npm i -g mu-agent@latest`；原版代码也只有文档模式 |
| F43 `/bot-logs` | 通过 | `commands-more.test.ts`（以文件发回、不含 AppSecret 与 token；未明确列出的用户被拒） | 只收集 `~/.mu/qqbot/logs`。偏离：只允许 allowFrom 中明确列出的用户（M11） |
| F44 `/bot-streaming` | 通过 | `commands-more.test.ts` | 修正：原版未配置时显示"已启用"且无法开启 |
| F45 `/bot-clear-storage` | 通过 | `commands-more.test.ts` | 清理本账号各会话的下载目录。偏离：只允许明确列出的用户（M11） |
| F46 `/bot-approve` | 通过 | `approvals.test.ts`（always / reset、off 的全部限制） | on/always/off 对应 jev/ask/full。off 只能在私聊中、由 allowFrom 中明确列出的用户执行，并需二次确认 |
| F47 `/bot-group-always` | 通过 | `group-and-access.test.ts`；`commands-more.test.ts`（未明确列出的用户被拒） | 偏离：只允许明确列出的用户（M11） |
| F48 `/bot-pairing`、`/命令 ?`、私聊限定、allowFrom 鉴权 | 通过 | `group-and-access.test.ts`、`misc.test.ts`（`?`）、`commands-more.test.ts`（鉴权：一般命令在 `dmPolicy: open` 或 `"*"` 时所有人可用，与原版一致；四条敏感命令除外，见 M11） | 修正：原版 `/bot-help` 声称支持 `/命令 ?`，但没有实现 |
| F49 `/stop` | 通过 | `commands-basic.test.ts`、`streaming-and-delivery.test.ts` | |

### F. 绑定与配置

| 功能 | 状态 | 验证方式 | 备注 |
| --- | --- | --- | --- |
| F50 扫码绑定 | 通过 | `cli-login-send.test.ts`（假的 q.qq.com：创建任务、轮询、AES-GCM 本地解密、写入默认值、扫码者加入 allowFrom、过期与解密失败、终端不打印密钥）；真实 q.qq.com 见走查 #11 | Q1 选项 e：按 onboard.py（MIT）用 TypeScript 重新实现，不依赖 qqbot-connector。协议已在开发时实测过 create_bind_task |
| F51 手动绑定（`--token`、`--use-env`） | 通过 | `cli-login-send.test.ts` | OpenClaw 向导里手动输入的方式改为 `--token` |
| F52 配置热更新、命令写回配置 | 通过 | `misc.test.ts`（运行中改 dmPolicy 立即生效，改凭据触发重连）；各命令测试检查 mu.json | |

### G. 其他

| 功能 | 状态 | 验证方式 | 备注 |
| --- | --- | --- | --- |
| F53 `qqbot_remind` | 通过 | `reminders.test.ts`（cron 解析与时区、到点发送、重启后保留、周期任务、失败重试、只看本会话、端到端：对话里创建 → 到点由模型写提醒语 → 发到 QQ） | Q4a：由 mu 的持久化调度器完成（原版交给 OpenClaw 的 cron 工具）。见走查 #10 |
| F54 群级 name / toolPolicy | 通过 | `config.test.ts`、`group-and-access.test.ts`（restricted 群只有只读工具） | 偏离（Q3b）：restricted = 只读工具 |
| F55 账号 systemPrompt | 通过 | `config.test.ts`；`group-and-access.test.ts`（系统提示含群聊说明） | Q6b：群 prompt 也会生效 |
| F56 分级日志与 trace | 通过 | `streaming-and-delivery.test.ts`（读日志）；`c2c-text.test.ts`、`host.test.ts`（脱敏） | 新增密钥脱敏 |
| F57 版本检查 | 通过 | `commands-basic.test.ts`（离线）；走查 #12（联网） | |
| F58 退出时 flush ref-index | 通过 | 代码：`mu qqbot start` 停止时调用；走查 #13 | |

### mu 新增与调整

| 功能 | 状态 | 验证方式 | 备注 |
| --- | --- | --- | --- |
| M1 会话池（闲置 30 分钟回收、上限 32、先回收最久未用） | 通过 | `host.test.ts`（复用、并发打开、闲置回收、忙时不回收、LRU、全忙拒绝）；`misc.test.ts`（全忙时的提示） | 补充要求 1 |
| M2 目录按会话隔离（workspace、下载、会话记录；私聊与群分开） | 通过 | `media.test.ts`（群与私聊下载分开、会话记录分开、白名单外路径被拒） | 补充要求 3 |
| M3 限流默认档位 | 通过 | 见 F16 | 补充要求 2，属偏离 |
| M4 `/bot-approve off` 限制与二次确认 | 通过 | `approvals.test.ts` | 补充要求 4 |
| M5 mu 命令只对 allowFrom 中明确列出的用户生效 | 通过 | `approvals.test.ts`（加载 kyrn-judge：明确列出的用户能执行 `/permissions`；仅凭 `"*"` 进来的用户，命令作为文字交给模型）；`commands-basic.test.ts` | Q5a |
| M6 权限模式（默认 jev，按账号配置，打开的会话立即生效） | 通过 | `approvals.test.ts` | Q2a |
| M7 按钮问答桥（select / confirm / input → QQ 按钮或文字） | 通过 | `approvals.test.ts`；`host.test.ts` | 通用组件，放在 `src/host/chat-ui.ts` |
| M8 QQ 会话默认中文（`MU_LANG=zh-CN`）；会话打开时扩展的提示只写日志 | 通过 | `approvals.test.ts`（中文按钮）；`host.test.ts`（静默提示） | |
| M9 事件监控（原 reply-options） | 通过 | `agent-events.test.ts`；`streaming-and-delivery.test.ts`（日志里有工具名、没有参数） | 原版测试针对 OpenClaw 专有选项，改为测试 mu 的事件映射 |
| M10 npm 打包 | 通过 | `node kyrn/npm/build.mjs`：`channels/dist/qqbot.js`、`silk.wasm`、技能、许可证；打包产物实际运行 `mu qqbot start` 并回答私聊；`kyrn/npm/smoke.mjs` 增加 `mu qqbot help/status` | qrcode-terminal 作为 mu-agent 的固定版本依赖 |
| M11 敏感命令（`/bot-logs`、`/bot-clear-storage`、`/bot-approve`、`/bot-group-always`）只允许 allowFrom 中明确列出的用户，`"*"` 与 `dmPolicy: open` 不算 | 通过 | `commands-more.test.ts`（open 模式下普通命令照常、四条敏感命令被拒并提示用 `/bot-me` 加入 allowFrom、明确列出的管理员可用；只配 `"*"` 时所有人都不能执行）；`approvals.test.ts` | 偏离（第 6 组后确认的方案 b）：原版这四条在 open / `"*"` 时所有人可执行 |

### 未移植的原版内容（非功能）

- 原版中没有任何调用方的代码：`outbound/cron-scheduler.ts`、`image-size.ts`、`tts-provider.ts`、runDiagnostics、`OutboundService` 类、`detectWasMentioned`。
- `features/onboarding.ts`：原版就是固定返回失败的空壳。
- OpenClaw 专用内容：preload、SDK 链接脚本、`bin/qqbot-cli.js`、升级脚本、`skills/qqbot-upgrade`、`adapter/contract.ts` 与 `lint.ts`。
- 已损坏的脚本 `scripts/send-proactive.ts`、`proactive-api-server.ts`（引用了不存在的模块）。它们的用途由 `mu qqbot send` 覆盖。
- 原版测试 `code-block-media-tag`、`strip-incomplete-media-tag`、`streaming-controller`：它们引用的模块在原版"新架构重构"时已删除，原仓库里也跑不起来。流式控制器已按现行代码重写测试。
- 只有定义、原版中也不生效的配置项：`upgradeMode`、`upgradePkg`、`urlDirectUpload`、`mediaMaxMb`、`uploadDirectFormats`、`transcodeEnabled`。

## 真机走查清单

准备：
1. 在 [q.qq.com](https://q.qq.com) 准备一个测试机器人（或用 #11 扫码新建），把它拉进一个测试群。
2. 准备两个 QQ 号：A 是管理员，B 是普通成员。
3. 在主机上执行：

```bash
mu qqbot login            # 或 --token AppID:AppSecret
# 在 ~/.mu/agent/mu.json 的 channels.qqbot 里：
#   allowFrom 改为 ["A 的 openid"]（A 私聊发 /bot-me 可以查到）
#   加上 "streaming": { "mode": "partial" }
MU_QQBOT_LOG_LEVEL=debug mu qqbot start
```

每项写明操作与预期结果，全部满足即为通过。

**1. 按钮审批**
- 操作：A 私聊发 `/bot-approve always`，再发"在当前目录新建 a.txt 写入 hello"。
- 预期：
  - 收到 🔐 消息，带"允许这一次 / 这次对话都允许 / 不允许"按钮，按钮显示正常。
  - 点"允许这一次"后，按钮变为"已选"，文件被创建，mu 回复完成。
  - 再让它删除 a.txt，这次点"不允许"：文件还在，mu 说明没有获得允许。
  - 在群里让 mu 做同样的事（先在 mu.json 把该群设为 `"toolPolicy": "full"`）：B 点按钮收到"⚠️ 你没有权限处理这个审批"，A 点才生效。
  - 把 `approvalTimeoutSeconds` 设为 60，发请求后不作答：约 1 分钟后按拒绝处理。
  - 最后发 `/bot-approve reset` 恢复。

**2. 私聊流式**
- 操作：A 私聊让 mu 写一段约 300 字的说明。
- 预期：消息以打字机效果逐步出现，结束后只有这一条完整消息，没有重复的普通消息。
- 操作：`/bot-streaming off` 后再问一次。
- 预期：以一条普通消息整体发出。

**3. 被动回复转主动**
- 操作：A 私聊让 mu 输出一段超过 25000 字的内容（例如"把 1 到 3000 每个数字写成一行中文"），或在群里连续触发 5 条以上回复。
- 预期：
  - 前 4 条消息显示为对 A 那条消息的回复（被动）。
  - 第 5 条起作为主动消息发出，不报错也不丢失。
  - debug 日志中，从第 5 条起发送请求的 Body 不带 `msg_id`。

**4. 群 @ 门控**
- 操作：B 在群里发普通消息（不 @ 机器人）。
- 预期：机器人不回复。
- 操作：B @ 机器人提问。
- 预期：机器人回复；如果问题与刚才的未 @ 消息有关，回答能引用到它们（群历史）。
- 操作：A 私聊发 `/bot-group-always on`，B 在群里不 @ 发消息。
- 预期：机器人回复。
- 操作：`/bot-group-always off` 恢复；在 mu.json 为该群设置 `"ignoreOtherMentions": true`，B @ 另一个人（不 @ 机器人）发言，然后再 @ 机器人问"刚才谁说了什么"。
- 预期：那条 @ 别人的消息没有进入历史。

**5. 富媒体收发**
- 操作：A 私聊发一张图片并问"图里是什么"。
- 预期：mu 能描述图片内容（所用模型需支持图片）；图片保存在 `~/.mu/qqbot/media/default/c2c/<A>/downloads/`。
- 操作：A 发一个 PDF 或 txt 文件，让 mu 总结。
- 预期：mu 能读取文件内容。
- 操作：让 mu"把刚才那张图发回给我"。
- 预期：图片被发回。
- 操作：让 mu 生成一个文件（例如 csv）再发给你。
- 预期：以文件形式收到。
- 操作：在群里 @ 机器人发图。
- 预期：图片保存在 `media/default/group/<群>/downloads/`，与私聊目录分开。

**6. 配对**
- 操作：把 `dmPolicy` 改为 `"pairing"`（`allowFrom` 保持只有 A），然后用 B 私聊机器人。
- 预期：B 收到 8 位配对码，此时机器人不回答 B 的问题。
- 操作：A 私聊发 `/bot-pairing approve <码>`。
- 预期：A 收到"已批准"；B 再发消息时机器人正常回答。
- 操作：换一个 C 号取得配对码后，在主机上执行 `mu qqbot pairing list` 与 `mu qqbot pairing approve <码>`。
- 预期：C 同样可以使用。

**7. 语音（SILK）**
- 操作：A 私聊发一条语音。
- 预期：
  - 不配置 `stt` 时，mu 按 QQ 自带识别的文字回答。
  - 配置 `"stt": { "provider": "openai" }`（mu 已登录 OpenAI）或填写 baseUrl 与 apiKey 后再发一次：mu 按 STT 转写的文字回答，日志里没有出现 key。

**8. 大文件与视频**
- 操作：让 mu 发送一个 20MB 以上的文件和一个 mp4。
- 预期：都能收到（大文件走 SDK 的分片上传）。

**9. `/stop` 与会话**
- 操作：让 mu 做一件耗时的事，中途发 `/stop`。
- 预期：mu 立即停止，并回复"已停止当前任务"。
- 操作：重启 `mu qqbot start` 后问"我们刚才聊到哪了"。
- 预期：mu 接着之前的对话回答。

**10. 定时提醒**
- 操作：A 私聊发"2 分钟后提醒我喝水"。
- 预期：mu 回复已设置；约 2 分钟后收到一条提醒语。
- 操作：发"每天早上 8 点提醒我打卡"，然后问"我有哪些提醒"。
- 预期：能列出这条提醒。
- 操作：重启 `mu qqbot start`。
- 预期：这条提醒还在（`~/.mu/qqbot/data/reminders.json`）。
- 操作：发"取消打卡提醒"。
- 预期：提醒被删除。

**11. 扫码绑定（真实 q.qq.com）**
- 操作：用一个新的 `MU_QQBOT_HOME` 与 `PI_CODING_AGENT_DIR`，执行 `mu qqbot login`。
- 预期：
  - 终端显示二维码，手机 QQ 扫码后显示绑定或创建页面；确认后终端提示"绑定成功"。
  - mu.json 中写入了 appId 与 clientSecret（文件权限为 0600），`allowFrom` 为扫码人的 openid，终端没有打印 AppSecret。
  - 若手机页面对 `source=mu` 显示异常，改用 `mu qqbot login --source openclaw` 再试，并记录结果。

**12. 版本与日志**
- 操作：A 私聊发 `/bot-version`（主机可以联网）。
- 预期：显示 mu 的版本与 npm 上 mu-agent 的最新版本。
- 操作：发 `/bot-logs`。
- 预期：收到日志文件，文件中没有 AppSecret 与 access token 明文。
- 操作：把 allowFrom 改为 `["*", "A 的 openid"]`，用 B 私聊发 `/bot-logs`、`/bot-approve off`、`/bot-group-always on`。
- 预期：三条都被拒，提示"只允许 allowFrom 中明确列出的用户执行（"*" 不算）"；B 发 `/bot-ping` 仍正常；A 发 `/bot-logs` 仍能收到文件。

**13. 断线恢复与引用**
- 操作：让机器人回复一条消息后，断开主机网络 30 秒再恢复。
- 预期：日志显示重连（resume），之后收发正常。
- 操作：在 QQ 里引用机器人较早的一条回复并提问；然后重启 `mu qqbot start`，再引用同一条消息提问。
- 预期：两次 mu 都能看到被引用的原文。

**14. Webhook（可选，需要公网 HTTPS）**
- 操作：把 `transport` 改为 `"webhook"`，在 QQ 开放平台配置回调地址。
- 预期：平台的地址校验通过，收发正常。
