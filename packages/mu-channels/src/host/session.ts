import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ExtensionFactory,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type ChatSurface, ChatUIBridge } from "./chat-ui.ts";
import type { ChannelLogger } from "./logger.ts";

/**
 * What tools a conversation gets.
 * - `full`: everything mu has, under mu's permission mode.
 * - `readonly`: read, grep, find, ls, plus the channel's own tools that `readonlyCustomTools` names.
 * - `none`: no tools at all; mu can only talk.
 */
export type ToolAccess = "full" | "readonly" | "none";

export const READONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/** pi's file tools: their `path` (default: the working directory) is what the guard checks. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "edit", "write"]);

/**
 * Who may make a conversation's tools reach outside it. A chat session serves people the operator does not
 * control, so pi's tools are not left to mu's permission gate alone: the gate asks "did the user want this?",
 * not "may this user do it?". Checked on every tool call of the current turn.
 */
export interface ToolGuard {
	/** The conversation's own directories. */
	roots: readonly string[];
	/** Tools that check their own scope and always run (the channel's tools). */
	freeTools: readonly string[];
	/** Whether the file tools are limited to `roots` in the current turn. */
	confine(): boolean;
	/** Whether the current turn comes from an operator; other people's turns need an operator's yes for other tools. */
	trusted(): boolean;
	/** Whether an operator can see and answer a question in this conversation. */
	operatorPresent(): boolean;
}

export interface ChannelSessionProfile {
	/** Working directory: the conversation's own folder. */
	cwd: string;
	/** Where this conversation's transcripts are kept; the newest one is continued. */
	sessionDir: string;
	agentDir: string;
	/** mu's judgment layer and anything else the launcher loads with `-e`. */
	extensionPaths: readonly string[];
	skillPaths: readonly string[];
	toolAccess: ToolAccess;
	customTools: readonly ToolDefinition[];
	/** Names from `customTools` still given under `readonly`. */
	readonlyCustomTools?: readonly string[];
	/** "provider/model-id"; default: mu's own default model. */
	model?: string;
	/** mu permission mode for this conversation (`full` | `jev` | `ask`), applied with `/permissions <mode> --here`. */
	permissionMode?: string;
	/** Added to the system prompt of every turn (read each turn, so configuration changes apply at once). */
	systemPrompt: () => string | undefined;
	surface: ChatSurface;
	authorize?: (operatorId: string | undefined) => boolean;
	/** False when nobody who may answer can see the chat: questions get their default at once. Default: true. */
	answerable?: () => boolean;
	guard?: ToolGuard;
	uiTimeoutMs?: number;
	log: ChannelLogger;
}

export interface ChannelSession {
	readonly session: AgentSession;
	readonly ui: ChatUIBridge;
	readonly profile: ChannelSessionProfile;
	dispose(): Promise<void>;
}

/**
 * Opens a mu session for one chat conversation the way `mu -p` opens one (pi's createAgentSessionServices, then
 * createAgentSessionFromServices), with mu's extensions loaded, the chat as its UI and the channel's own prompt
 * and tools. Nothing in pi is changed for this: every call is pi's public SDK.
 */
