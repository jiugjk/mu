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
	options: { secret?: string; contentType?: string; signature?: string } = {},
): Promise<Response> {
	const body = Buffer.from(JSON.stringify(payload));
	const timestamp = String(Math.floor(Date.now() / 1000));
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
});
