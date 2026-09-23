import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isGroupAllowed,
	listQQBotAccountIds,
	resolveDefaultQQBotAccountId,
	resolveGroupConfig,
	resolveMentionPatterns,
	resolveProcessingTimeoutMs,
	resolveQQBotAccount,
} from "../src/qqbot/config.ts";
import { resolveRateLimit } from "../src/qqbot/gateway/middleware-setup.ts";
import { buildChannelPrompt, isExplicitAdmin, isOperatorAuthorized, toolAccessFor } from "../src/qqbot/host.ts";
import type { MuConfig } from "../src/qqbot/types.ts";

const cfg = (qqbot: Record<string, unknown>): MuConfig => ({ channels: { qqbot } });

describe("account resolution (config.ts)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("lists the top-level account as default plus named accounts", () => {
		const config = cfg({
			appId: "1",
			clientSecret: "s",
			accounts: { work: { appId: "2", clientSecret: "t" }, empty: {} },
		});
		expect(listQQBotAccountIds(config)).toEqual(["default", "work"]);
		expect(resolveDefaultQQBotAccountId(config)).toBe("default");
		expect(resolveQQBotAccount(config, "work")).toMatchObject({
			accountId: "work",
			appId: "2",
			clientSecret: "t",
			secretSource: "config",
		});
	});

	it("reads QQBOT_APP_ID / QQBOT_CLIENT_SECRET for the default account only", () => {
		vi.stubEnv("QQBOT_APP_ID", "env-app");
		vi.stubEnv("QQBOT_CLIENT_SECRET", "env-secret");
		expect(resolveQQBotAccount(cfg({}), "default")).toMatchObject({
			appId: "env-app",
			clientSecret: "env-secret",
			secretSource: "env",
		});
		expect(resolveQQBotAccount(cfg({ accounts: { b: { appId: "b" } } }), "b")).toMatchObject({
			clientSecret: "",
			secretSource: "none",
		});
	});

	it("reads clientSecretFile (the original only marked the source)", () => {
		const dir = mkdtempSync(join(tmpdir(), "qqbot-secret-"));
		try {
			const file = join(dir, "secret");
			writeFileSync(file, "from-file-secret\n");
			expect(resolveQQBotAccount(cfg({ appId: "1", clientSecretFile: file }), "default")).toMatchObject({
				clientSecret: "from-file-secret",
				secretSource: "file",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("normalizes the legacy streaming boolean", () => {
		expect(resolveQQBotAccount(cfg({ appId: "1", streaming: true }), "default").config.streaming).toEqual({
			mode: "partial",
		});
		expect(resolveQQBotAccount(cfg({ appId: "1", streaming: false }), "default").config.streaming).toEqual({
			mode: "off",
		});
	});

	it("takes the processing timeout from the account, then MU_QQBOT_PROCESSING_TIMEOUT_MS, else none", () => {
		expect(resolveProcessingTimeoutMs({ processingTimeoutMs: 5 })).toBe(5);
		vi.stubEnv("MU_QQBOT_PROCESSING_TIMEOUT_MS", "9000");
		expect(resolveProcessingTimeoutMs({})).toBe(9000);
		vi.unstubAllEnvs();
		expect(resolveProcessingTimeoutMs({})).toBe(0);
	});

	it('resolves group settings: specific group, then "*", then defaultRequireMention, then built-in defaults', () => {
		const config = cfg({
			appId: "1",
			defaultRequireMention: false,
			groups: { "*": { toolPolicy: "none", historyLimit: 5 }, G1: { requireMention: true, name: "开发群" } },
		});
		expect(resolveGroupConfig(config, "G1")).toMatchObject({
			requireMention: true,
			toolPolicy: "none",
			historyLimit: 5,
			name: "开发群",
		});
		expect(resolveGroupConfig(config, "G2")).toMatchObject({
			requireMention: false,
			toolPolicy: "none",
			ignoreOtherMentions: false,
		});
		expect(resolveGroupConfig(cfg({ appId: "1" }), "G3")).toMatchObject({
			requireMention: true,
			toolPolicy: "restricted",
			historyLimit: 20,
		});
		expect(resolveGroupConfig(cfg({ appId: "1" }), "G3").prompt).toContain("机器人");
	});

	it("applies groupPolicy / groupAllowFrom", () => {
		expect(isGroupAllowed(cfg({ appId: "1" }), "G")).toBe(true);
		expect(isGroupAllowed(cfg({ appId: "1", groupPolicy: "disabled" }), "G")).toBe(false);
		expect(isGroupAllowed(cfg({ appId: "1", groupPolicy: "allowlist", groupAllowFrom: ["g"] }), "G")).toBe(true);
		expect(isGroupAllowed(cfg({ appId: "1", groupPolicy: "allowlist", groupAllowFrom: ["X"] }), "G")).toBe(false);
	});

	it("reads mentionPatterns from the channel config (OpenClaw's agents/messages keys do not exist in mu)", () => {
		expect(resolveMentionPatterns(cfg({ appId: "1", mentionPatterns: ["小mu"] }))).toEqual(["小mu"]);
		expect(resolveMentionPatterns(cfg({ appId: "1" }))).toEqual([]);
	});
});

describe("QQ conversation policy (host.ts)", () => {
	const account = (qqbot: Record<string, unknown>) => resolveQQBotAccount(cfg({ appId: "1", ...qqbot }), "default");

	it("maps group toolPolicy to mu tools: full, restricted = read-only (deviation), none", () => {
		const a = account({ groups: { F: { toolPolicy: "full" }, N: { toolPolicy: "none" } } });
		expect(toolAccessFor(a, { accountId: "default", scope: "c2c", peerId: "u" })).toBe("full");
		expect(toolAccessFor(a, { accountId: "default", scope: "group", peerId: "F" })).toBe("full");
		expect(toolAccessFor(a, { accountId: "default", scope: "group", peerId: "N" })).toBe("none");
		expect(toolAccessFor(a, { accountId: "default", scope: "group", peerId: "other" })).toBe("readonly");
	});

	it("authorizes answers like the original isApprovalAuthorized", () => {
		expect(isOperatorAuthorized(account({}), "u")).toBe(true);
		expect(isOperatorAuthorized(account({ allowFrom: ["*"] }), "u")).toBe(true);
		expect(isOperatorAuthorized(account({ allowFrom: ["a"] }), "a")).toBe(true);
		expect(isOperatorAuthorized(account({ allowFrom: ["a"] }), "b")).toBe(false);
		expect(isOperatorAuthorized(account({}), undefined)).toBe(false);
	});

	it("lets only explicitly listed users run mu commands (Q5a)", () => {
		expect(isExplicitAdmin(account({ allowFrom: ["*"] }), "u")).toBe(false);
		expect(isExplicitAdmin(account({}), "u")).toBe(false);
		expect(isExplicitAdmin(account({ allowFrom: ["u"] }), "u")).toBe(true);
	});

	it("builds the channel prompt: account systemPrompt, group name and group prompt (Q6b)", () => {
		const a = account({ systemPrompt: "你是客服。", groups: { G: { name: "测试群", prompt: "只回答技术问题。" } } });
		const group = buildChannelPrompt(a, { accountId: "default", scope: "group", peerId: "G" });
		expect(group).toContain("你是客服。");
		expect(group).toContain("当前群: 测试群");
		expect(group).toContain("只回答技术问题。");
		const direct = buildChannelPrompt(a, { accountId: "default", scope: "c2c", peerId: "u" });
		expect(direct).toContain("QQ 私聊");
		expect(direct).not.toContain("测试群");
	});
});

describe("rate limit defaults (deviation: the original configured no tiers)", () => {
	it("gives default tiers, lets each be overridden or switched off, and the whole limiter be switched off", () => {
		expect(resolveRateLimit(undefined)).toEqual({
			perSender: { max: 20, windowMs: 60_000 },
			perGroup: { max: 60, windowMs: 60_000 },
			global: { max: 300, windowMs: 60_000 },
		});
		expect(resolveRateLimit({ perSender: { max: 5, windowMs: 1000 }, global: false })).toEqual({
			perSender: { max: 5, windowMs: 1000 },
			perGroup: { max: 60, windowMs: 60_000 },
			global: undefined,
		});
		expect(resolveRateLimit(false)).toBeNull();
	});
});
