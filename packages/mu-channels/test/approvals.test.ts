import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RecordedCall } from "./support/fake-qq.ts";
import { c2cMessage, groupMessage } from "./support/fake-qq.ts";
import { type ChannelTestEnv, startChannelTest } from "./support/harness.ts";

const ADMIN = "ADM1N000000000000000000000000005";
const STRANGER = "5791A6E4000000000000000000000005";
const GROUP = "GROUP0000000000000000000000000005";

/** mu's own permission gate (kyrn-judge), loaded into every QQ session as `mu qqbot start` does. */
const KYRN_JUDGE = join(import.meta.dirname, "..", "..", "kyrn-judge", "src", "extension", "kyrn-judge.ts");

let interactionCounter = 0;

/** A button click, as QQ pushes it (INTERACTION_CREATE). */
function click(buttonData: string, who: { user?: string; group?: string; member?: string }): Record<string, unknown> {
	return {
		id: `interaction-${++interactionCounter}`,
		type: 11,
		version: 1,
		chat_type: who.group ? 1 : 2,
		...(who.group ? { group_openid: who.group, group_member_openid: who.member } : { user_openid: who.user }),
		data: { type: 11, resolved: { button_data: buttonData, button_id: "b", user_id: who.member ?? who.user } },
	};
}

type Keyboard = {
	content: { rows: Array<{ buttons: Array<{ action: { data: string }; render_data: { label: string } }> }> };
};

function keyboardOf(call: RecordedCall | undefined): Keyboard | undefined {
	return call?.body.keyboard as Keyboard | undefined;
}

function buttons(call: RecordedCall | undefined): Array<{ label: string; data: string }> {
	return (keyboardOf(call)?.content.rows ?? []).flatMap((row) =>
		row.buttons.map((b) => ({ label: b.render_data.label, data: b.action.data })),
	);
}

