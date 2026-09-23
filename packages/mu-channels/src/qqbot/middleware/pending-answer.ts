/**
 * 等待作答中间件（mu 移植新增）
 *
 * mu 会话在等某个问题的答案（权限审批、风险命令确认、选择、文字输入）时，这个回合还没结束，
 * concurrencyGuard 会把后续消息排在它后面 —— 回复「1」也会被卡住。因此在排队之前拦截：
 * 该会话有问题在等、且这条消息是一个有效答案（序号 / 选项文字 / 是否 / 任意文字 for input）时，
 * 直接交给问题并结束处理链。按钮点击走 INTERACTION_CREATE，不经过这里。
 *
 * 只有 allowFrom 中明确列出的人能作答（与按钮一致）。mu 修正：无权者的消息不再被回复「无权限」后丢弃，
 * 而是照常交给会话；以 / 开头的消息（如 /stop）不当作答案。
 */
import type { Middleware } from "@tencent-connect/qqbot-nodejs";
import type { QQBotRuntime } from "../runtime.ts";
import type { ResolvedQQBotAccount } from "../types.ts";
import { stripMentionText } from "../utils/mention.ts";

export function pendingAnswer(params: { account: ResolvedQQBotAccount; getRuntime: () => QQBotRuntime }): Middleware {
	return async (ctx, next) => {
		const msg = ctx.message;
		const isGroup = msg.kind === "group";
		const peerId = isGroup ? msg.groupOpenid : msg.senderId;
		if (!peerId) {
			await next();
			return;
		}
		const ref = {
			accountId: params.account.accountId,
			scope: isGroup ? ("group" as const) : ("c2c" as const),
			peerId,
		};
		const runtime = params.getRuntime();
		if (!runtime.host.bridge(ref)?.hasPending) {
			await next();
			return;
		}
		const text = stripMentionText(msg.content ?? "", (msg as { mentions?: never }).mentions);
		if (text.trim().startsWith("/")) {
			await next();
			return;
		}
		const outcome = runtime.host.answerText(ref, text, msg.senderId);
		if (outcome === "answered") {
			ctx.log?.info?.(`[answer] ${msg.senderId} answered a pending prompt`);
			ctx.stop("ui:answered");
			return;
		}
		await next();
	};
}
