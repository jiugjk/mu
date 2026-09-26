import { Type } from "typebox";
import {
	type GitUnusable,
	type GitUnusableReason,
	heldByLicense,
	stubProblem,
	UNUSABLE_TEXT,
} from "../../checkpoint/git.ts";
import { fileLocate, type LocateOutcome } from "../../decisions/file-locate.ts";
import type { KyrnRuntime } from "../runtime.ts";

/** Cheap lexical prefilter: how many query words appear in the path. */
export function lexicalRank(paths: readonly string[], query: string, limit: number): string[] {
	const words = query
		.toLowerCase()
		.split(/[^a-z0-9一-鿿]+/)
		.filter((word) => word.length > 1);
	return paths
		.map((path) => {
			const lower = path.toLowerCase();
			return { path, hits: words.filter((word) => lower.includes(word)).length };
		})
		.sort((a, b) => b.hits - a.hits || a.path.length - b.path.length)
		.slice(0, limit)
		.map((entry) => entry.path);
}

/**
 * F: a judge-backed `locate` tool. One call ranks candidate files against what
 * the agent is looking for and returns a dozen paths, in place of a string of
 * grep calls whose output all lands in the context.
 */
export function registerTools(runtime: KyrnRuntime): void {
	const options = runtime.options("locate", { enabled: true, candidates: 40, results: 12 });
	if (!options.enabled) return;
	const { pi } = runtime;
	let stub: Promise<GitUnusable | undefined> | undefined;
	/** git cannot run on this Mac: the model hears why, and nothing is ranked. */
	const cannot = (reason: GitUnusableReason) => {
		const none: LocateOutcome["ranked"] = [];
		return {
			content: [
				{
					type: "text" as const,
					text: `${UNUSABLE_TEXT[reason]}. locate lists files with git; search another way.`,
				},
			],
			details: { ranked: none, judged: false },
		};
	};

	pi.registerTool({
		name: "locate",
		label: "Locate",
		description:
			"Find the files most likely to contain something, described in words (e.g. 'where session cookies are set'). Returns a ranked list of paths. Prefer it over repeated grep when you do not know the exact identifier.",
		parameters: Type.Object({
			query: Type.String({ description: "What you are looking for, in plain words" }),
			directory: Type.Optional(Type.String({ description: "Limit the search to this directory" })),
		}),
		execute: async (_toolCallId, params, signal) => {
			const cwd = runtime.ctx?.cwd ?? process.cwd();
			// A Mac's git stub without the developer tools is never started: each start opens their install dialog.
			stub ??= stubProblem("git", process.env.PATH);
			const problem = await stub;
			if (problem) return cannot(problem.reason);
			const listing = await pi.exec("git", ["ls-files", ...(params.directory ? [params.directory] : [])], {
				cwd,
				signal,
			});
			if (heldByLicense(listing.code, () => `${listing.stderr}\n${listing.stdout}`)) return cannot("xcode_license");
			const paths = listing.stdout.split("\n").filter(Boolean);
			if (paths.length === 0) {
				const none: LocateOutcome["ranked"] = [];
				return {
					content: [{ type: "text", text: "No tracked files found here." }],
					details: { ranked: none, judged: false },
				};
			}
			const candidates = lexicalRank(paths, params.query, options.candidates);
			const decision = await runtime.engine.decide(
				fileLocate,
				{ query: params.query, paths: candidates },
				{ signal },
			);
			const ranked = decision.outcome.ranked.slice(0, options.results);
			const text = ranked.map((entry) => `${entry.probability.toFixed(2)}  ${entry.path}`).join("\n");
			return { content: [{ type: "text", text }], details: { ranked, judged: decision.source === "judge" } };
		},
	});
}
