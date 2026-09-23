/**
 * qqbot_remind — 定时提醒
 *
 * mu 适配：原版工具只返回 cronParams，要求 AI 再调用 OpenClaw 的 cron 工具完成注册（两步）。
 * mu 没有 cron 工具，改为直接交给提醒调度器（features/reminders.ts，持久化，重启后继续）一步完成；
 * 参数、时间格式（相对时间 / cron 表达式）、30 秒下限、默认时区与提醒 prompt 与原版一致。
 * 偏离：list / remove 只作用于当前会话（原版 cron list 列出全部任务），避免群里看到或删掉别人的私聊提醒。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ReminderJob, ReminderScheduler } from "../features/reminders.ts";
import { type ConversationRef, conversationTarget } from "../host.ts";
import { normalizeTarget } from "../outbound/target.ts";

// ========== 类型定义 ==========

interface RemindParams {
	action: "add" | "list" | "remove";
	/** 提醒内容（action=add 时必填） */
	content?: string;
	/**
	 * 投递目标地址（可选，系统会自动从当前会话上下文获取）。
	 * 仅在需要手动指定时填写。
	 */
	to?: string;
	/**
	 * 时间描述（action=add 时必填）
	 * - 一次性：相对时间如 "5m"、"1h30m"、"2h"，或绝对毫秒时间戳
	 * - 周期性：cron 表达式如 "0 8 * * *"
	 */
	time?: string;
	/** 时区（周期提醒时使用，默认 Asia/Shanghai） */
	timezone?: string;
	/** 提醒名称（可选，默认自动生成） */
	name?: string;
	/** jobId（action=remove 时必填） */
	jobId?: string;
}

// ========== Schema ==========
// mu 适配：原版为 JSON Schema 对象（OpenClaw registerTool）；pi 的工具参数用 TypeBox 描述，字段与说明不变。

const RemindSchema = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("remove")], {
		description: "操作类型。add=创建提醒, list=查看已有提醒, remove=删除提醒",
	}),
	content: Type.Optional(Type.String({ description: '提醒内容，如"喝水"、"开会"。action=add 时必填。' })),
	to: Type.Optional(
		Type.String({
			description:
				"投递目标地址（可选）。系统会自动从当前会话获取，通常无需手动填写。" +
				"私聊格式：qqbot:c2c:user_openid，群聊格式：qqbot:group:group_openid。",
		}),
	),
	time: Type.Optional(
		Type.String({
			description:
				"时间描述。支持两种格式：\n" +
				'1. 相对时间：如 "5m"(5分钟后)、"1h"(1小时后)、"1h30m"(1.5小时后)、"2d"(2天后)\n' +
				'2. cron 表达式：如 "0 8 * * *"(每天8点)、"0 9 * * 1-5"(工作日9点)\n' +
				"系统会自动判断：包含空格的视为 cron 表达式（周期提醒），否则视为相对时间（一次性提醒）。\n" +
				"action=add 时必填。",
		}),
	),
	timezone: Type.Optional(Type.String({ description: '时区，仅周期提醒(cron)时需要。默认 "Asia/Shanghai"。' })),
	name: Type.Optional(Type.String({ description: "提醒任务名称（可选）。默认自动从 content 截取前 20 字。" })),
	jobId: Type.Optional(Type.String({ description: "要删除的任务 ID。action=remove 时必填，先用 list 获取。" })),
});

// ========== 工具函数 ==========

function json(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

/** 一次性提醒最远一年后（mu 修正：原先过大的数值会存成 null / Infinity，list 抛 RangeError 或立即触发） */
const MAX_RELATIVE_MS = 366 * 86_400_000;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, min: 60_000, m: 60_000, s: 1_000 };

/**
 * 解析相对时间字符串为毫秒数
 * 支持格式：5m, 1h, 1h30m, 2d, 30s, 1d2h30m 等
 *
 * mu 修正：原先只挑出能匹配的片段，其余忽略 ——「2 months」当作 2 分钟、「10ms」当作 10 分钟、「1h30」当作
 * 1 小时、「-5m」当作 5 分钟后。现在整个字符串必须由「数字 + 单位」组成，否则返回 null。
 */
