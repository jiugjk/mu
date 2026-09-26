// Preloaded by the launcher when a checkout runs its TypeScript on Node's own type stripping (sourceRuntime in
// mu.mjs): Node keeps the code it compiled, by each file's content, in the system's temporary folder, and the next
// start takes it from there. The npm package's bundle does the same (scripts/build-coding-agent-bundle.mjs).
import { enableCompileCache } from "node:module";

enableCompileCache();
