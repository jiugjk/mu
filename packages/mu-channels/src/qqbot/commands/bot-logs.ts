import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SlashCommand } from "@tencent-connect/qqbot-nodejs";
import type { QQBotRuntime } from "../runtime.ts";
import { getQQBotDataDir, getQQBotMediaDir } from "../utils/platform.ts";
import { checkCommandAuth } from "./config-util.ts";

const MAX_LINES_PER_FILE = 1000;
const MAX_FILES = 4;

interface LogFileEntry {
	filePath: string;
	sourceDir: string;
	mtime: number;
}

// ── 候选目录 ──

/**
 * mu 适配：原版在 OpenClaw 的各种状态目录、/var/log、/tmp、PM2 等位置按关键词搜索 openclaw/gateway 日志；
 * 移植后 QQ 通道的日志由 `mu qqbot start` 写在 ~/.mu/qqbot/logs/ 下，只从那里收集。
 */
function collectCandidateLogDirs(): string[] {
	return [getQQBotDataDir("logs")];
}

// ── 日志文件收集 ──

function collectRecentLogFiles(logDirs: string[]): LogFileEntry[] {
	const candidates: LogFileEntry[] = [];
	const dedupe = new Set<string>();

	const pushFile = (filePath: string, sourceDir: string) => {
		const normalized = path.resolve(filePath);
		if (dedupe.has(normalized)) return;
		try {
			const stat = fs.statSync(normalized);
			if (!stat.isFile() || stat.size === 0) return;
			dedupe.add(normalized);
			candidates.push({ filePath: normalized, sourceDir, mtime: stat.mtimeMs });
		} catch {
			/* skip */
		}
	};

	for (const dir of logDirs) {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				if (!/\.(log|txt)$/i.test(entry.name)) continue;
				pushFile(path.join(dir, entry.name), dir);
			}
		} catch {
			/* skip */
		}
	}

	return candidates.sort((a, b) => b.mtime - a.mtime);
}

// ── 命令 ──

/** /bot-logs — 导出本地日志文件 */
export function botLogs(_getRuntime: () => QQBotRuntime): SlashCommand {
	return {
		name: "bot-logs",
		description: "导出本地日志文件",
		scope: "c2c",
		authorized: checkCommandAuth,
		usage: [
			"/bot-logs",
			"",
			`导出最近的 mu QQ 通道日志文件（最多 ${MAX_FILES} 个）。`,
			`每个文件最多保留最后 ${MAX_LINES_PER_FILE} 行，以文件形式返回。`,
		].join("\n"),
		handler: async (ctx) => {
			const logDirs = collectCandidateLogDirs();
			const recentFiles = collectRecentLogFiles(logDirs).slice(0, MAX_FILES);

			if (recentFiles.length === 0) {
				const existingDirs = logDirs.filter((d) => {
					try {
						return fs.existsSync(d);
					} catch {
						return false;
					}
				});
				const searched =
					existingDirs.length > 0
						? existingDirs.map((d) => `  • ${d}`).join("\n")
						: logDirs.map((d) => `  • ${d}`).join("\n");
				return ["⚠️ 未找到日志文件", "", "已搜索以下路径：", searched].join("\n");
			}

			const lines: string[] = [];
			let totalIncluded = 0;
			let totalOriginal = 0;
			let truncatedCount = 0;

			for (const logFile of recentFiles) {
				try {
					const content = fs.readFileSync(logFile.filePath, "utf8");
					const allLines = content.split("\n");
					const tail = allLines.slice(-MAX_LINES_PER_FILE);
					if (tail.length > 0) {
						const fileName = path.basename(logFile.filePath);
						lines.push(`\n== ${fileName} (last ${tail.length}/${allLines.length}) ==`);
						lines.push(...tail);
						totalIncluded += tail.length;
						totalOriginal += allLines.length;
						if (allLines.length > MAX_LINES_PER_FILE) truncatedCount++;
					}
				} catch {
					/* skip */
				}
			}

			if (lines.length === 0) {
				return "⚠️ 找到日志文件但读取失败";
			}

			const tmpDir = getQQBotMediaDir("exports");
			if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const suffix = crypto.randomBytes(4).toString("hex");
			const tmpFile = path.join(tmpDir, `bot-logs-${timestamp}-${suffix}.txt`);
			fs.writeFileSync(tmpFile, lines.join("\n"), "utf8");

			let summary = `${recentFiles.length} 个日志文件，共 ${totalIncluded} 行`;
			if (truncatedCount > 0) summary += `（${truncatedCount} 个截断，原始 ${totalOriginal} 行）`;

			try {
				const senderId = ctx.message.senderId;
				if (senderId) {
					await ctx.bot.sendFile(
						{ scope: "c2c", targetId: senderId, msgId: ctx.message.messageId },
						{ localPath: tmpFile },
						{ fileName: `bot-logs-${timestamp}-${suffix}.txt` },
					);
				}
			} catch (err) {
				return `📋 ${summary}\n⚠️ 文件发送失败：${err instanceof Error ? err.message : err}\n📎 ${tmpFile}`;
			}

			return `📋 ${summary}`;
		},
	};
}
