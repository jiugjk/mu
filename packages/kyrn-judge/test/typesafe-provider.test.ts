import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { isJudgeError } from "../src/errors.ts";
import { TypeSafeJudgeProvider } from "../src/providers/typesafe.ts";
import { buildJudge } from "../src/registry.ts";
import type { Questions } from "../src/types.ts";

const questions = {
	edit: { type: "boolean", instructions: "Does `user_message` ask for a code change?" },
	kind: { type: "choice", instructions: "What is it?", criteria: { chat: "Small talk", other: "Something else" } },
	size: { type: "score", instructions: "How big?", criteria: ["small", "medium", "large"] },
} satisfies Questions;

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		seen.url = String(url);
		seen.init = init;
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

describe("TypeSafeJudgeProvider", () => {
	it("speaks System One: yes/no questions go out as noul and come back as probabilities", async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		const provider = new TypeSafeJudgeProvider({
			apiKey: "test-key",
			fetch: fakeFetch(
				200,
				{
					model: "jev-1",
					answers: {
						edit: { noul: 0.93 },
						kind: { choice: "chat", confidence: 0.8, probabilities: { chat: 0.9, other: 0.1 } },
						size: { score: 1.4, confidence: 0.7, probabilities: {} },
					},
					usage: { input_tokens: 300, output_tokens: 40 },
				},
				seen,
			),
		});

		const result = await provider.evaluate({ state: { user_message: "hi" }, questions });
		const sent = JSON.parse(String(seen.init?.body)) as {
			model: string;
			questions: Record<string, { type: string }>;
		};

		expect(seen.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(new Headers(seen.init?.headers).get("authorization")).toBe("Bearer test-key");
		expect(sent.model).toBe("jev-latest");
		expect(Object.values(sent.questions).map((question) => question.type)).toEqual(["noul", "choice", "score"]);
		expect(result.answers.edit).toMatchObject({ type: "boolean", probability: 0.93 });
		expect(result.answers.kind).toMatchObject({
			type: "choice",
			choice: "chat",
			probabilities: { chat: 0.9, other: 0.1 },
		});
		expect(result.answers.size).toMatchObject({ type: "score", score: 1.4 });
		expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 40 });
		expect(result.modelId).toBe("jev-1");
	});

	it("posts to a configured base URL, including a private-network HTTP address", async () => {
		const seen: { url?: string } = {};
		const provider = new TypeSafeJudgeProvider({
			apiKey: "k",
			baseUrl: "http://192.168.31.124:8000/v1/systemone/",
			fetch: fakeFetch(
				200,
				{
					answers: {
						edit: { noul: 0.5 },
						kind: { choice: "other" },
						size: { score: 1 },
					},
				},
				seen,
			),
		});
		await provider.evaluate({ state: "s", questions });
		expect(seen.url).toBe("http://192.168.31.124:8000/v1/systemone");
	});

	it("classifies failures without ever echoing the key", async () => {
		const denied = new TypeSafeJudgeProvider({
			apiKey: "secret-key",
			fetch: fakeFetch(401, { error: { message: "bad key" } }),
		});
		const partial = new TypeSafeJudgeProvider({
			apiKey: "secret-key",
			fetch: fakeFetch(200, { answers: { edit: { noul: 0.5 } } }),
		});
		const keyless = new TypeSafeJudgeProvider({ apiKey: () => undefined, fetch: fakeFetch(200, {}) });

		for (const [provider, kind] of [
			[denied, "auth"],
			[partial, "invalid_response"],
			[keyless, "auth"],
		] as const) {
			const error = await provider.evaluate({ state: "s", questions }).catch((caught: unknown) => caught);
			expect(isJudgeError(error) && error.kind).toBe(kind);
			expect(String(error)).not.toContain("secret-key");
		}
	});

	it("makes the jev tier direct when a TypeSafe key is present and the gateway otherwise", () => {
		const config = parseConfig({ tiers: ["jev"] });

		expect(buildJudge(config, { env: { TYPESAFE_API_KEY: "k" } }).judge.id).toBe("typesafe:jev-latest");
		expect(buildJudge(config, { env: {} }).judge.id).toBe("gateway:typesafe-ai/jev");
		expect(buildJudge(parseConfig({ tiers: ["jev-gateway"] }), { env: { TYPESAFE_API_KEY: "k" } }).judge.id).toBe(
			"gateway:typesafe-ai/jev",
		);
	});
});
