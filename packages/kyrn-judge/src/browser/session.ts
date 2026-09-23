import { createHash } from "node:crypto";
import type { CdpConnection } from "./cdp.ts";
import { SNAPSHOT_SCRIPT } from "./snapshot.ts";

export type ActionKind = "click" | "fill" | "select" | "scroll" | "wait";

/** One thing the page offers right now. `node` is a code-owned identity of the real DOM element. */
export interface PageAction {
	readonly id: string;
	readonly kind: ActionKind;
	readonly label: string;
	readonly node?: number;
	readonly role?: string;
	readonly value?: string;
	readonly current_value?: string;
	readonly checked?: string;
	readonly selected?: string;
	readonly expanded?: string;
	readonly delta?: number;
}

export interface PageState {
	readonly url: string;
	readonly title: string;
	readonly text: string;
	readonly actions: readonly PageAction[];
	readonly marker: unknown;
	readonly page_key: unknown;
	readonly guards: Readonly<Record<string, unknown>>;
	readonly omitted_actions: number;
	readonly fingerprint: string;
}

/** The decision no longer refers to the page as it is now. Observe again and decide again. */
export class StalePage extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One owned tab. Observation and execution follow jev-ultrafast's design:
 * decisions are made against a snapshot, and every action re-checks that the
 * page still means what it meant when the decision was taken.
 */
export class BrowserSession {
	/** The address this tab was opened on: where the run was asked to go, before any page sent it elsewhere. */
	readonly start: string;
	private readonly cdp: CdpConnection;
	private readonly targetId: string;
	private readonly sessionId: string;
	private afterInput: PageAction | undefined;

	private constructor(cdp: CdpConnection, targetId: string, sessionId: string, start: string) {
		this.cdp = cdp;
		this.targetId = targetId;
		this.sessionId = sessionId;
		this.start = start;
	}

	static async open(cdp: CdpConnection, url: string): Promise<BrowserSession> {
		const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
		let session: BrowserSession;
		try {
			const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as {
				sessionId: string;
			};
			session = new BrowserSession(cdp, targetId, sessionId, url);
			await session.call("Emulation.setDeviceMetricsOverride", {
				width: 1120,
				height: 780,
				deviceScaleFactor: 1,
				mobile: false,
			});
			// Keeps animation frames and menus rendering in a tab that is never brought to the front.
			await session.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			await session.call("Page.navigate", { url });
		} catch (error) {
			// No run owns the tab yet, so nothing else would close it.
			await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
			throw error;
		}
		// The document itself gets 15 s. Its images, fonts and trackers get 3 s more: a slow third party
		// must not hold up a page that can already be read and operated.
		const deadline = Date.now() + 15_000;
		let parsedAt: number | undefined;
		while (Date.now() < deadline) {
			const state = await session.evaluate("document.readyState").catch(() => undefined);
			if (state === "complete") break;
			if (state === "interactive") {
				parsedAt ??= Date.now();
				if (Date.now() - parsedAt > 3_000) break;
			}
			await sleep(20);
		}
		return session;
	}

	/** The DevTools session of this tab. The desktop app's bridge uses it to tell runs on one connection apart. */
	get id(): string {
		return this.sessionId;
	}

