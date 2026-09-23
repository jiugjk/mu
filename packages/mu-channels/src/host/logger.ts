import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ChannelLogger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
	child(tag: string): ChannelLogger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Credentials never reach a log line. Known secrets (an account's AppSecret, a token once fetched) are replaced
 * wherever they appear, and a few shapes are masked even when nobody registered them: an `Authorization: QQBot …`
 * header, `access_token`, and `clientSecret` / `appSecret` / `client_secret` fields.
 */
export class Redactor {
	private readonly secrets = new Set<string>();

	add(secret: string | undefined): void {
		// Short values would mask ordinary words; an AppSecret or a token is far longer.
		if (secret && secret.length >= 6) this.secrets.add(secret);
	}

	redact(text: string): string {
		let out = text;
		for (const secret of this.secrets) out = out.split(secret).join("***");
		return out
			.replace(/(QQBot\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1***")
			.replace(/("?access_token"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1***")
			.replace(
				/("?(?:clientSecret|appSecret|client_secret|app_secret|apiKey|api_key)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
				"$1***",
			);
	}
}

export interface ChannelLoggerOptions {
	/** Log file; its directory is created. */
	file?: string;
	level?: LogLevel;
	/** Also write to stderr (the terminal `mu qqbot start` runs in). Default true. */
	console?: boolean;
	redactor?: Redactor;
	prefix?: string;
}

export function createChannelLogger(options: ChannelLoggerOptions = {}): ChannelLogger {
	const threshold = LEVELS[options.level ?? "info"];
	const redactor = options.redactor ?? new Redactor();
	const toConsole = options.console !== false;
	if (options.file) mkdirSync(dirname(options.file), { recursive: true });

	const write = (level: LogLevel, prefix: string, msg: string, meta?: Record<string, unknown>) => {
		if (LEVELS[level] < threshold) return;
		const metaText = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
		const line = redactor.redact(
			`${new Date().toISOString()} ${level.toUpperCase()} ${prefix ? `${prefix} ` : ""}${msg}${metaText}`,
		);
		if (toConsole) process.stderr.write(`${line}\n`);
		if (options.file) {
			try {
				appendFileSync(options.file, `${line}\n`, { mode: 0o600 });
			} catch {
				// A full disk must not stop the bot answering.
			}
		}
	};

	const make = (prefix: string): ChannelLogger => ({
		debug: (msg, meta) => write("debug", prefix, msg, meta),
		info: (msg, meta) => write("info", prefix, msg, meta),
		warn: (msg, meta) => write("warn", prefix, msg, meta),
		error: (msg, meta) => write("error", prefix, msg, meta),
		child: (tag) => make(`${prefix}[${tag}]`),
	});
	return make(options.prefix ?? "");
}

/** Discards everything: tests, and code that runs before the host has a log file. */
export const silentLogger: ChannelLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger,
};
