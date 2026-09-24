/**
 * 入站限流（mu 移植新增，替代 SDK 的 rateLimiter）
 *
 * SDK 的 rateLimiter 依次检查 global → perGroup → perSender，每一档检查时就记下这条消息：
 * 被 perSender 挡下的消息已经占用了群和全局额度，一个人刷屏就能让整个群、甚至所有人的消息被丢弃。
 * 这里先检查 perSender，三档都通过才记数；空桶随时删除，不随发送者数量无限增长。
 */
import type { Middleware, MiddlewareContext } from "@tencent-connect/qqbot-nodejs";

export interface RateLimitTier {
	max: number;
	windowMs: number;
}

export interface RateLimitOptions {
	perSender?: RateLimitTier;
	perGroup?: RateLimitTier;
	global?: RateLimitTier;
	onLimit?: (ctx: MiddlewareContext, tier: "perSender" | "perGroup" | "global") => void;
	now?: () => number;
}

class SlidingWindow {
	private readonly buckets = new Map<string, number[]>();
	private readonly tier: RateLimitTier;

	constructor(tier: RateLimitTier) {
		this.tier = tier;
	}

	allows(key: string, now: number): boolean {
		const times = this.buckets.get(key);
		if (!times) return true;
		while (times.length > 0 && now - (times[0] as number) >= this.tier.windowMs) times.shift();
		if (times.length === 0) {
			this.buckets.delete(key);
			return true;
		}
		return times.length < this.tier.max;
	}

	record(key: string, now: number): void {
		const times = this.buckets.get(key);
		if (times) times.push(now);
		else this.buckets.set(key, [now]);
	}
}

export function inboundRateLimit(options: RateLimitOptions): Middleware {
	const now = options.now ?? Date.now;
	const tiers = (
		[
			["perSender", options.perSender],
			["perGroup", options.perGroup],
			["global", options.global],
		] as const
	)
		.filter((entry): entry is readonly [(typeof entry)[0], RateLimitTier] => entry[1] !== undefined)
		.map(([name, tier]) => ({ name, window: new SlidingWindow(tier) }));

	return async (ctx, next) => {
		const senderId = String(ctx.message.senderId);
		const keys = {
			perSender: senderId,
			perGroup: String(ctx.message.groupOpenid ?? senderId),
			global: "__global__",
		};
		const at = now();
		const blocked = tiers.find(({ name, window }) => !window.allows(keys[name], at));
		if (blocked) {
			options.onLimit?.(ctx, blocked.name);
			ctx.stop(`rate-limit:${blocked.name}`);
			return;
		}
		for (const { name, window } of tiers) window.record(keys[name], at);
		await next();
	};
}
