import * as dns from "node:dns";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { c2cMessage, groupMessage } from "./support/fake-qq.ts";
import { type ChannelTestEnv, readLog, startChannelTest } from "./support/harness.ts";

const ALICE = "A11CE000000000000000000000000003";
const BOB = "B0B00000000000000000000000000003";
const GROUP = "GROUP0000000000000000000000000003";

// A valid 1×1 PNG: mu hands images to the model as they are.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const CDN = "https://multimedia.nt.qq.com.cn";

/**
 * QQ's CDN, served in-process: inbound downloads only accept HTTPS URLs that resolve to public addresses,
 * so the CDN host resolves to a documentation address and its fetches are answered here.
 */
const cdn = new Map<string, { status: number; body: Buffer; type: string }>();
const realFetch = globalThis.fetch;

describe("rich media (group 4)", () => {
	let env: ChannelTestEnv | undefined;

	beforeAll(() => {
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const hit = cdn.get(url);
			if (hit)
				return new Response(new Uint8Array(hit.body), {
					status: hit.status,
					headers: { "Content-Type": hit.type },
				});
			return realFetch(input, init);
		}) as typeof fetch;
		const realResolve4 = dns.promises.resolve4.bind(dns.promises);
		vi.spyOn(dns.promises, "resolve4").mockImplementation((async (host: string) =>
			host === new URL(CDN).hostname ? ["203.0.113.10"] : realResolve4(host)) as typeof dns.promises.resolve4);
		const realLookup = dns.promises.lookup.bind(dns.promises);
		vi.spyOn(dns.promises, "lookup").mockImplementation((async (host: string, options: dns.LookupAllOptions) =>
			host === new URL(CDN).hostname
				? [{ address: "203.0.113.10", family: 4 }]
				: realLookup(host, options)) as typeof dns.promises.lookup);
	});
	afterAll(() => {
		globalThis.fetch = realFetch;
		vi.restoreAllMocks();
	});
	afterEach(async () => {
		await env?.stop();
		env = undefined;
		cdn.clear();
	});

	const mediaDir = (scope: "c2c" | "group", peer: string) =>
		join(env?.qqHome ?? "", "media", "default", scope, peer, "downloads");
	const workspace = (scope: "c2c" | "group", peer: string) => {
		const dir = join(env?.qqHome ?? "", "workspace", "default", scope, peer);
		mkdirSync(dir, { recursive: true });
		return dir;
	};

	it("downloads a received image into that conversation's own folder and shows it to the model", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		cdn.set(`${CDN}/img/cat.png`, { status: 200, body: PNG, type: "image/png" });
		env.push(
			"C2C_MESSAGE_CREATE",
			c2cMessage(ALICE, "看看这张图", {
				attachments: [{ content_type: "image/png", url: `${CDN}/img/cat.png`, filename: "cat.png" }],
			}),
		);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE)[0], 15_000, "reply");
		const saved = readdirSync(mediaDir("c2c", ALICE));
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatch(/^cat_\d+_[0-9a-f]{8}\.png$/);
		const user = JSON.stringify(env.llm.requests[0]?.messages.filter((m) => m.role === "user"));
		expect(user).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
		expect(user).toContain(join(mediaDir("c2c", ALICE), saved[0] as string));
	});

	it("keeps group downloads apart from private ones", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		cdn.set(`${CDN}/img/g.png`, { status: 200, body: PNG, type: "image/png" });
		env.push(
			"GROUP_AT_MESSAGE_CREATE",
			groupMessage(GROUP, BOB, "群里的图", {
				atBot: true,
				extra: { attachments: [{ content_type: "image/png", url: `${CDN}/img/g.png`, filename: "g.png" }] },
			}),
		);
		await env.qq.waitFor(() => env?.qq.sentTo("group", GROUP)[0], 15_000, "group reply");
		expect(readdirSync(mediaDir("group", GROUP))).toHaveLength(1);
		expect(existsSync(mediaDir("c2c", BOB))).toBe(false);
	});

	it("passes a failed image download on as its remote URL and still answers", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		cdn.set(`${CDN}/img/gone.png`, { status: 404, body: Buffer.from("no"), type: "text/plain" });
		env.push(
			"C2C_MESSAGE_CREATE",
			c2cMessage(ALICE, "这张呢", { attachments: [{ content_type: "image/png", url: `${CDN}/img/gone.png` }] }),
		);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE)[0], 15_000, "reply");
		expect(JSON.stringify(env.llm.requests[0]?.messages)).toContain(`${CDN}/img/gone.png`);
		expect(readLog(env)).toContain("Download failed");
	});

	it("saves received files and tells the model where they are", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		cdn.set(`${CDN}/f/report.pdf`, { status: 200, body: Buffer.from("%PDF-1.4 test"), type: "application/pdf" });
		env.push(
			"C2C_MESSAGE_CREATE",
			c2cMessage(ALICE, "帮我看看文件", {
				attachments: [{ content_type: "file", url: `${CDN}/f/report.pdf`, filename: "report.pdf" }],
			}),
		);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE)[0], 15_000, "reply");
		const saved = readdirSync(mediaDir("c2c", ALICE));
		expect(saved[0]).toMatch(/^report_.*\.pdf$/);
		expect(env.llm.userTexts(0).join("\n")).toContain(
			`[Attachment: ${join(mediaDir("c2c", ALICE), saved[0] as string)}]`,
		);
	});

	it("uses QQ's own voice recognition when no STT is configured", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.push(
			"C2C_MESSAGE_CREATE",
			c2cMessage(ALICE, "", {
				attachments: [{ content_type: "voice", url: `${CDN}/v/a.silk`, asr_refer_text: "明天早上八点叫我" }],
			}),
		);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE)[0], 15_000, "reply");
		expect(env.llm.userTexts(0).join("\n")).toContain("明天早上八点叫我");
		expect(env.llm.transcriptions).toHaveLength(0);
	});

	it("transcribes voice with the configured STT and keeps its key out of the log", async () => {
		env = await startChannelTest({
			// The STT endpoint is the fake model server's OpenAI-compatible /audio/transcriptions.
			qqbot: ({ llm }) => ({
				deliverDebounce: { enabled: false },
				stt: { baseUrl: llm.baseUrl, apiKey: "stt-secret-key-123" },
			}),
		});
		cdn.set(`${CDN}/v/b.wav`, { status: 200, body: Buffer.from("RIFF....WAVEfmt "), type: "audio/wav" });
		env.llm.transcript = "帮我查一下天气";
		env.push(
			"C2C_MESSAGE_CREATE",
			c2cMessage(ALICE, "", {
				attachments: [
					{ content_type: "voice", url: `${CDN}/v/b.silk`, voice_wav_url: `${CDN}/v/b.wav`, asr_refer_text: "旧" },
				],
			}),
		);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE)[0], 15_000, "reply");
		expect(env.llm.transcriptions).toHaveLength(1);
		expect(env.llm.transcriptions[0]?.authorization).toBe("Bearer stt-secret-key-123");
		expect(env.llm.transcriptions[0]?.body).toContain("whisper-1");
		expect(env.llm.userTexts(0).join("\n")).toContain("帮我查一下天气");
		expect(readLog(env)).not.toContain("stt-secret-key-123");
	});

	it("falls back to a mu provider's credentials for STT (stt.provider)", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false }, stt: { provider: "fakellm" } } });
		cdn.set(`${CDN}/v/c.wav`, { status: 200, body: Buffer.from("RIFF....WAVEfmt "), type: "audio/wav" });
		env.push(
			"C2C_MESSAGE_CREATE",
			c2cMessage(ALICE, "", {
				attachments: [{ content_type: "voice", url: `${CDN}/v/c.silk`, voice_wav_url: `${CDN}/v/c.wav` }],
			}),
		);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE)[0], 15_000, "reply");
		expect(env.llm.transcriptions[0]?.authorization).toBe("Bearer fake-llm-key");
		expect(env.llm.userTexts(0).join("\n")).toContain(env.llm.transcript);
	});

	it("qqbot_send_media sends a workspace image as a passive reply", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		writeFileSync(join(workspace("c2c", ALICE), "chart.png"), PNG);
		env.llm.reply(
			{ toolCalls: [{ name: "qqbot_send_media", args: { source: "chart.png", text: "图表如下" } }] },
			{ text: "发好了。" },
		);
		const message = c2cMessage(ALICE, "把图表发我");
		env.push("C2C_MESSAGE_CREATE", message);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("发好了。"), 20_000, "final text");
		const upload = env.qq.calls.find((call) => call.path === `/v2/users/${ALICE}/files`);
		expect(upload?.body).toMatchObject({ file_type: 1, file_data: PNG.toString("base64") });
		const media = env.qq.sentTo("c2c", ALICE).find((call) => call.body.msg_type === 7);
		expect(media?.body).toMatchObject({ msg_id: message.id, media: { file_info: expect.any(String) } });
		expect(JSON.stringify(env.llm.requests[1]?.messages)).toContain("已发送。");
	});

	it("refuses files outside the conversation's folders and tells the user the media failed", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.llm.reply(
			{ toolCalls: [{ name: "qqbot_send_media", args: { source: "/etc/hostname" } }] },
			{ text: "没发出去。" },
		);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "把 /etc/hostname 发我"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("没发出去。"), 20_000, "final text");
		expect(env.qq.textsTo("c2c", ALICE)).toContain("⚠️ 媒体发送失败（1 个），请重试");
		expect(env.qq.calls.some((call) => call.path.endsWith("/files"))).toBe(false);
		expect(JSON.stringify(env.llm.requests[1]?.messages)).toContain("文件路径不在允许的目录中");
	});

	it("sends a voice file as a plain file when QQ refuses it as voice", async () => {
		env = await startChannelTest({
			qqbot: { deliverDebounce: { enabled: false } },
			fakeQQ: {
				failures: [
					{
						match: /\/files$/,
						when: (body) => body.file_type === 3,
						status: 400,
						body: { code: 40034, message: "voice rejected" },
					},
				],
			},
		});
		writeFileSync(join(workspace("c2c", ALICE), "note.silk"), Buffer.from("#!SILK_V3 fake"));
		env.llm.reply(
			{ toolCalls: [{ name: "qqbot_send_media", args: { source: "note.silk", kind: "voice" } }] },
			{ text: "好。" },
		);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "发段语音"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("好。"), 20_000, "final text");
		const uploads = env.qq.calls.filter((call) => call.path.endsWith("/files")).map((call) => call.body.file_type);
		expect(uploads[0]).toBe(3);
		expect(uploads.at(-1)).toBe(4);
		expect(JSON.stringify(env.llm.requests[1]?.messages)).toContain("语音发送失败，已改为以文件形式发送。");
	});

	it("keeps each conversation's session files in its own folder", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "你好"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE)[0], 15_000, "c2c reply");
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, ALICE, "你好", { atBot: true }));
		await env.qq.waitFor(() => env?.qq.sentTo("group", GROUP)[0], 15_000, "group reply");
		expect(readdirSync(join(env.qqHome, "sessions", "default", "c2c", ALICE)).length).toBeGreaterThan(0);
		expect(readdirSync(join(env.qqHome, "sessions", "default", "group", GROUP)).length).toBeGreaterThan(0);
	});
});
