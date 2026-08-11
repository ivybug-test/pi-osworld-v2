import { Type, type Tool } from "@earendil-works/pi-ai";

export const delegateGuiTool: Tool = {
  name: "delegate.gui",
  description: "Delegate a visual subtask to the GUI specialist",
  parameters: Type.Object({
    objective: Type.String(),
    success_criteria: Type.Optional(Type.Array(Type.String())),
  }),
};

export const completeDelegationTool: Tool = {
  name: "delegation.complete",
  description:
    "Finish the delegated subtask and return a concise structured report to the caller",
  parameters: Type.Object({
    report: Type.String({
      description: "Concise report of what was inspected or changed",
    }),
    actions_summary: Type.Optional(
      Type.String({ description: "Optional one-line summary of the actions taken" }),
    ),
  }),
};

export const finishTool: Tool = {
  name: "finish",
  description: "Declare the task complete",
  parameters: Type.Object({}),
};

export const failTool: Tool = {
  name: "fail",
  description: "Declare the task failed",
  parameters: Type.Object({}),
};

export const askUserTool: Tool = {
  name: "ask_user",
  description: "Ask the user a clarifying question",
  parameters: Type.Object({
    question: Type.String(),
  }),
};

export const finishGateVerdictTool: Tool = {
  name: "finish_gate.verdict",
  description:
    "Deliver the independent finish-gate verdict. Only call this after inspecting the persisted artifact directly; you never see the main agent's history or rationale.",
  parameters: Type.Object({
    accepted: Type.Boolean({
      description: "Whether the persisted artifact satisfies the task",
    }),
    feedback: Type.Optional(
      Type.String({
        description:
          "Specific structural defect for the main agent to fix. Required when accepted is false.",
      }),
    ),
  }),
};
