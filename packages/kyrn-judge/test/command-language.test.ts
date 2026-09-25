import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPromptTemplates } from "../../coding-agent/src/core/prompt-templates.ts";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { localizeTemplate, promptsFor } from "../src/extension/localized-prompts.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

const PROMPTS = fileURLToPath(new URL("../prompts", import.meta.url));
const CJK = /[一-鿿]/;

const temporary: string[] = [];
const harnesses: Harness[] = [];
beforeEach(() => {
	// Nothing here calls a model: whatever credentials the shell has must not make one callable either.
	for (const name of [
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_OAUTH_TOKEN",
		"ANTHROPIC_API_KEY",
		"GEMINI_API_KEY",
		"OPENAI_API_KEY",
	]) {
		vi.stubEnv(name, undefined);
	}
});
afterEach(() => {
	vi.unstubAllEnvs();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	while (temporary.length > 0) rmSync(temporary.pop() as string, { recursive: true, force: true });
});

describe("prompt templates in the app's language", () => {
	const template = [
		"---",
		"description: Scout, then plan",
		"description-zh: 先侦察，再计划",
		'argument-hint: "<what you want planned>"',
		'argument-hint-zh: "<想让它计划的事>"',
		"---",
		"Plan this: $@",
		"---",
		"description-zh: in the body, not frontmatter",
	].join("\n");

	it("puts the Chinese in place of the English and leaves the body the model reads alone", () => {
		const localized = localizeTemplate(template, "zh");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(localized);
		expect(frontmatter).toEqual({ description: "先侦察，再计划", "argument-hint": "<想让它计划的事>" });
		expect(body).toBe(parseFrontmatter(template).body);
		expect(localizeTemplate("No frontmatter here.", "zh")).toBe("No frontmatter here.");
		// Written on Windows: a byte-order mark and CRLF lines read the same.
		const windows = `\uFEFF${template.replaceAll("\n", "\r\n")}`;
		expect(parseFrontmatter<Record<string, string>>(localizeTemplate(windows, "zh")).frontmatter).toEqual(
			frontmatter,
		);
		// A block value is left as it is, in both directions; a Chinese key without its English is added.
		const block = [
			"---",
			"description: |",
			"  Two lines",
			"  of English",
			"description-zh: 两行",
			"argument-hint-zh: >",
			"  folded",
			"note-zh: 只有中文",
			"---",
			"Body",
		].join("\n");
		expect(parseFrontmatter<Record<string, string>>(localizeTemplate(block, "zh")).frontmatter).toEqual({
			description: "Two lines\nof English\n",
			note: "只有中文",
		});
		// A template with no Chinese keeps its English.
		expect(localizeTemplate("---\ndescription: Only English\n---\nBody", "zh")).toBe(
			"---\ndescription: Only English\n---\nBody",
		);
	});

	it("gives pi the folder itself in English, and a copy in Chinese made again when a template changes", () => {
		const root = mkdtempSync(join(tmpdir(), "mu-prompt-cache-"));
		const source = mkdtempSync(join(tmpdir(), "mu-prompt-source-"));
		temporary.push(root, source);
		writeFileSync(join(source, "plan.md"), template);
		writeFileSync(join(source, "notes.txt"), "not a template");

		expect(promptsFor(source, "en", root)).toBe(source);
		expect(promptsFor(source, undefined, root)).toBe(source);
		const copy = promptsFor(source, "zh", root);
		expect(copy).not.toBe(source);
		expect(readdirSync(copy)).toEqual(["plan.md"]);
		expect(parseFrontmatter<Record<string, string>>(readFileSync(join(copy, "plan.md"), "utf8")).frontmatter).toEqual(
			{
				description: "先侦察，再计划",
				"argument-hint": "<想让它计划的事>",
			},
		);
		expect(promptsFor(source, "zh", root)).toBe(copy);

		writeFileSync(join(source, "plan.md"), template.replace("先侦察，再计划", "先看，再计划"));
		const updated = promptsFor(source, "zh", root);
		expect(updated).not.toBe(copy);
		expect(readFileSync(join(updated, "plan.md"), "utf8")).toContain("description: 先看，再计划");
		// A change to how templates are localized is a new copy too, not the old one: FORMAT is in its name.
		expect(copy.startsWith(join(root, "zh-"))).toBe(true);
		// Nowhere to write: the English templates rather than none.
		expect(promptsFor(source, "zh", join(source, "notes.txt"))).toBe(source);
	});

	it("every template mu ships has its Chinese", () => {
		for (const name of readdirSync(PROMPTS).filter((file) => file.endsWith(".md"))) {
			const { frontmatter } = parseFrontmatter<Record<string, string>>(readFileSync(join(PROMPTS, name), "utf8"));
			expect(frontmatter["description-zh"], name).toMatch(CJK);
			if (frontmatter["argument-hint"]) expect(frontmatter["argument-hint-zh"], name).toBeTruthy();
		}
	});
});

