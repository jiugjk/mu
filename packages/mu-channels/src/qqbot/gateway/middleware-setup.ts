/**
 * SDK 中间件编排
 *
 * 根据账户配置组装 SDK 内置中间件链。
 * 中间件负责过滤和上下文富化；concurrencyGuard 负责串行+合并，
 * 合并后的消息继续走完剩余中间件链，最终统一由 bot.on("message") 处理转发。
 */
import type { Middleware, MiddlewareContext, QQBot, RateLimiterOptions } from "@tencent-connect/qqbot-nodejs";
import {
	concurrencyGuard,
	contentSanitizer,
	envelopeFormatter,
	errorHandler,
	historyBuffer,
	mentionGate,
	messageFilter,
	quoteRef,
	rateLimiter,
	slashCommand,
	typingIndicator,
} from "@tencent-connect/qqbot-nodejs";
import { buildCommandList } from "../commands/index.ts";
import { assembleBody } from "../dispatch/body-assembler.ts";
import { getHistoryStore, historyGroupKey } from "../features/history-store.ts";
import { getPersistedRefIndexStore } from "../features/ref-index-store.ts";
import { dynamicAccessControl } from "../middleware/access-control.ts";
import { attachmentProcessor } from "../middleware/attachment.ts";
import { pendingAnswer } from "../middleware/pending-answer.ts";
import { createPolicyInjector } from "../middleware/policy-injector.ts";
import type { QQBotRuntime } from "../runtime.ts";
import type { RateLimitConfig, ResolvedQQBotAccount } from "../types.ts";
import { stripMentionText } from "../utils/mention.ts";

export interface MiddlewareSetupOptions {
	/** 获取 runtime */
	getRuntime: () => QQBotRuntime;
}

/**
 * 默认限流档位（mu 移植新增，偏离原行为：原版调用 rateLimiter() 时未传任何档位，实际不限流）。
 * 可在 channels.qqbot.rateLimit 覆盖；某档设为 false 关闭该档，rateLimit: false 关闭限流。
 */
export const DEFAULT_RATE_LIMIT = {
	perSender: { max: 20, windowMs: 60_000 },
	perGroup: { max: 60, windowMs: 60_000 },
	global: { max: 300, windowMs: 60_000 },
} as const;

export function resolveRateLimit(config: RateLimitConfig | false | undefined): RateLimiterOptions | null {
	if (config === false) return null;
	const pick = (key: keyof RateLimitConfig) => {
		const value = config?.[key];
		if (value === false) return undefined;
		return value ?? DEFAULT_RATE_LIMIT[key];
	};
	return { perSender: pick("perSender"), perGroup: pick("perGroup"), global: pick("global") };
}

/**
 * 为 QQBot 实例编排完整的中间件链
 */
