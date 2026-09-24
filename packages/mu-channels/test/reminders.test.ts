import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nextCronTime, parseCron } from "../src/qqbot/features/cron-expr.ts";
import { type ReminderJob, ReminderScheduler } from "../src/qqbot/features/reminders.ts";
import { isCronExpression, parseRelativeTime } from "../src/qqbot/tools/remind.ts";
import { c2cMessage } from "./support/fake-qq.ts";
import { type ChannelTestEnv, startChannelTest } from "./support/harness.ts";

const at = (iso: string) => new Date(iso).getTime();
const SHANGHAI = "Asia/Shanghai";

describe("cron expressions", () => {
	it("finds the next time in the job's time zone", () => {
		// 2026-09-23 10:00 in Shanghai = 02:00 UTC
		const now = at("2026-09-23T02:00:00Z");
		expect(nextCronTime(parseCron("0 8 * * *"), now, SHANGHAI)).toBe(at("2026-09-24T00:00:00Z"));
		expect(nextCronTime(parseCron("30 10 * * *"), now, SHANGHAI)).toBe(at("2026-09-23T02:30:00Z"));
		expect(nextCronTime(parseCron("0 8 * * *"), now, "UTC")).toBe(at("2026-09-23T08:00:00Z"));
		expect(nextCronTime(parseCron("*/15 * * * *"), now, SHANGHAI)).toBe(at("2026-09-23T02:15:00Z"));
	});

	it("handles weekdays, names, lists, ranges, 7 as Sunday and day-of-month OR day-of-week", () => {
		// Wednesday 2026-09-23, 10:00 Shanghai
		const now = at("2026-09-23T02:00:00Z");
		expect(nextCronTime(parseCron("0 9 * * 1-5"), now, SHANGHAI)).toBe(at("2026-09-24T01:00:00Z"));
		expect(nextCronTime(parseCron("0 10 * * 0,6"), now, SHANGHAI)).toBe(at("2026-09-26T02:00:00Z"));
		expect(nextCronTime(parseCron("0 10 * * SUN"), now, SHANGHAI)).toBe(
			nextCronTime(parseCron("0 10 * * 7"), now, SHANGHAI),
		);
		expect(nextCronTime(parseCron("0 0 1 JAN *"), now, SHANGHAI)).toBe(at("2026-12-31T16:00:00Z"));
		// the 25th or any Friday, whichever comes first: Friday the 25th of September
		expect(nextCronTime(parseCron("0 12 30 * FRI"), now, SHANGHAI)).toBe(at("2026-09-25T04:00:00Z"));
		expect(nextCronTime(parseCron("0 0 8 * * *"), now, SHANGHAI)).toBe(at("2026-09-24T00:00:00Z"));
	});

	it("rejects what it cannot run", () => {
		expect(() => parseCron("0 8 * *")).toThrow(/5 段/);
		expect(() => parseCron("61 * * * *")).toThrow(/超出范围/);
		expect(() => parseCron("30 0 8 * * *")).toThrow(/秒字段/);
		expect(() => parseCron("0 8 * * MON-")).toThrow();
		expect(() => nextCronTime(parseCron("0 0 31 2 *"), 0, "UTC")).toThrow(/一年内/);
	});

	it("keeps the original's time helpers", () => {
		expect(parseRelativeTime("5m")).toBe(300_000);
		expect(parseRelativeTime("1h30m")).toBe(5_400_000);
		expect(parseRelativeTime("2d")).toBe(172_800_000);
		expect(parseRelativeTime("15")).toBe(900_000);
		expect(parseRelativeTime("soon")).toBeNull();
		expect(isCronExpression("0 8 * * *")).toBe(true);
		expect(isCronExpression("5m")).toBe(false);
	});
});