	private async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		try {
			return await this.cdp.send(method, params, this.sessionId);
		} catch (error) {
			// In the app, keys go to whatever holds the window's keyboard. When the page does not, the app types
			// nothing rather than into the person's message box. That is a page to look at again, not a failure.
			if (
				method.startsWith("Input.") &&
				error instanceof Error &&
				/does not hold the keyboard/.test(error.message)
			) {
				throw new StalePage(error.message);
			}
			throw error;
		}
	}

	private async evaluate(expression: string, awaitPromise = false): Promise<unknown> {
		const response = (await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise })) as {
			result?: { value?: unknown };
			exceptionDetails?: unknown;
		};
		if (response.exceptionDetails) throw new StalePage("The document changed during evaluation");
		return response.result?.value;
	}

	async observe(): Promise<PageState> {
		if (this.afterInput) {
			const action = this.afterInput;
			this.afterInput = undefined;
			// Let the page react: two animation frames or 50 ms; an autocomplete field gets up to 200 ms for its options.
			await this.evaluate(
				`(action => new Promise(resolve => {
					const field = window.__kyrnBrowser?.nodes.get(action.node);
					const autocomplete = action.kind === 'fill' && field?.getAttribute('role') === 'combobox';
					let frames = 0, stopped = false;
					const finish = () => { stopped = true; resolve(true); };
					setTimeout(finish, autocomplete ? 200 : 50);
					const ready = () => {
						if (stopped) return;
						const visible = (window.__kyrnBrowser?.all('[role="option"]') ?? []).some(e => {
							const r = e.getBoundingClientRect();
							return r.width && r.height && r.bottom > 0 && r.top < innerHeight;
						});
						if (++frames >= 2 && (!autocomplete || visible)) finish();
						else requestAnimationFrame(ready);
					};
					requestAnimationFrame(ready);
				}))(${JSON.stringify(action)})`,
				true,
			).catch(() => undefined);
		}
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				const info = (await this.evaluate(SNAPSHOT_SCRIPT)) as Omit<PageState, "fingerprint"> | null;
				if (info === null || info === undefined) throw new StalePage("The document is navigating");
				const content = { url: info.url, text: info.text, actions: info.actions };
				const fingerprint = createHash("sha256").update(JSON.stringify(content)).digest("hex");
				return { ...info, fingerprint };
			} catch (error) {
				if (!(error instanceof StalePage) || attempt === 9) throw error;
				await sleep(40);
			}
		}
		throw new StalePage("The page did not settle");
	}

	/** Does the page still mean what it meant when `page` was observed? Clicks compare only the target and its surroundings. */
	async fresh(page: PageState, action?: PageAction): Promise<boolean> {
		try {
			if (action && (action.kind === "click" || action.kind === "select")) {
				if (typeof action.node !== "number") return false;
				const current = await this.evaluate(
					`(() => { const c = window.__kyrnBrowser; return c ? [c.pageKey(), c.guard(c.nodes.get(${action.node}))] : null; })()`,
				);
				return same(current, [page.page_key, page.guards[String(action.node)]]);
			}
			const marker = await this.evaluate(
				`(() => { const state = ${SNAPSHOT_SCRIPT}; return state?.marker ?? null; })()`,
			);
			return same(marker, page.marker);
		} catch {
			return false;
		}
	}

	async act(action: PageAction, page: PageState, text?: string): Promise<void> {
		if (!(await this.fresh(page, action))) throw new StalePage("The page changed since this decision");
		if (action.kind === "wait") {
			await sleep(100);
			return;
		}
		if (action.kind === "scroll") {
			await this.call("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: 550,
				y: 650,
				deltaX: 0,
				deltaY: action.delta ?? 560,
			});
			this.afterInput = action;
			return;
		}
		if (typeof action.node !== "number") throw new StalePage("The action has no observed node");
		// Geometry is resolved and hit-tested now, never trusted from the snapshot.
		const target = (await this.evaluate(
			`(action => {
				const e = window.__kyrnBrowser?.nodes.get(action.node);
				const c = window.__kyrnBrowser;
				if (!e?.isConnected || e.matches(':disabled') || c.closest(e, '[aria-disabled="true"],[inert]') ||
					!e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return null;
				if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
				const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
				if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
				if (!c.contains(e, c.hit(x, y))) return null;
				if (action.kind === 'select') {
					if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value && !o.disabled)) return null;
					e.value = action.value;
					e.dispatchEvent(new Event('input', {bubbles: true}));
					e.dispatchEvent(new Event('change', {bubbles: true}));
				}
				return {x, y};
			})(${JSON.stringify(action)})`,
		)) as { x: number; y: number } | null;
		if (!target) throw new StalePage("The target changed or is covered");

		if (action.kind !== "select") {
			for (const type of ["mousePressed", "mouseReleased"]) {
				await this.call("Input.dispatchMouseEvent", {
					type,
					x: target.x,
					y: target.y,
					button: "left",
					clickCount: 1,
				});
			}
			if (action.kind === "fill") {
				const modifiers = process.platform === "darwin" ? 4 : 2;
				await this.call("Input.dispatchKeyEvent", {
					type: "keyDown",
					key: "a",
					code: "KeyA",
					modifiers,
					commands: ["selectAll"],
				});
				await this.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers });
				await this.call("Input.insertText", { text: text ?? "" });
			}
		}
		this.afterInput = action;
	}

	async close(): Promise<void> {
		await this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
	}
}
