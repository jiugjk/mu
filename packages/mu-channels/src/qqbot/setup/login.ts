/**
 * 绑定凭据写入配置 — `mu qqbot login` 使用
 *
 * mu 适配：原版为 OpenClaw auth.login（qqbotLogin）与 gateway.loginWithQrStart / loginWithQrWait，
 * 扫码依赖 @tencent-connect/qqbot-connector。移植后扫码协议见 qr-connect.ts，交互与写入由 cli.ts 完成；
 * 这里保留原版的账户键规则与写入步骤：
 *   --account <id>  → 写入指定账户
 *   AppID:AppSecret → 同 appId 账户刷新，零账户写 default，否则以 appId 为新账户键
 *   扫码            → 同上，扫码者 openid 写入 allowFrom
 */
import { applyQQBotAccountConfig } from "../config.ts";
import type { MuConfig } from "../types.ts";
import { resolveAccountKey } from "./account-key.ts";
import { applyAccountDefaults } from "./finalize.ts";

/** 解析 AppID:AppSecret */
export function parseChannelInput(channelInput?: string | null): { appId: string; clientSecret: string } | null {
	if (!channelInput) return null;
	const parts = channelInput.trim().split(":");
	if (parts.length === 2 && parts[0] && parts[1]) {
		return { appId: parts[0], clientSecret: parts[1] };
	}
	return null;
}

export interface BoundCredentials {
	appId: string;
	appSecret: string;
	userOpenid?: string;
}

/** 把凭据写入配置（与原版 qqbotLogin 相同的步骤），返回新配置与每组凭据写入的账户键 */
export function applyLoginCredentials(
	cfg: MuConfig,
	credentials: readonly BoundCredentials[],
	accountId?: string | null,
): { cfg: MuConfig; accountIds: string[] } {
	// mu 修正：原先转成小写，而 start / logout / send 按原样匹配，大小写混合的账户名因此启动不了也登出不了
	const resolvedId = accountId ? accountId.trim() : null;
	let next = cfg;
	const accountIds: string[] = [];
	for (const cred of credentials) {
		const key = resolveAccountKey(next, cred.appId, resolvedId);
		next = applyQQBotAccountConfig(next, key, { appId: cred.appId, clientSecret: cred.appSecret });
		next = applyAccountDefaults(next, key, cred.userOpenid);
		accountIds.push(key);
	}
	return { cfg: next, accountIds };
}