export async function openChannelSession(profile: ChannelSessionProfile): Promise<ChannelSession> {
	mkdirSync(profile.cwd, { recursive: true });
	mkdirSync(profile.sessionDir, { recursive: true });
	const sessionManager = SessionManager.continueRecent(profile.cwd, profile.sessionDir);
	const guard = profile.guard;
	const roots = (guard?.roots ?? []).map((root) => {
		mkdirSync(root, { recursive: true });
		return realpathSync(root);
	});
	// Set when mu's permission gate is missing: then even operators' turns ask before anything but the file tools.
	let gateMissing = false;
	// The chat UI, once the session exists. `answersSeen` is how many answers the guard has accounted for: mu's own
	// gate runs before it on each tool call, and when an operator just answered that gate's question, asking again
	// would only repeat it.
	let bridge: ChatUIBridge | undefined;
	let answersSeen = 0;

	const channelExtension: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (event) => {
			const extra = profile.systemPrompt()?.trim();
			if (!extra) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
		});
		if (!guard) return;
		pi.on("tool_call", async (event, ctx) => {
			const justAnswered = (bridge?.answeredCount ?? 0) > answersSeen;
			answersSeen = bridge?.answeredCount ?? 0;
			if (guard.freeTools.includes(event.toolName)) return undefined;
			if (FILE_TOOLS.has(event.toolName)) {
				if (!guard.confine()) return undefined;
				const input = event.input as { path?: unknown };
				const target = typeof input.path === "string" && input.path ? input.path : ".";
				const real = resolveGuardedPath(target, profile.cwd);
				if (real && roots.some((root) => real === root || real.startsWith(root + sep))) return undefined;
				return {
					block: true,
					reason: `${target} is outside this conversation's folders; here only its working folder and its downloads can be used.`,
				};
			}
			if (guard.trusted() && !gateMissing) return undefined;
			if (justAnswered) return undefined;
			if (!guard.operatorPresent()) {
				return {
					block: true,
					reason: "Only the bot's operators (listed in allowFrom) may start this; ask one of them.",
				};
			}
			const allowed = await ctx.ui.confirm(
				"需要管理员允许",
				`${event.toolName}\n${JSON.stringify(event.input).slice(0, 400)}`,
			);
			answersSeen = bridge?.answeredCount ?? 0;
			return allowed ? undefined : { block: true, reason: "An operator did not allow this." };
		});
	};

	const services = await createAgentSessionServices({
		cwd: profile.cwd,
		agentDir: profile.agentDir,
		// A conversation's folder is written by the people in the chat: its project settings, extensions, skills and
		// MCP servers are never trusted (pi's CLI decides the same without a UI to ask in).
		settingsManager: SettingsManager.create(profile.cwd, profile.agentDir, { projectTrusted: false }),
		modelRuntimeSignal: AbortSignal.timeout(15_000),
		resourceLoaderOptions: {
			additionalExtensionPaths: [...profile.extensionPaths],
			additionalSkillPaths: [...profile.skillPaths],
			extensionFactories: [{ name: "mu-channel", factory: channelExtension, hidden: true }],
		},
	});
	for (const { path, error } of services.resourceLoader.getExtensions().errors) {
		profile.log.error(`extension ${path} failed to load: ${error}`);
	}

	let model: ReturnType<typeof services.modelRuntime.getModel>;
	if (profile.model) {
		const slash = profile.model.indexOf("/");
		model =
			slash > 0
				? services.modelRuntime.getModel(profile.model.slice(0, slash), profile.model.slice(slash + 1))
				: undefined;
		if (!model) profile.log.warn(`model ${profile.model} not found; using mu's default model`);
	}

	const customToolNames = profile.customTools.map((tool) => tool.name);
	const readonlyCustom = customToolNames.filter((name) => profile.readonlyCustomTools?.includes(name));
	const tools =
		profile.toolAccess === "none"
			? []
			: profile.toolAccess === "readonly"
				? [...READONLY_TOOLS, ...readonlyCustom]
				: undefined;

	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model,
		tools,
		customTools: [...profile.customTools],
	});

	const ui = new ChatUIBridge({
		surface: profile.surface,
		authorize: profile.authorize,
		timeoutMs: profile.uiTimeoutMs,
		answerable: profile.answerable,
		base: session.extensionRunner.getUIContext(),
		onError: (error) => profile.log.warn(`chat UI: ${error instanceof Error ? error.message : String(error)}`),
		onMutedNotice: (message, level) => profile.log.info(`notice while opening (${level}): ${message}`),
	});
	bridge = ui;
	// What the extensions say while the session starts stays in the log; questions still reach the chat.
	ui.muted = true;
	await session.bindExtensions({
		uiContext: ui.context,
		mode: "rpc",
		onError: (error) => profile.log.error(`extension error (${error.extensionPath}): ${error.error}`),
	});

	if (profile.permissionMode) {
		if (session.extensionRunner.getCommand("permissions")) {
			await session.prompt(`/permissions ${profile.permissionMode} --here`, { source: "extension" });
		} else if (profile.permissionMode !== "full") {
			// The operator asked for a gate (jev / ask) and it is not there: fail closed rather than run everything.
			gateMissing = true;
			profile.log.error("mu's permission gate is not loaded: every tool but the file tools asks an operator");
		}
	}
	ui.muted = false;

	return {
		session,
		ui,
		profile,
		dispose: async () => {
			ui.cancelAll();
			try {
				if (session.isStreaming) await session.abort();
				// What extensions started for the session (language servers, MCP servers, background jobs, timers)
				// stops on session_shutdown; pi's dispose() does not send it.
				if (session.extensionRunner.hasHandlers("session_shutdown")) {
					await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				}
			} catch (error) {
				profile.log.warn(`session shutdown: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				session.dispose();
			}
		},
	};
}

/**
 * Where a tool path really points: `~` and a leading `@` expanded as pi does, relative to `cwd`, symlinks
 * resolved. A path that does not exist yet resolves through its nearest existing parent. Undefined when a
 * link on the way points nowhere (it could be created anywhere).
 */
function resolveGuardedPath(target: string, cwd: string): string | undefined {
	let path = target.startsWith("@") ? target.slice(1) : target;
	if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) path = join(homedir(), path.slice(1));
	let current = resolve(cwd, path);
	const missing: string[] = [];
	while (!lstatSync(current, { throwIfNoEntry: false })) {
		const parent = dirname(current);
		if (parent === current) return undefined;
		missing.unshift(basename(current));
		current = parent;
	}
	try {
		return join(realpathSync(current), ...missing);
	} catch {
		return undefined;
	}
}

export interface ChannelDeliverPayload {
	text?: string;
	mediaUrl?: string;
	mediaUrls?: string[];
}

/** `block`: one finished assistant message; `final`: the answer when the turn ends; `tool`: media a tool produced. */
export interface ChannelDeliverInfo {
	kind: "block" | "tool" | "final";
}

export interface ChannelTurn {
	text: string;
	images?: ImageContent[];
	/** Let `/commands` in `text` reach mu's extensions and prompt templates. False: the text goes to the model as it is. */
	allowCommands: boolean;
	signal?: AbortSignal;
	/** The text of the assistant message being written, whole, as it grows. */
	onPartialText?: (text: string) => Promise<void>;
	deliver: (payload: ChannelDeliverPayload, info: ChannelDeliverInfo) => Promise<void>;
	/** Every session event of the turn, for monitoring. Throwing here does not affect the turn. */
	onEvent?: (event: AgentSessionEvent) => void;
	log?: ChannelLogger;
}

interface AssistantLike {
	role: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

function assistantText(message: AssistantLike): string {
	if (!Array.isArray(message.content)) return typeof message.content === "string" ? message.content : "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Coalesces partial texts: while one is being sent only the newest waits, and `flush` sends a message's last text
 * even if newer partials were skipped. OpenClaw awaited every partial inside the model stream; pi's events cannot
 * hold the stream back, so this keeps the QQ calls to one at a time without dropping the end of a message.
 */
class PartialSender {
	private readonly send: (text: string) => Promise<void>;
	private latest: string | undefined;
	private running: Promise<void> | undefined;
	private forced: string[] = [];

	constructor(send: (text: string) => Promise<void>) {
		this.send = send;
	}

	push(text: string): void {
		this.latest = text;
		this.pump();
	}

	/** The message ended with `text`: it is sent, in order, before anything pushed later. */
	flush(text: string): void {
		this.forced.push(text);
		this.latest = undefined;
		this.pump();
	}

	private pump(): void {
		if (this.running) return;
		this.running = (async () => {
			try {
				while (this.forced.length > 0 || this.latest !== undefined) {
					const next = this.forced.length > 0 ? (this.forced.shift() as string) : (this.latest as string);
					if (this.forced.length === 0 && next === this.latest) this.latest = undefined;
					await this.send(next);
				}
			} finally {
				this.running = undefined;
			}
		})();
	}

	async idle(): Promise<void> {
		while (this.running) await this.running;
	}
}

/**
 * Runs one chat message through a mu session and hands what mu says to `deliver`, in order: each finished assistant
 * message as a `block`, then the turn's last assistant text as `final` (the channel removes what it already sent).
 * A failed turn delivers `⚠️ <error>` as `final`. Aborting `signal` stops the turn.
 */
export async function runChannelTurn(session: AgentSession, turn: ChannelTurn): Promise<void> {
	let chain: Promise<void> = Promise.resolve();
	const enqueue = (payload: ChannelDeliverPayload, info: ChannelDeliverInfo) => {
		chain = chain
			.then(() => turn.deliver(payload, info))
			.catch((error) => {
				turn.log?.error(`deliver ${info.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
			});
	};
	const partials = turn.onPartialText
		? new PartialSender(async (text) => {
				try {
					await turn.onPartialText?.(text);
				} catch (error) {
					turn.log?.error(`partial text failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			})
		: undefined;

	let lastAssistant: AssistantLike | undefined;
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		try {
			turn.onEvent?.(event);
		} catch (error) {
			turn.log?.warn(`event monitor failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (event.type === "message_update" && (event.message as AssistantLike).role === "assistant") {
			const text = assistantText(event.message as AssistantLike);
			if (text) partials?.push(text);
			return;
		}
		if (event.type === "message_end" && (event.message as AssistantLike).role === "assistant") {
			const message = event.message as AssistantLike;
			lastAssistant = message;
			const text = assistantText(message);
			// A message that failed or was stopped is not an answer: pi may retry it, and the final reports the error.
			if (text && message.stopReason !== "error" && message.stopReason !== "aborted") {
				partials?.flush(text);
				// The partial lane must have caught up before the block is judged, as OpenClaw's serial dispatcher did.
				const flushed = partials?.idle();
				chain = chain.then(() => flushed);
				enqueue({ text }, { kind: "block" });
			}
		}
	});

	const onAbort = () => void session.abort();
	turn.signal?.addEventListener("abort", onAbort, { once: true });
	let failure: string | undefined;
	try {
		if (turn.signal?.aborted) return;
		await session.prompt(turn.text, {
			images: turn.images,
			expandPromptTemplates: turn.allowCommands,
			source: "rpc",
		});
		await session.waitForIdle();
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	} finally {
		turn.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
	}

	await partials?.idle();
	if (!turn.signal?.aborted) {
		if (failure) {
			enqueue({ text: `⚠️ ${failure}` }, { kind: "final" });
		} else if (lastAssistant?.stopReason === "error") {
			enqueue({ text: `⚠️ ${lastAssistant.errorMessage ?? "mu could not answer"}` }, { kind: "final" });
		} else if (lastAssistant && lastAssistant.stopReason !== "aborted") {
			const text = assistantText(lastAssistant);
			enqueue({ text }, { kind: "final" });
		} else if (!lastAssistant) {
			// A command ran, or nothing was said: the final still closes the stream and flushes the channel's queues.
			enqueue({}, { kind: "final" });
		}
	}
	await chain;
}

export interface IsolatedPromptOptions {
	cwd: string;
	agentDir: string;
	prompt: string;
	/** "provider/model-id"; default: mu's own default model. */
	model?: string;
	timeoutMs?: number;
	log?: ChannelLogger;
}

/**
 * One prompt in a session of its own: nothing loaded (no extensions, skills, context files or tools), nothing
 * kept (in memory only). For work a channel does on its own, such as writing a reminder, that must not appear in
 * any conversation. Returns the assistant's text; throws when the model fails or says nothing.
 */
export async function runIsolatedPrompt(options: IsolatedPromptOptions): Promise<string> {
	mkdirSync(options.cwd, { recursive: true });
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false }),
		modelRuntimeSignal: AbortSignal.timeout(15_000),
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			noThemes: true,
		},
	});
	let model: ReturnType<typeof services.modelRuntime.getModel>;
	if (options.model) {
		const slash = options.model.indexOf("/");
		if (slash > 0)
			model = services.modelRuntime.getModel(options.model.slice(0, slash), options.model.slice(slash + 1));
		if (!model) options.log?.warn(`model ${options.model} not found; using mu's default model`);
	}
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(options.cwd),
		model,
		tools: [],
	});
	const timer = setTimeout(() => void session.abort(), options.timeoutMs ?? 60_000);
	let last: AssistantLike | undefined;
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_end" && (event.message as AssistantLike).role === "assistant") {
			last = event.message as AssistantLike;
		}
	});
	try {
		await session.prompt(options.prompt, { expandPromptTemplates: false, source: "rpc" });
		await session.waitForIdle();
	} finally {
		clearTimeout(timer);
		unsubscribe();
		session.dispose();
	}
	if (!last || last.stopReason === "error" || last.stopReason === "aborted") {
		throw new Error(last?.errorMessage ?? "the model gave no answer");
	}
	const text = assistantText(last).trim();
	if (!text) throw new Error("the model gave no answer");
	return text;
}
