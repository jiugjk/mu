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
import { MuConfigFile } from "../host/config-store.ts";
import { createChannelLogger, type LogLevel, Redactor } from "../host/logger.ts";
import { muAgentDir, muConfigPath } from "../host/paths.ts";
import { getPairingStore } from "./adapter/pairing.ts";
import { listQQBotAccountIds, resolveQQBotAccount } from "./config.ts";
import { createQQChatSurface } from "./features/chat-surface.ts";
import { flushAllRefIndexStores } from "./features/ref-index-store.ts";
import { logoutAndClearCredentials, startAccount, stopAccountGracefully } from "./gateway/lifecycle.ts";
import { QQBotHost } from "./host.ts";
import { type QQBotRuntime, setQQBotRuntime } from "./runtime.ts";
import { createPlatformTool } from "./tools/platform.ts";
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
	const extensionPaths = (process.env.MU_QQBOT_EXTENSIONS ?? "").split(path.delimiter).filter(Boolean);
	const skillsDir = process.env.MU_QQBOT_SKILLS;
	const host = new QQBotHost({
		home: getQQBotHome(),
		agentDir: muAgentDir(),
		extensionPaths,
		skillPaths: skillsDir ? [skillsDir] : [],
		log: logger.child("host"),
		getAccount,
		createTools: (ref) => [createSendMediaTool(ref), createPlatformTool(ref.accountId)],
		createSurface: (ref) =>
			createQQChatSurface({
				ref,
				getAccount: () => getAccount(ref.accountId),
				log: createPluginLogger({ prefix: `[${ref.accountId}]` }).child("ask"),
			}),
		defaultWorkspaceRoot: path.join(getQQBotHome(), "workspace"),
	});
	const runtime: QQBotRuntime = {
		version: process.env.MU_VERSION || "unknown",
		getConfig: () => config.read() as MuConfig,
		persistConfig: (mutator) => config.update((cfg) => mutator(cfg as MuConfig)),
		host,
		logger,
		redactor,
	};
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

	log.info(`started ${initial.length} account(s); logs in ${path.join(getQQBotHome(), "logs")}`);

	return {
		runtime,
		accountIds: () => [...running.keys()],
		stop: async () => {
			unwatch();
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

export async function main(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	switch (args.command) {
		case "start":
			return commandStart(args);
		case "status":
			return commandStatus();
		case "logout":
			return commandLogout(args);
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
