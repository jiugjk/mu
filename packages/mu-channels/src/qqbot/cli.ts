/**
 * `mu qqbot` — QQ Bot 通道的命令入口（mu 移植新增）
 *
 * 原版的生命周期由 OpenClaw 框架驱动（register → gateway.startAccount / stopAccount / logoutAccount、
 * auth.login、setup 向导）。mu 是命令行 agent，没有常驻框架，因此由本文件承担：
 *
 *   mu qqbot start [--account <id>]      启动所有已启用账户（或指定账户），前台常驻
 *   mu qqbot status                      账户配置与最近一次运行状态
 *   mu qqbot login …                     扫码或填写凭据绑定（见 setup/）
 *   mu qqbot logout [--account <id>]     清除配置中的 AppSecret
 *   mu qqbot send <目标> <文本> …         主动发消息（目标 qqbot:c2c:<openid> / qqbot:group:<openid>）
 *   mu qqbot pairing list | approve <码>  私聊配对
 *
 * 启动器（kyrn/bin/mu.mjs）设置 PI_CODING_AGENT_DIR（~/.mu/agent）、MU_VERSION，
 * 以及 MU_QQBOT_EXTENSIONS（mu 判断层扩展路径，QQ 会话与 `mu` 一样加载它）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import qrcode from "qrcode-terminal";
import { MuConfigFile } from "../host/config-store.ts";
import { createChannelLogger, type LogLevel, Redactor } from "../host/logger.ts";
import { muAgentDir, muConfigPath, safeSegment } from "../host/paths.ts";
import { runIsolatedPrompt } from "../host/session.ts";
import { getPairingStore } from "./adapter/pairing.ts";
import { sendChunkedText } from "./channel.ts";
import { listQQBotAccountIds, resolveQQBotAccount } from "./config.ts";
import { createQQChatSurface } from "./features/chat-surface.ts";
import { flushAllRefIndexStores } from "./features/ref-index-store.ts";
import { ReminderScheduler } from "./features/reminders.ts";
import { logoutAndClearCredentials, startAccount, stopAccountGracefully } from "./gateway/lifecycle.ts";
import { QQBotHost } from "./host.ts";
import { sendMedia } from "./outbound/media-send.ts";
import { getOrCreateGateway } from "./outbound/outbound-service.ts";
import { normalizeTarget } from "./outbound/target.ts";
import { type QQBotRuntime, setQQBotRuntime } from "./runtime.ts";
import { applyAccountDefaults } from "./setup/finalize.ts";
import { applyLoginCredentials, type BoundCredentials, parseChannelInput } from "./setup/login.ts";
import { qrConnect } from "./setup/qr-connect.ts";
import { createPlatformTool } from "./tools/platform.ts";
import { buildReminderPrompt, createRemindTool } from "./tools/remind.ts";
import { createSendMediaTool } from "./tools/send-media.ts";
import type { MuConfig, ResolvedQQBotAccount } from "./types.ts";
import { getQQBotDataDir, getQQBotHome } from "./utils/platform.ts";
import { createPluginLogger } from "./utils/plugin-logger.ts";

export const USAGE = [
	"mu qqbot — QQ 机器人通道",
	"",
	"  mu qqbot start [--account <id>]        启动 QQ 机器人（前台运行，Ctrl+C 停止）",
	"  mu qqbot status                        查看账户与运行状态",
	"  mu qqbot login [--account <id>]        扫码绑定机器人（手机 QQ 扫码）",
	"  mu qqbot login --token <AppID:AppSecret> [--account <id>]   用凭据绑定",
	"  mu qqbot login --use-env               使用环境变量 QQBOT_APP_ID / QQBOT_CLIENT_SECRET",
	"  mu qqbot logout [--account <id>]       清除配置中的 AppSecret",
	"  mu qqbot send <qqbot:c2c:openid|qqbot:group:openid> <文本> [--media <路径或URL>] [--account <id>]",
	"  mu qqbot pairing list                  待批准的私聊配对",
	"  mu qqbot pairing approve <配对码>       批准配对",
	"",
	"配置在 ~/.mu/agent/mu.json 的 channels.qqbot 下，说明见 docs/qqbot.md。",
].join("\n");

export interface ParsedArgs {
	command: string;
	positional: string[];
	flags: Record<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const [command = "help", ...rest] = argv;
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i] as string;
		if (arg.startsWith("--")) {
			const name = arg.slice(2);
			const next = rest[i + 1];
			if (next !== undefined && !next.startsWith("--") && name !== "use-env") {
				flags[name] = next;
				i++;
			} else {
				flags[name] = true;
			}
		} else {
			positional.push(arg);
		}
	}
	return { command, positional, flags };
}

function stringFlag(flags: ParsedArgs["flags"], name: string): string | undefined {
	const value = flags[name];
	return typeof value === "string" ? value : undefined;
}

/** 运行时共享部分：配置文件、脱敏日志、会话宿主 */
export function createRuntime(options: { console?: boolean } = {}): { runtime: QQBotRuntime; config: MuConfigFile } {
	const config = new MuConfigFile(muConfigPath());
	const redactor = new Redactor();
	const logger = createChannelLogger({
		file: path.join(getQQBotHome(), "logs", "qqbot.log"),
		level: (process.env.MU_QQBOT_LOG_LEVEL as LogLevel | undefined) ?? "info",
		console: options.console !== false,
		redactor,
		prefix: "[qqbot]",
	});
	const accounts = new Map<string, ResolvedQQBotAccount>();
	const getAccount = (accountId: string): ResolvedQQBotAccount => {
		let account = accounts.get(accountId);
		if (!account) {
			account = resolveQQBotAccount(config.read() as MuConfig, accountId);
			accounts.set(accountId, account);
		}
		return account;
	};
	const runtimeRef: { current?: QQBotRuntime } = {};
	const extensionPaths = (process.env.MU_QQBOT_EXTENSIONS ?? "").split(path.delimiter).filter(Boolean);
	const skillsDir = process.env.MU_QQBOT_SKILLS;
	const host = new QQBotHost({
		home: getQQBotHome(),
		agentDir: muAgentDir(),
		extensionPaths,
		skillPaths: skillsDir ? [skillsDir] : [],
		log: logger.child("host"),
		getAccount,
		createTools: (ref) => [
			createSendMediaTool(ref, getAccount),
			createPlatformTool(ref.accountId),
			createRemindTool(ref, () => runtimeRef.current?.reminders),
		],
		createSurface: (ref) =>
			createQQChatSurface({
				ref,
				getAccount: () => getAccount(ref.accountId),
				log: createPluginLogger({ prefix: `[${ref.accountId}]` }).child("ask"),
			}),
		defaultWorkspaceRoot: path.join(getQQBotHome(), "workspace"),
	});
	// STT 等非对话调用用 mu 自己的 provider 凭据（auth.json / 环境变量 / models.json），首次使用时加载
	let models: Promise<ModelRuntime> | undefined;
	const providerAuth = async (provider: string) => {
		models ??= ModelRuntime.create({
			authPath: path.join(muAgentDir(), "auth.json"),
			modelsPath: path.join(muAgentDir(), "models.json"),
			signal: AbortSignal.timeout(15_000),
		});
		const registry = await models.catch((error: unknown) => {
			models = undefined;
			throw error;
		});
		const auth = await registry.getAuth(provider);
		const apiKey = auth?.auth.apiKey;
		if (apiKey) redactor.add(apiKey);
		return { apiKey, baseUrl: auth?.auth.baseUrl ?? registry.getModels(provider)[0]?.baseUrl };
	};
	const runtime: QQBotRuntime = {
		version: process.env.MU_VERSION || "unknown",
		providerAuth,
		getConfig: () => config.read() as MuConfig,
		persistConfig: (mutator) => config.update((cfg) => mutator(cfg as MuConfig)),
		host,
		logger,
		redactor,
	};
	runtimeRef.current = runtime;
	runtimeAccounts.set(runtime, accounts);
	return { runtime, config };
}

