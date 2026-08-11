#!/usr/bin/env node

// Sync v1 legacy files into v2 (self-contained mirror).
// v1 冻结后不再默认依赖本机路径；必须显式指定 v1 根目录：
//   PI_OSWORLD_V1_ROOT=/path/to/pi-osworld node scripts/sync-legacy.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const v2Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v1Root = process.env.PI_OSWORLD_V1_ROOT || process.argv[2];
if (!v1Root) {
  console.error(
    "usage: PI_OSWORLD_V1_ROOT=/path/to/pi-osworld node scripts/sync-legacy.mjs",
  );
  process.exit(1);
}
const manifest = JSON.parse(
  readFileSync(path.join(v2Root, "scripts", "legacy-manifest.json"), "utf8"),
);

function rewriteImports(text) {
  return text
    .replaceAll('"../config/spec.js"', '"../legacy-config/spec.js"')
    .replaceAll("'../config/spec.js'", "'../legacy-config/spec.js'");
}

for (const entry of manifest) {
  if (entry.v2Only) {
    console.log(`skipped ${entry.v1} -> ${entry.v2} (v2-only divergence)`);
    continue;
  }
  const src = path.join(v1Root, entry.v1);
  const dst = path.join(v2Root, entry.v2);
  const text = rewriteImports(readFileSync(src, "utf8"));
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, text);
  console.log(`synced ${entry.v1} -> ${entry.v2}`);
}

console.log(`done (v1 root: ${v1Root})`);
