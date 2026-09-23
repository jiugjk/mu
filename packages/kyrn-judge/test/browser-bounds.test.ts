import { describe, expect, it } from "vitest";
import { runBrowserTask } from "../src/browser/agent.ts";
import { Bounds } from "../src/browser/bounds.ts";
import type { BrowserSession, PageAction, PageState } from "../src/browser/session.ts";
import { DecisionEngine } from "../src/decision.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const choose = (choice: string): Answer => ({ type: "choice", choice, probabilities: { [choice]: 0.97 } });

const at = (url: string, text: string, actions: PageAction[] = []): PageState => ({
	url,
	title: text,
	text,
	actions,
	marker: url,
	page_key: url,
	guards: {},
	omitted_actions: 0,
	fingerprint: url,
});

const link: PageAction = { id: "e1", kind: "click", node: 1, role: "link", label: "Read more" };

/** Name resolution without a network: a name missing here does not resolve. */
const DNS: Readonly<Record<string, readonly string[]>> = {
	"news.example": ["93.184.216.34"],
	"cdn.example": ["151.101.1.1"],
	"intranet.example": ["10.1.2.3"],
	"split.example": ["151.101.1.1", "127.0.0.1"],
	"myapp.test": ["127.0.0.1"],
};
const resolve = async (host: string): Promise<readonly string[]> => {
	const answer = DNS[host];
	if (!answer) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
	return answer;
};

/** A tab that starts at `start` and goes to the next page on every click. */
function tab(start: string, pages: PageState[]) {
	let now = 0;
	return {
		start,
		observe: async () => pages[now],
		fresh: async () => true,
		act: async () => {
			now = Math.min(now + 1, pages.length - 1);
		},
	} as unknown as BrowserSession;
}

/** A judge that clicks the first element and writes down everything it was shown. */
function clicker() {
	const seen: string[] = [];
	const engine = new DecisionEngine({
		judge: new Judge({
			provider: new MockJudgeProvider((request) => {
				seen.push(JSON.stringify(request.state));
				return { operation: choose("CLICK"), click_target: choose("1") };
			}),
		}),
		defaultMode: "active",
	});
	return { engine, seen };
}

describe("where the built-in browser may go", () => {
	it("anywhere on the public web, but a page may not send it to this computer, the local network or a file", async () => {
		const bounds = new Bounds("https://news.example/today", resolve);
		for (const url of [
			"https://news.example/other",
			"https://cdn.example/a.png",
			// Resolved by the browser through a proxy, perhaps: somewhere on the web.
			"http://unknown.example/",
			"about:blank",
			"chrome-error://chromewebdata/",
			"blob:https://cdn.example/1234",
		])
			expect(await bounds.refuse(url), url).toBeUndefined();

		const refused = async (url: string) => {
			const refusal = await bounds.refuse(url);
			return refusal && `${refusal.where} = ${refusal.what}`;
		};
		expect(await refused("http://127.0.0.1:8500/v1/kv/?recurse")).toBe("http://127.0.0.1:8500 = this computer");
		expect(await refused("http://[::1]:3000/")).toBe("http://[::1]:3000 = this computer");
		expect(await refused("http://[::ffff:127.0.0.1]/")).toBe("http://[::ffff:7f00:1] = this computer");
		expect(await refused("http://localhost:3000/admin")).toBe("http://localhost:3000 = this computer");
		expect(await refused("http://app.localhost./")).toBe("http://app.localhost. = this computer");
		expect(await refused("http://2130706433/")).toBe("http://127.0.0.1 = this computer");
		expect(await refused("http://myapp.test/")).toBe("http://myapp.test = this computer");
		expect(await refused("http://split.example/")).toBe("http://split.example = this computer");
		expect(await refused("http://192.168.1.1/")).toBe("http://192.168.1.1 = the local network");
		expect(await refused("http://intranet.example/wiki")).toBe("http://intranet.example = the local network");
		expect(await refused("http://169.254.169.254/latest/meta-data/")).toContain("metadata service");
		expect(await refused("http://0.0.0.0:8080/")).toBe("http://0.0.0.0:8080 = a reserved address");
		expect(await refused("file:///etc/passwd")).toBe("file: = not a web page");
		expect(await refused("chrome://settings/")).toBe("chrome: = not a web page");
		expect(await refused("data:text/html,hello")).toBe("data: = not a web page");
	});

	it("a run opened on this computer or the local network may stay in that kind of place", async () => {
		const dev = new Bounds("http://localhost:3000/", resolve);
		expect(await dev.refuse("http://127.0.0.1:3000/login")).toBeUndefined();
		expect(await dev.refuse("http://myapp.test/")).toBeUndefined();
		expect(await dev.refuse("https://cdn.example/sign-in")).toBeUndefined();
		expect((await dev.refuse("http://192.168.1.1/"))?.what).toBe("the local network");

		const router = new Bounds("http://192.168.1.1/", resolve);
		expect(await router.refuse("http://192.168.1.1/admin")).toBeUndefined();
		expect(await router.refuse("http://intranet.example/")).toBeUndefined();
		expect((await router.refuse("http://127.0.0.1:8500/"))?.what).toBe("this computer");
	});

	it("refuses at once when the address itself redirected there, before the judge is asked", async () => {
		const { engine, seen } = clicker();
		const session = tab("https://news.example/", [at("http://intranet.example/hr/salaries", "salaries of everyone")]);

		const result = await runBrowserTask({
			session,
			engine,
			goal: "Read it",
			writeText: async () => undefined,
			resolve,
		});

		expect(result).toMatchObject({
			status: "blocked",
			code: "off_the_web",
			params: { where: "http://intranet.example" },
			page: { url: "http://intranet.example", title: "", text: "" },
			history: [],
		});
		expect(seen).toEqual([]);
	});

	it("stops when a page sends it to this computer, and nothing of that page reaches the judge or the model", async () => {
		const { engine, seen } = clicker();
		const session = tab("https://93.184.216.34/news", [
			at("https://93.184.216.34/news", "Latest news", [link]),
			at("http://127.0.0.1:8500/v1/kv/?recurse", "DATABASE_PASSWORD=hunter2", [link]),
		]);

		const result = await runBrowserTask({
			session,
			engine,
			goal: "Read the article",
			writeText: async () => undefined,
		});

		expect(result).toMatchObject({
			status: "blocked",
			code: "off_the_web",
			params: { where: "http://127.0.0.1:8500" },
		});
		expect(JSON.stringify(result)).not.toContain("hunter2");
		expect(seen).toHaveLength(1);
		expect(seen.join("\n")).not.toContain("hunter2");
	});
});
