import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];
let agentDir = "";

vi.mock("../src/host/paths.ts", () => ({
	muAgentDir: () => agentDir,
}));

import { activePersonality } from "../../kyrn-judge/src/personality/model.ts";
import { loadPersonality, personalityPath } from "../../kyrn-judge/src/personality/store.ts";
import { botPersonality } from "../src/qqbot/commands/bot-personality.ts";

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("QQ /personality", () => {
	it("switches the same file the terminal writes, replacing the version rather than appending", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "qq-personality-"));
		dirs.push(agentDir);
		const command = botPersonality();
		const reply = await command.handler({
			command: { raw: "use reviewer", args: ["use", "reviewer"], name: "personality" },
			message: { senderId: "admin" },
		} as never);
		expect(String(reply)).toMatch(/Reviewer|审阅/);
		const loaded = loadPersonality(personalityPath(agentDir));
		const active = activePersonality(loaded.file);
		expect(active.id).toBe("reviewer");
		expect(active.prompt.startsWith("Read as a reviewer first.")).toBe(true);
		expect(active.prompt).not.toContain("Work like a careful colleague");
	});
});
