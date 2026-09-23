import { createServer } from "node:net";
import { ed25519Sign, signValidationResponse } from "@tencent-connect/qqbot-nodejs/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { c2cMessage } from "./support/fake-qq.ts";
import { APP_SECRET, type ChannelTestEnv, startChannelTest } from "./support/harness.ts";

const ALICE = "A11CE000000000000000000000000007";
const PATH = "/qqbot/webhook";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolve(port));
		});
	});
}

/** QQ's callback: Ed25519 over timestamp + body with the bot's secret. */
async function post(
	port: number,
	payload: unknown,
	options: { secret?: string; contentType?: string; signature?: string; timestamp?: string; raw?: Buffer } = {},
): Promise<Response> {
	const body = options.raw ?? Buffer.from(JSON.stringify(payload));
	const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
	const signature =
		options.signature ?? ed25519Sign(options.secret ?? APP_SECRET, Buffer.concat([Buffer.from(timestamp), body]));
	return fetch(`http://127.0.0.1:${port}${PATH}`, {
		method: "POST",
		headers: {
			"Content-Type": options.contentType ?? "application/json",
			"X-Signature-Timestamp": timestamp,
			"X-Signature-Ed25519": signature,
		},
		body,
	});
}

describe("webhook transport (group 6)", () => {
	let env: ChannelTestEnv | undefined;
	let port = 0;
	afterEach(async () => {
		await env?.stop();
		env = undefined;
	});

	const start = async () => {
		port = await freePort();
		env = await startChannelTest({
			qqbot: {
				transport: "webhook",
				webhook: { host: "127.0.0.1", port, path: PATH },
				deliverDebounce: { enabled: false },
			},
			waitForReady: false,
		});
		// The server listens once the account has started.
		for (let tries = 0; ; tries++) {
			try {
				await fetch(`http://127.0.0.1:${port}/`);
				return;
			} catch (error) {
				if (tries > 200) throw error;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
	};

	it("answers QQ's callback URL validation (op 13) with the signed plain_token", async () => {
		await start();
		const res = await post(port, { op: 13, d: { plain_token: "plain-abc", event_ts: "1725000000" } });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(
			signValidationResponse({ plainToken: "plain-abc", eventTs: "1725000000", botSecret: APP_SECRET }),
		);
	});

	it("takes a signed message event, acknowledges it and answers through the API", async () => {
		await start();
		env?.llm.reply({ text: "从 webhook 收到了。" });
		const message = c2cMessage(ALICE, "webhook 你好");
		const res = await post(port, { op: 0, s: 1, t: "C2C_MESSAGE_CREATE", id: "evt-1", d: message });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ op: 12 });
		const sent = await env?.qq.waitFor(() => env?.qq.sentTo("c2c", ALICE)[0], 15_000, "reply");
		expect(sent?.body.msg_id).toBe(message.id);
		expect(env?.qq.textsTo("c2c", ALICE)).toContain("从 webhook 收到了。");
	});

	it("rejects requests signed with another secret, and non-JSON bodies, without handling them", async () => {
		await start();
		const forged = await post(
			port,
			{ op: 0, s: 2, t: "C2C_MESSAGE_CREATE", id: "evt-2", d: c2cMessage(ALICE, "伪造") },
			{
				secret: "not-the-bot-secret",
			},
		);
		expect(forged.status).toBeGreaterThanOrEqual(400);
		const text = await post(port, { op: 0 }, { contentType: "text/plain" });
		expect(text.status).toBe(415);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(env?.llm.requests).toHaveLength(0);
		expect(env?.qq.sentTo("c2c", ALICE)).toHaveLength(0);
	});

	it("does not sign what a caller asks it to: an event cannot be forged through the op 13 validation", async () => {
		await start();
		// The validation reply is a signature over event_ts + plain_token, the same shape an event is signed with.
		const forged = Buffer.from(
			JSON.stringify({ op: 0, s: 3, t: "C2C_MESSAGE_CREATE", id: "evt-3", d: c2cMessage(ALICE, "/bot-ping") }),
		);
		const eventTs = String(Math.floor(Date.now() / 1000));
		const oracle = await post(port, { op: 13, d: { plain_token: forged.toString("utf8"), event_ts: eventTs } });
		// Answering would hand out a valid signature for `eventTs + forged`, i.e. for the forged event.
		expect(oracle.status).toBe(400);
		expect(JSON.stringify(await oracle.json())).not.toContain("signature");
	});

	it("rejects stale timestamps and replays of a signed event", async () => {
		await start();
		env?.llm.reply({ text: "只回一次。" });
		const stale = String(Math.floor(Date.now() / 1000) - 3600);
		const old = await post(
			port,
			{ op: 0, s: 4, t: "C2C_MESSAGE_CREATE", id: "evt-4", d: c2cMessage(ALICE, "旧的") },
			{ timestamp: stale },
		);
		expect(old.status).toBe(401);

		const body = Buffer.from(
			JSON.stringify({ op: 0, s: 5, t: "C2C_MESSAGE_CREATE", id: "evt-5", d: c2cMessage(ALICE, "一次") }),
		);
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = ed25519Sign(APP_SECRET, Buffer.concat([Buffer.from(timestamp), body]));
		expect((await post(port, undefined, { raw: body, timestamp, signature })).status).toBe(200);
		expect((await post(port, undefined, { raw: body, timestamp, signature })).status).toBe(401);
		await env?.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("只回一次。"), 15_000, "reply");
		expect(env?.llm.requests).toHaveLength(1);
	});

	it("does not let unsigned requests use up the budget for QQ's real callbacks", async () => {
		await start();
		env?.llm.reply({ text: "还能收到。" });
		const junk = await Promise.all(
			Array.from({ length: 700 }, () => post(port, { op: 0 }, { signature: "00".repeat(64) })),
		);
		expect(junk.every((res) => res.status === 401)).toBe(true);
		const res = await post(port, { op: 0, s: 6, t: "C2C_MESSAGE_CREATE", id: "evt-6", d: c2cMessage(ALICE, "真的") });
		expect(res.status).toBe(200);
		await env?.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("还能收到。"), 15_000, "reply");
	});
});

