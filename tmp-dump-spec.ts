import { loadHarnessSpec } from "./src/config/load.js";
import { buildLegacyConfig } from "./src/legacy/context.js";

const loaded = loadHarnessSpec(
  "/home/binqiu/osworld-experiments/experiments/stateact-minimal.yaml",
  "/home/binqiu/osworld-experiments",
);
const spec = loaded.spec;
console.log("=== legacy? ===", loaded.legacy, "hash:", loaded.configHash);
console.log("=== loop ===", JSON.stringify(spec.loop, null, 1));
console.log("=== main role ===", JSON.stringify(spec.roles.main, null, 1));
console.log("=== subagent keys ===", JSON.stringify(Object.keys(spec.subagents ?? {})));
const legacy = buildLegacyConfig(spec as any);
console.log("=== legacy main tools ===", JSON.stringify(legacy.agents?.main?.tools));
console.log("=== legacy main prompt ===", JSON.stringify(legacy.agents?.main?.prompt?.system));
console.log("=== legacy subagent gui ===", JSON.stringify(legacy.subagents?.gui));
