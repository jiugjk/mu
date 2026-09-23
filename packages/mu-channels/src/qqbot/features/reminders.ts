/**
 * 定时提醒调度器（mu 移植新增）
 *
 * 原版的 qqbot_remind 工具只生成参数，由 OpenClaw 的 cron 工具持久化并调度：到点在隔离会话里跑一轮
 * AI（payload.kind = "agentTurn"，暖心提醒 prompt），再把结果投递到 QQ（delivery.mode = "announce"）。
 * mu 没有 cron 工具，因此由本文件承担同样的职责：
 *   - 任务存在 ~/.mu/qqbot/data/reminders.json（原子写入，0600），`mu qqbot start` 重启后继续；
 *   - 一次性（at）任务触发后删除（deleteAfterRun）；周期（cron + tz）任务算出下一次；
 *   - 到点先让模型写提醒语（隔离会话，不进入任何对话），失败时直接发「⏰ 内容」，提醒不会丢；
 *   - 与原版 announce 投递一样走出站发送：该会话近期有用户消息时借用其 msg_id 作被动回复，否则为主动消息；
 *   - 停机期间错过的一次性提醒在启动后补发一次，错过的周期提醒不补发，直接排到下一次。
 *
 * mu 修正：reminders.json 是唯一的真相 —— 每次读写都先读文件再改（原先各进程启动时读一次、之后整份覆盖，
 * 按账户分开运行的进程会互相抹掉对方的提醒）；算不出下一次时间的周期提醒（如 2 月 29 日）删除并记录，
 * 原先会在紧循环里反复投递或让进程崩溃。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginLogger } from "../utils/plugin-logger.ts";
import { isValidTimeZone, nextCronTime, parseCron } from "./cron-expr.ts";

export type ReminderSchedule = { kind: "at"; atMs: number } | { kind: "cron"; expr: string; tz: string };

export interface ReminderJob {
	id: string;
	name: string;
	accountId: string;
	/** qqbot:c2c:<openid> / qqbot:group:<openid> */
	to: string;
	content: string;
	schedule: ReminderSchedule;
	createdAt: number;
	nextRunAt: number;
	lastRunAt?: number;
	/** 连续投递失败次数（一次性提醒失败 3 次后放弃） */
	failures?: number;
}

export interface ReminderSchedulerOptions {
	file: string;
	/** 写提醒语（隔离会话）；抛错时改发「⏰ 内容」 */
	compose(job: ReminderJob): Promise<string>;
	/** 发送到 QQ；抛错视为投递失败 */
	deliver(job: ReminderJob, text: string): Promise<void>;
	log?: PluginLogger;
	now?: () => number;
	/**
	 * 这个进程负责的账户（mu 修正：原先每个 `mu qqbot start` 都触发所有账户的提醒，停用的账户也照发，
	 * 按账户分开运行的多个进程会重复投递）。默认：全部。
	 */
	owns?: (accountId: string) => boolean;
}

const MAX_TIMER_MS = 60 * 60_000;
const RETRY_MS = 60_000;
const MAX_FAILURES = 3;

export class ReminderScheduler {
	private readonly options: ReminderSchedulerOptions;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running: Promise<void> | undefined;
	private started = false;

	constructor(options: ReminderSchedulerOptions) {
		this.options = options;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private owns(job: ReminderJob): boolean {
		return this.options.owns?.(job.accountId) ?? true;
	}

	private load(): ReminderJob[] {
		try {
			const raw = JSON.parse(fs.readFileSync(this.options.file, "utf8")) as { jobs?: ReminderJob[] };
			return Array.isArray(raw.jobs) ? raw.jobs : [];
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				this.options.log?.error(`reminders: cannot read ${this.options.file}: ${String(err)}`);
			}
			return [];
		}
	}

