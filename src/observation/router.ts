import type { ObservationPolicy } from "../legacy-config/spec.js";

export interface ObservationEnvelope {
  screenshotB64?: string;
  /** MIME type of screenshotB64. Defaults to image/png for legacy payloads. */
  screenshotMime?: string;
  accessibilityTree?: string;
  userResponse?: string;
  terminal?: string;
}

/**
 * Accept both wire formats for the screenshot payload. The Node bridge reads
 * camelCase, while some producers historically sent snake_case; without this
 * guard, a mismatched key silently drops the screenshot from every observation.
 */
export function normalizeObservation(
  observation: ObservationEnvelope,
): ObservationEnvelope {
  const raw = observation as ObservationEnvelope & {
    screenshot_b64?: string;
  };
  const { screenshot_b64, ...rest } = raw;
  if (!screenshot_b64 || rest.screenshotB64) return rest;
  return { ...rest, screenshotB64: screenshot_b64 };
}

export type ObservationChannel =
  | "screenshot"
  | "accessibility_tree"
  | "state"
  | "user_response"
  | "terminal"
  | "tool_text";

export interface RoleObservationView {
  channels: ObservationChannel[];
  screenshot?: string;
  accessibilityTree?: string;
  stateText?: string;
  userResponse?: string;
  terminal?: string;
}

function isAllowed(
  policy: ObservationPolicy,
  channel: ObservationChannel,
): boolean {
  if (policy.deny?.includes(channel)) return false;
  return policy.allow.includes(channel);
}

export function buildRoleView(
  policy: ObservationPolicy,
  observation: ObservationEnvelope,
  stateText: string,
): RoleObservationView {
  const view: RoleObservationView = { channels: [] };

  if (isAllowed(policy, "screenshot") && observation.screenshotB64) {
    view.screenshot = observation.screenshotB64;
    view.channels.push("screenshot");
  }
  if (isAllowed(policy, "accessibility_tree") && observation.accessibilityTree) {
    view.accessibilityTree = observation.accessibilityTree;
    view.channels.push("accessibility_tree");
  }
  if (isAllowed(policy, "state") && stateText) {
    view.stateText = stateText;
    view.channels.push("state");
  }
  if (isAllowed(policy, "user_response") && observation.userResponse) {
    view.userResponse = observation.userResponse;
    view.channels.push("user_response");
  }
  if (isAllowed(policy, "terminal") && observation.terminal) {
    view.terminal = observation.terminal;
    view.channels.push("terminal");
  }
  return view;
}
