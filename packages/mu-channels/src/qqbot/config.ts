import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { muAgentDir } from "../host/paths.ts";
import type {
	GroupConfig,
	GroupPolicy,
	MuConfig,
	QQBotAccountConfig,
	ResolvedQQBotAccount,
	ToolPolicy,
} from "./types.ts";

// ============ mentionPatterns 解析 ============

/**
 * 解析 mentionPatterns（账户 → 通道 → 空数组）
 *
 * mu 适配：原版读取 OpenClaw 的 agents.list[agentId].groupChat.mentionPatterns /
 * messages.groupChat.mentionPatterns；mu 只有一个 agent，没有这两处配置，改为读取
 * channels.qqbot[.accounts.<id>].mentionPatterns。用途与原版一致：仅用于群配置面板回包。
 */
export function resolveMentionPatterns(cfg: MuConfig, accountId?: string): string[] {
	const account = resolveQQBotAccount(cfg, accountId);
	const patterns = account.config?.mentionPatterns;
	return Array.isArray(patterns) ? patterns.map((p) => String(p)) : [];
}

export const DEFAULT_ACCOUNT_ID = "default";

// 内联 evaluateMatchedGroupAccessForPolicy（openclaw dist 尚未导出，本地实现）

type MatchedGroupAccessReason = "allowed" | "disabled" | "missing_match_input" | "empty_allowlist" | "not_allowlisted";

interface MatchedGroupAccessDecision {
	allowed: boolean;
	groupPolicy: GroupPolicy;
	reason: MatchedGroupAccessReason;
}

function evaluateMatchedGroupAccessForPolicy(params: {
	groupPolicy: GroupPolicy;
	allowlistConfigured: boolean;
	allowlistMatched: boolean;
	requireMatchInput?: boolean;
	hasMatchInput?: boolean;
}): MatchedGroupAccessDecision {
	if (params.groupPolicy === "disabled") {
		return { allowed: false, groupPolicy: params.groupPolicy, reason: "disabled" };
	}
	if (params.groupPolicy === "allowlist") {
		if (params.requireMatchInput && !params.hasMatchInput) {
			return { allowed: false, groupPolicy: params.groupPolicy, reason: "missing_match_input" };
		}
		if (!params.allowlistConfigured) {
			return { allowed: false, groupPolicy: params.groupPolicy, reason: "empty_allowlist" };
		}
		if (!params.allowlistMatched) {
			return { allowed: false, groupPolicy: params.groupPolicy, reason: "not_allowlisted" };
		}
	}
	return { allowed: true, groupPolicy: params.groupPolicy, reason: "allowed" };
}

interface QQBotChannelConfig extends QQBotAccountConfig {
	/** HTTP/WebSocket User-Agent 追加后缀 */
	userAgentSuffix?: string;
	accounts?: Record<string, QQBotAccountConfig>;
}

// ============ 群消息策略 ============

const DEFAULT_GROUP_POLICY: GroupPolicy = "open";

/** 群历史缓存条数默认值 */
const DEFAULT_GROUP_HISTORY_LIMIT = 20;

/** 单条消息默认处理超时（0 = 不限制） */
const DEFAULT_PROCESSING_TIMEOUT_MS = 0;

const DEFAULT_GROUP_CONFIG: Omit<Required<GroupConfig>, "prompt"> = {
	requireMention: true,
	ignoreOtherMentions: false,
	toolPolicy: "restricted",
	name: "",
	historyLimit: DEFAULT_GROUP_HISTORY_LIMIT,
};

/** 默认群消息行为 PE（可通过配置覆盖） */
const DEFAULT_GROUP_PROMPT = [
	"若发送者为机器人，仅在对方明确@你提问或请求协助具体任务时，以简洁明了的内容回复，",
	"避免与其他机器人产生抢答或多轮无意义对话。",
	"在群聊中优先让人类用户的消息得到响应，机器人之间保持协作而非竞争，确保对话有序不刷屏。",
].join("");

/** 解析群消息策略 */
export function resolveGroupPolicy(cfg: MuConfig, accountId?: string): GroupPolicy {
	const account = resolveQQBotAccount(cfg, accountId);
	return account.config?.groupPolicy ?? DEFAULT_GROUP_POLICY;
}

