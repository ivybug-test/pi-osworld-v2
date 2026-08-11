import type { PermissionAction, RoleSpec } from "../config/spec.js";

export interface PermissionDecision {
  allow: boolean;
  /** Execute through a read-only wrapper instead of the raw tool. */
  readonly?: boolean;
  reason?: string;
}

export interface PermissionPolicy {
  readonly mode: "full" | "read_only";
  check(name: string): PermissionDecision;
}

const READ_ONLY_DEFAULTS: Record<string, PermissionAction> = {
  "state.bash": "deny",
  "state.write_file": "deny",
  "state.edit_file": "deny",
  "state.python": "readonly",
};

/**
 * Role-level permission layer.
 *
 * `read_only: enforce` is the legacy boolean form; `permissions` is the
 * configurable form. The check is modeled after Pi's beforeToolCall hook:
 * it runs before execution and can block or rewrite the call.
 */
export function policyForRole(role: RoleSpec): PermissionPolicy {
  const mode =
    role.permissions?.mode ?? (role.read_only === "enforce" ? "read_only" : "full");
  const overrides = role.permissions?.tools ?? {};
  return {
    mode,
    check(name: string): PermissionDecision {
      if (mode === "full") return { allow: true };
      const action = overrides[name] ?? READ_ONLY_DEFAULTS[name] ?? "allow";
      switch (action) {
        case "deny":
          return {
            allow: false,
            reason: `${name} is disabled for the read-only role`,
          };
        case "readonly":
          return { allow: true, readonly: true };
        default:
          return { allow: true };
      }
    },
  };
}