/** 每个 runtime 的账户快照（start 在配置变更时就地更新它们） */
const runtimeAccounts = new WeakMap<QQBotRuntime, Map<string, ResolvedQQBotAccount>>();

function statusFile(): string {
	return path.join(getQQBotDataDir("data"), "status.json");
}

function readStatus(): Record<string, Record<string, unknown>> {
	try {
		return JSON.parse(readFileSync(statusFile(), "utf8")) as Record<string, Record<string, unknown>>;
	} catch {
		return {};
	}
}

/** 影响连接的字段变了才需要重连；其余配置就地生效 */
function needsRestart(before: ResolvedQQBotAccount, after: ResolvedQQBotAccount): boolean {
	return (
		before.appId !== after.appId ||
		before.clientSecret !== after.clientSecret ||
		before.enabled !== after.enabled ||
		before.markdownSupport !== after.markdownSupport ||
		(before.config.transport ?? "websocket") !== (after.config.transport ?? "websocket") ||
		JSON.stringify(before.config.webhook ?? {}) !== JSON.stringify(after.config.webhook ?? {}) ||
		JSON.stringify(before.config.rateLimit ?? null) !== JSON.stringify(after.config.rateLimit ?? null) ||
		before.processingTimeoutMs !== after.processingTimeoutMs
	);
}

