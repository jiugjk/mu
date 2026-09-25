import { spawnSync } from "node:child_process";
import { lstatSync, rmSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** kyrn/bin of this checkout: the launcher and its scripts. */
export const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../../../kyrn/bin");

const windows = process.platform === "win32";
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";

/** What the launcher needs of the system: cmd, tasklist and PowerShell on Windows, sh and the usual tools elsewhere. */
export const SYSTEM_PATH = windows
	? [join(systemRoot, "System32"), join(systemRoot, "System32", "WindowsPowerShell", "v1.0")]
	: ["/usr/bin", "/bin"];

/** A bare search path: `first`, then the folder of this Node, then the system's own. */
export function searchPath(...first: string[]): string {
	return [...first, dirname(process.execPath), ...SYSTEM_PATH].join(delimiter);
}

/** The launcher as a person runs it: the bash script elsewhere, mu.cmd on Windows. */
export const MU = join(BIN, windows ? "mu.cmd" : "mu");

/**
 * Runs a script of kyrn/bin, or a link or shim to one, the way a shell does: a bash script directly, a `.cmd` through
 * cmd.exe, which is the only way a batch file starts. `args` are plain words. Nothing of the developer's own setup leaks
 * in: no real home, no MU_* or KYRN_* variables. `HOME` is the home on every platform (USERPROFILE on Windows), and
 * Windows also gets the few variables its programs expect to find.
 */
export function runScript(script: string, args: readonly string[], env: Record<string, string>, timeout = 60_000) {
	const base: Record<string, string | undefined> = windows
		? {
				PATH: searchPath(),
				PATHEXT: process.env.PATHEXT,
				ComSpec: process.env.ComSpec,
				SystemDrive: process.env.SystemDrive,
				SystemRoot: systemRoot,
				windir: process.env.windir,
				TEMP: process.env.TEMP,
				TMP: process.env.TMP,
			}
		: { PATH: searchPath() };
	const full = { ...base, ...env, ...(windows && env.HOME ? { USERPROFILE: env.HOME } : {}) };
	const options = { encoding: "utf8" as const, input: "", env: full, timeout, windowsHide: true };
	const result = windows
		? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${script}" ${args.join(" ")}"`], {
				...options,
				windowsVerbatimArguments: true,
			})
		: spawnSync(script, args, options);
	return { code: result.status, out: result.stdout, err: result.stderr };
}

/**
 * Removes a folder a test gave the launcher as its home. The app view in it leads into this repository (through
 * junctions on Windows): its links go first, one by one, so that removing the rest can never reach the sources.
 */
export function removeHome(home: string): void {
	for (const app of [join(home, ".mu", "app"), join(home, ".kyrn", "app")]) {
		for (const name of ["src", "docs", "examples", "README.md", "CHANGELOG.md"]) {
			try {
				if (lstatSync(join(app, name)).isSymbolicLink()) unlinkSync(join(app, name));
			} catch {
				// Not there, or not a link.
			}
		}
	}
	// A process the launcher started may take a moment to let go of the folder on Windows.
	rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