describe("commands in the app's language", () => {
	async function start(): Promise<Harness> {
		// A home of its own: the features that keep files there (checkpoints, lessons, what was inherited) need one.
		const home = mkdtempSync(join(tmpdir(), "mu-command-language-"));
		temporary.push(home);
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(),
					mode: "active",
					config: parseConfig({}),
					roots: { home, agentDir: home },
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	}
	const commands = (harness: Harness) =>
		harness.session.extensionRunner.getRegisteredCommands().map((command) => [command.name, command.description]);

	it("describes every mu command in Chinese when the app is in Chinese, and in English otherwise", async () => {
		vi.stubEnv("MU_LANG", "zh-CN");
		const chinese = commands(await start());
		expect(chinese.map(([name]) => name)).toEqual(
			expect.arrayContaining([
				"checkpoints",
				"rewind",
				"inherit",
				"remember",
				"board",
				"permissions",
				"swarm",
				"hive",
			]),
		);
		expect(chinese.filter(([, description]) => !CJK.test(description ?? ""))).toEqual([]);
		expect(Object.fromEntries(chinese)).toMatchObject({
			permissions: expect.stringContaining("/permissions full（完全访问）"),
			board: expect.stringContaining("人话看板"),
		});

		vi.stubEnv("MU_LANG", "en-US");
		const english = commands(await start());
		expect(english.map(([name]) => name)).toEqual(chinese.map(([name]) => name));
		expect(english.filter(([, description]) => CJK.test(description ?? ""))).toEqual([]);
	});

	it("shows the templates' Chinese in the menu, with the same body for the model", async () => {
		vi.stubEnv("MU_LANG", "zh-CN");
		const harness = await start();
		// What pi does with the folders mu hands it, with pi's own loader.
		const { promptPaths } = await harness.session.extensionRunner.emitResourcesDiscover(harness.tempDir, "startup");
		const templates = Object.fromEntries(
			loadPromptTemplates({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				promptPaths: promptPaths.map((entry) => entry.path),
				includeDefaults: false,
			}).templates.map((template) => [template.name, template] as const),
		);
		expect(templates.implement?.description).toBe("侦察、计划、实现：三个子代理接力，每个按自己的清单做");
		expect(templates.implement?.argumentHint).toBe("<要做或要修的事>");
		expect(templates.implement?.content).toBe(
			parseFrontmatter(readFileSync(join(PROMPTS, "implement.md"), "utf8")).body,
		);
		expect(templates.init?.description).toMatch(CJK);
		// The copy lives in mu's own folder, not in a temp folder other users can write to.
		expect(
			promptPaths
				.map((entry) => entry.path)
				.every((path) => path.startsWith(harness.tempDir) || path.includes("mu-command-language-")),
		).toBe(true);
	});

	it("without a home of its own (a caller that owns the setup), keeps the English templates and writes nothing", async () => {
		vi.stubEnv("MU_LANG", "zh-CN");
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({ provider: new MockJudgeProvider(), mode: "active", config: parseConfig({}) }),
			],
		});
		harnesses.push(harness);
		const { promptPaths } = await harness.session.extensionRunner.emitResourcesDiscover(harness.tempDir, "startup");
		expect(promptPaths.map((entry) => entry.path)).toContain(PROMPTS);
	});
});
