#!/usr/bin/env node
// The desktop app carries mu inside it (resources/harness/mu-agent) and runs it on its own binary as Node, with
// ELECTRON_RUN_AS_NODE. After a desktop build: does that copy start, on this system, the way the app starts it?
//
//   node kyrn/npm/smoke-app.mjs <the builder's output folder, or one app> [arm64|x64]
//
// An output folder (desktop/out) holds an unpacked app per system and processor: win-unpacked, win-arm64-unpacked,
// linux-unpacked, linux-arm64-unpacked, mac, mac-arm64. The one for the processor named is taken, by default this
// Node's: a runner's Node may be an x64 one emulated on an arm64 machine. One app is a `.app` on macOS, an unpacked
// folder elsewhere. A `mu` that starts the app's binary on the carried launcher is written to a temporary folder and
// handed to smoke.mjs, which checks it in a throwaway home: no model is called.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const mac = process.platform === "darwin";

const isDir = (path) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/** The app's binary and resources folder, when `dir` is an unpacked app for this system. */
function appIn(dir) {
	if (mac) {
		const bundle = dir.endsWith(".app") ? dir : readdirSync(dir).find((name) => name.endsWith(".app"));
		if (!bundle) return undefined;
		const contents = join(dir.endsWith(".app") ? dir : join(dir, bundle), "Contents");
		const binaries = isDir(join(contents, "MacOS")) ? readdirSync(join(contents, "MacOS")) : [];
		if (binaries.length !== 1) return undefined;
		return { binary: join(contents, "MacOS", binaries[0]), resources: join(contents, "Resources") };
	}
	const resources = join(dir, "resources");
	if (!isDir(join(resources, "harness"))) return undefined;
	// Windows: the one .exe beside resources (not the uninstaller electron-builder may add). Linux: the executable
	// electron-builder names in electron-builder.yml, the file beside resources with the execute bit and no dot.
	const helpers = new Set(["chrome-sandbox", "chrome_crashpad_handler"]);
	const binary = readdirSync(dir).find((name) => {
		if (windows) return name.endsWith(".exe") && !/^uninstall/i.test(name);
		const path = join(dir, name);
		return !name.includes(".") && !helpers.has(name) && !isDir(path) && (statSync(path).mode & 0o111) !== 0;
	});
	return binary ? { binary: join(dir, binary), resources } : undefined;
}

function findApp(target, arch) {
	const direct = appIn(target);
	if (direct) return direct;
	// An output folder: the unpacked app for this system and processor.
	const system = windows ? /^win/ : mac ? /^mac/ : /^linux/;
	const arm = arch === "arm64";
	for (const name of readdirSync(target).sort()) {
		if (!system.test(name) || name.includes("arm64") !== arm || !isDir(join(target, name))) continue;
		if (!mac && !name.endsWith("unpacked")) continue;
		const found = appIn(join(target, name));
		if (found) return found;
	}
	return undefined;
}

const target = resolve(process.argv[2] ?? "out");
const arch = process.argv[3] ?? process.arch;
const app = existsSync(target) ? findApp(target, arch) : undefined;
if (!app) {
	console.error(`No unpacked app for ${process.platform}-${arch} in ${target}`);
	process.exit(2);
}
const launcher = join(app.resources, "harness", "mu-agent", "kyrn", "bin", "mu.mjs");
if (!existsSync(launcher)) {
	console.error(`The app carries no mu: ${launcher} is missing`);
	process.exit(2);
}
console.log(`app binary: ${app.binary}`);
console.log(`mu launcher: ${launcher}`);

// What the app itself does (piRpc.ts, launchCommand): its binary as Node, the launcher as the script.
const folder = mkdtempSync(join(tmpdir(), "mu-app-smoke-"));
const mu = join(folder, windows ? "mu.cmd" : "mu");
writeFileSync(
	mu,
	windows
		? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${app.binary}" "${launcher}" %*\r\n`
		: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${app.binary}" "${launcher}" "$@"\n`,
);
if (!windows) chmodSync(mu, 0o755);

const smoke = join(dirname(fileURLToPath(import.meta.url)), "smoke.mjs");
const result = spawnSync(process.execPath, [smoke, mu], { stdio: "inherit" });
rmSync(folder, { recursive: true, force: true });
console.log(`${basename(app.binary)} ran its own mu: ${result.status === 0 ? "ok" : "FAILED"}`);
process.exit(result.status ?? 1);
