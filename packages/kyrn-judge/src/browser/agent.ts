import type { DecisionEngine } from "../decision.ts";
import {
	type BrowserStepInput,
	browserStep,
	type ElementRow,
	type Operation,
	type TargetOption,
} from "../decisions/browser-step.ts";
import { Bounds, type Refusal, type ResolveHost, refusalReason } from "./bounds.ts";
import { type BrowserSession, type PageAction, type PageState, StalePage } from "./session.ts";

const OPERATION_OF: Readonly<Partial<Record<PageAction["kind"], Operation>>> = {
	click: "CLICK",
	fill: "TYPE_TEXT",
	select: "SELECT",
};

/** Labels that spend money, destroy data or speak for the user. These never run without a yes. */
const IRREVERSIBLE =
	/\b(pay|purchase|buy now|place (the |your )?order|check ?out|delete|remove|send|transfer|subscribe|unsubscribe|sign out|log ?out)\b|支付|付款|购买|下单|结算|删除|发送|转账|订阅|退出登录/i;

export interface ActionSpace {
	readonly elements: ElementRow[];
	readonly targets: Partial<Record<Operation, Record<string, TargetOption>>>;
	readonly actionFor: Map<string, PageAction>;
	readonly controls: Record<string, string>;
}

/** One index per observed element; each operation gets its own table of valid targets. */
export function actionSpace(actions: readonly PageAction[]): ActionSpace {
	const elements: ElementRow[] = [];
	const indexOfNode = new Map<number, string>();
	const targets: Partial<Record<Operation, Record<string, TargetOption>>> = {};
	const actionFor = new Map<string, PageAction>();
	const controls: Record<string, string> = {};

	for (const action of actions) {
		const operation = OPERATION_OF[action.kind];
		if (!operation || action.node === undefined) {
			const id = action.id.toUpperCase();
			controls[id] = action.label;
			actionFor.set(id, action);
			continue;
		}
		let index = indexOfNode.get(action.node);
		if (!index) {
			index = String(elements.length + 1);
			indexOfNode.set(action.node, index);
			elements.push({
				index,
				label: action.label.split(" → ")[0],
				role: action.role,
				value: action.kind === "select" ? (action.current_value ?? "") : action.value,
				checked: action.checked,
				selected: action.selected,
				expanded: action.expanded,
				operations: [],
				options: action.kind === "select" ? [] : undefined,
			});
		}
		const element = elements[Number(index) - 1];
		if (!element.operations.includes(operation)) element.operations.push(operation);
		let target = index;
		if (action.kind === "select") {
			target = `${index}:${(element.options?.length ?? 0) + 1}`;
			element.options?.push({ index: target, label: action.label, value: action.value });
		}
		const table = targets[operation] ?? {};
		targets[operation] = table;
		table[target] = {
			element: `[${target}] ${action.label}`,
			current_value: action.current_value ?? action.value ?? "",
			role: action.role,
			checked: action.checked,
			selected: action.selected,
			expanded: action.expanded,
		};
		actionFor.set(`${operation}:${target}`, action);
	}
	return { elements, targets, actionFor, controls };
}

export interface BrowserStepRecord {
	readonly step: number;
	readonly action: string;
	readonly kind: string;
	readonly text?: string;
	readonly probability?: number;
	page_changed?: boolean;
	url?: string;
}

export interface FieldContext {
	readonly goal: string;
	readonly field: { readonly label: string; readonly role?: string; readonly value?: string };
	readonly page: { readonly title: string; readonly text: string };
	readonly recent_actions: readonly { action: string; text?: string }[];
}

export interface BrowserTaskOptions {
	readonly session: BrowserSession;
	readonly engine: DecisionEngine;
	readonly goal: string;
	/** Supplies the string to type. Judges choose; they cannot write. */
	readonly writeText: (context: FieldContext) => Promise<string | undefined>;
	/** Asked before an action that looks irreversible. Absent means "never allowed". */
	readonly confirm?: (label: string, url: string) => Promise<boolean>;
	/** Asked before every step. False ends the run: someone watching it said stop. It may take its time (a pause). */
	readonly beforeStep?: () => Promise<boolean>;
	readonly maxSteps?: number;
	readonly signal?: AbortSignal;
	readonly onStep?: (record: BrowserStepRecord) => void;
	/** For tests: how host names are resolved when a page leaves the host the run was opened on. */
	readonly resolve?: ResolveHost;
}

/**
 * Why a run ended, as a stable code a client can translate. `reason` stays the
 * English of it, and `params` holds what the sentence names (a count, a label).
 */
export type BrowserEndCode =
	| "done"
	| "cancelled"
	| "stopped_by_user"
	| "max_steps"
	| "no_judge"
	| "no_progress"
	| "not_confirmed"
	| "no_value"
	| "stuck"
	| "off_the_web";

export interface BrowserTaskResult {
	readonly status: "done" | "blocked" | "budget" | "needs_confirmation" | "aborted";
	readonly code: BrowserEndCode;
	readonly reason?: string;
	readonly params?: Readonly<Record<string, string | number>>;
	readonly page: { readonly url: string; readonly title: string; readonly text: string };
	readonly history: readonly BrowserStepRecord[];
	readonly decisions: number;
	readonly elapsedMs: number;
}