export interface RunningQQBot {
	runtime: QQBotRuntime;
	/** 已启动的账户 id */
	accountIds(): string[];
	stop(): Promise<void>;
}

/**
 * 启动所有已启用账户（或 only 指定的一个）并监视配置变更；返回的 stop() 停止一切。
 * `mu qqbot start` 与测试共用。无可启动账户时抛错。
 */
export async function startQQBot(options: { only?: string; console?: boolean } = {}): Promise<RunningQQBot> {
	// QQ 会话的权限模式来自 channels.qqbot.permissions（默认 jev），不继承终端里 mu 的默认模式
	process.env.MU_PERMISSIONS ??= "jev";
	// QQ 用户读中文：mu 扩展（审批按钮、提示）的措辞随 MU_LANG；已设置时尊重用户的选择
	process.env.MU_LANG ??= "zh-CN";
	const { runtime, config } = createRuntime({ console: options.console });
	setQQBotRuntime(runtime);
	const log = runtime.logger;
	const accounts = runtimeAccounts.get(runtime) as Map<string, ResolvedQQBotAccount>;
	const only = options.only;

	const status = readStatus();
	const writeStatus = () => {
		try {
			writeFileSync(statusFile(), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
		} catch {
			/* 非关键 */
		}
	};

	const running = new Map<string, { abort: AbortController; done: Promise<void> }>();

	const launch = (account: ResolvedQQBotAccount) => {
		const abort = new AbortController();
		status[account.accountId] = {
			accountId: account.accountId,
			appId: account.appId,
			running: true,
			connected: false,
			pid: process.pid,
			startedAt: Date.now(),
		};
		writeStatus();
		const done = startAccount({
			account,
			abortSignal: abort.signal,
			cfg: runtime.getConfig(),
			getStatus: () => status[account.accountId] ?? {},
			setStatus: (next) => {
				status[account.accountId] = next;
				writeStatus();
			},
		})
			.catch((err) => {
				log.error(
					`[${account.accountId}] gateway stopped with error: ${err instanceof Error ? err.message : String(err)}`,
				);
				status[account.accountId] = {
					...status[account.accountId],
					lastError: err instanceof Error ? err.message : String(err),
				};
			})
			.finally(() => {
				status[account.accountId] = { ...status[account.accountId], running: false, connected: false };
				writeStatus();
			});
		running.set(account.accountId, { abort, done });
	};

	const stopAccount = async (accountId: string) => {
		const entry = running.get(accountId);
		if (!entry) return;
		running.delete(accountId);
		entry.abort.abort();
		await stopAccountGracefully({ accountId, log: createPluginLogger({ prefix: `[${accountId}]` }) });
		await runtime.host.closeAccount(accountId);
		await entry.done;
	};

	const eligible = (cfg: MuConfig): ResolvedQQBotAccount[] =>
		listQQBotAccountIds(cfg)
			.filter((id) => !only || id === only)
			.map((id) => resolveQQBotAccount(cfg, id))
			.filter((account) => {
				if (!account.enabled) {
					log.info(`[${account.accountId}] disabled, skipped`);
					return false;
				}
				if (!account.appId || !account.clientSecret) {
					log.warn(`[${account.accountId}] missing AppID or AppSecret, skipped (mu qqbot login)`);
					return false;
				}
				return true;
			});

	const initial = eligible(runtime.getConfig());
	if (initial.length === 0) {
		setQQBotRuntime(null);
		throw new Error(`no QQ Bot account to start${only ? ` (--account ${only})` : ""}; run \`mu qqbot login\` first`);
	}
	for (const account of initial) {
		accounts.set(account.accountId, account);
		launch(account);
	}

	// 配置热更新（原版 reload.configPrefixes: ['channels.qqbot']）
	let reloading: Promise<void> = Promise.resolve();
	const reload = async () => {
		let next: MuConfig;
		try {
			next = runtime.getConfig();
		} catch (err) {
			log.warn(`config not reloaded: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const wanted = new Map(eligible(next).map((account) => [account.accountId, account]));
		for (const accountId of [...running.keys()]) {
			if (!wanted.has(accountId)) {
				log.info(`[${accountId}] removed or disabled in config, stopping`);
				await stopAccount(accountId);
				accounts.delete(accountId);
			}
		}
		for (const [accountId, fresh] of wanted) {
			const current = accounts.get(accountId);
			if (!current || !running.has(accountId)) {
				accounts.set(accountId, fresh);
				launch(fresh);
			} else if (needsRestart(current, fresh)) {
				log.info(`[${accountId}] connection settings changed, restarting`);
				await stopAccount(accountId);
				accounts.set(accountId, fresh);
				launch(fresh);
			} else {
				// 就地更新：中间件、命令、会话宿主都持有同一个对象
				Object.assign(current, fresh);
			}
		}
	};
	const unwatch = config.watch(() => {
		reloading = reloading.then(reload);
	});

	// 定时提醒（原版由 OpenClaw cron 调度）：到点在隔离会话里写提醒语，再发到 QQ
	const reminderLog = createPluginLogger({ prefix: "[reminders]" });
	const reminders = new ReminderScheduler({
		file: path.join(getQQBotDataDir("data"), "reminders.json"),
		log: reminderLog,
		compose: (job) =>
			runIsolatedPrompt({
				cwd: path.join(getQQBotHome(), "workspace", safeSegment(job.accountId), "reminders"),
				agentDir: muAgentDir(),
				prompt: buildReminderPrompt(job.content),
				model: (accounts.get(job.accountId) ?? resolveQQBotAccount(runtime.getConfig(), job.accountId)).config
					.model,
				log: runtime.logger.child("reminders"),
			}),
		deliver: async (job, text) => {
			const account = accounts.get(job.accountId) ?? resolveQQBotAccount(runtime.getConfig(), job.accountId);
			if (!account.appId || !account.clientSecret) throw new Error(`account ${job.accountId} has no credentials`);
			const result = await sendChunkedText({ to: job.to, text, account });
			if (result.error) throw new Error(result.error);
		},
	});
	runtime.reminders = reminders;
	reminders.start();

	log.info(`started ${initial.length} account(s); logs in ${path.join(getQQBotHome(), "logs")}`);

	return {
		runtime,
		accountIds: () => [...running.keys()],
		stop: async () => {
			unwatch();
			await reminders.stop();
			await reloading;
			for (const accountId of [...running.keys()]) await stopAccount(accountId);
			await runtime.host.closeAll();
			flushAllRefIndexStores();
			setQQBotRuntime(null);
		},
	};
}

async function commandStart(args: ParsedArgs): Promise<number> {
	let bot: RunningQQBot;
	try {
		bot = await startQQBot({ only: stringFlag(args.flags, "account") });
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
	await new Promise<void>((resolve) => {
		const shutdown = () => {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
			resolve();
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});
	bot.runtime.logger.info("stopping");
	await bot.stop();
	return 0;
}

function commandStatus(): number {
	const config = new MuConfigFile(muConfigPath());
	let cfg: MuConfig;
	try {
		cfg = config.read() as MuConfig;
	} catch (err) {
		console.error(`无法读取 ${config.path}: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	const ids = listQQBotAccountIds(cfg);
	const status = existsSync(statusFile()) ? readStatus() : {};
	if (ids.length === 0) {
		console.log("尚未配置 QQ 机器人。运行 `mu qqbot login` 绑定。");
		return 0;
	}
	for (const id of ids) {
		const account = resolveQQBotAccount(cfg, id);
		const s = status[id] ?? {};
		const alive = typeof s.pid === "number" && isAlive(s.pid);
		console.log(
			[
				`${id}${account.name ? ` (${account.name})` : ""}`,
				`  AppID: ${account.appId || "-"}   AppSecret: ${account.clientSecret ? `已配置（来源 ${account.secretSource}）` : "未配置"}`,
				`  启用: ${account.enabled ? "是" : "否"}   传输: ${account.config.transport ?? "websocket"}   流式: ${account.config.streaming ? JSON.stringify(account.config.streaming) : "关"}`,
				`  运行: ${s.running && alive ? `是（pid ${s.pid}）` : "否"}   已连接: ${s.connected && alive ? "是" : "否"}${s.lastError ? `   最近错误: ${String(s.lastError)}` : ""}`,
			].join("\n"),
		);
	}
	return 0;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function commandLogout(args: ParsedArgs): Promise<number> {
	const { runtime } = createRuntime({ console: false });
	setQQBotRuntime(runtime);
	const cfg = runtime.getConfig();
	const accountId = stringFlag(args.flags, "account") ?? listQQBotAccountIds(cfg)[0] ?? "default";
	const result = await logoutAndClearCredentials({ accountId, cfg });
	console.log(
		result.cleared ? `已清除账户 ${accountId} 的 AppSecret。` : `账户 ${accountId} 的配置中没有 AppSecret。`,
	);
	if (result.envToken) console.log("注意：环境变量 QQBOT_CLIENT_SECRET 仍然设置着。");
	return 0;
}

function commandPairing(args: ParsedArgs): number {
	const [sub, code] = args.positional;
	const store = getPairingStore();
	if (sub === "list") {
		const requests = store.listRequests(stringFlag(args.flags, "account"));
		if (requests.length === 0) console.log("没有待批准的配对请求。");
		for (const r of requests) {
			console.log(`${r.code}  账户 ${r.accountId}  用户 ${r.id}  ${new Date(r.createdAt).toLocaleString()}`);
		}
		return 0;
	}
	if (sub === "approve" && code) {
		const result = store.approveCode(code, stringFlag(args.flags, "account"));
		if (!result) {
			console.error(`配对码 ${code} 无效或已过期（有效期 1 小时）。`);
			return 1;
		}
		console.log(`已批准账户 ${result.accountId} 的用户 ${result.id}。`);
		return 0;
	}
	console.error("用法: mu qqbot pairing list | approve <配对码>");
	return 1;
}

// ── login ──

export interface LoginOptions {
	/** 扫码轮询间隔（测试用） */
	pollIntervalMs?: number;
	out?: (line: string) => void;
	signal?: AbortSignal;
}

/**
 * `mu qqbot login`：扫码（默认）、--token AppID:AppSecret，或 --use-env。
 * 凭据写入 mu.json（0600），不在终端或日志中输出 AppSecret。
 */
export async function commandLogin(args: ParsedArgs, options: LoginOptions = {}): Promise<number> {
	const out = options.out ?? ((line: string) => console.log(line));
	const config = new MuConfigFile(muConfigPath());
	let cfg: MuConfig;
	try {
		cfg = config.read() as MuConfig;
	} catch (err) {
		console.error(`无法读取 ${config.path}: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	const accountFlag = stringFlag(args.flags, "account");

	const persist = async (credentials: BoundCredentials[]): Promise<string[]> => {
		let written: string[] = [];
		await config.update((current) => {
			const result = applyLoginCredentials(current as MuConfig, credentials, accountFlag);
			written = result.accountIds;
			return result.cfg;
		});
		return written;
	};

	if (args.flags.token !== undefined) {
		const parsed = parseChannelInput(stringFlag(args.flags, "token"));
		if (!parsed) {
			console.error("--token 需要 AppID:AppSecret（在 q.qq.com 机器人管理页查看）。");
			return 1;
		}
		const [key] = await persist([{ appId: parsed.appId, appSecret: parsed.clientSecret }]);
		out(`QQ 机器人已配置：账户 ${key}，AppID ${parsed.appId}。运行 \`mu qqbot start\` 启动。`);
		return 0;
	}

	if (args.flags["use-env"]) {
		const appId = process.env.QQBOT_APP_ID?.trim();
		if (!appId || !process.env.QQBOT_CLIENT_SECRET?.trim()) {
			console.error("--use-env 需要同时设置环境变量 QQBOT_APP_ID 与 QQBOT_CLIENT_SECRET。");
			return 1;
		}
		// 凭据留在环境变量中（只适用于 default 账户），配置里只写默认值
		await config.update((current) => {
			const next = applyAccountDefaults(current as MuConfig, "default");
			const qqbot = (next.channels?.qqbot ?? {}) as Record<string, unknown>;
			qqbot.enabled = true;
			qqbot.allowFrom ??= ["*"];
			return next;
		});
		out(`将使用环境变量中的凭据（AppID ${appId}），AppSecret 不写入配置。运行 \`mu qqbot start\` 启动。`);
		return 0;
	}

	const qqbotCfg = (cfg.channels?.qqbot ?? {}) as { clawType?: string };
	const abort = new AbortController();
	const onSignal = () => abort.abort(new Error("已取消"));
	process.once("SIGINT", onSignal);
	try {
		const credentials = await qrConnect({
			source: stringFlag(args.flags, "source") ?? (qqbotCfg.clawType?.trim() || "mu"),
			pollIntervalMs: options.pollIntervalMs,
			signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal,
			userAgent: `mu/${process.env.MU_VERSION || "unknown"} (qqbot)`,
			onQrReady: (url) => {
				out("请用手机 QQ 扫描二维码，创建并绑定一个 QQ 机器人：");
				qrcode.generate(url, { small: true }, (code) => out(code));
				out(`二维码无法显示时，在手机 QQ 中打开：${url}`);
			},
			onScanned: () => out("已扫码，请在手机上确认…"),
		});
		const keys = await persist(credentials);
		for (const [i, cred] of credentials.entries()) {
			out(`绑定成功：账户 ${keys[i]}，AppID ${cred.appId}${cred.userOpenid ? "（扫码者已加入 allowFrom）" : ""}。`);
		}
		out("运行 `mu qqbot start` 启动机器人。");
		return 0;
	} catch (err) {
		console.error(`绑定失败：${err instanceof Error ? err.message : String(err)}`);
		console.error("也可以在 q.qq.com 创建机器人后运行：mu qqbot login --token <AppID:AppSecret>");
		return 1;
	} finally {
		process.off("SIGINT", onSignal);
	}
}

// ── send ──

/** `mu qqbot send <目标> <文本> [--media <路径或URL>] [--account <id>]`：主动消息（不需要 start 在运行） */
export async function commandSend(args: ParsedArgs): Promise<number> {
	const [to, ...words] = args.positional;
	const text = words.join(" ");
	const media = stringFlag(args.flags, "media");
	if (!to || (!text && !media)) {
		console.error(
			"用法: mu qqbot send <qqbot:c2c:openid|qqbot:group:openid> <文本> [--media <路径或URL>] [--account <id>]",
		);
		return 1;
	}
	const target = to ? normalizeTarget(to) : undefined;
	if (!target) {
		console.error(`无法识别的目标：${to}（应为 qqbot:c2c:<openid> 或 qqbot:group:<openid>）`);
		return 1;
	}
	const { runtime } = createRuntime({ console: false });
	setQQBotRuntime(runtime);
	try {
		const cfg = runtime.getConfig();
		const account = resolveQQBotAccount(
			cfg,
			stringFlag(args.flags, "account") ?? listQQBotAccountIds(cfg)[0] ?? "default",
		);
		if (!account.appId || !account.clientSecret) {
			console.error(`账户 ${account.accountId} 未配置 AppID / AppSecret，先运行 mu qqbot login。`);
			return 1;
		}
		runtime.redactor.add(account.clientSecret);
		getOrCreateGateway(account);
		if (media) {
			const result = await sendMedia({
				to: target,
				source: media,
				text: text || undefined,
				accountId: account.accountId,
				// 路径由主机上的人给出，不是 AI 选的
				trustedLocalPath: true,
			});
			if (result.error) {
				console.error(`发送失败：${result.error}`);
				return 1;
			}
		} else {
			const result = await sendChunkedText({ to: target, text, account });
			if (result.error) {
				console.error(`发送失败：${result.error}`);
				return 1;
			}
		}
		console.log("已发送。");
		return 0;
	} finally {
		setQQBotRuntime(null);
	}
}

export async function main(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	switch (args.command) {
		case "start":
			return commandStart(args);
		case "status":
			return commandStatus();
		case "logout":
			return commandLogout(args);
		case "login":
			return commandLogin(args);
		case "send":
			return commandSend(args);
		case "pairing":
			return commandPairing(args);
		case "help":
		case "--help":
		case "-h":
			console.log(USAGE);
			return 0;
		default:
			console.error(`未知命令: ${args.command}\n\n${USAGE}`);
			return 1;
	}
}

function invokedDirectly(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	const self = new URL(import.meta.url).pathname;
	return path.resolve(entry) === path.resolve(self) || /qqbot[\\/]cli\.(ts|js)$/.test(entry);
}

if (invokedDirectly()) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		},
	);
}
