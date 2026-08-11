#!/usr/bin/env node

// Sync v1 legacy files into v2 (self-contained mirror).
// Usage: PI_OSWORLD_V1_ROOT=/path/to/pi-osworld node scripts/sync-legacy.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const v2Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v1Root = process.env.PI_OSWORLD_V1_ROOT || process.argv[2] || "/home/binqiu/pi-osworld";
const manifest = JSON.parse(
  readFileSync(path.join(v2Root, "scripts", "legacy-manifest.json"), "utf8"),
);

function rewriteImports(text) {
  return text
    .replaceAll('"../config/spec.js"', '"../legacy-config/spec.js"')
    .replaceAll("'../config/spec.js'", "'../legacy-config/spec.js'");
}

for (const entry of manifest) {
  const src = path.join(v1Root, entry.v1);
  const dst = path.join(v2Root, entry.v2);
  const text = rewriteImports(readFileSync(src, "utf8"));
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, text);
  console.log(`synced ${entry.v1} -> ${entry.v2}`);
}

console.log(`done (v1 root: ${v1Root})`);