/**
 * The loop: observe, one judge call, act, observe. The judge never produces a
 * selector or a coordinate; it picks among elements the snapshot found, and
 * the executor re-checks the page right before every input.
 */
export async function runBrowserTask(options: BrowserTaskOptions): Promise<BrowserTaskResult> {
	const { session, engine, goal } = options;
	const maxSteps = options.maxSteps ?? 40;
	const startedAt = performance.now();
	const history: BrowserStepRecord[] = [];
	let decisions = 0;
	const bounds = new Bounds(session.start, options.resolve);
	let page: PageState = await session.observe();

	const finish = (
		status: BrowserTaskResult["status"],
		code: BrowserEndCode,
		reason?: string,
		params?: Readonly<Record<string, string | number>>,
	): BrowserTaskResult => ({
		status,
		code,
		reason,
		...(params ? { params } : {}),
		page: { url: page.url, title: page.title, text: page.text },
		history,
		decisions,
		elapsedMs: Math.round(performance.now() - startedAt),
	});

	/**
	 * After every observation: when a page has sent the browser where it may not be, nothing of that page is kept,
	 * for the judge, the writer or the model, and the run ends.
	 */
	const within = async (): Promise<Refusal | undefined> => {
		const refused = await bounds.refuse(page.url);
		if (refused) page = { ...page, url: refused.where, title: "", text: "", actions: [] };
		return refused;
	};
	const look = async (): Promise<Refusal | undefined> => {
		page = await session.observe();
		return within();
	};
	const offTheWeb = (refused: Refusal) =>
		finish("blocked", "off_the_web", refusalReason(refused), { where: refused.where });

	// The address itself may already have redirected elsewhere.
	const opened = await within();
	if (opened) return offTheWeb(opened);

	while (true) {
		if (options.signal?.aborted) return finish("aborted", "cancelled");
		if (options.beforeStep && !(await options.beforeStep()))
			return finish("aborted", "stopped_by_user", "stopped by the person watching");
		if (history.length >= maxSteps || decisions >= maxSteps * 2)
			return finish("budget", "max_steps", `stopped after ${maxSteps} actions`, { maxSteps });
		if (!(await session.fresh(page))) {
			const refused = await look();
			if (refused) return offTheWeb(refused);
		}

		const space = actionSpace(page.actions);
		const input: BrowserStepInput = {
			goal,
			page: { url: page.url, title: page.title, text: page.text },
			elements: space.elements,
			targets: space.targets,
			controls: space.controls,
			recentActions: history
				.slice(-10)
				.map(({ action, kind, text, page_changed }) => ({ action, kind, text, page_changed })),
		};
		decisions++;
		const decision = await engine.decide(browserStep, input, { signal: options.signal });
		// The judge is the actor here, so its verdict is used whatever the decision mode says.
		const verdict = decision.judged;
		if (!verdict) {
			const why = decision.reason ?? "no verdict";
			return finish("blocked", "no_judge", `no judge could choose an action (${why})`, { judgeReason: why });
		}
		if (verdict.operation === "DONE") return finish("done", "done");
		if (verdict.operation === "BLOCKED")
			return finish("blocked", "no_progress", "the judge found no operation that makes progress");

		const key =
			verdict.operation in space.targets ? `${verdict.operation}:${verdict.target ?? ""}` : verdict.operation;
		const action = space.actionFor.get(key);
		if (!action) {
			// An operation without a usable target is a wasted step, not a crash.
			history.push({
				step: history.length + 1,
				action: `${verdict.operation} (no target)`,
				kind: "none",
				page_changed: false,
			});
		} else {
			let text: string | undefined;
			if (action.kind === "click" && IRREVERSIBLE.test(action.label)) {
				const allowed = options.confirm ? await options.confirm(action.label, page.url) : false;
				if (!allowed)
					return finish(
						"needs_confirmation",
						"not_confirmed",
						`"${action.label}" looks irreversible and was not confirmed`,
						{ label: action.label },
					);
			}
			if (action.kind === "fill") {
				text = await options.writeText({
					goal,
					field: { label: action.label, role: action.role, value: action.value },
					page: { title: page.title, text: page.text.slice(0, 6000) },
					recent_actions: history.slice(-6).map((entry) => ({ action: entry.action, text: entry.text })),
				});
				if (!text)
					return finish("blocked", "no_value", `no value could be produced for "${action.label}"`, {
						label: action.label,
					});
			}
			try {
				await session.act(action, page, text);
			} catch (error) {
				if (!(error instanceof StalePage)) throw error;
				const refused = await look();
				if (refused) return offTheWeb(refused);
				continue;
			}
			const record: BrowserStepRecord = {
				step: history.length + 1,
				action: action.label,
				kind: action.kind,
				text,
				probability: verdict.probability ?? undefined,
			};
			// Logged before observing: a navigation during the next observation must not erase the action.
			history.push(record);
			const before = page.fingerprint;
			const refused = await look();
			record.page_changed = page.fingerprint !== before;
			record.url = page.url;
			options.onStep?.(record);
			if (refused) return offTheWeb(refused);
		}

		const lastThree = history.slice(-3);
		if (lastThree.length === 3 && lastThree.every((entry) => entry.page_changed === false && entry.kind !== "wait")) {
			return finish("blocked", "stuck", "three actions in a row changed nothing", { actions: 3 });
		}
	}
}