describe("reminder scheduler", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function scheduler(
		options: {
			compose?: (job: ReminderJob) => Promise<string>;
			deliver?: (job: ReminderJob, text: string) => Promise<void>;
		} = {},
	) {
		const dir = mkdtempSync(join(tmpdir(), "mu-reminders-"));
		dirs.push(dir);
		const file = join(dir, "reminders.json");
		let now = at("2026-09-23T02:00:00Z");
		const sent: string[] = [];
		const make = () =>
			new ReminderScheduler({
				file,
				now: () => now,
				compose: options.compose ?? (async (job) => `⏰ 该${job.content}啦`),
				deliver:
					options.deliver ??
					(async (job, text) => {
						sent.push(`${job.to} ${text}`);
					}),
			});
		const advance = (ms: number) => {
			now += ms;
		};
		return { file, sent, make, advance, now: () => now };
	}

	it("sends a one-off reminder when due, then forgets it; the jobs survive a restart", async () => {
		const s = scheduler();
		const first = s.make();
		const job = first.add({
			accountId: "default",
			to: "qqbot:c2c:U1",
			content: "喝水",
			name: "提醒: 喝水",
			schedule: { kind: "at", atMs: s.now() + 5 * 60_000 },
		});
		await first.runDue();
		expect(s.sent).toEqual([]);

		// Restarted before it was due: the job is read back from disk.
		const second = s.make();
		expect(second.list().map((j) => j.id)).toEqual([job.id]);
		s.advance(5 * 60_000);
		await second.runDue();
		expect(s.sent).toEqual(["qqbot:c2c:U1 ⏰ 该喝水啦"]);
		expect(second.list()).toEqual([]);
		expect(JSON.parse(readFileSync(s.file, "utf8")).jobs).toEqual([]);
	});

	it("moves a cron reminder to its next time after it runs, and skips runs missed while stopped", async () => {
		const s = scheduler();
		const sched = s.make();
		sched.add({
			accountId: "default",
			to: "qqbot:group:G1",
			content: "打卡",
			name: "提醒: 打卡",
			schedule: { kind: "cron", expr: "0 8 * * *", tz: SHANGHAI },
		});
		expect(sched.list()[0]?.nextRunAt).toBe(at("2026-09-24T00:00:00Z"));
		s.advance(22 * 3600_000); // 2026-09-24 08:00 Shanghai
		await sched.runDue();
		expect(s.sent).toEqual(["qqbot:group:G1 ⏰ 该打卡啦"]);
		expect(sched.list()[0]?.nextRunAt).toBe(at("2026-09-25T00:00:00Z"));

		s.advance(3 * 86_400_000); // three days down
		const restarted = s.make();
		restarted.start();
		await restarted.stop();
		expect(restarted.list()[0]?.nextRunAt).toBeGreaterThan(s.now());
		expect(s.sent).toHaveLength(1);
	});

	it("sends the plain reminder when the model fails, and gives up on a one-off after three failed deliveries", async () => {
		let attempts = 0;
		const s = scheduler({
			compose: async () => {
				throw new Error("model down");
			},
			deliver: async () => {
				attempts++;
				throw new Error("QQ refused");
			},
		});
		const sched = s.make();
		sched.add({
			accountId: "a",
			to: "qqbot:c2c:U",
			content: "开会",
			name: "n",
			schedule: { kind: "at", atMs: s.now() },
		});
		for (let i = 0; i < 3; i++) {
			await sched.runDue();
			s.advance(60_000);
		}
		expect(attempts).toBe(3);
		expect(sched.list()).toEqual([]);

		const ok = scheduler({ compose: async () => Promise.reject(new Error("x")) });
		const okSched = ok.make();
		okSched.add({
			accountId: "a",
			to: "qqbot:c2c:U",
			content: "开会",
			name: "n",
			schedule: { kind: "at", atMs: ok.now() },
		});
		await okSched.runDue();
		expect(ok.sent).toEqual(["qqbot:c2c:U ⏰ 开会"]);
	});

	it("lists and removes only within the given conversation", () => {
		const s = scheduler();
		const sched = s.make();
		const mine = sched.add({
			accountId: "a",
			to: "qqbot:c2c:ME",
			content: "x",
			name: "x",
			schedule: { kind: "at", atMs: s.now() + 60_000 },
		});
		sched.add({
			accountId: "a",
			to: "qqbot:c2c:OTHER",
			content: "y",
			name: "y",
			schedule: { kind: "at", atMs: s.now() + 60_000 },
		});
		expect(sched.list({ accountId: "a", to: "qqbot:c2c:ME" }).map((j) => j.id)).toEqual([mine.id]);
		expect(sched.remove(mine.id, { accountId: "a", to: "qqbot:c2c:OTHER" })).toBe(false);
		expect(sched.remove(mine.id, { accountId: "a", to: "qqbot:c2c:ME" })).toBe(true);
		expect(() =>
			sched.add({
				accountId: "a",
				to: "t",
				content: "z",
				name: "z",
				schedule: { kind: "cron", expr: "0 8 * * *", tz: "Mars/Base" },
			}),
		).toThrow(/时区/);
	});
});

describe("qqbot_remind end to end (group 6)", () => {
	let env: ChannelTestEnv | undefined;
	afterEach(async () => {
		await env?.stop();
		env = undefined;
	});

	it("creates a reminder from the chat, keeps it on disk, and at the time sends what the model wrote", async () => {
		const ALICE = "A11CE000000000000000000000000009";
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.llm.reply(
			{ toolCalls: [{ name: "qqbot_remind", args: { action: "add", content: "喝水", time: "10m" } }] },
			{ text: "好的，10 分钟后提醒你喝水。" },
		);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "10分钟后提醒我喝水"));
		await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", ALICE).includes("好的，10 分钟后提醒你喝水。"),
			20_000,
			"reply",
		);
		expect(JSON.stringify(env.llm.requests[1]?.messages)).toContain("10分钟后提醒");

		const reminders = env.bot.runtime.reminders;
		const [job] = reminders?.list() ?? [];
		expect(job).toMatchObject({
			accountId: "default",
			to: `qqbot:c2c:${ALICE}`,
			content: "喝水",
			schedule: { kind: "at" },
		});
		expect(existsSync(join(env.qqHome, "data", "reminders.json"))).toBe(true);

		// Due now: the reminder is written in a session of its own and sent to the chat.
		env.llm.reply({ text: "💧 该喝水啦，照顾好自己～" });
		if (job) job.nextRunAt = Date.now();
		const before = env.llm.requests.length;
		await reminders?.runDue();
		await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", ALICE).includes("💧 该喝水啦，照顾好自己～"),
			15_000,
			"reminder",
		);
		const composed = env.llm.requests[before];
		expect(JSON.stringify(composed?.messages)).toContain("你是一个暖心的提醒助手");
		// Isolated: not the conversation's history, no tools.
		expect(JSON.stringify(composed?.messages)).not.toContain("10分钟后提醒我喝水");
		expect(composed?.tools ?? []).toEqual([]);
		expect(reminders?.list()).toEqual([]);
	});
});
