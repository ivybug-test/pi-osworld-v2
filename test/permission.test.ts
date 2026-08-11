import { describe, expect, it } from "vitest";
import type { RoleSpec } from "../src/config/spec.js";
import { policyForRole } from "../src/primitives/permission.js";

function role(partial: Partial<RoleSpec>): RoleSpec {
  return {
    model: "main",
    prompt: { system: "main.md" },
    observation: { allow: ["state"] },
    tools: ["state.inspect_ro"],
    ...partial,
  } as RoleSpec;
}

describe("PermissionPolicy", () => {
  it("read_only enforce maps state.python to a guarded read-only execution", () => {
    const policy = policyForRole(role({ read_only: "enforce" }));
    expect(policy.check("state.python")).toEqual({ allow: true, readonly: true });
    expect(policy.check("state.bash")).toEqual({
      allow: false,
      reason: "state.bash is disabled for the read-only role",
    });
    expect(policy.check("state.write_file").allow).toBe(false);
    expect(policy.check("state.edit_file").allow).toBe(false);
    expect(policy.check("state.read_file").allow).toBe(true);
    expect(policy.check("state.list_dir").allow).toBe(true);
  });

  it("permissions.tools can override a tool back to allow", () => {
    const policy = policyForRole(
      role({
        permissions: {
          mode: "read_only",
          tools: { "state.bash": "allow" },
        },
      }),
    );
    expect(policy.check("state.bash")).toEqual({ allow: true });
    expect(policy.check("state.python")).toEqual({ allow: true, readonly: true });
  });

  it("full mode does not block or rewrite tools", () => {
    const policy = policyForRole(role({ read_only: "none" }));
    expect(policy.check("state.python")).toEqual({ allow: true });
    expect(policy.check("state.bash")).toEqual({ allow: true });
    expect(policy.check("state.write_file")).toEqual({ allow: true });
  });
});
