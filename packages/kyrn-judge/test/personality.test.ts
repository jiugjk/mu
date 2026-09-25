import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../coding-agent/src/core/system-prompt.ts";
import { runPersonalityCommand } from "../src/personality/command.ts";
import {
	activePersonality,
	applyPersonalityAction,
	applyPersonalitySection,
	BUILTIN_PERSONALITIES,
	emptyPersonalityFile,
	MU_IDENTITY,
	normalizePersonalityFile,
	PERSONALITY_SECTION,
} from "../src/personality/model.ts";
import { loadPersonality, personalityPath, writePersonality } from "../src/personality/store.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-personality-"));
	dirs.push(dir);
	return dir;
}

describe("personality versions", () => {
	it("keeps the stock mu text when nothing is selected, and replaces the section instead of appending", () => {
		const stock = activePersonality(emptyPersonalityFile());
		expect(stock.id).toBe("mu");
		expect(stock.prompt).toBe(MU_IDENTITY);

		const sections = applyPersonalitySection(
			{ tools: "keep these", [PERSONALITY_SECTION]: MU_IDENTITY },
			"other voice",
		);
		expect(sections).toEqual({ tools: "keep these", mu: "other voice" });
		expect(Object.keys(sections)).toEqual(["tools", "mu"]);

		const colleague = BUILTIN_PERSONALITIES.find((item) => item.id === "colleague");
		expect(colleague).toBeDefined();
		const rendered = buildSystemPrompt({
			cwd: "/work",
			sections: applyPersonalitySection(undefined, colleague?.prompt ?? ""),
		});
		expect(rendered).toContain("<tools>");
		expect(rendered).toContain("<mu>");
		expect(rendered).toContain("collaborative colleague");
		expect(rendered).not.toContain("Work like a careful colleague");
		expect(rendered).not.toContain(`${MU_IDENTITY}\n\n${colleague?.prompt}`);

		const alice = BUILTIN_PERSONALITIES.find((item) => item.id === "alice");
		expect(alice?.prompt).toContain("Alice (AL-1S)");
		expect(alice?.prompt).not.toContain("Work like a careful colleague");
	});

	it("switches, edits, and deletes through one file the other entry points share", () => {
		const agentDir = tempDir();
		const path = personalityPath(agentDir);
		expect(runPersonalityCommand(agentDir, "use concise")).toMatch(/Concise|简练/);
		const switched = loadPersonality(path);
		expect(switched.invalid).toBe(false);
		expect(activePersonality(switched.file).id).toBe("concise");
		expect(activePersonality(switched.file).prompt).not.toContain(MU_IDENTITY);

		expect(
			runPersonalityCommand(agentDir, "add mine | Mine | a custom voice | Speak as Mine, and only Mine."),
		).toMatch(/Saved|已保存/);
		expect(runPersonalityCommand(agentDir, "edit mine | Speak as Mine, revised.")).toMatch(/Saved|已保存/);
		const edited = activePersonality(
			applyPersonalityAction(loadPersonality(path).file, { action: "use", id: "mine" }),
		);
		expect(edited.prompt).toBe("Speak as Mine, revised.");
		expect(edited.prompt).not.toContain("only Mine");

		expect(runPersonalityCommand(agentDir, "edit concise | Be brief. That is the whole version.")).toMatch(
			/Saved|已保存/,
		);
		expect(runPersonalityCommand(agentDir, "use concise")).toMatch(/Concise|简练/);
		expect(activePersonality(loadPersonality(path).file).prompt).toBe("Be brief. That is the whole version.");
		expect(runPersonalityCommand(agentDir, "reset concise")).toMatch(/Restored|已恢复/);
		expect(activePersonality(loadPersonality(path).file).prompt).toBe(
			BUILTIN_PERSONALITIES.find((item) => item.id === "concise")?.prompt,
		);

		expect(runPersonalityCommand(agentDir, "delete mu")).toMatch(/cannot be deleted|不能删除/);
		expect(runPersonalityCommand(agentDir, "delete mine")).toMatch(/Deleted|已删除/);
		expect(loadPersonality(path).file.custom).toEqual([]);
	});

	it("does not overwrite a broken file", () => {
		const agentDir = tempDir();
		const path = personalityPath(agentDir);
		writePersonality(path, emptyPersonalityFile());
		writeFileSync(path, "{ not json");
		expect(runPersonalityCommand(agentDir, "use mentor")).toMatch(/not valid JSON|不是合法的 JSON/);
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});

	it("drops entries it cannot use and ignores a personality id that is not there", () => {
		const file = normalizePersonalityFile({
			version: 1,
			active: "missing",
			custom: [
				{ id: "Mu", name: "No", prompt: "no" },
				{ id: "mine", name: "Mine", description: "", prompt: "hello" },
			],
			overrides: { concise: { prompt: "short version" }, gone: { prompt: "nope" } },
		});
		expect(file.custom.map((entry) => entry.id)).toEqual(["mine"]);
		expect(file.overrides.gone).toBeUndefined();
		expect(activePersonality(file).id).toBe("mu");
		expect(activePersonality(applyPersonalityAction(file, { action: "use", id: "concise" })).prompt).toBe(
			"short version",
		);
	});
});
