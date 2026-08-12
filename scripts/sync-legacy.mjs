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

// v1 模块路径 → v2 模块路径（按 manifest 推导，dir 迁移时只需改 manifest）。
const moves = Object.fromEntries(
  manifest.map((entry) => [
    entry.v1.replace(/\.ts$/, ""),
    entry.v2.replace(/\.ts$/, ""),
  ]),
);

function rewriteImports(text, v1Path, v2Path) {
  const oldDir = path.posix.dirname(v1Path);
  const newDir = path.posix.dirname(v2Path);
  return text.replace(
    /(\b(?:from|import)\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (match, pre, quote, spec) => {
      const nojs = spec.replace(/\.js$/, "");
      const oldTarget = path.posix.normalize(path.posix.join(oldDir, nojs));
      const newTarget = moves[oldTarget] ?? oldTarget;
      const rel = path.posix.relative(newDir, newTarget).replace(/\\/g, "/");
      return `${pre}${quote}${rel.startsWith(".") ? rel : `./${rel}`}.js${quote}`;
    },
  );
}

for (const entry of manifest) {
  if (entry.v2Only) {
    console.log(`skipped ${entry.v1} -> ${entry.v2} (v2-only divergence)`);
    continue;
  }
  const src = path.join(v1Root, entry.v1);
  const dst = path.join(v2Root, entry.v2);
  const text = rewriteImports(
    readFileSync(src, "utf8"),
    entry.v1,
    entry.v2,
  );
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, text);
  console.log(`synced ${entry.v1} -> ${entry.v2}`);
}

console.log(`done (v1 root: ${v1Root})`);
