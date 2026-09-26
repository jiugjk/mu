import {
	type GitProbe,
	type GitUnusable,
	type GitUnusableReason,
	heldByLicense,
	hostProbe,
	stubProblem,
	UNUSABLE_TEXT,
} from "../checkpoint/git.ts";
import type { Runner } from "./exec.ts";

/**
 * git for the packs that commit and resolve: the user's own repository, the
 * user's own hooks. That is the difference from `src/swarm/worktree.ts`, whose
 * runner turns hooks off because it makes checkouts nobody asked for.
 */
export interface GitCall {
	readonly cwd: string;
	readonly input?: string | Buffer;
	readonly env?: Readonly<Record<string, string>>;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface GitOutput {
	readonly code: number;
	/** Bytes: a diff may hold any encoding, and a path any characters. */
	readonly stdout: Buffer;
	readonly stderr: string;
	readonly missing: boolean;
	/** git is there and cannot run on this Mac: not started at all (`developer_tools_missing`), or held back. */
	readonly unusable?: GitUnusableReason;
}

export type Git = (args: readonly string[], call: GitCall) => Promise<GitOutput>;

/** Variables that would point git at another repository or index than the one in `cwd`, as a hook sets them. */
const INHERITED = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

/**
 * Before git first runs, the probe checks it is no macOS stub without the developer tools behind it
 * (`stubProblem`): that git is never started, since each start opens the system's install dialog.
 */
export function gitOver(run: Runner, binary = "git", probe: GitProbe = hostProbe): Git {
	let stub: Promise<GitUnusable | undefined> | undefined;
	return async (args, call) => {
		stub ??= stubProblem(binary, call.env?.PATH ?? process.env.PATH, probe);
		const problem = await stub;
		if (problem)
			return {
				code: 127,
				stdout: Buffer.alloc(0),
				stderr: problem.message,
				missing: false,
				unusable: problem.reason,
			};
		const env: Record<string, string | undefined> = {};
		for (const name of INHERITED) env[name] = undefined;
		// Messages are read by a model and compared in tests: never localized, never a prompt, never a pager.
		Object.assign(env, { LC_ALL: "C", LANGUAGE: "C", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" }, call.env);
		const result = await run(binary, ["-c", "core.quotepath=false", ...args], {
			cwd: call.cwd,
			input: call.input,
			env,
			signal: call.signal,
			timeoutMs: call.timeoutMs ?? 60_000,
			encoding: "latin1",
		});
		const output: GitOutput = {
			code: result.code,
			stdout: Buffer.from(result.stdout, "latin1"),
			stderr: result.stderr,
			missing: result.missing,
		};
		return heldByLicense(result.code, () => `${result.stderr}\n${result.stdout}`)
			? { ...output, unusable: "xcode_license" }
			: output;
	};
}

export const text = (output: GitOutput): string => output.stdout.toString("utf8");

export const lines = (output: GitOutput): string[] => text(output).split("\n").filter(Boolean);

export const splitZ = (output: GitOutput): string[] => text(output).split("\0").filter(Boolean);

export type RepoState =
	| { ok: true; root: string; gitDir: string; head: string | undefined; inProgress: string | undefined }
	| { ok: false; reason: "no-git" | "not-a-repo"; message: string }
	/** `message` is for a model: only the user can make git run (`UNUSABLE_TEXT`). */
	| { ok: false; reason: "unusable"; unusable: GitUnusableReason; message: string };

const IN_PROGRESS = [
	["MERGE_HEAD", "merge"],
	["REBASE_HEAD", "rebase"],
	["CHERRY_PICK_HEAD", "cherry-pick"],
	["REVERT_HEAD", "revert"],
] as const;

/**
 * Where the repository is, whether HEAD exists, and whether a merge, rebase,
 * cherry-pick or revert is under way (`inProgress` names it).
 */
export async function repoState(git: Git, cwd: string): Promise<RepoState> {
	const top = await git(["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd });
	if (top.missing) return { ok: false, reason: "no-git", message: "git could not be started" };
	if (top.unusable)
		return { ok: false, reason: "unusable", unusable: top.unusable, message: UNUSABLE_TEXT[top.unusable] };
	if (top.code !== 0)
		return { ok: false, reason: "not-a-repo", message: lastLine(top.stderr) || "not a git repository" };
	const [root, gitDir] = lines(top).map((line) => line.trim());
	const head = await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd });
	let inProgress: string | undefined;
	for (const [ref, name] of IN_PROGRESS) {
		if ((await git(["rev-parse", "--verify", "-q", ref], { cwd })).code === 0) {
			inProgress = name;
			break;
		}
	}
	return { ok: true, root, gitDir, head: head.code === 0 ? text(head).trim() : undefined, inProgress };
}

export function lastLine(stderr: string): string {
	return stderr.trim().split("\n").pop()?.trim() ?? "";
}
