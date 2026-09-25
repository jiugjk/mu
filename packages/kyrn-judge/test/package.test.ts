import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const manifest = (dir: string): { name: string; version: string; peerDependencies?: Record<string, string> } =>
	JSON.parse(readFileSync(join(PACKAGES, dir, "package.json"), "utf8"));

/** Whether a caret range admits a version, as npm reads it: below 1.0.0 the minor is the breaking part. */
function admits(range: string, version: string): boolean {
	const [major, minor, patch] = range.replace(/^\^/, "").split(".").map(Number);
	const [atMajor, atMinor, atPatch] = version.split(".").map(Number);
	if (atMajor !== major) return false;
	if (major === 0) return atMinor === minor && atPatch >= patch;
	return atMinor > minor || (atMinor === minor && atPatch >= patch);
}

describe("package.json", () => {
	// A merge of pi moves the workspace to a new minor, and npm links it anyway: ^0.86.0 went on asking for a pi
	// that was no longer there (0.87.1) without a word from npm install.
	it("asks for the pi packages this workspace holds", () => {
		const pi = new Map(["coding-agent", "tui"].map((dir) => [manifest(dir).name, manifest(dir).version]));
		const peers = Object.entries(manifest("kyrn-judge").peerDependencies ?? {});
		expect(peers.map(([name]) => name).sort()).toEqual([...pi.keys()].sort());
		for (const [name, range] of peers) expect(admits(range, pi.get(name) ?? ""), `${name} ${range}`).toBe(true);
	});

	it("reads caret ranges the way npm does", () => {
		expect(admits("^0.87.1", "0.87.1")).toBe(true);
		expect(admits("^0.87.1", "0.87.4")).toBe(true);
		expect(admits("^0.86.0", "0.87.1")).toBe(false);
		expect(admits("^0.87.1", "0.87.0")).toBe(false);
		expect(admits("^1.2.0", "1.9.0")).toBe(true);
		expect(admits("^1.2.0", "2.0.0")).toBe(false);
	});
});
