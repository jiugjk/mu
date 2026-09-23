import { afterEach, describe, expect, it } from "vitest";
import { c2cMessage, groupMessage } from "./support/fake-qq.ts";
import { type ChannelTestEnv, startChannelTest } from "./support/harness.ts";

const GROUP = "GROUP0000000000000000000000000001";
const ALICE = "A11CE000000000000000000000000001";
const BOB = "B0B00000000000000000000000000001";
const ADMIN = "ADM1N000000000000000000000000001";
const STRANGER = "5791A6E4000000000000000000000001";

const quiet = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms));

describe("group chat and access control (group 2)", () => {
	let env: ChannelTestEnv | undefined;
	afterEach(async () => {
		await env?.stop();
		env = undefined;
	});

	it("answers in a group only when @-ed, with the unanswered messages as history and the sender labelled", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.llm.reply({ text: "群里好！" });
		env.push("GROUP_MESSAGE_CREATE", groupMessage(GROUP, BOB, "今天周几", { nickname: "Bob" }));
		await quiet();
		expect(env.llm.requests).toHaveLength(0);
		expect(env.qq.sentTo("group", GROUP)).toHaveLength(0);

		const at = groupMessage(GROUP, ALICE, "帮我回答一下", { atBot: true, nickname: "Alice" });
		env.push("GROUP_AT_MESSAGE_CREATE", at);
		const sent = await env.qq.waitFor(() => env?.qq.sentTo("group", GROUP)[0], 15_000, "group reply");
		expect(sent.body.msg_id).toBe(at.id);
		const user = env.llm.userTexts(0).join("\n");
		expect(user).toContain("[Chat history begins]");
		expect(user).toContain(`[Bob (${BOB})] 今天周几`);
		expect(user).toContain(`[Alice (${ALICE})] 帮我回答一下 (@you)`);
		expect(user).not.toContain("<@!bot>");
		expect(env.llm.systemPrompt(0)).toContain("QQ 群聊");
	});

	it("honours the group's own historyLimit (the SDK ignored it and always kept 50) and 0 turns history off", async () => {
		env = await startChannelTest({
			qqbot: {
				deliverDebounce: { enabled: false },
				groups: { [GROUP]: { historyLimit: 2 }, G0: { historyLimit: 0 } },
			},
		});
		for (const text of ["一", "二", "三"]) env.push("GROUP_MESSAGE_CREATE", groupMessage(GROUP, BOB, `消息${text}`));
		await quiet(400);
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, ALICE, "总结", { atBot: true }));
		await env.qq.waitFor(() => env?.qq.sentTo("group", GROUP)[0], 15_000, "reply");
		const user = env.llm.userTexts(0).join("\n");
		expect(user).not.toContain("消息一");
		expect(user).toContain("消息二");
		expect(user).toContain("消息三");

		env.push("GROUP_MESSAGE_CREATE", groupMessage("G0", BOB, "不该出现"));
		await quiet(300);
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage("G0", ALICE, "你好", { atBot: true }));
		await env.qq.waitFor(() => env?.qq.sentTo("group", "G0")[0], 15_000, "reply in G0");
		expect(env.llm.userTexts(1).join("\n")).not.toContain("Chat history");
	});

	it("answers every group message when requireMention is off for the group", async () => {
		env = await startChannelTest({
			qqbot: { deliverDebounce: { enabled: false }, groups: { "*": { requireMention: false } } },
		});
		env.push("GROUP_MESSAGE_CREATE", groupMessage(GROUP, BOB, "没有 @ 也回答吗"));
		await env.qq.waitFor(() => env?.qq.sentTo("group", GROUP)[0], 15_000, "reply");
	});

	it("keeps groups outside groupAllowFrom and disabled groups quiet", async () => {
		env = await startChannelTest({
			qqbot: { deliverDebounce: { enabled: false }, groupPolicy: "allowlist", groupAllowFrom: ["OTHERGROUP"] },
		});
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, ALICE, "在吗", { atBot: true }));
		await quiet();
		expect(env.llm.requests).toHaveLength(0);
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage("OTHERGROUP", ALICE, "在吗", { atBot: true }));
		await env.qq.waitFor(() => env?.qq.sentTo("group", "OTHERGROUP")[0], 15_000, "reply in allowed group");
		await env.stop();

		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false }, groupPolicy: "disabled" } });
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, ALICE, "在吗", { atBot: true }));
		await quiet();
		expect(env.llm.requests).toHaveLength(0);
	});

	it("gives a restricted group read-only tools (deviation: OpenClaw did not restrict), a private chat all of them", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, ALICE, "看看", { atBot: true }));
		await env.qq.waitFor(() => env?.qq.sentTo("group", GROUP)[0], 15_000, "group reply");
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "私聊"));
		await env.qq.waitFor(() => env?.qq.sentTo("c2c", ALICE)[0], 15_000, "c2c reply");
		const toolNames = (i: number) =>
			((env?.llm.requests[i]?.tools ?? []) as Array<{ function: { name: string } }>)
				.map((t) => t.function.name)
				.sort();
		expect(toolNames(0)).toEqual(["find", "grep", "ls", "qqbot_send_media", "read"]);
		expect(toolNames(1)).toEqual(
			expect.arrayContaining(["bash", "edit", "write", "qqbot_platform_api", "qqbot_send_media"]),
		);
	});

	it("merges messages that arrive while the conversation is busy into one turn", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.llm.reply({ text: "第一条回复", chunks: 4, chunkDelayMs: 300 }, { text: "合并后的回复" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "第一条"));
		await env.qq.waitFor(() => env?.llm.requests.length, 10_000, "first request");
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "第二条"));
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "第三条"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("合并后的回复"), 20_000, "merged reply");
		expect(env.llm.requests).toHaveLength(2);
		const merged = env.llm.userTexts(1).at(-1) ?? "";
		expect(merged).toContain("第二条");
		expect(merged).toContain("第三条");
	});

	it("resolves a quoted bot message from the local ref index", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false } } });
		env.llm.reply({ text: "北京的天气晴。" }, { text: "好的" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ALICE, "天气"));
		const first = await env.qq.waitFor(() => env?.qq.sentTo("c2c", ALICE)[0]?.response, 15_000, "first reply");
		// QQ answers every send with ext_info.ref_idx; a later quote of that message carries it back.
		const refIdx = (first as { ext_info: { ref_idx: string } }).ext_info.ref_idx;
		env.push(
			"C2C_MESSAGE_CREATE",
			c2cMessage(ALICE, "那明天呢", {
				message_type: 103,
				message_scene: { source: "default", ext: [`ref_msg_idx=${refIdx}`] },
			}),
		);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ALICE).includes("好的"), 15_000, "second reply");
		const user = env.llm.userTexts(1).at(-1) ?? "";
		expect(user).toContain("[Quoted message begins]");
		expect(user).toContain("北京的天气晴。");
	});

	it("drops messages beyond the per-sender rate limit (deviation: the original had no limit)", async () => {
		env = await startChannelTest({
			qqbot: { deliverDebounce: { enabled: false }, rateLimit: { perSender: { max: 2, windowMs: 60_000 } } },
		});
		for (let i = 1; i <= 3; i++) {
			env.push("C2C_MESSAGE_CREATE", c2cMessage(BOB, `第${i}条`));
			await env.qq.waitFor(
				() => (i < 3 ? (env?.qq.textsTo("c2c", BOB).length ?? 0) >= i : true),
				15_000,
				`reply ${i}`,
			);
		}
		await quiet(1000);
		expect(env.qq.textsTo("c2c", BOB)).toHaveLength(2);
		expect(JSON.stringify(env.llm.requests)).not.toContain("第3条");
	});

	it("pairs a stranger: a code in private chat, approved with /bot-pairing by someone in allowFrom", async () => {
		env = await startChannelTest({
			qqbot: { deliverDebounce: { enabled: false }, dmPolicy: "pairing", allowFrom: [ADMIN] },
		});
		env.push("C2C_MESSAGE_CREATE", c2cMessage(STRANGER, "你好"));
		const challenge = await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", STRANGER).find((t) => t.includes("Pairing code")),
			15_000,
			"pairing code",
		);
		const code = /```\n([A-Z2-9]{8})\n```/.exec(challenge)?.[1];
		expect(code).toBeDefined();
		expect(challenge).toContain(`/bot-pairing approve ${code}`);
		expect(env.llm.requests).toHaveLength(0);

		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, `/bot-pairing approve ${code}`));
		const approved = await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", ADMIN).find((t) => t.includes("已批准")),
			15_000,
			"approval",
		);
		expect(approved).toContain(STRANGER);

		env.llm.reply({ text: "欢迎" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(STRANGER, "现在可以了吗"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", STRANGER).includes("欢迎"), 15_000, "answer after pairing");
	});

	it("dmPolicy disabled ignores private messages; allowlist ignores those not listed", async () => {
		env = await startChannelTest({
			qqbot: { deliverDebounce: { enabled: false }, dmPolicy: "allowlist", allowFrom: [ADMIN] },
		});
		env.push("C2C_MESSAGE_CREATE", c2cMessage(STRANGER, "你好"));
		await quiet();
		expect(env.qq.sentTo("c2c", STRANGER)).toHaveLength(0);
		expect(env.llm.requests).toHaveLength(0);
		await env.stop();

		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false }, dmPolicy: "disabled" } });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "你好"));
		await quiet();
		expect(env.llm.requests).toHaveLength(0);
	});

	it("/bot-group-always on lets the bot answer groups without @, written to mu.json", async () => {
		env = await startChannelTest({ qqbot: { deliverDebounce: { enabled: false }, allowFrom: [ADMIN] } });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "/bot-group-always on"));
		await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", ADMIN).find((t) => t.includes("自主判断")),
			15_000,
			"confirmation",
		);
		expect(
			(env.config().channels as { qqbot: { defaultRequireMention?: boolean } }).qqbot.defaultRequireMention,
		).toBe(false);
		env.push("GROUP_MESSAGE_CREATE", groupMessage(GROUP, BOB, "没有 @"));
		await env.qq.waitFor(() => env?.qq.sentTo("group", GROUP)[0], 15_000, "group reply without @");
	});
});
