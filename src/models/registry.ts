export interface ModelRef {
  alias: string;
  provider: string;
  id: string;
}

export function resolveModelRefs(models: Record<string, string>): ModelRef[] {
  return Object.entries(models).map(([alias, value]) => {
    const slash = value.indexOf("/");
    if (slash > 0) {
      return { alias, provider: value.slice(0, slash), id: value.slice(slash + 1) };
    }
    return { alias, provider: "auto", id: value };
  });
}

export function resolveModelRef(
  models: Record<string, string>,
  alias: string,
): ModelRef {
  const value = models[alias];
  if (!value) throw new Error(`unknown model alias: ${alias}`);
  return resolveModelRefs({ [alias]: value })[0];
}