export function parseRelativeTime(timeStr: string): number | null {
	const s = timeStr.trim().toLowerCase();

	// 纯数字 → 视为分钟
	if (/^\d+$/.test(s)) {
		const ms = parseInt(s, 10) * 60_000;
		return ms <= MAX_RELATIVE_MS ? ms : null;
	}

	const token = /\s*(\d+(?:\.\d+)?)\s*(min|d|h|m|s)(?![a-z])/y;
	let totalMs = 0;
	let matched = false;
	while (token.lastIndex < s.length) {
		const match = token.exec(s);
		if (!match) return null;
		matched = true;
		totalMs += parseFloat(match[1] as string) * (UNIT_MS[match[2] as string] ?? 0);
	}
	if (!matched || totalMs > MAX_RELATIVE_MS) return null;
	return Math.round(totalMs);
}

/**
 * 判断是否为 cron 表达式（包含空格且有 3~6 段）
 */
export function isCronExpression(timeStr: string): boolean {
	const parts = timeStr.trim().split(/\s+/);
	return parts.length >= 3 && parts.length <= 6;
}

/**
 * 自动生成任务名称
 */
function generateJobName(content: string): string {
	const trimmed = content.trim();
	const short = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed;
	return `提醒: ${short}`;
}

/**
 * 构建提醒 payload 中的 AI prompt
 */
export function buildReminderPrompt(content: string): string {
	return (
		`你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：${content}。` +
		`要求：(1) 不要回复HEARTBEAT_OK (2) 不要解释你是谁 ` +
		`(3) 直接输出一条暖心的提醒消息 (4) 可以加一句简短的鸡汤或关怀的话 ` +
		`(5) 控制在2-3句话以内 (6) 用emoji点缀`
	);
}

/**
 * 格式化延迟时间为人类可读文本
 */
