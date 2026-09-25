// Loaded into the launcher with NODE_OPTIONS=--import by the launcher's tests on Windows. The list of running processes
// the launcher asks tasklist and PowerShell for comes from two files in the folder MU_TEST_PROCESS_LIST names instead,
// as pgrep is a stub on the other platforms: the machine running the tests may well have a real mu session open, and
// other tests start some.
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const listed = new Map([
	["tasklist", "tasklist.csv"],
	["powershell.exe", "processes.csv"],
]);
const real = childProcess.spawnSync;
childProcess.spawnSync = (file, args, options) => {
	const name = listed.get(file);
	if (!name) return real(file, args, options);
	const stdout = readFileSync(join(process.env.MU_TEST_PROCESS_LIST, name), "utf8");
	return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
};
// The launcher imports spawnSync by name: that binding follows the module object only once this has run.
syncBuiltinESMExports();