/** 解析群白名单（统一转大写） */
export function resolveGroupAllowFrom(cfg: MuConfig, accountId?: string): string[] {
	const account = resolveQQBotAccount(cfg, accountId);
	return (account.config?.groupAllowFrom ?? []).map((id) => String(id).trim().toUpperCase());
}

/** 检查指定群是否被允许（使用标准策略引擎） */
export function isGroupAllowed(cfg: MuConfig, groupOpenid: string, accountId?: string): boolean {
	const account = resolveQQBotAccount(cfg, accountId);
	const policy = account.config?.groupPolicy ?? DEFAULT_GROUP_POLICY;
	const allowList = (account.config?.groupAllowFrom ?? []).map((id) => String(id).trim().toUpperCase());
	const allowlistConfigured = allowList.length > 0;
	const allowlistMatched = allowList.some((id) => id === "*" || id === groupOpenid.toUpperCase());

	return evaluateMatchedGroupAccessForPolicy({
		groupPolicy: policy,
		allowlistConfigured,
		allowlistMatched,
	}).allowed;
}

export type ResolvedGroupConfig = Required<GroupConfig>;

export function resolveGroupConfigFromAccount(account: ResolvedQQBotAccount, groupOpenid: string): ResolvedGroupConfig {
	const groups = account.config?.groups ?? {};
	const wildcardCfg = groups["*"] ?? {};
	const specificCfg = groups[groupOpenid] ?? {};
	const accountDefaultRequireMention = account.config?.defaultRequireMention ?? DEFAULT_GROUP_CONFIG.requireMention;

	return {
		requireMention: specificCfg.requireMention ?? wildcardCfg.requireMention ?? accountDefaultRequireMention,
		ignoreOtherMentions:
			specificCfg.ignoreOtherMentions ?? wildcardCfg.ignoreOtherMentions ?? DEFAULT_GROUP_CONFIG.ignoreOtherMentions,
		toolPolicy: specificCfg.toolPolicy ?? wildcardCfg.toolPolicy ?? DEFAULT_GROUP_CONFIG.toolPolicy,
		name: specificCfg.name ?? wildcardCfg.name ?? DEFAULT_GROUP_CONFIG.name,
		prompt: specificCfg.prompt ?? wildcardCfg.prompt ?? DEFAULT_GROUP_PROMPT,
		historyLimit: specificCfg.historyLimit ?? wildcardCfg.historyLimit ?? DEFAULT_GROUP_CONFIG.historyLimit,
	};
}

export function resolveGroupConfig(cfg: MuConfig, groupOpenid: string, accountId?: string): ResolvedGroupConfig {
	return resolveGroupConfigFromAccount(resolveQQBotAccount(cfg, accountId), groupOpenid);
}

/** 解析群历史消息缓存条数 */
export function resolveHistoryLimit(cfg: MuConfig, groupOpenid: string, accountId?: string): number {
	return Math.max(0, resolveGroupConfig(cfg, groupOpenid, accountId).historyLimit);
}

/** 解析群行为 PE（具体群 > "*" > 默认值） */
export function resolveGroupPrompt(cfg: MuConfig, groupOpenid: string, accountId?: string): string {
	return resolveGroupConfig(cfg, groupOpenid, accountId).prompt;
}

/** 解析群是否需要 @机器人才响应 */
export function resolveRequireMention(cfg: MuConfig, groupOpenid: string, accountId?: string): boolean {
	return resolveGroupConfig(cfg, groupOpenid, accountId).requireMention;
}

/** 解析群是否忽略 @了其他人（非 bot）的消息 */
export function resolveIgnoreOtherMentions(cfg: MuConfig, groupOpenid: string, accountId?: string): boolean {
	return resolveGroupConfig(cfg, groupOpenid, accountId).ignoreOtherMentions;
}

/** 解析群工具策略 */
export function resolveToolPolicy(cfg: MuConfig, groupOpenid: string, accountId?: string): ToolPolicy {
	return resolveGroupConfig(cfg, groupOpenid, accountId).toolPolicy;
}

