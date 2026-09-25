import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { holdLocksUntilExit } from "../auth/exit.ts";

/**
 * When a session quits, pi exits soon after: no lock of its credentials (auth.json) or its model catalogue
 * (models-store.json) may be half taken or half dropped then (`holdLocksUntilExit`). A lock left behind keeps every
 * other mu out of that file for 30 s, as `mu auth` did to the desktop's first conversation, which then had no model.
 * Registered after every other handler of a session's end, which may still use those files.
 */
export function registerLockSafeQuit(pi: ExtensionAPI, agentDir: string): void {
	const stores = [join(agentDir, "auth.json"), join(agentDir, "models-store.json")];
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") await holdLocksUntilExit(stores);
	});
}
