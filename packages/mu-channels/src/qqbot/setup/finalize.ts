/**
 * 绑定后的账户默认值
 *
 * mu 适配：原文件还包含 OpenClaw setup 向导（finalizeQQBotSetup：选择扫码 / 手动输入 / 跳过），
 * mu 中由 `mu qqbot login`（cli.ts）承担，这里只保留两者共用的默认值写入，逻辑不变。
 */
import { DEFAULT_ACCOUNT_ID } from "../config.ts";
import type { MuConfig } from "../types.ts";

/** 写入默认 streaming / dmPolicy / mediaMaxMb；扫码用户加入白名单 */
export function applyAccountDefaults(cfg: MuConfig, accountId: string, userOpenid?: string): MuConfig {
	const next = { ...cfg, channels: { ...cfg.channels } };
	const qqbot = { ...((next.channels?.qqbot as Record<string, unknown>) ?? {}) } as Record<string, unknown>;

	const defaults: Record<string, unknown> = { streaming: { mode: "partial" }, dmPolicy: "allowlist", mediaMaxMb: 200 };
	if (userOpenid) defaults.allowFrom = [userOpenid];

	if (accountId === DEFAULT_ACCOUNT_ID) {
		Object.assign(qqbot, defaults);
	} else {
		const accounts = { ...((qqbot.accounts as Record<string, unknown>) ?? {}) };
		accounts[accountId] = { ...((accounts[accountId] as Record<string, unknown>) ?? {}), ...defaults };
		qqbot.accounts = accounts;
	}

	next.channels = { ...next.channels, qqbot };
	return next;
}