describe("button approvals (group 5)", () => {
	let env: ChannelTestEnv | undefined;
	afterEach(async () => {
		await env?.stop();
		env = undefined;
	});

	const start = (qqbot: Record<string, unknown>) =>
		startChannelTest({
			qqbot: { deliverDebounce: { enabled: false }, allowFrom: [ADMIN], ...qqbot },
			extensions: [KYRN_JUDGE],
			env: { MU_JUDGE: "mock" },
		});

	const promptTo = (scope: "c2c" | "group", id: string) =>
		env?.qq.sentTo(scope, id).find((call) => call.body.keyboard !== undefined);

	it("asks with buttons before running a command, and runs it once allowed", async () => {
		env = await start({ permissions: "ask" });
		env.llm.reply(
			{ toolCalls: [{ name: "bash", args: { command: "touch approved.txt && echo approved-run" } }] },
			{ text: "跑完了。" },
		);
		const message = c2cMessage(ADMIN, "跑一下 echo");
		env.push("C2C_MESSAGE_CREATE", message);
		const prompt = await env.qq.waitFor(() => promptTo("c2c", ADMIN), 20_000, "approval prompt");
		expect(prompt.body.msg_id).toBe(message.id);
		const text = (prompt.body.markdown as { content: string } | undefined)?.content ?? String(prompt.body.content);
		expect(text).toContain("touch approved.txt && echo approved-run");
		expect(text).toContain("点击按钮或回复序号作答");
		const options = buttons(prompt);
		expect(options.map((o) => o.label)).toEqual(expect.arrayContaining(["允许这一次", "不允许"]));
		expect(options.every((o) => /^mu:[^:]+:\d+$/.test(o.data))).toBe(true);

		const allowOnce = options.find((o) => o.label === "允许这一次");
		const event = click(allowOnce?.data ?? "", { user: ADMIN });
		env.push("INTERACTION_CREATE", event);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ADMIN).includes("跑完了。"), 20_000, "final answer");
		expect(env.qq.calls.some((call) => call.method === "PUT" && call.path === `/interactions/${event.id}`)).toBe(
			true,
		);
		expect(JSON.stringify(env.llm.requests[1]?.messages)).toContain("approved-run");
	});

	it("takes the option number as a text answer, and a refusal blocks the command", async () => {
		env = await start({ permissions: "ask" });
		env.llm.reply(
			{ toolCalls: [{ name: "bash", args: { command: "touch denied.txt && echo should-not-run" } }] },
			{ text: "那就不跑。" },
		);
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "跑一下"));
		const prompt = await env.qq.waitFor(() => promptTo("c2c", ADMIN), 20_000, "approval prompt");
		const deny = buttons(prompt).findIndex((o) => o.label === "不允许");
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, String(deny + 1)));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ADMIN).includes("那就不跑。"), 20_000, "final answer");
		const toolResult = JSON.stringify(env.llm.requests[1]?.messages);
		expect(toolResult).toContain("The user did not allow this");
		expect(toolResult).not.toContain("should-not-run\\n");
		// The answer did not become a turn of its own.
		expect(env.llm.requests).toHaveLength(2);
	});

	it("refuses a text answer from a group member outside allowFrom, and waits for someone allowed", async () => {
		env = await start({ groups: { [GROUP]: { toolPolicy: "full", requireMention: false } }, permissions: "ask" });
		env.llm.reply({ toolCalls: [{ name: "bash", args: { command: "touch x.txt" } }] }, { text: "好了。" });
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, ADMIN, "跑", { atBot: true }));
		await env.qq.waitFor(() => promptTo("group", GROUP), 20_000, "approval prompt");
		env.push("GROUP_MESSAGE_CREATE", groupMessage(GROUP, STRANGER, "1"));
		await env.qq.waitFor(
			() => env?.qq.textsTo("group", GROUP).includes("⚠️ 你没有权限回答这个问题。"),
			15_000,
			"unauthorized notice",
		);
		expect(env.llm.requests).toHaveLength(1);
		env.push("GROUP_MESSAGE_CREATE", groupMessage(GROUP, ADMIN, "1"));
		await env.qq.waitFor(() => env?.qq.textsTo("group", GROUP).includes("好了。"), 20_000, "final answer");
		expect(env.llm.requests).toHaveLength(2);
	});

	it("approves in a group by the member who clicked (group_member_openid)", async () => {
		env = await start({ groups: { [GROUP]: { toolPolicy: "full" } }, permissions: "ask" });
		env.llm.reply(
			{ toolCalls: [{ name: "bash", args: { command: "touch g.txt && echo in-group" } }] },
			{ text: "群里跑完了。" },
		);
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, STRANGER, "跑一下", { atBot: true }));
		const prompt = await env.qq.waitFor(() => promptTo("group", GROUP), 20_000, "group prompt");
		const allowOnce = buttons(prompt).find((o) => o.label === "允许这一次")?.data ?? "";

		env.push("INTERACTION_CREATE", click(allowOnce, { group: GROUP, member: STRANGER }));
		await env.qq.waitFor(
			() => env?.qq.textsTo("group", GROUP).includes("⚠️ 你没有权限处理这个审批。"),
			15_000,
			"unauthorized notice",
		);
		env.push("INTERACTION_CREATE", click(allowOnce, { group: GROUP, member: ADMIN }));
		await env.qq.waitFor(() => env?.qq.textsTo("group", GROUP).includes("群里跑完了。"), 20_000, "final answer");
		expect(JSON.stringify(env.llm.requests[1]?.messages)).toContain("in-group");
	});

	it("treats an unanswered prompt as a refusal after approvalTimeoutSeconds", async () => {
		env = await start({ permissions: "ask", approvalTimeoutSeconds: 1 });
		env.llm.reply({ toolCalls: [{ name: "bash", args: { command: "touch late.txt" } }] }, { text: "超时了。" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "跑"));
		const prompt = await env.qq.waitFor(() => promptTo("c2c", ADMIN), 20_000, "approval prompt");
		expect((prompt.body.markdown as { content: string } | undefined)?.content ?? prompt.body.content).toContain(
			"1 秒内未作答按拒绝处理",
		);
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ADMIN).includes("超时了。"), 20_000, "final answer");
		expect(JSON.stringify(env.llm.requests[1]?.messages)).toContain("The user did not allow this");
	});

	it("/bot-approve always and on switch open conversations and persist the mode", async () => {
		env = await start({ permissions: "full" });
		env.llm.reply({ text: "你好" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "你好"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ADMIN).includes("你好"), 15_000, "first reply");

		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "/bot-approve always"));
		await env.qq.waitFor(
			() => env?.qq.textsTo("c2c", ADMIN).find((t) => t.includes("严格审批模式")),
			15_000,
			"always",
		);
		expect((env.config().channels as { qqbot: { permissions?: string } }).qqbot.permissions).toBe("ask");

		// The already open conversation now asks.
		env.llm.reply({ toolCalls: [{ name: "bash", args: { command: "touch now.txt" } }] }, { text: "完成。" });
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "再跑"));
		await env.qq.waitFor(() => promptTo("c2c", ADMIN), 20_000, "prompt after switch");

		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "/bot-approve reset"));
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "1"));
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ADMIN).includes("完成。"), 20_000, "after answer");
		await env.qq.waitFor(() => env?.qq.textsTo("c2c", ADMIN).find((t) => t.includes("已重置")), 15_000, "reset");
		expect((env.config().channels as { qqbot: { permissions?: string } }).qqbot.permissions).toBeUndefined();
	});

	it("/bot-approve off: private chat only, allowFrom users only, and only after a second confirmation", async () => {
		env = await start({ permissions: "ask", allowFrom: [ADMIN, "*"], groupPolicy: "open" });
		const said = (user: string, match: string) =>
			env?.qq.waitFor(() => env?.qq.textsTo("c2c", user).find((t) => t.includes(match)), 15_000, match);
		const mode = () => (env?.config().channels as { qqbot: { permissions?: string } }).qqbot.permissions;

		// "*" lets anyone use the bot, but not switch approvals off.
		env.push("C2C_MESSAGE_CREATE", c2cMessage(STRANGER, "/bot-approve off"));
		await said(STRANGER, "只允许 allowFrom 中明确列出的用户执行");

		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "/bot-approve off"));
		await said(ADMIN, "确认请在 2 分钟内发送");
		expect(mode()).toBe("ask");

		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "/bot-approve off --confirm"));
		await said(ADMIN, "审批已关闭");
		expect(mode()).toBe("full");

		// A confirmation without a fresh request does nothing but ask again.
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "/bot-approve always"));
		await said(ADMIN, "严格审批模式");
		const before = env.qq.textsTo("c2c", ADMIN).length;
		env.push("C2C_MESSAGE_CREATE", c2cMessage(ADMIN, "/bot-approve off --confirm"));
		await env.qq.waitFor(
			() =>
				env?.qq
					.textsTo("c2c", ADMIN)
					.slice(before)
					.find((t) => t.includes("确认请在 2 分钟内发送")),
			15_000,
			"asks again",
		);
		expect(mode()).toBe("ask");

		// Not in a group, not even by the admin.
		env.push("GROUP_AT_MESSAGE_CREATE", groupMessage(GROUP, ADMIN, "/bot-approve off --confirm", { atBot: true }));
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(mode()).toBe("ask");
	});
});