/** 解析群名称（优先配置，fallback 为 openid 前 8 位） */
export function resolveGroupName(cfg: MuConfig, groupOpenid: string, accountId?: string): string {
	const name = resolveGroupConfig(cfg, groupOpenid, accountId).name;
	return name || groupOpenid.slice(0, 8);
}

/**
 * 解析 User-Agent 追加后缀（仅通道级：channels.qqbot.userAgentSuffix）
 */
export function resolveUserAgentSuffix(cfg: MuConfig): string {
	const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
	return qqbot?.userAgentSuffix ? String(qqbot.userAgentSuffix).trim() : "";
}

function normalizeAppId(raw: unknown): string {
	if (raw === null || raw === undefined) return "";
	return String(raw).trim();
}

/**
 * 列出所有 QQBot 账户 ID
 */
export function listQQBotAccountIds(cfg: MuConfig): string[] {
	const ids = new Set<string>();
	const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

	// mu 修正：只在环境变量里有凭据的 default 账户（`mu qqbot login --use-env`）也要列出，否则 start 找不到它
	if (qqbot?.appId || process.env.QQBOT_APP_ID?.trim()) {
		ids.add(DEFAULT_ACCOUNT_ID);
	}

	if (qqbot?.accounts) {
		for (const accountId of Object.keys(qqbot.accounts)) {
			if (qqbot.accounts[accountId]?.appId) {
				ids.add(accountId);
			}
		}
	}

	return Array.from(ids);
}

/**
 * 获取默认账户 ID
 */
export function resolveDefaultQQBotAccountId(cfg: MuConfig): string {
	const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
	// 如果有默认账户配置，返回 default
	if (qqbot?.appId) {
		return DEFAULT_ACCOUNT_ID;
	}
	// 否则返回第一个配置的账户
	if (qqbot?.accounts) {
		const ids = Object.keys(qqbot.accounts);
		if (ids.length > 0) {
			return ids[0];
		}
	}
	return DEFAULT_ACCOUNT_ID;
}

/**
 * 解析单条消息处理超时时间（ms）。
 * 优先级：账户配置 > 环境变量 MU_QQBOT_PROCESSING_TIMEOUT_MS（原 OPENCLAW_PROCESSING_TIMEOUT_MS）> 默认
 * 返回 0 表示不限制超时。
 */
export function resolveProcessingTimeoutMs(accountConfig?: QQBotAccountConfig): number {
	if (accountConfig?.processingTimeoutMs !== undefined) {
		return accountConfig.processingTimeoutMs;
	}
	const env = process.env.MU_QQBOT_PROCESSING_TIMEOUT_MS;
	if (env) {
		const v = Number(env);
		if (!Number.isNaN(v) && v >= 0) return v;
	}
	return DEFAULT_PROCESSING_TIMEOUT_MS;
}

/**
 * 解析 QQBot 账户配置
 */
