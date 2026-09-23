/**
 * Pairing API
 *
 * mu 适配：原版从 OpenClaw 安装目录动态加载 conversation-runtime 中的配对函数
 * （readChannelAllowFromStore / upsertChannelPairingRequest / buildPairingReply / approveChannelPairingCode），
 * 不可用时配对功能降级为不可用。移植后使用 mu 渠道宿主的通用配对存储（src/host/pairing-store.ts，
 * 规则与 OpenClaw 一致），存放在 ~/.mu/qqbot/data/pairing.json，接口保持不变。
 */
import * as path from "node:path";
import { PairingStore } from "../../host/pairing-store.ts";
import { getQQBotDataDir } from "../utils/platform.ts";

export interface PairingApi {
	readAllowFromStore: (params: { channel: string; accountId: string }) => Promise<string[]>;
	issueChallenge: (params: { channel: string; id: string; accountId: string }) => Promise<{ code: string }>;
	buildReply: (params: { code: string; channel: string }) => string;
	approveCode: (params: { channel: string; code: string; accountId?: string }) => Promise<{ id: string } | null>;
}

let _api: PairingApi | null = null;

/** 配对存储文件（~/.mu/qqbot/data/pairing.json） */
export function getPairingStore(): PairingStore {
	return new PairingStore(path.join(getQQBotDataDir("data"), "pairing.json"));
}

/** 获取 Pairing API */
export function getPairingApi(): PairingApi {
	if (_api) return _api;
	_api = {
		readAllowFromStore: async (params) => getPairingStore().readAllowFrom(params.accountId),
		issueChallenge: async (params) => ({
			code: getPairingStore().upsertRequest({ id: params.id, accountId: params.accountId }).code,
		}),
		// 对齐 OpenClaw buildPairingReply 的格式，批准命令换成 mu 的
		buildReply: (params) =>
			[
				"mu: access not configured.",
				"",
				"Pairing code:",
				"```",
				params.code,
				"```",
				"",
				"Ask the bot owner to approve with:",
				"```",
				`mu qqbot pairing approve ${params.code}`,
				"```",
			].join("\n"),
		approveCode: async (params) => getPairingStore().approveCode(params.code, params.accountId),
	};
	return _api;
}
