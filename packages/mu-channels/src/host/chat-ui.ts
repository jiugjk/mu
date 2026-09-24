import { randomBytes } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

/** A question mu asks the people in a chat: an approval, a choice, a line of text. */
export interface ChatPrompt {
	/** Short id carried by the answer (a button's data, or nothing when answered by text). */
	readonly id: string;
	readonly kind: "select" | "confirm" | "input";
	readonly title: string;
	readonly message?: string;
	/** The choices, in order; empty for `input`. */
	readonly options: readonly string[];
}

/**
 * How a chat channel shows mu's questions. The channel decides the form (buttons, a numbered list, both); the bridge
 * decides what counts as an answer and who may give it.
 */
export interface ChatSurface {
	ask(prompt: ChatPrompt): Promise<void>;
	notify(message: string, level: "info" | "warning" | "error"): void;
	/** Called once a question is answered, timed out or cancelled (`answer` undefined), e.g. to say what was decided. */
	settled?(prompt: ChatPrompt, answer: string | undefined, by: string | undefined): void;
}

export interface ChatUIOptions {
	surface: ChatSurface;
	/** Who may answer. Called with the id of the person who clicked or replied. Default: anyone. */
	authorize?: (operatorId: string | undefined) => boolean;
	/** An unanswered question gets its default (no, nothing chosen) after this long. Default 10 minutes. */
	timeoutMs?: number;
	/** The context the session had before (pi's no-op one): theme and the terminal-only calls come from it. */
	base: ExtensionUIContext;
	onError?: (error: unknown) => void;
	/** Where notices go while the bridge is muted (e.g. a log). */
	onMutedNotice?: (message: string, level: "info" | "warning" | "error") => void;
}

export type AnswerOutcome = "answered" | "unknown" | "unauthorized" | "invalid";

interface Pending {
	prompt: ChatPrompt;
	finish(answer: string | undefined, by: string | undefined): void;
}

const CONFIRM_OPTIONS = ["确认", "取消"] as const;
const YES = new Set(["1", "y", "yes", "ok", "是", "好", "确认", "同意", "允许"]);
const NO = new Set(["2", "n", "no", "否", "不", "取消", "拒绝"]);

/**
 * mu's extensions ask through `ctx.ui` (select / confirm / input): the permission gate, the risk guard, MCP and
 * checkpoints all do. In a chat there is no terminal dialog, so the bridge sends each question into the chat and
 * waits for a button click or a reply. Only people `authorize` accepts can answer; an unanswered question falls
 * back to the dialog's default (for an approval: not allowed). Everything terminal-only (widgets, editor, footer)
 * does nothing, as in pi's RPC mode.
 */
export class ChatUIBridge {
	private readonly pending = new Map<string, Pending>();
	private readonly options: ChatUIOptions;
	readonly context: ExtensionUIContext;
	/**
	 * While true, notices are not sent into the chat but to `onMutedNotice`: what extensions say while a session
	 * opens (welcome lines, what was loaded) is for a terminal, not for the people in a chat.
	 */
	muted = false;

	constructor(options: ChatUIOptions) {
		this.options = options;
		this.context = this.createContext();
	}

	get hasPending(): boolean {
		return this.pending.size > 0;
	}

	pendingPrompts(): ChatPrompt[] {
		return [...this.pending.values()].map((entry) => entry.prompt);
	}

	/** A button click: `index` into the prompt's options. */
	answer(promptId: string, index: number, operatorId: string | undefined): AnswerOutcome {
		const entry = this.pending.get(promptId);
		if (!entry) return "unknown";
		if (!this.authorized(operatorId)) return "unauthorized";
		const option = entry.prompt.options[index];
		if (option === undefined) return "invalid";
		entry.finish(option, operatorId);
		return "answered";
	}

	/**
	 * A chat message while a question waits: the number of an option, its text, or (for `input`) any text answers
	 * the newest question. Returns false when the message is not an answer, so it goes on to mu as usual.
	 */
	answerText(text: string, senderId: string | undefined): AnswerOutcome {
		const entries = [...this.pending.values()];
		const entry = entries[entries.length - 1];
		if (!entry) return "unknown";
		const reply = text.trim();
		if (!reply) return "invalid";
		const { prompt } = entry;
		let answer: string | undefined;
		if (prompt.kind === "input") {
			answer = reply;
		} else if (prompt.kind === "confirm") {
			const word = reply.toLowerCase();
			if (YES.has(word)) answer = CONFIRM_OPTIONS[0];
			else if (NO.has(word)) answer = CONFIRM_OPTIONS[1];
		} else {
			const number = /^\d+$/.test(reply) ? Number(reply) : Number.NaN;
			answer = Number.isInteger(number) ? prompt.options[number - 1] : prompt.options.find((each) => each === reply);
		}
		if (answer === undefined) return "invalid";
		if (!this.authorized(senderId)) return "unauthorized";
		entry.finish(answer, senderId);
		return "answered";
	}

	/** Gives every waiting question its default: the turn was stopped or the session is closing. */
	cancelAll(): void {
		for (const entry of [...this.pending.values()]) entry.finish(undefined, undefined);
	}

	private authorized(operatorId: string | undefined): boolean {
		return this.options.authorize ? this.options.authorize(operatorId) : true;
	}

	private ask(
		kind: ChatPrompt["kind"],
		title: string,
		message: string | undefined,
		options: readonly string[],
		dialog: ExtensionUIDialogOptions | undefined,
	): Promise<string | undefined> {
		if (dialog?.signal?.aborted) return Promise.resolve(undefined);
		const prompt: ChatPrompt = { id: randomBytes(4).toString("hex"), kind, title, message, options };
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => finish(undefined, undefined);
			const finish = (answer: string | undefined, by: string | undefined) => {
				if (!this.pending.delete(prompt.id)) return;
				if (timer) clearTimeout(timer);
				dialog?.signal?.removeEventListener("abort", onAbort);
				try {
					this.options.surface.settled?.(prompt, answer, by);
				} catch (error) {
					this.options.onError?.(error);
				}
				resolve(answer);
			};
			this.pending.set(prompt.id, { prompt, finish });
			dialog?.signal?.addEventListener("abort", onAbort, { once: true });
			const timeoutMs = dialog?.timeout ?? this.options.timeoutMs ?? 10 * 60_000;
			if (timeoutMs > 0) timer = setTimeout(() => finish(undefined, undefined), timeoutMs);
			this.options.surface.ask(prompt).catch((error) => {
				// A question nobody can see cannot be answered: take the default now instead of after the timeout.
				this.options.onError?.(error);
				finish(undefined, undefined);
			});
		});
	}

	private createContext(): ExtensionUIContext {
		const base = this.options.base;
		const surface = this.options.surface;
		return {
			select: (title, options, dialog) => this.ask("select", title, undefined, options, dialog),
			confirm: async (title, message, dialog) =>
				(await this.ask("confirm", title, message, CONFIRM_OPTIONS, dialog)) === CONFIRM_OPTIONS[0],
			input: (title, placeholder, dialog) => this.ask("input", title, placeholder, [], dialog),
			notify: (message, type) => {
				try {
					if (this.muted) this.options.onMutedNotice?.(message, type ?? "info");
					else surface.notify(message, type ?? "info");
				} catch (error) {
					this.options.onError?.(error);
				}
			},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: (title) => this.ask("input", title, undefined, [], undefined),
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return base.theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "No theme in a chat channel" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}
}