export function setupMiddlewares(bot: QQBot, account: ResolvedQQBotAccount, opts: MiddlewareSetupOptions): void {
	// 1. 错误兜底（最外层洋葱皮）
	bot.use(errorHandler());

	// 2. 消息过滤：bot 回声 + 消息去重
	bot.use(messageFilter({ skipSelfEcho: false }));

	// 3. 动态策略注入 — 每条消息注入 ctx.state.policy
	//    后续 dynamicAccessControl / mentionGate / historyBuffer 自动读取
	bot.use(createPolicyInjector(account));

	// 4. 群历史缓冲 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
	//    key 带 accountId 前缀隔离多账号
	//    mu 修正：SDK 的 historyBuffer 总是用静态 limit（默认 50），ctx.state.policy 里的 historyLimit 从不生效，
	//    原版因此所有群都缓存 50 条。这里按每条消息所在群的 historyLimit 选用对应 limit 的 historyBuffer，
	//    historyLimit 为 0 时不记录。
	const historyBuffers = new Map<number, Middleware>();
	bot.use(async (ctx, next) => {
		const group = (ctx.state.policy as { group?: { historyLimit?: number } } | undefined)?.group;
		const limit = Math.max(0, group?.historyLimit ?? 20);
		if (ctx.message.kind !== "group" || limit === 0) {
			await next();
			return;
		}
		let buffer = historyBuffers.get(limit);
		if (!buffer) {
			buffer = historyBuffer({
				store: getHistoryStore(),
				limit,
				groupKey: (c) => {
					const gid = c.message.groupOpenid;
					if (c.message.kind !== "group" || !gid) return undefined;
					return historyGroupKey(account.accountId, gid);
				},
			});
			historyBuffers.set(limit, buffer);
		}
		await buffer(ctx, next);
	});

	// 5. 动态访问控制 — 从 ctx.state.policy 动态读取，支持 pairing
	bot.use(
		dynamicAccessControl({
			accountId: account.accountId,
			getRuntime: opts.getRuntime,
		}),
	);

	// 5.5 等待作答（mu 移植新增）：会话里有问题（审批/选择）在等人回答时，回复序号或文字即作答，
	//     不再排队进入会话。放在 @ 门控之前：群里回复「1」无需 @ 机器人。
	bot.use(pendingAnswer({ account, getRuntime: opts.getRuntime }));

	// 6. 群聊 @bot 门控（从 ctx.state.policy.group 读取动态配置）
	bot.use(mentionGate());
	// 7. 内容清洗（去 @marker、表情标签、多余空白）
	// SDK 用 appId 匹配 @标记，但 QQ openid 不等于 appId，追加 stripMentionText 正确剥离
	bot.use(
		contentSanitizer({
			parseFaceTags: true,
			transform: (content, ctx) => stripMentionText(content, (ctx.message as any).mentions),
		}),
	);

	// 8. 三层限流（sender / group / global）— mu 移植给出默认档位（见 DEFAULT_RATE_LIMIT）
	const rateLimit = resolveRateLimit(account.config.rateLimit);
	if (rateLimit) {
		bot.use(
			rateLimiter({
				...rateLimit,
				onLimit: (ctx, tier) => {
					ctx.log?.info?.(`[rate-limit] dropped message from ${ctx.message.senderId} (${tier})`);
				},
			}),
		);
	}

	// 9. 斜杠命令（在并发锁之前，命令匹配后直接 reply + stop，不排队）
	//    依赖：ctx.state.policy（policyInjector, #3）、ctx.message.*（原始消息）
	//    注意：/stop 是框架级命令，不在 qqbot 命令列表中，仍由 urgentPredicate 处理
	const slash = slashCommand({ commands: buildCommandList(account, { getRuntime: opts.getRuntime }) });
	bot.use(slash.middleware);

	// 10. 并发串行+合并（在副作用中间件之前）
	//     - 同 peer 串行处理，避免平台 session conflict
	//     - 处理中消息暂存 buffer；完成后合并为一条，继续走完剩余中间件链
	//       （typingIndicator/quoteRef/attachmentProcessor/... 直到 bot.on("message")）
	//     - 合并时清除 assembledBody 让 dispatch.ts 用合并后 content 重建
	//     - 超时后 abort 处理链（取消 LLM 调用），释放锁并排空缓冲
	bot.use(
		concurrencyGuard({
			strategy: "merge",
			maxQueue: 50,
			maxProcessingMs: account.processingTimeoutMs,
			/** 紧急指令（/stop）跳过排队，立即处理 */
			urgentPredicate: (ctx: MiddlewareContext) => {
				return ((ctx.message.content as string) ?? "").trim() === "/stop";
			},
			onMerge: (buffered) => {
				const last = buffered[buffered.length - 1];
				if (buffered.length === 1) return last;

				// 透传原始消息列表，格式拼接下沉给下游 envelopeFormatter / assembleBody
				(last.state as Record<string, unknown>).mergedMessages = buffered;

				// 合并附件（所有 buffer 中的附件汇总到 survivor）
				const attachments = buffered.flatMap((c) => c.message.attachments ?? []);
				if (attachments.length > 0) {
					last.message.attachments = attachments;
				}

				// 清除 assembledBody，让 dispatch.ts 用合并后的 ctx 重新构建
				delete (last.state as Record<string, unknown>).assembledBody;

				return last;
			},
		}),
	);

	// 11. C2C 输入状态指示器
	bot.use(typingIndicator());

	// 12. 引用消息解析（默认优先 msg_elements 获取文件名等丰富信息）
	bot.use(
		quoteRef({
			store: getPersistedRefIndexStore(account.accountId),
		}),
	);

	// 13. 附件处理（语音 STT 转录 + 图片/文件下载）
	bot.use(attachmentProcessor({ getRuntime: opts.getRuntime, accountId: account.accountId }));

	// 14. 上下文组装（构建框架规约的 body）
	bot.use(
		envelopeFormatter({
			format: (ctx) => {
				const assembled = assembleBody(ctx, ctx.message as never, account, opts.getRuntime);
				(ctx.state as Record<string, unknown>).assembledBody = assembled;
				return assembled.agentBody;
			},
		}),
	);
}
