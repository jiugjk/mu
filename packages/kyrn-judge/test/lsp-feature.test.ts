import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { JudgeError } from "../src/errors.ts";
import { DIAGNOSTICS_MESSAGE, projectServersTrusted } from "../src/extension/features/lsp.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer, JudgeProvider } from "../src/types.ts";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp-server.mjs");
const yes: Answer = { type: "boolean", probability: 0.95 };
const no: Answer = { type: "boolean", probability: 0.04 };

const verdict =
	(moreEditsComing: Answer, warningsAreStyle: Answer = no): MockResponder =>
	(request): Record<string, Answer> =>
		"more_edits_coming" in request.questions
			? { more_edits_coming: moreEditsComing, warnings_are_style: warningsAreStyle }
			: {};

const write = (path: string, content: string, say = "Editing.") =>
	fauxAssistantMessage([fauxText(say), fauxToolCall("write", { path, content })], { stopReason: "toolUse" });

describe("lsp diagnostics feature", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		// A server that was stopped on Windows goes through taskkill, which takes a moment to let go of its folders.
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	const scratch = () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-lsp-feature-"));
		dirs.push(dir);
		return dir;
	};

	async function start(
		judge: MockResponder | JudgeProvider,
		extra: { mode?: DecisionMode; lsp?: Record<string, unknown>; server?: Record<string, unknown> } = {},
	) {
		const log = join(scratch(), "server.log");
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: typeof judge === "function" ? new MockJudgeProvider(judge) : judge,
					mode: extra.mode ?? "active",
					only: ["lsp"],
					onPresentation: (event) => events.push(event),
					config: parseConfig({
						features: {
							lsp: {
								builtin: false,
								quietMs: 40,
								settleMs: 3000,
								turnEndSettleMs: 3000,
								baselineMs: 2000,
								servers: {
									fake: {
										command: process.execPath,
										args: [FAKE_SERVER, JSON.stringify({ log, ...extra.server })],
										extensions: [".fake"],
									},
								},
								...extra.lsp,
							},
						},
					}),
				}),
			],
		});
		harnesses.push(harness);
		const starts = () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.split("\n")
						.filter((line) => line.startsWith("start")).length
				: 0;
		const toolResults = () =>
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => JSON.stringify(message));
		const told = () =>
			harness.session.messages
				.filter(
					(message) =>
						message.role === "custom" && (message as { customType?: string }).customType === DIAGNOSTICS_MESSAGE,
				)
				.map((message) => String((message as { content?: unknown }).content));
		const kinds = () => events.filter((event) => event.kind.startsWith("diagnostics.")).map((event) => event.kind);
		const run = async (prompt: string, responses: FauxResponseStep[]) => {
			harness.setResponses(responses);
			await harness.session.prompt(prompt);
		};
		return {
			harness,
			starts,
			toolResults,
			told,
			kinds,
			events,
			run,
			file: (name: string) => join(harness.tempDir, name),
		};
	}

	it("starts nothing until a matching file is edited, and then tells only what the edit introduced", async () => {
		const { harness, starts, toolResults, told, events, run, file } = await start(verdict(no));
		writeFileSync(file("a.fake"), "one\ntwo !error E1 was here before\nthree\n");

		await run("Write the notes.", [write("notes.md", "# notes\n"), fauxAssistantMessage("Done.")]);
		expect(starts()).toBe(0);

		await run("Add the helper.", [
			write("a.fake", "zero\nzero\none\ntwo !error E1 was here before\nthree !error E2 Cannot find helper 你好\n"),
			fauxAssistantMessage("Added."),
			fauxAssistantMessage("I will leave that error for now."),
		]);
		expect(starts()).toBe(1);
		const result = toolResults().at(-1) ?? "";
		expect(result).toContain("[mu diagnostics: 1 error that your edits introduced.");
		expect(result).toContain("a.fake:5:7 error E2 Cannot find helper 你好");
		expect(result).toContain("[mu diagnostics end]");
		// The old problem moved two lines down and is still not this edit's.
		expect(result).not.toContain("was here before");
		// The model was told and the error is still there when it stops: the rule says it once more, and only once.
		await vi.waitFor(() => expect(told()).toHaveLength(1));
		const delivered = events.filter((event) => event.kind === "diagnostics.delivered").map((event) => event.payload);
		expect(delivered).toMatchObject([
			{ errors: 1, by: "judge", when: "edit" },
			{ errors: 1, by: "rule", when: "turn_end" },
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("works the same for the edit tool, and stays out of a failed edit", async () => {
		const { toolResults, run, file } = await start(verdict(no));
		writeFileSync(file("a.fake"), "one\ntwo !error E1 was here before\nthree\n");
		const edit = (oldText: string, newText: string) =>
			fauxAssistantMessage(
				[fauxText("Editing."), fauxToolCall("edit", { path: "a.fake", edits: [{ oldText, newText }] })],
				{
					stopReason: "toolUse",
				},
			);
		await run("Change line three.", [
			edit("no such text", "x"),
			edit("three", "three !error E2 introduced by the edit"),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Seen."),
		]);
		expect(toolResults()[0]).not.toContain("mu diagnostics");
		expect(toolResults()[1]).toContain("a.fake:3:7 error E2 introduced by the edit");
		// The edit tool's own diff shows the old line as context; the diagnostics block must not.
		const block = toolResults()[1].slice(
			toolResults()[1].indexOf("[mu diagnostics"),
			toolResults()[1].indexOf("[mu diagnostics end"),
		);
		expect(block).not.toContain("was here before");
	});

	it("holds what the model is about to fix anyway, and says nothing when it did", async () => {
		const { toolResults, told, kinds, run, harness } = await start(verdict(yes));
		await run("Rename helper everywhere.", [
			write("lib.fake", "export !provides helper\n", "Setting up."),
			write("app.fake", "use !needs helper\n", "Now the caller."),
			write("lib.fake", "export nothing yet\n", "Renaming in lib first, the callers follow."),
			write("lib.fake", "export !provides helper\n", "And back."),
			fauxAssistantMessage("All renamed."),
		]);
		expect(toolResults().join("\n")).not.toContain("mu diagnostics");
		expect(kinds()).toEqual(["diagnostics.held"]);
		expect(told()).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("tells held errors once when the model stops with them still there, in the file that broke", async () => {
		const { toolResults, told, kinds, run, harness, events } = await start(verdict(yes));
		await run("Set it up.", [
			write("lib.fake", "export !provides helper\n", "Setting up."),
			write("app.fake", "use !needs helper\n", "Now the caller."),
			fauxAssistantMessage("Both files are there."),
		]);
		// A new turn: only lib.fake is edited in it, and what breaks is the caller.
		await run("Rename helper everywhere.", [
			write("lib.fake", "export nothing\n", "Renaming in lib first, the callers follow."),
			fauxAssistantMessage("All renamed, done."),
			fauxAssistantMessage("Fixed the caller."),
			fauxAssistantMessage("unused"),
		]);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
		expect(toolResults().join("\n")).not.toContain("mu diagnostics");
		expect(told()).toHaveLength(1);
		expect(told()[0]).toContain("still there");
		expect(told()[0]).toContain("app.fake:1:5 error E_NEEDS Missing helper (in a file you did not edit)");
		expect(kinds()).toEqual(["diagnostics.held", "diagnostics.delivered"]);
		const delivered = events.find((event) => event.kind === "diagnostics.delivered")?.payload;
		expect(delivered).toMatchObject({ errors: 1, warnings: 0, files: ["app.fake"], by: "rule", when: "turn_end" });
		expect(JSON.stringify(delivered)).not.toContain("Missing helper");
	});

	it("drops style warnings for good and counts what it kept out", async () => {
		const { toolResults, told, kinds, run, harness } = await start(verdict(no, yes));
		await run("Tidy up.", [
			write("a.fake", "clean\n", "Creating it."),
			write("a.fake", "clean\nlet x !warn W1 x is never used\n", "Adding the variable."),
			fauxAssistantMessage("Done."),
		]);
		expect(toolResults().join("\n")).not.toContain("mu diagnostics");
		expect(kinds()).toEqual(["diagnostics.dropped"]);
		expect(told()).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("caps the list and says how many were left out", async () => {
		const { toolResults, run } = await start(verdict(no), { lsp: { maxItems: 2 } });
		const broken = Array.from({ length: 5 }, (_, index) => `line !error E${index} problem ${index}`).join("\n");
		await run("Write it.", [
			write("a.fake", broken),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Looked at them."),
		]);
		const result = toolResults()[0];
		expect(result).toContain("5 errors that your edits introduced");
		expect(result).toContain("[mu diagnostics end: 3 more not shown]");
	});

	for (const [name, mode, judge] of [
		["shadow", "shadow", verdict(no, no)],
		["off", "off", verdict(no, no)],
		[
			"a judge that is down",
			"active",
			{
				id: "down",
				evaluate: async () => {
					throw new JudgeError("unreachable", "no route to the judge");
				},
			} satisfies JudgeProvider,
		],
	] as const) {
		it(`with ${name}: errors wait for the end of the turn, warnings are never told`, async () => {
			const { toolResults, told, run, harness } = await start(judge, { mode });
			await run("Break it.", [
				write("a.fake", "bad !error E1 broken build\nodd !warn W1 looks odd\n"),
				fauxAssistantMessage("Done."),
				fauxAssistantMessage("Fixed."),
				fauxAssistantMessage("unused"),
			]);
			await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
			expect(toolResults().join("\n")).not.toContain("mu diagnostics");
			expect(told()).toHaveLength(1);
			expect(told()[0]).toContain("a.fake:1:5 error E1 broken build");
			expect(told()[0]).not.toContain("looks odd");
		});
	}

	it("does not wait for a slow server: what arrives late is told when the model stops", async () => {
		const { toolResults, told, run, harness } = await start(verdict(no), {
			lsp: { settleMs: 60 },
			server: { delayMs: 400 },
		});
		await run("Break it.", [
			write("a.fake", "bad !error E1 slow to be found\n"),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Fixed."),
			fauxAssistantMessage("unused"),
		]);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
		expect(toolResults().join("\n")).not.toContain("mu diagnostics");
		expect(told()).toHaveLength(1);
		expect(told()[0]).toContain("a.fake:1:5 error E1 slow to be found");
	});

	it("lists servers, what runs and the last error under /lsp, and registers them in the catalog", async () => {
		const { harness, run } = await start(verdict(no));
		await run("Go.", [write("a.fake", "fine\n"), fauxAssistantMessage("Done.")]);
		const shown: string[] = [];
		const command = harness.session.extensionRunner.getCommand("lsp");
		await command?.handler("", {
			cwd: harness.tempDir,
			isProjectTrusted: () => true,
			ui: { notify: (message: string) => shown.push(message) },
		} as never);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toMatch(/ok {2}fake +\.fake · .*node/);
		expect(shown[0]).toContain("running in ");
		expect(shown[0]).toContain("1 open · started 1x");
		expect(shown[0]).toContain("0 new diagnostics tracked this turn");
	});

	it("restarts a crashed server once, on its next use, and then leaves it down", async () => {
		const { starts, toolResults, run } = await start(verdict(no));
		await run("Go.", [
			write("a.fake", "fine\n", "First."),
			write("a.fake", "boom !crash\n", "This kills the server."),
			write("a.fake", "fine again !error E1 seen after the restart\n", "Third."),
			write("a.fake", "boom !crash\n", "Kills it again."),
			write("a.fake", "quiet !error E2 nobody is listening\n", "Fifth."),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Done again."),
		]);
		expect(starts()).toBe(2);
		// The restarted server had no baseline for the file, so its first word is not called new.
		expect(toolResults().join("\n")).not.toContain("mu diagnostics");
	});

	it("is silent when no server is installed, and finds one on PATH when it is", async () => {
		const bin = scratch();
		// Only this folder, and on Windows the system's own as well, as every PATH there has it: taskkill is in it.
		const system = process.platform === "win32" ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : [];
		vi.stubEnv("PATH", [bin, ...system].join(delimiter));
		const silent = await start(verdict(no), { lsp: { builtin: true, servers: {} } });
		await silent.run("Write it.", [write("a.ts", "const x: number = 'no';\n"), fauxAssistantMessage("Done.")]);
		expect(silent.toolResults().join("\n")).not.toContain("mu diagnostics");
		expect(silent.kinds()).toEqual([]);

		const log = join(bin, "found.log");
		const config = JSON.stringify({ log });
		if (process.platform === "win32") {
			// As npm installs one on Windows: name.cmd, which only cmd can start. Node reads a quote in its command line as \".
			const quoted = config.replaceAll('"', '\\"');
			writeFileSync(
				join(bin, "typescript-language-server.cmd"),
				`@"${process.execPath}" "${FAKE_SERVER}" "${quoted}" %*\r\n`,
			);
		} else {
			writeFileSync(
				join(bin, "typescript-language-server"),
				`#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER}" '${config}'\n`,
			);
			chmodSync(join(bin, "typescript-language-server"), 0o755);
		}
		// The server starts on the first edit, which on a cold, busy machine takes longer than the usual settle wait;
		// the wait ends as soon as the server has spoken, so a longer one only costs a slow run.
		const found = await start(verdict(no), { lsp: { builtin: true, servers: {}, settleMs: 15_000 } });
		await found.run("Write it.", [
			write("notes.md", "nothing for a language server\n", "Notes first."),
			write("a.ts", "const x = 1; // !error TS2322 Type 'string' is not assignable\n", "Now the code."),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Seen."),
		]);
		expect(found.toolResults()[0]).not.toContain("mu diagnostics");
		expect(found.toolResults()[1]).toContain("a.ts:1:17 error TS2322 Type 'string' is not assignable");
		expect(readFileSync(log, "utf8")).toContain("textDocument/didOpen");
	});

	it("never starts a server that the project names unless the project is trusted", async () => {
		const agentDir = scratch();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const log = join(scratch(), "project.log");
		const projectFile = (cwd: string) => {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "lsp.json"),
				JSON.stringify({
					servers: {
						mine: {
							command: process.execPath,
							args: [FAKE_SERVER, JSON.stringify({ log })],
							extensions: [".proj"],
						},
					},
				}),
			);
		};

		const untrusted = await start(verdict(no));
		projectFile(untrusted.harness.tempDir);
		await untrusted.run("Write it.", [write("a.proj", "x !error E1 broken\n"), fauxAssistantMessage("Done.")]);
		expect(existsSync(log)).toBe(false);
		expect(untrusted.toolResults().join("\n")).not.toContain("mu diagnostics");

		const trusted = await start(verdict(no));
		projectFile(trusted.harness.tempDir);
		new ProjectTrustStore(agentDir).set(trusted.harness.tempDir, true);
		await trusted.run("Write it.", [
			write("a.proj", "x !error E1 broken\n"),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Seen."),
		]);
		expect(readFileSync(log, "utf8")).toContain("start");
		expect(trusted.toolResults().join("\n")).toContain("a.proj:1:3 error E1 broken");
	});

	it("takes pi's word on trust only when pi had to ask, and a saved decision otherwise", () => {
		const agentDir = scratch();
		const cwd = scratch();
		expect(projectServersTrusted({ cwd, isProjectTrusted: () => false }, agentDir)).toBe(false);
		// Nothing in the folder made pi ask, so its "trusted" is a default, not a decision.
		expect(projectServersTrusted({ cwd, isProjectTrusted: () => true }, agentDir)).toBe(false);
		new ProjectTrustStore(agentDir).set(cwd, true);
		expect(projectServersTrusted({ cwd, isProjectTrusted: () => true }, agentDir)).toBe(true);
		expect(projectServersTrusted({ cwd, isProjectTrusted: () => false }, agentDir)).toBe(false);

		const asked = scratch();
		mkdirSync(join(asked, ".pi"), { recursive: true });
		writeFileSync(join(asked, ".pi", "settings.json"), "{}");
		expect(projectServersTrusted({ cwd: asked, isProjectTrusted: () => true }, agentDir)).toBe(true);
	});
});
