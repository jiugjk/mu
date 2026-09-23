/**
 * Gateway 生命周期管理
 *
 * 封装 startAccount / stopAccount / logoutAccount 的业务逻辑：
 * - QQBotGateway 实例创建与注册
 * - Features 初始化（update-checker）
 * - 登出时凭证清除
 *
 * mu 适配：
 * - 原版的「凭证暂存与恢复」（credential-backup）未移植（Q7a）：它为 OpenClaw 热升级丢配置而设，
 *   会在磁盘上多留一份明文 AppSecret；mu 没有该场景。
 * - 原版在 gateway ready 后启动审批处理器（连接 OpenClaw 网关）；mu 的审批经由会话的 ctx.ui，
 *   由会话宿主在打开会话时接好（见 features/chat-surface.ts），这里无需再启动。
 * - 原版的 ctx.setStatus / getStatus 由框架提供；移植后由 `mu qqbot start` 传入，写入 status.json。
 */

import { getAdapters } from "../adapter/resolve.ts";
import { DEFAULT_ACCOUNT_ID, resolveQQBotAccount } from "../config.ts";
import { triggerUpdateCheck } from "../features/update-checker.ts";
import { getGateway, registerGateway, unregisterGateway } from "../outbound/outbound-service.ts";
import { getQQBotRuntime } from "../runtime.ts";
import type { MuConfig, ResolvedQQBotAccount } from "../types.ts";
import type { PluginLogger } from "../utils/plugin-logger.ts";
import { createPluginLogger } from "../utils/plugin-logger.ts";
import { QQBotGateway } from "./qqbot-gateway.ts";

export interface StartAccountContext {
	account: ResolvedQQBotAccount;
	abortSignal?: AbortSignal;
	cfg: MuConfig;
	/** 基础 logger（无 child 方法）。内部会自动包装为 PluginLogger。 */
	log?: {
		info: (msg: string) => void;
		warn: (msg: string) => void;
		error: (msg: string) => void;
		debug: (msg: string) => void;
	};
	getStatus: () => Record<string, unknown>;
	setStatus: (s: Record<string, unknown>) => void;
}

/**
 * 启动账户（原 startAccountWithCredentialRecovery；凭证恢复部分未移植）
 */
export async function startAccount(ctx: StartAccountContext): Promise<void> {
	const { account, abortSignal } = ctx;
	const log: PluginLogger = createPluginLogger({
		prefix: `[${account.accountId}]`,
		...(ctx.log?.info ? { output: ctx.log as PluginLogger } : {}),
	});
	const runtime = getQQBotRuntime();
	runtime.redactor.add(account.clientSecret);

	// 创建 gateway 实例并注册
	const gw = new QQBotGateway(account, runtime, log);
	registerGateway(account.accountId, gw);

	await gw.start(
		{
			onReady: () => {
				ctx.setStatus({
					...ctx.getStatus(),
					running: true,
					connected: true,
					lastConnectedAt: Date.now(),
				});

				// ── Features 初始化（gateway ready 后触发）──
				triggerUpdateCheck(log);
			},
			onError: (error) => {
				log?.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
				ctx.setStatus({ ...ctx.getStatus(), lastError: error.message });
			},
		},
		abortSignal,
	);
}

/**
 * 停止账户 — 主动调用，与 abort 信号双保险。
 *
 * 实现策略：
 *   1. 主动调用 bot.stop() — 比 abort 信号更立刻、不依赖事件循环时机
 *   2. 注销 gateway
 *   3. 立即返回；剩余资源（typing keepalive 定时器等）由 abort 信号触发收尾
 */
export async function stopAccountGracefully(params: { accountId: string; log?: PluginLogger }): Promise<void> {
	const { accountId, log } = params;
	const gw = getGateway(accountId);

	if (gw) {
		try {
			await gw.stop();
			log?.info(`[qqbot:${accountId}] gateway stopped`);
		} catch (err) {
			log?.error(`[qqbot:${accountId}] gateway stop error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	unregisterGateway(accountId);
}

/**
 * 登出账户（清除凭证）
 */
export async function logoutAndClearCredentials(params: {
	accountId: string;
	cfg: MuConfig;
}): Promise<{ ok: boolean; cleared: boolean; envToken: boolean; loggedOut: boolean }> {
	const { accountId, cfg } = params;
	unregisterGateway(accountId);

	const nextCfg = structuredClone(cfg) as MuConfig;
	const nextQQBot = nextCfg.channels?.qqbot as Record<string, unknown> | undefined;
	let cleared = false;
	let changed = false;

	if (nextQQBot) {
		const qqbot = nextQQBot;
		if (accountId === DEFAULT_ACCOUNT_ID && qqbot.clientSecret) {
			delete qqbot.clientSecret;
			cleared = true;
			changed = true;
		}
		const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
		if (accounts && accountId in accounts) {
			const entry = accounts[accountId];
			if (entry && "clientSecret" in entry) {
				delete entry.clientSecret;
				cleared = true;
				changed = true;
			}
			if (entry && Object.keys(entry).length === 0) {
				delete accounts[accountId];
				changed = true;
			}
		}
	}

	if (changed) {
		const adapters = getAdapters(getQQBotRuntime());
		if (adapters.persistConfig) {
			await adapters.persistConfig(() => nextCfg);
		}
	}

	const resolved = resolveQQBotAccount(changed ? nextCfg : cfg, accountId);
	const loggedOut = resolved.secretSource === "none";
	const envToken = Boolean(process.env.QQBOT_CLIENT_SECRET);
	return { ok: true, cleared, envToken, loggedOut };
}