describe("claw_cfg interactions (group 5)", () => {
	let env: ChannelTestEnv | undefined;
	afterEach(async () => {
		await env?.stop();
		env = undefined;
	});

	const ackOf = (id: string) =>
		env?.qq.calls.find((call) => call.method === "PUT" && call.path === `/interactions/${id}`);

	it('answers the 2001 config query with claw_type "mu" by default', async () => {
		env = await startChannelTest({ qqbot: { mentionPatterns: ["小mu"] } });
		const query = { id: "cfg-1", type: 11, version: 1, group_openid: GROUP, data: { type: 2001, resolved: {} } };
		env.push("INTERACTION_CREATE", query);
		const ack = await env.qq.waitFor(() => ackOf("cfg-1"), 15_000, "ack");
		expect(ack.body).toMatchObject({
			code: 0,
			data: {
				claw_cfg: {
					channel_type: "qqbot",
					claw_type: "mu",
					claw_ver: "0.0.0-test",
					require_mention: "mention",
					mention_patterns: "小mu",
					online_state: "online",
				},
			},
		});
	});

	it('uses clawType from the config ("openclaw" restores the original value)', async () => {
		env = await startChannelTest({ qqbot: { clawType: "openclaw" } });
		env.push("INTERACTION_CREATE", { id: "cfg-2", type: 11, version: 1, data: { type: 2001, resolved: {} } });
		const ack = await env.qq.waitFor(() => ackOf("cfg-2"), 15_000, "ack");
		expect((ack.body.data as { claw_cfg: { claw_type: string } }).claw_cfg.claw_type).toBe("openclaw");
	});

	it("applies a 2002 update of a group's mention setting to mu.json and reports it back", async () => {
		env = await startChannelTest({});
		env.push("INTERACTION_CREATE", {
			id: "cfg-3",
			type: 11,
			version: 1,
			group_openid: GROUP,
			data: { type: 2002, resolved: { claw_cfg: { require_mention: "always" } } },
		});
		const ack = await env.qq.waitFor(() => ackOf("cfg-3"), 15_000, "ack");
		const groups = (env.config().channels as { qqbot: { groups?: Record<string, { requireMention?: boolean }> } })
			.qqbot.groups;
		expect(groups?.[GROUP]?.requireMention).toBe(false);
		expect((ack.body.data as { claw_cfg: { require_mention: string } }).claw_cfg.require_mention).toBeDefined();
	});
});
