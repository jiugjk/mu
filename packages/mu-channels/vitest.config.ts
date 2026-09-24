import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

// The channel tests drive real mu sessions (pi's SDK, and mu's judgment layer where a test loads it), so the
// workspace packages resolve to their sources, as in packages/kyrn-judge.
export default mergeConfig(
	baseConfig,
	defineConfig({
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
				// pi's session manager imports the bare builtin "string_decoder"; resolved from this package vite takes it for a path.
				{ find: /^string_decoder$/, replacement: "node:string_decoder" },
			],
		},
		test: {
			environment: "node",
			testTimeout: 30000,
			hookTimeout: 30000,
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
	}),
);