function formatDelay(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}秒`;
	const totalMinutes = Math.round(ms / 60_000);
	if (totalMinutes < 60) return `${totalMinutes}分钟`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (minutes === 0) return `${hours}小时`;
	return `${hours}小时${minutes}分钟`;
}

function describeJob(job: ReminderJob) {
	return {
		jobId: job.id,
		name: job.name,
		content: job.content,
		schedule: job.schedule.kind === "at" ? "一次性" : `${job.schedule.expr} (${job.schedule.tz})`,
		nextRunAt: new Date(job.nextRunAt).toISOString(),
	};
}

// ========== 工具 ==========

/** 每个会话最多同时存在的提醒（mu 修正：原先不限，任何人都能排下成百上千个每分钟的提醒） */
export const MAX_REMINDERS_PER_TARGET = 20;

/** 间隔不到 5 分钟的 cron（第一段为 * 或 *\/N，N < 5）：每次触发都要调一次模型，不允许 */
function firesTooOften(expr: string): boolean {
	const match = /^\*(?:\/(\d+))?$/.exec(expr.trim().split(/\s+/)[0] ?? "");
	return match !== null && Number(match[1] ?? 1) < 5;
}

export function createRemindTool(
	ref: ConversationRef,
	getScheduler: () => ReminderScheduler | undefined,
	/** 当前回合是否来自运维者：只有运维者能把提醒发到别的会话 */
	isTrusted: () => boolean = () => false,
): ToolDefinition {
	const here = conversationTarget(ref);
	const tool: ToolDefinition<typeof RemindSchema> = {
		name: "qqbot_remind",
		label: "QQBot 定时提醒",
		description:
			"创建、查询、删除 QQ 定时提醒。" +
			"使用简单参数即可，无需手动构造 cron JSON。\n" +
			"创建提醒：action=add, content=提醒内容, time=时间（to 可省略，默认当前会话）\n" +
			"查看提醒：action=list\n" +
			"删除提醒：action=remove, jobId=任务ID（先 list 获取）\n" +
			'时间格式示例："5m"(5分钟后) "1h"(1小时后) "0 8 * * *"(每天8点)',
		promptSnippet: "qqbot_remind: 创建 / 查看 / 删除 QQ 定时提醒（到点主动发消息）",
		parameters: RemindSchema,
		async execute(_toolCallId, params) {
			const p = params as RemindParams;
			const scheduler = getScheduler();
			if (!scheduler) return json({ error: "提醒调度器未运行（需要 mu qqbot start）。" });

			// ===== list =====
			if (p.action === "list") {
				const jobs = scheduler.list({ accountId: ref.accountId, to: here });
				return json({ count: jobs.length, jobs: jobs.map(describeJob) });
			}

			// ===== remove =====
			if (p.action === "remove") {
				if (!p.jobId) {
					return json({ error: "action=remove 时 jobId 为必填参数。请先用 action=list 获取 jobId。" });
				}
				const removed = scheduler.remove(p.jobId, { accountId: ref.accountId, to: here });
				return json(removed ? { removed: p.jobId } : { error: `当前会话没有 ID 为 ${p.jobId} 的提醒。` });
			}

			// ===== add =====
			if (!p.content) {
				return json({ error: "action=add 时 content（提醒内容）为必填参数" });
			}
			// 优先使用 AI 传入的 to，否则为当前会话
			const resolvedTo = p.to ? normalizeTarget(p.to) : here;
			if (!resolvedTo) {
				return json({
					error: `无法识别的目标地址 "${p.to}"。私聊 qqbot:c2c:openid，群聊 qqbot:group:group_openid。`,
				});
			}
			// mu 修正：原先任何会话（含只读群）都能往任意私聊或群排提醒，创建方还看不到、删不掉
			if (resolvedTo !== here && !isTrusted()) {
				return json({ error: "只能给当前会话设置提醒；发到其他会话需要机器人运维者本人要求。" });
			}
			if (scheduler.list({ accountId: ref.accountId, to: resolvedTo }).length >= MAX_REMINDERS_PER_TARGET) {
				return json({ error: `这个会话已有 ${MAX_REMINDERS_PER_TARGET} 个提醒，请先删除一些（action=remove）。` });
			}
			if (!p.time) {
				return json({ error: 'action=add 时 time（时间）为必填参数。示例："5m"、"1h30m"、"0 8 * * *"' });
			}
			const name = p.name || generateJobName(p.content);

			// 判断是 cron 表达式还是相对时间
			if (isCronExpression(p.time)) {
				if (firesTooOften(p.time)) return json({ error: "提醒最频繁每 5 分钟一次（cron 的分钟段至少 */5）。" });
				const tz = p.timezone || "Asia/Shanghai";
				try {
					const job = scheduler.add({
						accountId: ref.accountId,
						to: resolvedTo,
						content: p.content,
						name,
						schedule: { kind: "cron", expr: p.time.trim(), tz },
					});
					return json({
						jobId: job.id,
						summary: `⏰ 周期提醒: "${p.content}" (${p.time}, tz=${tz})`,
						nextRunAt: new Date(job.nextRunAt).toISOString(),
					});
				} catch (err) {
					return json({ error: err instanceof Error ? err.message : String(err) });
				}
			}

			// 一次性提醒
			const delayMs = parseRelativeTime(p.time);
			if (!delayMs || delayMs <= 0) {
				return json({
					error:
						`无法解析时间 "${p.time}"。支持格式：` +
						`相对时间如 "5m"、"1h"、"1h30m"、"2d"；` +
						`cron 表达式如 "0 8 * * *"（每天8点）`,
				});
			}

			if (delayMs < 30_000) {
				return json({ error: "提醒时间不能少于 30 秒" });
			}

			const job = scheduler.add({
				accountId: ref.accountId,
				to: resolvedTo,
				content: p.content,
				name,
				schedule: { kind: "at", atMs: Date.now() + delayMs },
			});
			return json({ jobId: job.id, summary: `⏰ ${formatDelay(delayMs)}后提醒: "${p.content}"` });
		},
	};
	return tool as unknown as ToolDefinition;
}