	/** 读文件 → 修改 → 原子写回；返回 change 的结果 */
	private mutate<T>(change: (jobs: ReminderJob[]) => T): T {
		const jobs = this.load();
		const result = change(jobs);
		fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
		const tmp = `${this.options.file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify({ jobs }, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, this.options.file);
		return result;
	}

	/** 周期任务的下一次；算不出时 undefined（调用方删除任务） */
	private nextRun(job: ReminderJob): number | undefined {
		if (job.schedule.kind !== "cron") return undefined;
		try {
			return nextCronTime(parseCron(job.schedule.expr), this.now(), job.schedule.tz);
		} catch (err) {
			this.options.log?.error(`reminders: ${job.id} has no next run, removed: ${String(err)}`);
			return undefined;
		}
	}

	/** 校验并计算第一次触发时间 */
	private firstRun(schedule: ReminderSchedule): number {
		if (schedule.kind === "at") return schedule.atMs;
		if (!isValidTimeZone(schedule.tz)) throw new Error(`无效的时区: ${schedule.tz}`);
		return nextCronTime(parseCron(schedule.expr), this.now(), schedule.tz);
	}

	add(input: {
		accountId: string;
		to: string;
		content: string;
		name: string;
		schedule: ReminderSchedule;
	}): ReminderJob {
		const job: ReminderJob = {
			id: `rem_${crypto.randomBytes(4).toString("hex")}`,
			name: input.name,
			accountId: input.accountId,
			to: input.to,
			content: input.content,
			schedule: input.schedule,
			createdAt: this.now(),
			nextRunAt: this.firstRun(input.schedule),
		};
		if (!Number.isFinite(job.nextRunAt)) throw new Error("无效的提醒时间");
		this.mutate((jobs) => jobs.push(job));
		this.arm();
		return job;
	}

	list(filter: { accountId?: string; to?: string } = {}): ReminderJob[] {
		return this.load()
			.filter(
				(job) => (!filter.accountId || job.accountId === filter.accountId) && (!filter.to || job.to === filter.to),
			)
			.sort((a, b) => a.nextRunAt - b.nextRunAt);
	}

	/** 删除任务；filter 限定只能删自己会话的 */
	remove(id: string, filter: { accountId?: string; to?: string } = {}): boolean {
		const removed = this.mutate((jobs) => {
			const index = jobs.findIndex(
				(job) =>
					job.id === id &&
					(!filter.accountId || job.accountId === filter.accountId) &&
					(!filter.to || job.to === filter.to),
			);
			if (index >= 0) jobs.splice(index, 1);
			return index >= 0;
		});
		this.arm();
		return removed;
	}

	start(): void {
		this.started = true;
		// 停机期间错过的周期提醒不补发：排到下一次
		const now = this.now();
		if (this.load().some((job) => this.owns(job) && job.schedule.kind === "cron" && job.nextRunAt <= now)) {
			this.mutate((jobs) => {
				for (const [i, job] of [...jobs.entries()].reverse()) {
					if (!this.owns(job) || job.schedule.kind !== "cron" || job.nextRunAt > now) continue;
					const next = this.nextRun(job);
					if (next === undefined) jobs.splice(i, 1);
					else job.nextRunAt = next;
				}
			});
		}
		this.arm();
	}

	async stop(): Promise<void> {
		this.started = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		await this.running;
	}

	private arm(): void {
		if (!this.started) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const owned = this.load().filter((job) => this.owns(job));
		// 没有自己的任务时也定期看一眼文件：其他进程（或 CLI）可能加了任务
		const next = owned.length > 0 ? Math.min(...owned.map((job) => job.nextRunAt)) : this.now() + MAX_TIMER_MS;
		const delay = Math.max(0, Math.min(next - this.now(), MAX_TIMER_MS));
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.runDue();
		}, delay);
		this.timer.unref?.();
	}

	/** 触发所有到点的任务（测试也直接调用） */
	runDue(): Promise<void> {
		if (this.running) return this.running;
		this.running = (async () => {
			try {
				const now = this.now();
				const due = this.load().filter((job) => this.owns(job) && job.nextRunAt <= now);
				for (const job of due) await this.fire(job);
			} finally {
				this.running = undefined;
				this.arm();
			}
		})();
		return this.running;
	}

	private async fire(job: ReminderJob): Promise<void> {
		const log = this.options.log;
		let text: string;
		try {
			text = (await this.options.compose(job)).trim() || `⏰ ${job.content}`;
		} catch (err) {
			log?.warn(
				`reminders: ${job.id} compose failed (${err instanceof Error ? err.message : String(err)}), sending plain text`,
			);
			text = `⏰ ${job.content}`;
		}
		let delivered = false;
		try {
			await this.options.deliver(job, text);
			delivered = true;
			log?.info(`reminders: ${job.id} delivered to ${job.to}`);
		} catch (err) {
			log?.error(
				`reminders: ${job.id} delivery failed (${(job.failures ?? 0) + 1}): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		this.mutate((jobs) => {
			const index = jobs.findIndex((each) => each.id === job.id);
			// 期间被删除（本进程或其他进程）：不再改动
			if (index < 0) return;
			const current = jobs[index] as ReminderJob;
			current.failures = delivered ? 0 : (current.failures ?? 0) + 1;
			if (delivered) current.lastRunAt = this.now();
			if (current.schedule.kind === "at") {
				if (delivered || current.failures >= MAX_FAILURES) jobs.splice(index, 1);
				else current.nextRunAt = this.now() + RETRY_MS;
				return;
			}
			const next = this.nextRun(current);
			if (next === undefined) jobs.splice(index, 1);
			else current.nextRunAt = next;
		});
	}
}
