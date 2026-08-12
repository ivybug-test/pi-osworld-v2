import type { HarnessSpec } from "../config/spec.js";

// ---------------------------------------------------------------------------
// engine 核心类型：任务状态 / 契约 / 审计报告 / 轮次
// ---------------------------------------------------------------------------

export type RecordStatus = "pending" | "completed" | "blocked" | "untrusted";

export interface EvidenceRef {
  reportId: string; // 来源审计报告 round id
  summary: string; // 支持该记录的证据摘要
  source?: string; // 文件/命令/观察，可追溯
}

export interface RequirementRecord {
  id: string;
  text: string;
  status: RecordStatus;
  evidence: EvidenceRef[];
}

export interface ArtifactRecord {
  id: string;
  path: string;
  status: RecordStatus;
  evidence: EvidenceRef[];
}

export interface FactRecord {
  id: string;
  text: string;
  evidence: EvidenceRef[];
}

export interface RoundRecord {
  index: number;
  contract?: SubtaskContract;
  executorReport?: string;
  auditReport?: AuditReport;
  decision: ManagerDecision;
  /** 后端透传元数据（如 m3 的 pyautogui actions），serve 需要它驱动 env.step。 */
  metadata?: Record<string, unknown>;
}

export interface TaskState {
  goal: string;
  requirements: RequirementRecord[];
  artifacts: ArtifactRecord[];
  facts: FactRecord[];
  /** gate_verdict 驱动跨 predict 持久化的拒绝计数与待注入 feedback。 */
  gate?: { rejections: number; feedback?: string };
  /** 周期进度审计：最近一次审计轮次、报告与待注入 main 的反馈（serve 跨 predict 恢复用）。 */
  audit?: { lastRound: number; feedback?: string; report?: AuditReport };
  rounds: RoundRecord[];
}

export type ContractTarget = "gui" | "cli";

export interface SubtaskContract {
  id: string;
  goal: string;
  acceptanceCriteria: string[];
  boundaryConstraints: string[];
  evidenceRefs: EvidenceRef[];
  target: ContractTarget;
  budget?: { max_seconds?: number; max_steps?: number };
}

export interface AuditReport {
  roundId: string;
  completion: "complete" | "incomplete" | "blocked";
  integrity: "clean" | "suspect" | "violation";
  contractAudit: "aligned" | "needs_revision" | "invalid";
  verifiedFacts: EvidenceRef[];
  gaps: string[];
  evidence: string[];
  /** 周期审计给 main 的简短可执行反馈（finish gate 不用）。 */
  feedback?: string;
}

export type ManagerDecision =
  | { kind: "execute"; contract?: SubtaskContract }
  | { kind: "done"; reason?: string }
  | { kind: "blocked"; reason: string }
  | { kind: "ask"; question: string; answers?: string[] };

export type DecisionOutcome =
  | { kind: "execute" }
  | { kind: "done" }
  | { kind: "blocked"; reason: string }
  | { kind: "ask"; question: string; answers?: string[] }
  | { kind: "max_rounds" };

export interface EpisodeSummary {
  episodeId: string;
  state: TaskState;
  outcome: DecisionOutcome;
  rounds: number;
}

// ---------------------------------------------------------------------------
// 后端与运行时交互的最小结构（核心不依赖 Pi）
// ---------------------------------------------------------------------------

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ObservationEnvelope {
  screenshotB64?: string;
  /** MIME type of screenshotB64. Defaults to image/png for legacy payloads. */
  screenshotMime?: string;
  accessibilityTree?: string;
  userResponse?: string;
  terminal?: string;
}

export interface EpisodeRequest {
  episodeId: string;
  role: string;
  system: string;  // 静态角色 system prompt（从 spec.roles.<id>.prompt.system 读取）
  user: string;    // 动态 user 内容（按 role.receives 组装）
  tools: string[];
  budget?: { max_seconds?: number; max_steps?: number; max_cost_usd?: number };
  roundIndex: number;
  freshPerRound: boolean;
  /** 原始任务指令（pi 后端 state_text/raw_task/gate 消息格式需要）。 */
  task: string;
  /** 当前环境观察（pi 后端截图/a11y/terminal 需要）。 */
  observation: ObservationEnvelope;
  /** 上一轮 gate 拒绝反馈（注入角色消息；stateact main 修复缺口用）。 */
  feedback?: string;
  /** 最近一次周期审计反馈（注入 feedback_to 角色消息；独立于 finish gate 的拒绝反馈）。 */
  auditFeedback?: string;
}

export interface EpisodeResult {
  status: "done" | "timeout" | "error" | "cancelled";
  report?: string; // 执行报告 / 审计报告 / 决策文本
  actionsLog?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  /** 结构化决策/产物：由 driver 从 report 或工具调用解析后写入。 */
  decision?: ManagerDecision;
  auditReport?: AuditReport;
  verdict?: { accepted: boolean; feedback?: string };
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// orchestrator 上下文
// ---------------------------------------------------------------------------

export interface RoundContext {
  episodeId: string;
  index: number;
  state: TaskState;
  contract?: SubtaskContract;
  executorReport?: string;
  auditReport?: AuditReport;
  decision?: ManagerDecision;
}

export interface RuntimeServices {
  spec: HarnessSpec;
  runRoleEpisode(
    roleId: string,
    ctx: RoundContext,
    obs: ObservationEnvelope,
    feedback?: string,
    auditFeedback?: string,
  ): Promise<EpisodeResult>;
  readState(episodeId: string): Promise<TaskState | undefined>;
  writeState(episodeId: string, state: TaskState): Promise<void>;
  /** 追加轮次记录并返回更新后的任务状态（用于 resume 与结果汇总）。 */
  appendRound(episodeId: string, round: RoundRecord): Promise<TaskState>;
  emit(event: string, attrs: Record<string, unknown>): void;
  /** 审计阶段的环境检查（P0：仅记录；后续接 Environment/IntegrityMonitor）。 */
  checkIntegrity?(roundIndex: number): Promise<{ clean: boolean; findings: string[] }>;
}
