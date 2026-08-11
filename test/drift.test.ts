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

/** v2 镜像文件把旧 spec import 收敛到 legacy-config，比较前做同样归一化。 */
function normalizeImports(text: string): string {
  return text
    .replaceAll('"../config/spec.js"', '"../legacy-config/spec.js"')
    .replaceAll("'../config/spec.js'", "'../legacy-config/spec.js'");
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
      );
      const actual = readFileSync(path.join(v2Root, entry.v2), "utf8");
      expect(actual).toBe(expected);
    });
  }
});
