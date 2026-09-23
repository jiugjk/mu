import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { c2cMessage } from "./support/fake-qq.ts";
import { APP_SECRET, type ChannelTestEnv, startChannelTest } from "./support/harness.ts";

const ADMIN = "ADM1N000000000000000000000000006";
const OTHER = "0EE10EE10EE10EE10EE10EE10EE10006";

describe("remaining commands and the platform API tool (group 6)", () => {
	let env: ChannelTestEnv;
	beforeAll(async () => {
		env = await startChannelTest({ qqbot: { allowFrom: [ADMIN], deliverDebounce: { enabled: false } } });
	});
	afterAll(async () => {
		await env.stop();
	});

	const ask = async (user: string, text: string, match: (reply: string) => boolean) => {
		const before = env.qq.textsTo("c2c", user).length;
		env.push("C2C_MESSAGE_CREATE", c2cMessage(user, text));
		return env.qq.waitFor(() => env.qq.textsTo("c2c", user).slice(before).find(match), 15_000, `reply to ${text}`);
	};

	it("/bot-streaming shows the state, switches private streaming on in mu.json, and the next answer streams", async () => {
		expect(await ask(ADMIN, "/bot-streaming", (t) => t.includes("流式消息状态"))).toContain("未启用");
		await ask(ADMIN, "/bot-streaming on", (t) => t.includes("流式消息已开启"));
		expect((env.config().channels as { qqbot: { streaming?: unknown } }).qqbot.streaming).toEqual({
			mode: "partial",
		});
		env.llm.reply({ text: "这一条走流式。" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "测试流式"));
		await env.qq.waitFor(
			() => env.qq.streamCalls(ADMIN).find((call) => call.body.input_state === 10),
			15_000,
			"stream DONE frame",
		);
		await ask(ADMIN, "/bot-streaming off", (t) => t.includes("流式消息已关闭"));
		expect(await ask(ADMIN, "/bot-streaming off", (t) => t.includes("无需切换"))).toContain("关闭状态");
	});

	it("/bot-logs sends the channel's log as a file, with secrets already masked", async () => {
		const reply = await ask(ADMIN, "/bot-logs", (t) => t.includes("日志文件"));
		expect(reply).toMatch(/📋 \d+ 个日志文件，共 \d+ 行/);
		const upload = env.qq.calls.filter((call) => call.path === `/v2/users/${ADMIN}/files`).at(-1);
		expect(upload?.body.file_type).toBe(4);
		const exported = Buffer.from(String(upload?.body.file_data), "base64").toString("utf8");
		expect(exported).toContain("gateway READY");
		expect(exported).not.toContain(APP_SECRET);
		expect(exported).not.toContain("fake-access-token-0123456789");
	});

	it("/bot-clear-storage lists this account's downloads, and --force deletes them", async () => {
		const downloads = join(env.qqHome, "media", "default", "c2c", ADMIN, "downloads");
		mkdirSync(downloads, { recursive: true });
		writeFileSync(join(downloads, "old.png"), Buffer.alloc(2048));
		const listing = await ask(ADMIN, "/bot-clear-storage", (t) => t.includes("old.png") || t.includes("没有"));
		expect(listing).toContain("old.png");
		expect(listing).toContain("--force");
		expect(await ask(ADMIN, "/bot-clear-storage --force", (t) => t.includes("已删除"))).toContain("已删除 1 个文件");
		expect(existsSync(join(downloads, "old.png"))).toBe(false);
		expect(existsSync(join(env.qqHome, "media", "default")) ? readdirSync(downloads) : []).toEqual([]);
	});

	it("/bot-upgrade explains that the check failed when the host is offline", async () => {
		const reply = await ask(ADMIN, "/bot-upgrade", (t) => t.includes("升级") || t.includes("版本"));
		expect(reply).toMatch(/无法检查更新|版本检查中/);
	});

	it("does not serve people outside allowFrom (dmPolicy allowlist), commands included", async () => {
		env.push("C2C_MESSAGE_CREATE", c2cMessage(OTHER, "/bot-logs"));
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(env.qq.sentTo("c2c", OTHER)).toHaveLength(0);
		expect(env.qq.calls.filter((call) => call.path === `/v2/users/${OTHER}/files`)).toHaveLength(0);
	});

	it("qqbot_platform_api calls the QQ Open Platform with the bot's token and refuses unsafe paths", async () => {
		env.llm.reply(
			{
				toolCalls: [
					{
						name: "qqbot_platform_api",
						args: { method: "GET", path: "/v2/groups/G123/bot_state", query: { detail: "1" } },
					},
				],
			},
			{ toolCalls: [{ name: "qqbot_platform_api", args: { method: "GET", path: "/v2/../app/getAppAccessToken" } }] },
			{ text: "查好了。" },
		);
		const before = env.llm.requests.length;
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "机器人在群里的状态？"));
		await env.qq.waitFor(() => env.qq.textsTo("c2c", ADMIN).includes("查好了。"), 20_000, "final answer");
		const call = env.qq.calls.find((c) => c.path === "/v2/groups/G123/bot_state");
		expect(call?.method).toBe("GET");
		expect(String(call?.headers.authorization)).toBe("QQBot fake-access-token-0123456789");
		const toolResults = JSON.stringify(env.llm.requests.slice(before).map((r) => r.messages.at(-1)));
		expect(toolResults).toContain("path 不允许包含 .. 或 //");
		// The token never reaches the model.
		expect(JSON.stringify(env.llm.requests)).not.toContain("fake-access-token-0123456789");
	});
});

describe("/bot-* commands under dmPolicy open (the original's rule, kept)", () => {
	it("lets anyone run them, as the original checkCommandAuth does", async () => {
		const env = await startChannelTest({
			qqbot: { allowFrom: [ADMIN], dmPolicy: "open", deliverDebounce: { enabled: false } },
		});
		try {
			env.push("C2C_MESSAGE_CREATE", c2cMessage(OTHER, "/bot-streaming"));
			await env.qq.waitFor(
				() => env.qq.textsTo("c2c", OTHER).find((t) => t.includes("流式消息状态")),
				15_000,
				"command reply",
			);
		} finally {
			await env.stop();
		}
	});
});
