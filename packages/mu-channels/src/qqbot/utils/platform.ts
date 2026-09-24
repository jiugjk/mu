/**
 * 数据目录
 *
 * mu 适配：原版数据在 ~/.openclaw/qqbot/…，媒体在 ~/.openclaw/media/qqbot/…（OpenClaw 媒体白名单之下）。
 * 移植后统一放在 mu 的 home 下：~/.mu/qqbot/…（MU_QQBOT_HOME 可改）。
 *
 * 原文件中的 ffmpeg / silk-wasm 探测与启动诊断（runDiagnostics 等）在原版中没有任何调用方，未移植；
 * 实际的格式转换由 SDK 的 protocol/utils/audio.ts 负责（有 ffmpeg 用 ffmpeg，否则用 silk-wasm）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { channelHome } from "../../host/paths.ts";

/** QQ 通道 home：~/.mu/qqbot */
export function getQQBotHome(): string {
	return channelHome("qqbot");
}

/**
 * 获取 ~/.mu/qqbot/<subPaths> 目录，并自动创建
 */
export function getQQBotDataDir(...subPaths: string[]): string {
	const dir = path.join(getQQBotHome(), ...subPaths);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/**
 * 获取 ~/.mu/qqbot/media/<subPaths> 目录，并自动创建
 *
 * 按会话隔离的下载目录见 host.ts 的 conversationDirs（media/<账户>/<c2c|group>/<openid>）。
 */
export function getQQBotMediaDir(...subPaths: string[]): string {
	return getQQBotDataDir("media", ...subPaths);
}
