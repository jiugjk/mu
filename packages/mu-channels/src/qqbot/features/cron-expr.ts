/**
 * cron 表达式（mu 移植新增）
 *
 * 原版的周期提醒交给 OpenClaw 的 cron 工具计算触发时间（schedule.kind = "cron"，expr + tz）。
 * mu 没有 cron 工具，提醒调度器（reminders.ts）用这里计算下一次触发时间。
 *
 * 支持标准 5 段（分 时 日 月 周），或 6 段（首段为秒，只接受 0，精度为分钟）；
 * 每段支持 *、数字、a-b、步长 /n、逗号列表，月份与星期可用英文缩写（JAN…DEC、SUN…SAT），星期 0 与 7 都是周日。
 * 日与周都受限时按传统 cron 取「或」。时间按 tz（IANA 时区）的本地时间计算。
 */

export interface CronSpec {
	minutes: ReadonlySet<number>;
	hours: ReadonlySet<number>;
	days: ReadonlySet<number>;
	months: ReadonlySet<number>;
	weekdays: ReadonlySet<number>;
	domAny: boolean;
	dowAny: boolean;
}

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function parseValue(raw: string, names: readonly string[] | undefined, offset: number): number {
	const upper = raw.toUpperCase();
	const named = names?.indexOf(upper) ?? -1;
	if (named >= 0) return named + offset;
	if (!/^\d+$/.test(raw)) throw new Error(`无效的 cron 值: ${raw}`);
	return Number(raw);
}

function parseField(field: string, min: number, max: number, names?: readonly string[], nameOffset = 0): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		const [range = "", stepText] = part.split("/");
		const step = stepText === undefined ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1) throw new Error(`无效的 cron 步长: ${part}`);
		let from: number;
		let to: number;
		if (range === "*") {
			from = min;
			to = max;
		} else if (range.includes("-")) {
			const [a = "", b = ""] = range.split("-");
			from = parseValue(a, names, nameOffset);
			to = parseValue(b, names, nameOffset);
		} else {
			from = parseValue(range, names, nameOffset);
			to = stepText === undefined ? from : max;
		}
		if (from < min || to > max || from > to) throw new Error(`cron 值超出范围 (${min}-${max}): ${part}`);
		for (let v = from; v <= to; v += step) values.add(v);
	}
	return values;
}

/** 解析 cron 表达式；无效时抛出带说明的错误 */
export function parseCron(expr: string): CronSpec {
	let fields = expr.trim().split(/\s+/);
	if (fields.length === 6) {
		if (fields[0] !== "0") throw new Error("6 段 cron 的秒字段只支持 0（精度为分钟）");
		fields = fields.slice(1);
	}
	if (fields.length !== 5) throw new Error(`cron 表达式应为 5 段（分 时 日 月 周）: ${expr}`);
	const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields;
	// mu 修正：Quartz 风格的 `?`（日或周不限）原先在 parseField 里就被拒绝
	const weekdays = parseField(weekday === "?" ? "*" : weekday, 0, 7, DAY_NAMES);
	if (weekdays.has(7)) {
		weekdays.delete(7);
		weekdays.add(0);
	}
	return {
		minutes: parseField(minute, 0, 59),
		hours: parseField(hour, 0, 23),
		days: parseField(day === "?" ? "*" : day, 1, 31),
		months: parseField(month, 1, 12, MONTH_NAMES, 1),
		weekdays,
		domAny: day === "*" || day === "?",
		dowAny: weekday === "*" || weekday === "?",
	};
}

interface LocalParts {
	month: number;
	day: number;
	hour: number;
	minute: number;
	weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
	let formatter = formatters.get(tz);
	if (!formatter) {
		// 无效时区在这里抛出 RangeError
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			weekday: "short",
		});
		formatters.set(tz, formatter);
	}
	return formatter;
}

function localParts(ms: number, tz: string): LocalParts {
	const parts: Record<string, string> = {};
	for (const part of formatterFor(tz).formatToParts(new Date(ms))) parts[part.type] = part.value;
	return {
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
		weekday: DAY_NAMES.indexOf((parts.weekday ?? "").toUpperCase()),
	};
}

/** 检查时区是否有效 */
export function isValidTimeZone(tz: string): boolean {
	try {
		formatterFor(tz);
		return true;
	} catch {
		return false;
	}
}

/** after 之后（不含）第一次触发的时间（毫秒）；一年内没有则抛错 */
export function nextCronTime(spec: CronSpec, afterMs: number, tz: string): number {
	const MINUTE = 60_000;
	let t = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
	const limit = afterMs + 366 * 24 * 60 * MINUTE;
	while (t <= limit) {
		const p = localParts(t, tz);
		const dayMatches =
			spec.domAny && spec.dowAny
				? true
				: spec.domAny
					? spec.weekdays.has(p.weekday)
					: spec.dowAny
						? spec.days.has(p.day)
						: spec.days.has(p.day) || spec.weekdays.has(p.weekday);
		if (!spec.months.has(p.month) || !dayMatches) {
			// 跳到下一个整点。mu 修正：原先按 24 小时跳到「下一天 0 点」，夏令时开始那天只有 23 小时，
			// 会跳过次日 0 点这一小时的触发
			t += (60 - p.minute) * MINUTE;
			continue;
		}
		if (!spec.hours.has(p.hour)) {
			t += (60 - p.minute) * MINUTE;
			continue;
		}
		if (!spec.minutes.has(p.minute)) {
			t += MINUTE;
			continue;
		}
		// mu 修正：夏令时结束时同一本地时刻出现两次，只在第一次触发
		const hourBefore = localParts(t - 60 * MINUTE, tz);
		if (hourBefore.day === p.day && hourBefore.hour === p.hour && hourBefore.minute === p.minute) {
			t += MINUTE;
			continue;
		}
		return t;
	}
	throw new Error("cron 表达式在一年内不会触发");
}
