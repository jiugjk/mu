import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listOf, readFrontmatter } from "../src/inherit/frontmatter.ts";
import { globToRegExp, matchesAnyGlob } from "../src/inherit/glob.ts";
import { type JsonSelection, parseSelected } from "../src/inherit/json-members.ts";
import { expandPlaceholders } from "../src/inherit/mcp-config.ts";
import { ruleLabel, rulesForFile } from "../src/inherit/rules.ts";
import { inheritanceSummary, readInheritState, scanInheritance, writeInheritState } from "../src/inherit/scan.ts";
import { readMcpServerTables } from "../src/inherit/toml.ts";

const SECRET = "sk-test-SECRET-value-0123456789";

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** A throwaway home and project. Nothing here ever looks at the real home folder. */
function fixture(files: Record<string, string>): { home: string; project: string } {
	const root = mkdtempSync(join(tmpdir(), "mu-inherit-"));
	roots.push(root);
	const home = join(root, "home");
	const project = join(root, "home", "code", "app");
	mkdirSync(join(project, ".git"), { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		const target = path.startsWith("~/") ? join(home, path.slice(2)) : join(project, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return { home, project };
}

const skill = (name: string, description = `what ${name} does`) =>
	`---\nname: ${name}\ndescription: ${description}\n---\nSteps for ${name}.\n`;

describe("rule files", () => {
	it("reads the frontmatter Cursor writes, which is not YAML", () => {
		const parsed = readFrontmatter(
			"---\ndescription: API rules\nglobs: *.ts, src/**/*.{ts,tsx}\nalwaysApply: false\n---\nBody\n",
		);
		expect(parsed.fields.description).toBe("API rules");
		expect(parsed.fields.alwaysApply).toBe(false);
		expect(listOf(parsed.fields.globs)).toEqual(["*.ts", "src/**/*.{ts,tsx}"]);
		expect(parsed.body).toBe("Body\n");
		expect(listOf(readFrontmatter("---\npaths:\n  - 'src/**'\n  - docs/*.md\n---\nx").fields.paths)).toEqual([
			"src/**",
			"docs/*.md",
		]);
		expect(listOf(readFrontmatter('---\nglobs: ["a.ts", "b.ts"]\n---\nx').fields.globs)).toEqual(["a.ts", "b.ts"]);
		expect(readFrontmatter("no frontmatter").fields).toEqual({});
	});

	it("matches the glob syntax rules use", () => {
		expect(matchesAnyGlob("src/api/user.ts", ["*.ts"])).toBe(true);
		expect(matchesAnyGlob("src/api/user.ts", ["src/**/*.ts"])).toBe(true);
		expect(matchesAnyGlob("src/user.ts", ["src/**/*.ts"])).toBe(true);
		expect(matchesAnyGlob("src/api/user.tsx", ["src/**/*.{ts,tsx}"])).toBe(true);
		expect(matchesAnyGlob("src/api/user.js", ["src/**/*.{ts,tsx}"])).toBe(false);
		expect(matchesAnyGlob("docs/a/b.md", ["docs/"])).toBe(true);
		expect(matchesAnyGlob("lib/user.ts", ["src/*.ts"])).toBe(false);
		expect(matchesAnyGlob("src/a/user.ts", ["src/*.ts"])).toBe(false);
		expect(matchesAnyGlob("test/a1.ts", ["test/a[0-9].ts"])).toBe(true);
		expect(matchesAnyGlob("src\\api\\user.ts", ["src/**/*.ts"])).toBe(true);
		expect(matchesAnyGlob("a.ts", ["{unbalanced.ts"])).toBe(false);
		expect(globToRegExp("   ")).toBeUndefined();
	});

	it("finds what pi does not load, and sorts it into always, by glob, and on request", () => {
		const { home, project } = fixture({
			"~/.claude/CLAUDE.md": "Always answer in Chinese.",
			"~/.codex/AGENTS.md": "Prefer small commits.",
			".cursorrules": "Legacy rule.",
			".cursor/rules/always.mdc": "---\ndescription: House style\nalwaysApply: true\n---\nUse tabs.",
			".cursor/rules/api.mdc":
				"---\ndescription: API conventions\nglobs: src/api/**/*.ts\nalwaysApply: false\n---\nValidate input.",
			".cursor/rules/deploy.mdc": "---\ndescription: How to deploy\nalwaysApply: false\n---\nRun the script.",
			".claude/rules/tests.md": "---\npaths: test/**\n---\nUse vitest.",
			".claude/rules/general.md": "Be careful.",
			// pi reads these itself; they must not come back as inherited rules.
			"CLAUDE.md": "Project memory.",
			"AGENTS.md": "Project agents file.",
		});
		const scan = scanInheritance({ roots: { home, projectDir: project, projectTrusted: true } });
		const byLabel = Object.fromEntries(scan.rules.map((rule) => [ruleLabel(rule), rule]));

		expect(Object.keys(byLabel).sort()).toEqual(
			[
				join(home, ".claude", "CLAUDE.md"),
				join(home, ".codex", "AGENTS.md"),
				".claude/rules/general.md",
				".claude/rules/tests.md",
				".cursor/rules/always.mdc",
				".cursor/rules/api.mdc",
				".cursor/rules/deploy.mdc",
				".cursorrules",
			].sort(),
		);
		expect(byLabel[".cursor/rules/always.mdc"]).toMatchObject({
			mode: "always",
			content: "Use tabs.",
			tool: "cursor",
		});
		expect(byLabel[".cursor/rules/api.mdc"]).toMatchObject({ mode: "glob", globs: ["src/api/**/*.ts"] });
		expect(byLabel[".cursor/rules/deploy.mdc"]).toMatchObject({ mode: "described", description: "How to deploy" });
		expect(byLabel[".claude/rules/tests.md"]).toMatchObject({ mode: "glob", globs: ["test/**"] });
		expect(byLabel[".claude/rules/general.md"]).toMatchObject({ mode: "always" });
		expect(byLabel[".cursorrules"]).toMatchObject({ mode: "always", scope: "project" });
		expect(byLabel[join(home, ".claude", "CLAUDE.md")]).toMatchObject({ mode: "always", scope: "user" });

		expect(rulesForFile(scan.rules, join(project, "src/api/user.ts")).map(ruleLabel)).toEqual([
			".cursor/rules/api.mdc",
		]);
		expect(rulesForFile(scan.rules, join(project, "test/a.test.ts")).map(ruleLabel)).toEqual([
			".claude/rules/tests.md",
		]);
		expect(rulesForFile(scan.rules, join(project, "README.md"))).toEqual([]);
		expect(rulesForFile(scan.rules, join(home, "elsewhere/src/api/user.ts"))).toEqual([]);
	});

	it("takes nothing from a project pi does not trust, and respects every switch", () => {
		const { home, project } = fixture({
			"~/.claude/CLAUDE.md": "User rule.",
			"~/.codex/AGENTS.md": "Codex rule.",
			".cursorrules": "Project rule.",
			".claude/skills/local/SKILL.md": skill("local"),
		});
		const untrusted = scanInheritance({ roots: { home, projectDir: project, projectTrusted: false } });
		expect(untrusted.rules.map((rule) => rule.scope)).toEqual(["user", "user"]);
		expect(untrusted.skills).toEqual([]);

		const trusted = { home, projectDir: project, projectTrusted: true };
		expect(scanInheritance({ roots: trusted, switches: { rules: false } }).rules).toEqual([]);
		expect(scanInheritance({ roots: trusted, switches: { claude: false } }).rules.map((rule) => rule.tool)).toEqual([
			"codex",
			"cursor",
		]);
		expect(scanInheritance({ roots: trusted, switches: { cursor: false, codex: false } }).rules).toHaveLength(1);
	});
});

describe("skills", () => {
	it("offers each skill once, and never one pi already has", () => {
		const { home, project } = fixture({
			"~/shared/pdf/SKILL.md": skill("pdf"),
			"~/.claude/skills/review/SKILL.md": skill("review"),
			"~/.claude/skills/no-description/SKILL.md": "---\nname: nothing\n---\nBody",
			"~/.codex/skills/review/SKILL.md": skill("review", "a copy under the same name"),
			"~/.codex/skills/charts/SKILL.md": skill("charts"),
			"~/.codex/skills/.system/imagegen/SKILL.md": skill("imagegen"),
			"~/.codex/skills/group/nested/SKILL.md": skill("nested"),
			"~/.agents/skills/charts/SKILL.md": skill("charts"),
			".claude/skills/local/SKILL.md": skill("local"),
		});
		// The way these folders usually look: links into one shared place, some of them dangling.
		symlinkSync(join(home, "shared", "pdf"), join(home, ".claude", "skills", "pdf"));
		symlinkSync(join(home, "shared", "pdf"), join(home, ".codex", "skills", "pdf"));
		symlinkSync(join(home, "shared", "gone"), join(home, ".claude", "skills", "gone"));

		const scan = scanInheritance({
			roots: { home, projectDir: project, projectTrusted: true },
			piSkillDirs: [join(home, ".agents", "skills")],
		});

		expect(scan.skills.map((entry) => [entry.name, entry.tool, entry.scope])).toEqual([
			["local", "claude", "project"],
			["pdf", "claude", "user"],
			["review", "claude", "user"],
			["nested", "codex", "user"],
		]);
		expect(scan.skills[1].dir).toBe(join(home, ".claude", "skills", "pdf"));
		expect(scan.problems).toEqual([]);
	});
});

describe("the TOML subset reader", () => {
	it("reads mcp_servers tables and steps over everything else", () => {
		const tables = readMcpServerTables(`
model = "gpt"
notes = """
[mcp_servers.fake]
command = "rm"
"""
[projects."/Users/someone/with spaces"]
trust_level = "trusted"   # comment

[mcp_servers.files]
command = "npx"            # trailing comment
args = [
  "-y",
  "@scope/server",  # comment inside an array
  'C:\\literal\\path',
]
startup_timeout_sec = 20.5
enabled = true

[mcp_servers.files.env]
TOKEN = "a \\"quoted\\" value"
"KEY WITH SPACE" = 'literal'

[mcp_servers."remote one"]
url = "https://example.com/mcp"
http_headers = { Authorization = "Bearer x", "X-Other" = "y" }
env_http_headers.X-From-Env = "SOME_VAR"

[[mcp_servers_list]]
command = "ignored"

[other]
mcp_servers.nope.command = "ignored"
when = 1979-05-27T07:32:00Z
`);
		expect(Object.keys(tables)).toEqual(["files", "remote one"]);
		expect(tables.files).toEqual({
			command: "npx",
			args: ["-y", "@scope/server", "C:\\literal\\path"],
			startup_timeout_sec: 20.5,
			enabled: true,
			env: { TOKEN: 'a "quoted" value', "KEY WITH SPACE": "literal" },
		});
		expect(tables["remote one"]).toEqual({
			url: "https://example.com/mcp",
			http_headers: { Authorization: "Bearer x", "X-Other": "y" },
			env_http_headers: { "X-From-Env": "SOME_VAR" },
		});
	});

	it("reads root-level dotted keys and inline definitions, and names the line of what never closes", () => {
		expect(
			readMcpServerTables('mcp_servers.a.command = "x"\n[mcp_servers]\nb = { command = "y", args = ["1"] }\n'),
		).toEqual({
			a: { command: "x" },
			b: { command: "y", args: ["1"] },
		});
		expect(readMcpServerTables("")).toEqual({});
		expect(() => readMcpServerTables('[mcp_servers.a]\nargs = ["x",\n')).toThrow(/line \d+: an array is not closed/);
		expect(() => readMcpServerTables('[mcp_servers.a]\ncommand = "never closed\n')).toThrow(/line 2/);
	});
});

describe("the selective JSON reader", () => {
	const read = (text: string, selection: JsonSelection) => parseSelected(Buffer.from(text), selection);

	it("builds the selected members as JSON.parse does, and steps over the rest", () => {
		const text = JSON.stringify(
			{
				history: [{ display: 'a "quoted" } and { in a prompt', path: "C:\\dir\\", note: "\\" }],
				mcpServers: { a: { command: "x", args: ["{", "}", '"', "\\"] } },
				projects: { "/a": { mcpServers: { b: {} } }, "/b": { big: "x".repeat(1000) }, "/c": [1, { d: null }] },
				flag: true,
				count: -1.5e3,
			},
			null,
			"\t",
		);
		const whole = JSON.parse(text);
		expect(read(text, { mcpServers: true, flag: true, count: true })).toEqual({
			mcpServers: whole.mcpServers,
			flag: true,
			count: -1500,
		});
		// Of an object member, only the entries whose key passes.
		expect(read(text, { projects: (key) => key !== "/b" })).toEqual({
			projects: { "/a": whole.projects["/a"], "/c": whole.projects["/c"] },
		});
		expect(read(`\uFEFF ${text}\n`, { missing: true })).toEqual({});
		expect(read('{"\\u0061": 1}', { a: true })).toEqual({ a: 1 });
		// The last of two equal keys wins; one a key test selects has to be an object.
		expect(read('{"a": 1, "a": {"b": 2, "c": 3}}', { a: (key) => key === "b" })).toEqual({ a: { b: 2 } });
		expect(read('{"a": {"b": 2}, "a": [1]}', { a: () => true })).toEqual({});
	});

	it("tells an object from anything else, and throws on an object that is not JSON", () => {
		expect(read("[]", { a: true })).toBeUndefined();
		expect(read("", { a: true })).toBeUndefined();
		for (const broken of [
			'{"a": 1',
			'{"a": 1} x',
			'{"a" 1}',
			"{a: 1}",
			'{"a": 1,}',
			'{"a": "never closed}',
			'{"a": }',
			'{"a": [1, 2}',
			'{"a": tru}',
		]) {
			expect(() => read(broken, { a: true }), broken).toThrow(SyntaxError);
		}
	});
});

describe("MCP server definitions", () => {
	const claudeJson = (project: string) =>
		JSON.stringify({
			mcpServers: {
				github: { command: "npx", args: ["-y", "gh-server"], env: { GITHUB_TOKEN: SECRET } },
				linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
				old: { type: "sse", url: "https://example.com/sse" },
			},
			projects: {
				[project]: {
					mcpServers: { scratch: { command: "node", args: ["scratch.js"] } },
					disabledMcpServers: ["linear"],
				},
				"/somewhere/else": { mcpServers: { other: { command: "nope" } } },
			},
		});

	it("normalizes every source into one shape, first definition of a name wins", () => {
		const { home, project } = fixture({});
		const files = {
			"~/.claude.json": claudeJson(project),
			"~/.cursor/mcp.json": JSON.stringify({
				mcpServers: { github: { command: "other-github" }, figma: { url: "http://127.0.0.1:3845/mcp" } },
			}),
			"~/.codex/config.toml":
				'[mcp_servers.docs]\ncommand = "docs-mcp"\nstartup_timeout_sec = 5\n[mcp_servers.docs.env]\nKEY = "v"\n' +
				'[mcp_servers.off]\ncommand = "x"\nenabled = false\n' +
				'[mcp_servers.remote]\nurl = "https://r.example/mcp"\nbearer_token_env_var = "REMOTE_TOKEN"\n',
			".mcp.json": JSON.stringify({
				mcpServers: { db: { command: "db-mcp", args: ["--ro"] }, github: { command: "evil" } },
			}),
			".cursor/mcp.json": JSON.stringify({ mcpServers: { browser: { command: "browser-mcp" } } }),
		};
		for (const [path, content] of Object.entries(files)) {
			const target = path.startsWith("~/") ? join(home, path.slice(2)) : join(project, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}

		const scan = scanInheritance({
			roots: { home, projectDir: project, projectTrusted: true },
			env: { REMOTE_TOKEN: "tok" },
			own: {
				servers: {
					mine: { command: "mine-mcp", exposure: "always" },
					figma: { exposure: "always" },
					docs: { enabled: false },
				},
			},
		});

		const byName = Object.fromEntries(scan.servers.map((server) => [server.name, server]));
		expect(Object.keys(byName)).toEqual(["mine", "scratch", "github", "figma", "remote", "db", "browser"]);
		expect(byName.mine).toMatchObject({ tool: "mu", exposure: "always", scope: "user" });
		expect(byName.github).toMatchObject({
			tool: "claude",
			scope: "user",
			exposure: "judged",
			transport: { type: "stdio", command: "npx", args: ["-y", "gh-server"], env: { GITHUB_TOKEN: SECRET } },
		});
		expect(byName.scratch).toMatchObject({ tool: "claude", scope: "user", transport: { command: "node" } });
		// An entry in mu.json without a command only adjusts the inherited server.
		expect(byName.figma).toMatchObject({ tool: "cursor", exposure: "always", transport: { type: "http" } });
		expect(byName.remote.transport).toEqual({
			type: "http",
			url: "https://r.example/mcp",
			headers: { Authorization: "Bearer tok" },
		});
		expect(byName.db).toMatchObject({ scope: "project", source: join(project, ".mcp.json") });
		expect(byName.browser).toMatchObject({ scope: "project", tool: "cursor" });

		// Keyed by the file below the home, with forward slashes whatever this machine writes.
		const reasons = Object.fromEntries(
			scan.skipped.map((entry) => [
				`${entry.name}@${entry.source.slice(home.length).replaceAll("\\", "/")}`,
				entry.reason,
			]),
		);
		expect(reasons["linear@/.claude.json"]).toContain("switched off for this project in Claude Code");
		expect(reasons["old@/.claude.json"]).toContain("HTTP+SSE");
		expect(reasons["off@/.codex/config.toml"]).toContain("switched off in its own file");
		expect(reasons["docs@/.codex/config.toml"]).toContain("switched off in mu.json");
		expect(reasons["github@/.cursor/mcp.json"]).toContain("is used instead");
		// The repository's "github" does not replace the user's.
		expect(reasons["github@/code/app/.mcp.json"]).toContain("is used instead");
		expect(scan.problems).toEqual([]);
		expect(inheritanceSummary(scan)).toBe("Inherited 6 MCP servers from Claude Code, Cursor and Codex.");
	});

	// A VPS with 1 GB: Claude Code's file had grown to 30 MB of prompt history, and building all of it, twice at every
	// start, took the heap from about 40 MB to about 180 MB.
	it("builds only this project's entries of a large ~/.claude.json", () => {
		const { home, project } = fixture({});
		const projects: Record<string, unknown> = {};
		for (let index = 0; index < 2000; index++) {
			projects[`/work/project-${index}`] = {
				history: [{ display: "a long prompt ".repeat(100), pastedContents: {} }],
				mcpServers: { [`other-${index}`]: { command: "other" } },
			};
		}
		projects[project] = { mcpServers: { scratch: { command: "node", args: ["scratch.js"] } } };
		const text = JSON.stringify({ numStartups: 5, projects, mcpServers: { github: { command: "npx" } } });
		writeFileSync(join(home, ".claude.json"), text);

		const parse = vi.spyOn(JSON, "parse");
		let parsed: number;
		let scan: ReturnType<typeof scanInheritance>;
		try {
			scan = scanInheritance({ roots: { home, projectDir: project, projectTrusted: true } });
			parsed = parse.mock.calls.reduce((sum, [source]) => sum + source.length, 0);
		} finally {
			parse.mockRestore();
		}
		expect(scan.servers.map((server) => server.name)).toEqual(["scratch", "github"]);
		expect(scan.problems).toEqual([]);
		// The keys of the projects and the two members used, not the file.
		expect(text.length).toBeGreaterThan(2_500_000);
		expect(parsed).toBeLessThan(text.length / 20);
	});

	it("does not even parse project files of an untrusted project, but says they are there", () => {
		const { home, project } = fixture({
			".mcp.json": JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }),
			"~/.cursor/mcp.json": JSON.stringify({ mcpServers: { figma: { url: "http://127.0.0.1:3845/mcp" } } }),
		});
		const scan = scanInheritance({ roots: { home, projectDir: project, projectTrusted: false } });
		expect(scan.servers.map((server) => server.name)).toEqual(["figma"]);
		expect(scan.skipped).toEqual([
			{ name: "*", source: join(project, ".mcp.json"), reason: "the project is not trusted" },
		]);
	});

	it("reports a broken file once, keeps going, and never quotes what is in it", () => {
		const { home, project } = fixture({
			"~/.claude.json": `{"mcpServers": {"x": {"env": {"TOKEN": "${SECRET}"}}`,
			"~/.cursor/mcp.json": "[]",
			"~/.codex/config.toml": `[mcp_servers.a]\ncommand = "ok"\nenv = { TOKEN = "${SECRET}\n`,
			".mcp.json": JSON.stringify({ mcpServers: { db: { command: "db-mcp" }, bad: "nonsense", empty: {} } }),
		});
		const scan = scanInheritance({ roots: { home, projectDir: project, projectTrusted: true } });

		expect(scan.servers.map((server) => server.name)).toEqual(["db"]);
		expect(scan.problems.map((problem) => problem.source).sort()).toEqual(
			[join(home, ".claude.json"), join(home, ".cursor", "mcp.json"), join(home, ".codex", "config.toml")].sort(),
		);
		expect(scan.skipped.map((entry) => entry.name).sort()).toEqual(["bad", "empty"]);
		expect(JSON.stringify([scan.problems, scan.skipped])).not.toContain(SECRET);
	});

	it("only reads mu's own section when inheriting MCP servers is switched off", () => {
		const { home, project } = fixture({
			"~/.cursor/mcp.json": JSON.stringify({ mcpServers: { figma: { url: "http://127.0.0.1:3845/mcp" } } }),
		});
		const scan = scanInheritance({
			roots: { home, projectDir: project, projectTrusted: true },
			switches: { mcp: false },
			own: { servers: { mine: { command: "mine-mcp" } } },
		});
		expect(scan.servers.map((server) => server.name)).toEqual(["mine"]);
		expect(inheritanceSummary(scan)).toBeUndefined();
	});

	it("fills in placeholders the way Claude Code and Cursor do", () => {
		const context = { env: { TOKEN: "abc" }, projectDir: "/work/app", home: "/home/u" };
		// Written this way so that no plain string here looks like a template by mistake.
		const hole = (body: string) => ["$", "{", body, "}"].join("");
		expect(expandPlaceholders(`Bearer ${hole("TOKEN")}`, context)).toBe("Bearer abc");
		expect(expandPlaceholders(`${hole("env:TOKEN")}/${hole("MISSING:-fallback")}/${hole("MISSING")}`, context)).toBe(
			"abc/fallback/",
		);
		expect(expandPlaceholders(`${hole("workspaceFolder")}/x:${hole("userHome")}`, context)).toBe(
			"/work/app/x:/home/u",
		);
	});
});

describe("first-run state", () => {
	it("remembers that the notice was shown, and survives a damaged file", () => {
		const { home } = fixture({});
		const agentDir = join(home, ".mu", "agent");
		expect(readInheritState(agentDir)).toEqual({});
		writeInheritState(agentDir, { noticeShownAt: "2026-09-22T00:00:00.000Z" });
		expect(readInheritState(agentDir)).toEqual({ noticeShownAt: "2026-09-22T00:00:00.000Z" });
		writeFileSync(join(agentDir, "mu", "inherit.json"), "{broken");
		expect(readInheritState(agentDir)).toEqual({});
	});

	it("summarizes what was found in one line", () => {
		const { home, project } = fixture({
			"~/.claude/CLAUDE.md": "Rule.",
			"~/.codex/skills/charts/SKILL.md": skill("charts"),
		});
		const scan = scanInheritance({ roots: { home, projectDir: project, projectTrusted: true } });
		expect(inheritanceSummary(scan)).toBe("Inherited 1 rule and 1 skill from Claude Code and Codex.");
		expect(
			inheritanceSummary(scanInheritance({ roots: { home: project, projectDir: project, projectTrusted: true } })),
		).toBe(undefined);
	});
});
