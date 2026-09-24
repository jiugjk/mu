import type { SlashCommand, SlashCommandHandlerContext } from "@tencent-connect/qqbot-nodejs";
import { isExplicitAdmin } from "../host.ts";
import type { QQBotRuntime } from "../runtime.ts";
import type { MuPermissionMode, ResolvedQQBotAccount } from "../types.ts";
import { checkAdminCommandAuth, updateAccountConfig } from "./config-util.ts";

/**
 * mu 适配：原版修改 OpenClaw 的 tools.exec.security / tools.exec.ask；mu 用权限模式表达同样的意思：
 *   on     → jev（Jev 审批：白名单外的操作由 Jev 判断，拿不准就发按钮问你）   ≈ allowlist + on-miss
 *   always → ask（最小权限：读以外的操作每次都问）                               ≈ allowlist + always
 *   off    → full（完全访问：不问直接执行）                                     ≈ full + off
 *   reset  → 删除 channels.qqbot.permissions，回到 QQ 会话默认（jev）
 * 设置写入账户配置（新会话生效），并立即应用到已打开的 QQ 会话（/permissions <mode> --here）。
 *
 * 安全要求（mu 移植新增）：整个 /bot-approve 只允许 allowFrom 中明确列出的用户执行（"*" 不算，见 checkAdminCommandAuth）；
 * off 另外只能在私聊中执行，且需二次确认。
 */
const PRESETS: Record<"on" | "off" | "always", { mode: MuPermissionMode; desc: string }> = {
	on: { mode: "jev", desc: "开启审批（Jev 审批模式）" },
	off: { mode: "full", desc: "关闭审批（完全访问）" },
	always: { mode: "ask", desc: "严格模式（每次都审批）" },
};

const MODE_TEXT: Record<MuPermissionMode, string> = {
	full: "🟢 完全访问（full）：所有操作直接执行，不弹审批",
	jev: "🟡 Jev 审批（jev）：项目内读写直接执行，其余由 Jev 判断，拿不准时发按钮请你审批",
	ask: "🔴 最小权限（ask）：除读取外的每个操作都需要你审批",
};

/** off 的二次确认有效期 */
const CONFIRM_WINDOW_MS = 2 * 60_000;
const pendingOffConfirm = new Map<string, number>();

/** 格式化当前审批状态 */
function formatStatus(mode: MuPermissionMode): string {
	return ["🔐 当前审批配置", "", MODE_TEXT[mode]].join("\n");
}

/** 操作指引菜单 */
function menuText(): string {
	return [
		"🔐 命令执行审批配置",
		"",
		'<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（Jev 审批模式）',
		'<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批',
		'<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式',
		'<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认',
		'<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置',
	].join("\n");
}

function currentMode(account: ResolvedQQBotAccount): MuPermissionMode {
	return account.config.permissions ?? "jev";
}

async function applyMode(
	account: ResolvedQQBotAccount,
	getRuntime: () => QQBotRuntime,
	mode: MuPermissionMode | undefined,
): Promise<string | null> {
	const error = await updateAccountConfig(account, getRuntime, (acfg) => {
		if (mode) acfg.permissions = mode;
		else delete acfg.permissions;
	});
	if (error) return error;
	if (mode) account.config.permissions = mode;
	else delete account.config.permissions;
	await getRuntime().host.applyPermissionMode(account.accountId, mode ?? "jev");
	return null;
}

function offAllowed(account: ResolvedQQBotAccount, ctx: SlashCommandHandlerContext): string | null {
	if (ctx.message.kind !== "c2c") return "⚠️ /bot-approve off 只能在私聊中执行。";
	if (!isExplicitAdmin(account, ctx.message.senderId)) {
		return '⚠️ /bot-approve off 只允许 allowFrom 中明确列出的用户执行（"*" 不算）。';
	}
	return null;
}

/** /bot-approve — 管理命令执行审批配置 */
export function botApprove(account: ResolvedQQBotAccount, getRuntime: () => QQBotRuntime): SlashCommand {
	return {
		name: "bot-approve",
		description: "管理命令执行审批配置",
		scope: "c2c",
		authorized: checkAdminCommandAuth,
		usage: [
			"/bot-approve            查看操作指引",
			"/bot-approve on         开启审批（Jev 审批模式，推荐）",
			"/bot-approve off        关闭审批，命令直接执行（需二次确认，仅 allowFrom 用户）",
			"/bot-approve always     始终审批，每次执行都需审批",
			"/bot-approve reset      恢复默认（Jev 审批）",
			"/bot-approve status     查看当前审批配置",
		].join("\n"),
		handler: async (ctx) => {
			const raw = (Array.isArray(ctx.command.args) ? ctx.command.args.join(" ") : String(ctx.command.args ?? ""))
				.trim()
				.toLowerCase();
			const words = raw.split(/\s+/).filter(Boolean);
			const arg = words[0] ?? "";

			if (!arg) {
				return menuText();
			}

			if (arg === "status") {
				return [
					formatStatus(currentMode(account)),
					"",
					'<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批',
					'<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批',
					'<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式',
					'<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认',
				].join("\n");
			}

			if (arg === "off") {
				const refused = offAllowed(account, ctx);
				if (refused) return refused;
				const key = `${account.accountId}:${ctx.message.senderId}`;
				const confirming = words.includes("--confirm");
				const askedAt = pendingOffConfirm.get(key);
				if (!confirming || askedAt === undefined || Date.now() - askedAt > CONFIRM_WINDOW_MS) {
					pendingOffConfirm.set(key, Date.now());
					return [
						"⚠️ 即将关闭审批：之后 AI 在这台主机上执行命令、改写文件都不再询问任何人。",
						"",
						"确认请在 2 分钟内发送：",
						'‼️ <qqbot-cmd-enter text="/bot-approve off --confirm" />',
					].join("\n");
				}
				pendingOffConfirm.delete(key);
				const error = await applyMode(account, getRuntime, "full");
				if (error) return error;
				return ["✅ 审批已关闭", "", MODE_TEXT.full, "", "⚠️ 所有命令将直接执行，不会弹出审批确认。"].join("\n");
			}

			if (arg === "on" || arg === "always") {
				const preset = PRESETS[arg];
				const error = await applyMode(account, getRuntime, preset.mode);
				if (error) return error;
				if (arg === "on") {
					return ["✅ 审批已开启", "", MODE_TEXT.jev].join("\n");
				}
				return ["✅ 已切换为严格审批模式", "", MODE_TEXT.ask, "", "每个操作都会弹出审批按钮，需手动确认。"].join(
					"\n",
				);
			}

			if (arg === "reset") {
				const error = await applyMode(account, getRuntime, undefined);
				if (error) return error;
				return [
					"✅ 审批配置已重置",
					"",
					"已移除 channels.qqbot.permissions，QQ 会话使用默认的 Jev 审批模式。",
					"",
					MODE_TEXT.jev,
				].join("\n");
			}

			return [`❌ 未知参数: ${arg}`, "", "可用选项: on | off | always | reset | status"].join("\n");
		},
	};
}
