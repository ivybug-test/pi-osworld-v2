import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  formatPromptTemplateInvocation,
  loadPromptTemplates,
  NodeExecutionEnv,
  type PromptTemplate,
} from "@earendil-works/pi-agent-core/node";
import type { PromptSpec } from "../legacy-config/spec.js";

export interface ResolvedPromptTemplate {
  name: string;
  content: string;
  args: string[];
}

export interface ResolvedPrompt {
  system: string;
  append: string[];
  templates: ResolvedPromptTemplate[];
  contextFiles: string[];
  skills: string[];
  hash: string;
}

function readAsset(root: string, ref: string): string {
  return readFileSync(path.resolve(root, ref), "utf8");
}

function hashBundle(bundle: ResolvedPrompt): string {
  const canonical = {
    system: bundle.system,
    append: bundle.append,
    templates: bundle.templates.map((template) => ({
      name: template.name,
      content: template.content,
      args: template.args,
    })),
    contextFiles: bundle.contextFiles,
    skills: bundle.skills,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function templateName(refPath: string): string {
  return path.basename(refPath, path.extname(refPath));
}

export async function resolvePrompt(
  spec: PromptSpec,
  root: string,
): Promise<ResolvedPrompt> {
  const env = new NodeExecutionEnv({ cwd: root });
  const templatePaths = [
    ...(spec.system ? [spec.system] : []),
    ...(spec.append ?? []),
    ...(spec.templates ?? []).map((ref) => ref.path),
  ];
  const { promptTemplates, diagnostics } = await loadPromptTemplates(
    env,
    templatePaths,
  );
  for (const diagnostic of diagnostics) {
    console.warn(`[pi-osworld] prompt template diagnostic: ${diagnostic.message}`);
  }
  const byName = new Map(
    promptTemplates.map((template) => [template.name, template]),
  );

  const resolveTemplate = (refPath: string): PromptTemplate => {
    const template = byName.get(templateName(refPath));
    if (!template) throw new Error(`prompt template not found: ${refPath}`);
    return template;
  };

  const system = spec.system ? resolveTemplate(spec.system).content : "";
  const append = (spec.append ?? []).map((ref) => resolveTemplate(ref).content);
  const templates = (spec.templates ?? []).map((ref) => {
    const template = resolveTemplate(ref.path);
    return {
      name: template.name,
      content: formatPromptTemplateInvocation(template, ref.args ?? []),
      args: ref.args ?? [],
    };
  });
  const contextFiles = (spec.context_files ?? []).map((ref) =>
    readAsset(root, ref),
  );
  const skills = spec.skills ?? [];

  const bundle: ResolvedPrompt = {
    system,
    append,
    templates,
    contextFiles,
    skills,
    hash: "",
  };
  bundle.hash = hashBundle(bundle);
  return bundle;
}
