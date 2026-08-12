import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const v2Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v1Root = process.env.PI_OSWORLD_V1_ROOT || "/home/binqiu/pi-osworld";
const manifestPath = path.join(v2Root, "scripts", "legacy-manifest.json");

interface ManifestEntry {
  v1: string;
  v2: string;
  /** v2-only divergence: skip mirror equality (and sync must not overwrite). */
  v2Only?: boolean;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestEntry[];

/** v1 模块路径 → v2 模块路径（与 scripts/sync-legacy.mjs 同一套映射）。 */
const moves = new Map(
  manifest.map((entry) => [
    entry.v1.replace(/\.ts$/, ""),
    entry.v2.replace(/\.ts$/, ""),
  ]),
);

/** v2 镜像文件按新目录重写相对 import，比较前对 v1 内容做同样归一化。 */
function normalizeImports(text: string, v1Path: string, v2Path: string): string {
  const oldDir = path.posix.dirname(v1Path);
  const newDir = path.posix.dirname(v2Path);
  return text.replace(
    /(\b(?:from|import)\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (match, pre, quote, spec: string) => {
      const nojs = spec.replace(/\.js$/, "");
      const oldTarget = path.posix.normalize(path.posix.join(oldDir, nojs));
      const newTarget = moves.get(oldTarget) ?? oldTarget;
      const rel = path.posix.relative(newDir, newTarget).replace(/\\/g, "/");
      return `${pre}${quote}${rel.startsWith(".") ? rel : `./${rel}`}.js${quote}`;
    },
  );
}

const v1Available =
  manifest.length > 0 && existsSync(path.join(v1Root, manifest[0].v1));

describe.skipIf(!v1Available)("legacy drift", () => {
  for (const entry of manifest) {
    if (entry.v2Only) {
      it.skip(`${entry.v1} intentionally diverged in v2 (${entry.v2})`, () => {});
      continue;
    }
    it(`${entry.v1} mirrors v2 ${entry.v2}`, () => {
      const expected = normalizeImports(
        readFileSync(path.join(v1Root, entry.v1), "utf8"),
        entry.v1,
        entry.v2,
      );
      const actual = readFileSync(path.join(v2Root, entry.v2), "utf8");
      expect(actual).toBe(expected);
    });
  }
});
