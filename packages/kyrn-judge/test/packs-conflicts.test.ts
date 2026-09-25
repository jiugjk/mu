import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConflicts, replaceBlocks } from "../src/packs/conflicts.ts";
import { sh } from "./fixtures/git-repo.ts";
import { call, disclosing, startPacks, toolResults } from "./packs-helpers.ts";

// The machine's own line-ending setting stays out (Windows runners have core.autocrlf=true, which gives the merged
// files CRLF): the pack keeps whatever endings a file has, as the first test shows.
const LOCAL = {
	"user.name": "t",
	"user.email": "t@t",
	"commit.gpgsign": "false",
	"core.hooksPath": ".git/no-hooks",
	"core.autocrlf": "false",
};
const twelve = (change: Record<number, string> = {}) =>
	`${Array.from({ length: 12 }, (_line, index) => change[index + 1] ?? `b${index + 1}`).join("\n")}\n`;

describe("pack:conflicts", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reads conflict blocks in both styles, keeps the line endings, and refuses damaged markers", () => {
		const merged = "top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\nbottom\n";
		const parsed = parseConflicts(merged);
		expect(parsed.blocks).toEqual([
			{
				number: 1,
				startLine: 2,
				endLine: 6,
				ours: ["ours"],
				base: undefined,
				theirs: ["theirs"],
				oursLabel: "HEAD",
				theirsLabel: "other",
			},
		]);
		expect(replaceBlocks(parsed, new Map([[1, "both\n"]]))).toBe("top\nboth\nbottom\n");
		expect(replaceBlocks(parsed, new Map([[1, ""]]))).toBe("top\nbottom\n");

		const diff3 = "<<<<<<< ours\r\na\r\n||||||| base\r\nb\r\n=======\r\nc\r\n>>>>>>> theirs\r\nend\r\n";
		const withBase = parseConflicts(diff3);
		expect(withBase.eol).toBe("\r\n");
		expect(withBase.blocks[0].base).toEqual(["b"]);
		expect(replaceBlocks(withBase, new Map([[1, "abc"]]))).toBe("abc\r\nend\r\n");

		// A block left alone stays as it was, markers and all.
		const two = parseConflicts(`${merged}<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n`);
		expect(two.blocks).toHaveLength(2);
		expect(parseConflicts(replaceBlocks(two, new Map([[2, "z"]]))).blocks).toHaveLength(1);

		expect(parseConflicts("a\n=======\nb\n").problem).toContain("outside a conflict block");
		expect(parseConflicts("<<<<<<< a\n<<<<<<< b\n").problem).toContain("inside another");
		expect(parseConflicts("<<<<<<< a\nx\n").problem).toContain("not closed");
	});

	it("walks a stopped merge file by file, shows the base, resolves block by block, and never commits", async () => {
		const { harness } = await startPacks(harnesses, { responder: disclosing("Merge conflict") });
		const repo = harness.tempDir;
		sh(repo, "init", "-q", "-b", "main", ".");
		for (const [key, value] of Object.entries(LOCAL)) sh(repo, "config", key, value);
		writeFileSync(join(repo, ".git", "info", "exclude"), "*\n!a.txt\n!b.txt\n!gone.txt\n");
		writeFileSync(join(repo, "a.txt"), "top\nshared\nbottom\n");
		writeFileSync(join(repo, "b.txt"), twelve());
		writeFileSync(join(repo, "gone.txt"), "keep me\n");
		sh(repo, "add", "a.txt", "b.txt", "gone.txt");
		sh(repo, "commit", "-qm", "init");
		sh(repo, "checkout", "-q", "-b", "other");
		writeFileSync(join(repo, "a.txt"), "top\ntheirs\nbottom\n");
		writeFileSync(join(repo, "b.txt"), twelve({ 2: "theirs 2", 11: "theirs 11" }));
		writeFileSync(join(repo, "gone.txt"), "changed by them\n");
		sh(repo, "commit", "-qam", "their side");
		sh(repo, "checkout", "-q", "main");
		writeFileSync(join(repo, "a.txt"), "top\nours\nbottom\n");
		writeFileSync(join(repo, "b.txt"), twelve({ 2: "ours 2", 11: "ours 11" }));
		sh(repo, "rm", "-q", "gone.txt");
		sh(repo, "commit", "-qam", "our side");
		const head = sh(repo, "rev-parse", "HEAD");
		expect(() => sh(repo, "merge", "-q", "other")).toThrow();

		harness.setResponses([
			call("conflicts_list", {}),
			call("conflicts_show", { path: "a.txt" }),
			call("conflicts_resolve", { path: "a.txt", blocks: [{ block: 1, text: "ours and theirs" }] }),
			call("conflicts_resolve", { path: "b.txt", blocks: [{ block: 2, text: "both 11" }] }),
			call("conflicts_resolve", { path: "b.txt", blocks: [{ block: 1, text: "both 2" }] }),
			call("conflicts_resolve", { path: "gone.txt", take: "delete" }),
			fauxAssistantMessage("The conflicts are resolved; the merge is yours to finish."),
		]);

		await harness.session.prompt("The merge stopped on conflicts. Resolve them.");

		const [listed, shown, first, partial, second, last] = toolResults(harness);
		expect(listed).toContain("A merge is in progress: merging");
		expect(listed).toContain("their side");
		expect(listed).toContain("a.txt: both modified, 1 conflict block");
		expect(listed).toContain("b.txt: both modified, 2 conflict blocks");
		expect(listed).toContain("gone.txt: deleted by us");
		// The file was written without base sections; the base comes from the three sides.
		expect(shown).toContain("ours (HEAD)");
		expect(shown).toContain("theirs (other)");
		expect(shown).toMatch(/base:\\n +shared/);
		expect(first).toContain("a.txt: resolved and marked resolved. Still conflicted: b.txt, gone.txt.");
		expect(partial).toContain("b.txt: 1 block resolved, 1 left");
		expect(second).toContain("b.txt: resolved and marked resolved");
		expect(last).toContain("All conflicts are resolved and staged");
		expect(last).toContain("are the user's to run");

		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("top\nours and theirs\nbottom\n");
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe(twelve({ 2: "both 2", 11: "both 11" }));
		expect(sh(repo, "ls-files", "-u")).toBe("");
		// Still merging: nothing was committed and nothing continued.
		expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
		expect(sh(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").trim()).not.toBe("");
	});
});