export function resolveQQBotAccount(cfg: MuConfig, accountId?: string | null): ResolvedQQBotAccount {
	const resolvedAccountId = accountId ?? resolveDefaultQQBotAccountId(cfg);
	const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

	// 基础配置
	let accountConfig: QQBotAccountConfig = {};
	let appId = "";
	let clientSecret = "";
	let secretSource: "config" | "file" | "env" | "none" = "none";
	let secretError: string | undefined;

	if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
		// 默认账户从顶层读取（展开所有字段，避免遗漏新增配置项）
		const { accounts: _accounts, ...topLevelConfig } = qqbot ?? ({} as QQBotChannelConfig);
		accountConfig = {
			...topLevelConfig,
			markdownSupport: qqbot?.markdownSupport ?? true,
		};
		appId = normalizeAppId(qqbot?.appId);
	} else {
		// 命名账户从 accounts 读取。mu 修正：原版不继承顶层配置，未写 allowFrom 的命名账户解析为 []（= 所有人），
		// 文档示例（顶层 allowFrom + 只有 appId 的 accounts.work）因此对所有人开放。现在顶层的访问与行为配置
		// 作为默认值，账户自己的键覆盖它们；凭据、名称不继承。
		const account = qqbot?.accounts?.[resolvedAccountId];
		const {
			accounts: _accounts,
			appId: _appId,
			clientSecret: _clientSecret,
			clientSecretFile: _clientSecretFile,
			name: _name,
			...inherited
		} = qqbot ?? ({} as QQBotChannelConfig);
		accountConfig = account ? { ...inherited, ...account } : {};
		appId = normalizeAppId(account?.appId);
	}

	// 解析 clientSecret
	if (accountConfig.clientSecret) {
		clientSecret = accountConfig.clientSecret;
		secretSource = "config";
	} else if (accountConfig.clientSecretFile) {
		// mu 修正：原版只标记 secretSource="file"，从未真正读取文件。`~` 展开；相对路径相对 mu.json 所在目录
		const file = accountConfig.clientSecretFile.trim();
		const expanded = file === "~" || file.startsWith("~/") ? join(homedir(), file.slice(1)) : file;
		try {
			clientSecret = readFileSync(resolve(muAgentDir(), expanded), "utf8").trim();
		} catch (err) {
			clientSecret = "";
			secretError = `clientSecretFile ${file}: ${err instanceof Error ? err.message : String(err)}`;
		}
		secretSource = "file";
	} else if (process.env.QQBOT_CLIENT_SECRET && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
		clientSecret = process.env.QQBOT_CLIENT_SECRET;
		secretSource = "env";
	}

	// AppId 也可以从环境变量读取
	if (!appId && process.env.QQBOT_APP_ID && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
		appId = normalizeAppId(process.env.QQBOT_APP_ID);
	}

	return {
		accountId: resolvedAccountId,
		name: accountConfig.name,
		enabled: accountConfig.enabled !== false,
		appId,
		clientSecret,
		secretSource,
		...(secretError ? { secretError } : {}),
		systemPrompt: accountConfig.systemPrompt,
		markdownSupport: accountConfig.markdownSupport !== false,
		userAgentSuffix: resolveUserAgentSuffix(cfg),
		processingTimeoutMs: resolveProcessingTimeoutMs(accountConfig),
		config: normalizeAccountConfig(accountConfig),
	};
}

/** 兼容旧版 streaming: boolean 格式 → { mode: "partial" | "off" }，对齐框架 schema */
function normalizeAccountConfig(raw: QQBotAccountConfig): QQBotAccountConfig {
	if (typeof (raw as any).streaming === "boolean") {
		const { streaming, ...rest } = raw as any;
		return { ...rest, streaming: { mode: streaming ? "partial" : "off" } };
	}
	return raw;
}

/**
 * 应用账户配置
 */
export function applyQQBotAccountConfig(
	cfg: MuConfig,
	accountId: string,
	input: { appId?: string; clientSecret?: string; clientSecretFile?: string; name?: string },
): MuConfig {
	const next = { ...cfg };

	if (accountId === DEFAULT_ACCOUNT_ID) {
		// mu 修正：原版在没有 allowFrom 时写入 ["*"]，任何 QQ 用户都能私聊并自己批准自己的命令。
		// 现在不写 allowFrom；未设置 dmPolicy 时由 applyAccountDefaults 设为 pairing（陌生人需配对）。
		next.channels = {
			...next.channels,
			qqbot: {
				...((next.channels?.qqbot as Record<string, unknown>) || {}),
				enabled: true,
				...(input.appId ? { appId: input.appId } : {}),
				...(input.clientSecret
					? { clientSecret: input.clientSecret }
					: input.clientSecretFile
						? { clientSecretFile: input.clientSecretFile }
						: {}),
				...(input.name ? { name: input.name } : {}),
			},
		};
	} else {
		next.channels = {
			...next.channels,
			qqbot: {
				...((next.channels?.qqbot as Record<string, unknown>) || {}),
				enabled: true,
				accounts: {
					...((next.channels?.qqbot as QQBotChannelConfig)?.accounts || {}),
					[accountId]: {
						...((next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId] || {}),
						enabled: true,
						...(input.appId ? { appId: input.appId } : {}),
						...(input.clientSecret
							? { clientSecret: input.clientSecret }
							: input.clientSecretFile
								? { clientSecretFile: input.clientSecretFile }
								: {}),
						...(input.name ? { name: input.name } : {}),
					},
				},
			},
		};
	}

	return next;
}
