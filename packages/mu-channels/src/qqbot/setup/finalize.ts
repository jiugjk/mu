/**
 * 绑定后的账户默认值
 *
 * mu 适配：原文件还包含 OpenClaw setup 向导（finalizeQQBotSetup：选择扫码 / 手动输入 / 跳过），
 * mu 中由 `mu qqbot login`（cli.ts）承担，这里只保留两者共用的默认值写入，逻辑不变。
 */
import { DEFAULT_ACCOUNT_ID } from "../config.ts";
import type { MuConfig } from "../types.ts";

/**
 * 写入默认 streaming / dmPolicy / mediaMaxMb；扫码用户加入白名单。
 *
 * mu 修正：原版每次登录都覆盖这些键，刷新凭据会把 dmPolicy "disabled" 改回 allowlist、扫码会把 allowFrom
 * 换成扫码者一人。现在只补全未设置的键，扫码者追加进已有的 allowFrom。没有扫码者（--token / --use-env）
 * 且没有 allowFrom 时 dmPolicy 默认 pairing：陌生人拿到配对码，由主机上的人 `mu qqbot pairing approve` 批准。
 */
export function applyAccountDefaults(cfg: MuConfig, accountId: string, userOpenid?: string): MuConfig {
	const next = { ...cfg, channels: { ...cfg.channels } };
	const qqbot = { ...((next.channels?.qqbot as Record<string, unknown>) ?? {}) } as Record<string, unknown>;

	const fill = (target: Record<string, unknown>) => {
		const allowFrom = Array.isArray(target.allowFrom) ? target.allowFrom.map(String) : undefined;
		if (userOpenid)
			target.allowFrom = allowFrom?.includes(userOpenid) ? allowFrom : [...(allowFrom ?? []), userOpenid];
		target.streaming ??= { mode: "partial" };
		target.dmPolicy ??= userOpenid || allowFrom?.length ? "allowlist" : "pairing";
		target.mediaMaxMb ??= 200;
	};

	if (accountId === DEFAULT_ACCOUNT_ID) {
		fill(qqbot);
	} else {
		const accounts = { ...((qqbot.accounts as Record<string, unknown>) ?? {}) };
		const account = { ...((accounts[accountId] as Record<string, unknown>) ?? {}) };
		fill(account);
		accounts[accountId] = account;
		qqbot.accounts = accounts;
	}

	next.channels = { ...next.channels, qqbot };
	return next;
}
