import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningQQBot, startQQBot } from "../../src/qqbot/cli.ts";
import { FakeLLM } from "./fake-llm.ts";
import { FakeQQ, type FakeQQOptions } from "./fake-qq.ts";

export const APP_ID = "102400001";
export const APP_SECRET = "fake-app-secret-4b1d";

export interface ChannelTestEnv {
	root: string;
	agentDir: string;
	qqHome: string;
	qq: FakeQQ;
	llm: FakeLLM;
	bot: RunningQQBot;
	/** mu.json as it is now. */
	config(): Record<string, unknown>;
	/** Replaces `channels.qqbot` in mu.json (the running bot picks it up through its file watcher). */
	writeQQBotConfig(qqbot: Record<string, unknown>): void;
	/** A message the fake QQ pushes to the bot. */
	push(t: string, d: Record<string, unknown>): void;
	stop(): Promise<void>;
}

export interface ChannelTestOptions {
	/**
	 * `channels.qqbot`, merged over { appId, clientSecret, model: "fakellm/fake-1" }; a function receives the
	 * started fakes (for settings that point at them).
	 */
	qqbot?: Record<string, unknown> | ((fakes: { qq: FakeQQ; llm: FakeLLM }) => Record<string, unknown>);
	/** Extensions loaded into every QQ session (MU_QQBOT_EXTENSIONS). Default: none. */
	extensions?: string[];
	/** mu.json keys besides `channels` (e.g. judge settings). */
	muConfig?: Record<string, unknown>;
	fakeQQ?: FakeQQOptions;
	env?: Record<string, string>;
}

const touchedEnv = [
	"PI_CODING_AGENT_DIR",
	"MU_QQBOT_HOME",
	"QQBOT_BASE_URL",
	"QQBOT_TOKEN_BASE_URL",
	"MU_QQBOT_EXTENSIONS",
	"MU_QQBOT_SKILLS",
	"MU_VERSION",
	"MU_PERMISSIONS",
	"MU_JUDGE",
	"MU_QQBOT_LOG_LEVEL",
];

/**
 * A real `mu qqbot start` against local fakes: the QQ Open Platform (FakeQQ) and an OpenAI-compatible model
 * (FakeLLM, reached through a models.json provider). mu's home is a temporary directory.
 */
export async function startChannelTest(options: ChannelTestOptions = {}): Promise<ChannelTestEnv> {
	const saved = new Map(touchedEnv.map((key) => [key, process.env[key]]));
	const root = mkdtempSync(join(tmpdir(), "mu-qqbot-test-"));
	const agentDir = join(root, "agent");
	const qqHome = join(root, "qqbot");
	mkdirSync(agentDir, { recursive: true });

	const qq = new FakeQQ(options.fakeQQ);
	const llm = new FakeLLM();
	await qq.start();
	await llm.start();

	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fakellm: {
					baseUrl: llm.baseUrl,
					api: "openai-completions",
					apiKey: "fake-llm-key",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: true },
					models: [
						{ id: "fake-1", name: "Fake 1", input: ["text", "image"], contextWindow: 128000, maxTokens: 4096 },
					],
				},
			},
		}),
	);
	const muConfigPath = join(agentDir, "mu.json");
	const writeMuConfig = (qqbot: Record<string, unknown>) => {
		writeFileSync(
			muConfigPath,
			JSON.stringify(
				{
					...(options.muConfig ?? {}),
					channels: { qqbot: { appId: APP_ID, clientSecret: APP_SECRET, model: "fakellm/fake-1", ...qqbot } },
				},
				null,
				2,
			),
		);
	};
	writeMuConfig((typeof options.qqbot === "function" ? options.qqbot({ qq, llm }) : options.qqbot) ?? {});

	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.MU_QQBOT_HOME = qqHome;
	process.env.QQBOT_BASE_URL = qq.baseUrl;
	process.env.QQBOT_TOKEN_BASE_URL = qq.baseUrl;
	process.env.MU_QQBOT_EXTENSIONS = (options.extensions ?? []).join(":");
	process.env.MU_VERSION = "0.0.0-test";
	process.env.MU_QQBOT_LOG_LEVEL = "debug";
	delete process.env.MU_PERMISSIONS;
	delete process.env.MU_QQBOT_SKILLS;
	for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = value;

	const bot = await startQQBot({ console: process.env.MU_QQBOT_TEST_CONSOLE === "1" });
	await qq.waitForReady();

	return {
		root,
		agentDir,
		qqHome,
		qq,
		llm,
		bot,
		config: () => JSON.parse(readFileSync(muConfigPath, "utf8")) as Record<string, unknown>,
		writeQQBotConfig: writeMuConfig,
		push: (t, d) => qq.push(t, d),
		stop: async () => {
			await bot.stop();
			await qq.stop();
			await llm.stop();
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** The log file the host wrote (redacted). */
export function readLog(env: ChannelTestEnv): string {
	try {
		return readFileSync(join(env.qqHome, "logs", "qqbot.log"), "utf8");
	} catch {
		return "";
	}
}
