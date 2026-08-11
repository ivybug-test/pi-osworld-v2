import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { HarnessSpec, type HarnessSpec as HarnessSpecT } from "./spec.js";
import { convertLegacySpec, isLegacySpec, parseLegacySpec } from "./legacyCompat.js";

export interface LoadedSpec {
  spec: HarnessSpecT;
  configPath: string;
  root: string;
  configHash: string;
  legacy: boolean;
}

type RawRecord = Record<string, unknown>;

function isRecord(v: unknown): v is RawRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 深合并：后者覆盖前者；数组整体替换。 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(base) || !isRecord(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: RawRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = base[key];
    out[key] =
      isRecord(baseValue) && isRecord(value)
        ? deepMerge(baseValue, value)
        : value;
  }
  return out as T;
}

function loadYamlFile(filePath: string): RawRecord {
  const text = readFileSync(filePath, "utf8");
  const parsed = parseYaml(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${filePath}: YAML 顶层必须是映射`);
  }
  return parsed;
}

/** 解析 extends 链（后者覆盖前者），返回合并后的原始记录。 */
export function resolveExtends(filePath: string, seen = new Set<string>()): RawRecord {
  const resolved = path.resolve(filePath);
  if (seen.has(resolved)) {
    throw new Error(`extends 循环引用: ${[...seen, resolved].join(" -> ")}`);
  }
  seen.add(resolved);
  const raw = loadYamlFile(resolved);
  if (raw.extends !== undefined) {
    if (typeof raw.extends !== "string") {
      throw new Error(`${filePath}: extends 必须是字符串路径`);
    }
    const parentPath = path.resolve(path.dirname(resolved), raw.extends);
    const parent = resolveExtends(parentPath, seen);
    const merged = deepMerge(parent, raw);
    // extends 字段本身是加载机制，不进最终 spec
    delete merged.extends;
    return merged;
  }
  return raw;
}

/**
 * 探测 config root：prompt/task_set 等相对路径的基准。
 * 显式 --root 优先；否则按 [config 所在目录, 父目录] 依次探测，以首个角色 prompt
 * 是否存在为准（兼容 config 放在 experiments/、prompts 放在实验根的布局）。
 */
function resolveRootDir(
  configPath: string,
  spec: HarnessSpecT,
  explicitRoot?: string,
): string {
  if (explicitRoot) return path.resolve(explicitRoot);
  const firstPrompt = firstRolePrompt(spec);
  const candidates = [
    path.dirname(configPath),
    path.dirname(path.dirname(configPath)),
  ];
  if (firstPrompt) {
    for (const candidate of candidates) {
      if (existsSync(path.join(candidate, firstPrompt))) return candidate;
    }
  }
  return candidates[0];
}

function firstRolePrompt(spec: HarnessSpecT): string | undefined {
  for (const role of Object.values(spec.roles)) {
    if (role.prompt.system) return role.prompt.system;
    if (role.prompt.templates && role.prompt.templates.length > 0) {
      return role.prompt.templates[0].path;
    }
  }
  return undefined;
}

export function loadHarnessSpec(configPath: string, root?: string): LoadedSpec {
  const resolvedPath = path.resolve(configPath);
  const raw = resolveExtends(resolvedPath);
  const legacy = isLegacySpec(raw);
  const spec = legacy ? parseLegacySpec(raw) : HarnessSpec.parse(raw);
  const configHash = createHash("sha256")
    .update(JSON.stringify(spec, null, 2))
    .digest("hex")
    .slice(0, 16);
  return {
    spec,
    configPath: resolvedPath,
    root: resolveRootDir(resolvedPath, spec, root),
    configHash,
    legacy,
  };
}