describe("webhook with two accounts on one path", () => {
	it("routes each signed event to the account whose secret signed it", async () => {
		const port = await freePort();
		const OTHER_SECRET = "second-account-secret-51c2";
		const env = await startChannelTest({
			qqbot: {
				transport: "webhook",
				webhook: { host: "127.0.0.1", port, path: PATH },
				deliverDebounce: { enabled: false },
				accounts: {
					second: {
						appId: "102400002",
						clientSecret: OTHER_SECRET,
						model: "fakellm/fake-1",
						transport: "webhook",
						webhook: { host: "127.0.0.1", port, path: PATH },
						deliverDebounce: { enabled: false },
					},
				},
			},
			waitForReady: false,
		});
		try {
			for (let tries = 0; ; tries++) {
				try {
					await fetch(`http://127.0.0.1:${port}/`);
					break;
				} catch (error) {
					if (tries > 200) throw error;
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
			env.llm.reply({ text: "第二个账户回答。" });
			const message = c2cMessage(ALICE, "找第二个机器人");
			const res = await post(
				port,
				{ op: 0, s: 1, t: "C2C_MESSAGE_CREATE", id: "evt-9", d: message },
				{ secret: OTHER_SECRET },
			);
			expect(res.status).toBe(200);
			await env.qq.waitFor(() => env.qq.textsTo("c2c", ALICE).includes("第二个账户回答。"), 15_000, "reply");
			const sent = env.qq.sentTo("c2c", ALICE)[0];
			// Only the second account's secret verifies this signature: a 200 and a reply mean it took the event.
			expect(sent?.body.msg_id).toBe(message.id);
			expect(env.bot.accountIds().sort()).toEqual(["default", "second"]);
		} finally {
			await env.stop();
		}
	});
});
