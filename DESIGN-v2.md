# pi-osworld v2 设计草案（可调试的 harness 组合框架）

> 状态：草案 v0.2（评估版，未落代码）
> 修订说明：v0.1 把论文功能按模块搬进代码（flows/mea.ts、roles/manager.ts），
> 方向错误。v0.2 改为 **组合优先（composition-first）**：引擎通用，
> 论文（LongHorizon-Harness 的 MEA）只是 YAML 里的一份组合，不是代码模块。

## 0. 定位与原则

**一句话定位**：一个"靠 YAML 组合出任意 harness agent、且每一步都能调试"的框架。

1. **论文 = 配置**：MEA 等 harness 用 YAML 声明（角色、边、决策、状态更新、终止），
   不是写死成 flow 类。新增 harness = 新增 YAML（或新增一个原语）。
2. **引擎通用**：核心是一个 round-loop 解释器，行为全部由 YAML 参数化；
   代码里**不出现** "manager / executor / auditor" 这种论文专属类名。
3. **原语正交**：role / tool / observation / state / gate / backend / budget /
   termination 都是独立小零件，YAML 组合它们。
4. **调试一等公民**：每轮产物人类可读、运行可暂停、轨迹可重放、mock 可无模型跑。
5. **兼容现状**：`m3-single`、`stateact-minimal` 两个现有 YAML 在新引擎下行为不变
   （它们各自变成一份组合配置）；保留 RoleAgent、PiContextManager、compaction、
   observation router、telemetry、bridge、Python 侧不 fork OSWorld。

## 1. 核心模型：原语 + 组合 + 解释器

```text
YAML（HarnessSpec）
  ├── roles:           角色原语（backend/model/prompt/tools/obs/context/budget）
  ├── tools:           引用已注册工具组（state.* / computer.* / plan.* / delegation.* / gate.*）
  ├── state:           任务状态 schema + store + 更新策略
  ├── gates:           只读验证原语（finish gate = 一个实例）
  ├── loop:            驱动方式（manager_decision / self_report / gate_verdict / policy）
  ├── termination:     终止策略
  ├── backends:        后端注册（pi / codex / claude / openclaw / mock）
  └── debug:           断点 / 检查项
        │
        ▼
通用引擎（RoundLoop 解释器，唯一一份）
  ├── 解析 HarnessSpec，实例化角色与工具
  ├── 按 loop.driver 驱动轮次：发输入 → 跑角色 → 收输出 → 更新状态 → 判断终止
  └── 每个环节发结构化事件给调试器
        │
        ▼
调试设施（debug / replay / dashboard / mock）
```

关键点：**解释器只有一份**。m3-single、stateact-minimal、MEA 的差异全部在 YAML：
- m3-single：1 个角色 + `driver: self_report`
- stateact-minimal：main/gui/finish_gate 三角色 + `driver: gate_verdict` + repair 回灌
- mea（论文）：manager/executor/auditor 三角色 + `driver: manager_decision` +
  `state_update: audit_verified`

当 YAML 表达不了某种语义时，才新增一个**原语**（如新 driver 类型、新 gate），
框架通过加原语生长，而不是加 flow 类。

## 2. YAML 组合 schema（HarnessSpec 草案）

```yaml
experiment: <id>
extends: presets/<base>.yaml          # 可选：预设组合，支持覆盖

backends:
  pi:     { model: anthropic/MiniMax-M3 }
  codex:  { command: codex, model: gpt-5.6-sol }
  claude: { command: claude }
  mock:   { script: fixtures/scripted.yaml }

roles:
  <role-id>:
    backend: pi | codex | claude | openclaw | mock
    prompt: prompts/roles/<file>.md    # 静态角色提示词（可复现，进 prompt hash）
    tools: [state.inspect, state.bash, ...]   # 引用工具组
    observation: { allow: [state, screenshot, a11y, terminal], deny: [...] }
    context: fresh_per_round | persistent | <策略>
    receives: [task, task_state, contract, evidence_refs, executor_report, audit_history, env_state]
    read_only: enforce | none          # 执行层强制（见 4.5）
    budget: { max_seconds, max_steps, max_cost_usd }

state:
  schema: [requirements, artifacts, facts]   # 可扩展
  store: file                          # runs/<id>/state/<episodeId>/round-<i>/...
  update_policy: audit_verified | self_report

gates:
  <gate-id>:
    role: <role-id>                    # 复用角色定义（工具/obs/budget）
    verdict_tool: finish_gate.verdict
    fresh_context: true

loop:
  driver: manager_decision | self_report | gate_verdict | policy
  max_rounds: 30
  # driver=manager_decision 时：
  decision_tool: manager.decide        # execute/done/blocked/ask
  contract: { produced_by: manager, fields: [goal, acceptance_criteria, boundary_constraints, evidence_refs, target] }
  routing: { gui: gui_executor, cli: executor }   # 契约 target 路由
  # driver=gate_verdict 时：
  verdict: { gate: finish, feedback_to: main, max_rounds: 3 }

termination:
  on: [done, blocked, ask, max_rounds, timeout]

debug:
  pause_after: [executor, auditor]     # 断点：这些角色结束后暂停
  inspect: [task_state, contract, audit_report]
  hooks: { on_round_start: script, on_state_update: script }   # 可选
```

约束：
- `topology` 不再是代码分发器，只是 preset 名字（`extends: presets/mea.yaml`）。
- 角色定义静态（system prompt 固定）；动态指令由驱动角色运行时生成、作为 user
  消息注入（详见 4.7 委派指令来源）。

## 3. 论文 MEA 的一份 YAML（示例）

```yaml
experiment: mea-demo
extends: presets/round-loop.yaml

state:
  schema: [requirements, artifacts, facts]
  store: file
  update_policy: audit_verified

roles:
  manager:
    backend: pi
    prompt: prompts/roles/manager.md
    tools: []                          # 无环境工具，只有决策工具
    observation: { allow: [state] }
    receives: [task, task_state, audit_history]
    budget: { max_seconds: 600 }
  executor:
    backend: pi
    prompt: prompts/roles/executor.md
    tools: [state.inspect, state.bash, state.python, state.write_file]
    observation: { allow: [state, terminal] }
    context: fresh_per_round
    budget: { max_seconds: 1800 }
  gui_executor:
    backend: pi
    prompt: prompts/roles/gui-specialist.md
    tools: [computer.pyautogui]
    observation: { allow: [screenshot, accessibility_tree] }
    context: fresh_per_round
    budget: { max_seconds: 1800 }
  auditor:
    backend: pi
    prompt: prompts/roles/auditor.md
    tools: [state.inspect_ro]
    observation: { allow: [state, terminal, screenshot] }
    context: fresh_per_round
    read_only: enforce
    receives: [task, contract, executor_report, env_state]
    budget: { max_seconds: 600 }

loop:
  driver: manager_decision
  max_rounds: 25
  decision_tool: manager.decide        # execute / done / blocked / ask
  contract:
    produced_by: manager
    fields: [goal, acceptance_criteria, boundary_constraints, evidence_refs, target]
  routing: { gui: gui_executor, cli: executor }

termination:
  on: [done, blocked, ask, max_rounds]

debug:
  pause_after: [executor, auditor]
  inspect: [task_state, contract, audit_report]
```

这个 YAML 完整表达了论文的 MEA，但代码里**没有** manager.ts / executor.ts /
auditor.ts——它们只是 roles 的实例，语义由 `loop.driver` 和 `state.update_policy`
决定。

## 4. 原语清单

### 4.1 BackendAdapter —— 执行衬底可互换

```ts
type BackendId = "pi" | "codex" | "claude" | "openclaw" | "mock";

interface BackendAdapter {
  readonly id: BackendId;
  runEpisode(req: EpisodeRequest): Promise<EpisodeResult>;
}

interface EpisodeRequest {
  role: string;
  prompt: string;                 // 渲染后的 system + 动态 user 内容
  env: Environment;
  tools: Tool[];
  budget: EpisodeBudget;          // 秒 / 步 / 成本 / 令牌
  checkpointDir?: string;
}

interface EpisodeResult {
  status: "done" | "timeout" | "error" | "cancelled";
  report?: string;                // 执行报告 / 审计报告 / 决策
  actionsLog?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  metadata?: Record<string, unknown>;
}
```

- **pi**：包装现有 `RoleAgent` + `PiContextManager`；`maxSeconds` 用 AbortController。
- **codex / claude / openclaw**：子进程，经 `PI_OSWORLD_TOOL_SERVER` 访问统一 tool
  server；超时 kill 用 process group；参考 LHH `src/lh_harness/adapters/` 的
  `run_episode` 协议，但**不搬运其模块**，只借鉴接口形态。
- **mock**：脚本化行为，供调试与 CI。

### 4.2 Environment —— 统一环境抽象

```ts
interface Environment {
  readonly capabilities: Set<Capability>;   // "gui" | "cli" | "observe-only" | ...
  observe(channel: ObservationChannel): Promise<ObservationEnvelope>;
  execute(call: ToolCall, policy: PermissionPolicy): Promise<ToolResult>;
  snapshot(): Promise<WorkspaceSnapshot>;   // 供 integrity
  verify(checks: VerificationCheck[]): Promise<VerificationResult>;
}
```

### 4.3 TaskStateStore —— 状态外置（原语）

```ts
interface TaskState {
  goal: string;
  requirements: RequirementRecord[];  // { id, text, status, evidence: EvidenceRef[] }
  artifacts: ArtifactRecord[];
  facts: FactRecord[];
  rounds: RoundRecord[];
}

interface TaskStateStore {
  read(episodeId: string): Promise<TaskState | undefined>;
  write(episodeId: string, state: TaskState): Promise<void>;
  appendRound(episodeId: string, round: RoundRecord): Promise<void>;
}
```

落盘：`runs/<run_id>/state/<episodeId>/round-<i>/task_state.json`。

### 4.4 Gate / 验证原语

```ts
interface Gate {
  readonly role: string;                 // 复用角色定义
  verify(ctx: GateContext): Promise<GateVerdict>;
}
interface GateVerdict {
  accepted: boolean;
  feedback?: string;
  report?: AuditReport;                  // 结构化时
}
```

现有 `FinishGate`（`src/gate/finish-gate.ts`）收敛为 Gate 原语的一个实例
（fresh context + 只读工具集 + verdict 工具）。

### 4.5 PermissionPolicy + IntegrityMonitor —— 只读结构性强制

```ts
interface PermissionPolicy {
  phase: "execute" | "audit" | "manager";
  denyMutation: boolean;            // audit 阶段强制 true
  allow: Set<string>;
}
interface IntegrityMonitor {
  before(round: number): Promise<WorkspaceSnapshot>;
  after(round: number): Promise<WorkspaceDiff>;
  recordMutation(call: ToolCall, by: string, round: number): void;
}
```

- 强制点在**执行层**（tool server）：audit 阶段一切 mutation 直接拒绝并记账，
  不再依赖 prompt/工具列表过滤（现状 `state.inspect_ro` 放行 `state.python`，
  只读是假的，必须修）。
- tool server 是所有 VM 工具调用的唯一咽喉 → 天然完成 mutation 记账与 diff。

### 4.6 决策/驱动原语

```ts
type Driver =
  | { kind: "manager_decision"; decisionTool: string; contractFields: string[]; routing: Routing }
  | { kind: "self_report"; doneTool: string }
  | { kind: "gate_verdict"; gate: string; feedbackTo: string; maxRounds: number }
  | { kind: "policy"; policy: TerminationPolicy };
```

引擎按 driver 驱动轮次；新驱动 = 新原语。

### 4.7 委派指令来源（main/manager 写给 subagent 的"提示词"）

- 动态指令 = 驱动角色运行时生成的契约/子任务文本，作为 subagent 的 **user 消息**
  注入；subagent 的 **system prompt 保持静态**（YAML 角色定义，进 prompt hash）。
  与论文一致（LHH 的 manager 契约同样是动态 user 内容，角色提示词固定）。
- `delegate.subtask` 参数对齐契约字段：`goal` / `acceptance_criteria` /
  `boundary_constraints` / `evidence_refs` / `target: "gui" | "cli"` /
  `additional_instructions`。现状 `delegate.gui`（`src/tools/delegation.ts`）只有
  `objective` + `success_criteria`、无 CLI 委派，需扩展；`SubagentInput.task`
  （`src/subagents/types.ts`）即契约序列化文本，`buildDelegatedTask`
  （`src/flows/stateact-minimal.ts`）是雏形。
- **不要**让委派方动态改写 subagent 的 system prompt：角色定义必须稳定。
  确需微调时用 system prompt 模板变量（如 `{{boundary_constraints}}`），
  注入值记入 manifest。

## 5. 调试设施（一等公民）

- **每轮产物人类可读**：`contract.md`、`executor_report.md`、`audit_report.md`、
  `task_state.json`、`decisions.jsonl` 落盘在 `runs/<id>/state/<episodeId>/round-<i>/`。
- **CLI 调试器**：`pi-osworld debug <run_id>`——逐步走轮次，展示每个角色本轮
  "收到什么（消息/观察）→ 调了哪些工具 → 输出什么 → 状态如何更新"，轮间
  暂停/继续，可修改状态后继续（干预式调试）。
- **断点**：YAML `debug.pause_after` / `debug.inspect`；运行时 `--pause-on round=N`。
- **重放**：基于 `llm_traces.jsonl` + `events.jsonl` 确定性重放，不重跑模型；
  用于定位"哪一轮、哪个角色、哪个工具调用"导致失败。
- **mock**：mock backend + mock env，无模型跑通编排逻辑（单测/CI/调试）。
- **结构化事件**：现有 `events.jsonl` 扩充 round 级事件
  （`round.start / round.contract / round.executor_start / round.executor_end /
  round.audit / round.state_update / round.decision`），作为重放和 dashboard 的数据源。
- **dashboard（后置）**：简单 Web 视图，展示 round 状态机与产物（参考 LHH
  `src/lh_harness/dashboard/` 的思路，但按本框架重写）。

## 6. 目录结构

```text
pi-osworld/
├── package.json
├── src/
│   ├── cli.ts                    # run / debug / replay / compare / doctor / matrix
│   ├── config/
│   │   ├── spec.ts               # HarnessSpec 全量 schema（zod）
│   │   ├── load.ts               # 加载 + extends/覆盖 + 校验 + config hash
│   │   ├── matrix.ts             # --matrix 组合展开
│   │   └── defaults.yaml
│   ├── presets/                  # 命名组合：round-loop.yaml / mea.yaml / stateact.yaml / m3-single.yaml
│   ├── engine/
│   │   ├── orchestrator.ts       # 通用 round-loop 解释器（唯一一份）
│   │   ├── drivers.ts            # driver 原语（manager_decision / self_report / gate_verdict / policy）
│   │   ├── router.ts             # 契约 target → gui/cli 路由
│   │   └── runtime.ts            # 角色/工具/状态运行时实例化
│   ├── primitives/
│   │   ├── backend.ts            # BackendAdapter 接口
│   │   ├── environment.ts        # Environment 接口
│   │   ├── task-state.ts         # TaskStateStore
│   │   ├── gate.ts               # Gate 原语
│   │   ├── permission.ts         # PermissionPolicy
│   │   ├── integrity.ts          # IntegrityMonitor
│   │   ├── budget.ts             # BudgetController
│   │   └── termination.ts        # TerminationPolicy
│   ├── backends/                 # pi.ts / codex.ts / claude.ts / openclaw.ts / mock.ts
│   ├── agents/role.ts            # 保留（Pi backend 实现细节）
│   ├── context/manager.ts        # 保留（storage 可插拔）
│   ├── subagents/…               # 保留（fresh-context 委派 = RoleSubagent 原语）
│   ├── tools/…                   # 保留（工具组注册）
│   ├── observation/router.ts     # 保留（channel 可扩展）
│   ├── gate/finish-gate.ts       # 保留（收敛为 Gate 原语实例）
│   ├── bridge/…                  # 保留 + resume 请求
│   └── telemetry/                # writer.ts（保留）+ manifest.ts + replay.ts
├── python/                       # 保留；协议文档化
└── test/
    ├── unit/…                    # 保留
    └── integration/              # mock env + mock backend 端到端（含 mea.yaml 冒烟）
```

与 v0.1 的差异：**删掉** `flows/mea.ts`、`roles/manager|executor|auditor.ts`、
`registry/topologies.ts`（这些是把论文搬进来）；**新增** `engine/`（通用解释器）、
`presets/`（YAML 组合）、`debug/replay` 设施。

## 7. 与 LHH（论文仓库）的关系

- **借鉴语义，不搬运模块**：LHH 告诉我们 MEA 的状态/契约/审计长什么样
  （`task_state.txt`、三行 control header、integrity 状态、mutation 检测），
  这些语义用原语和 YAML 表达。
- LHH 是"一个 harness 应用"；pi-osworld v2 是"能组合出任意 harness 的框架"，
  论文的 MEA 只是 `presets/mea.yaml` 一份配置。
- 代码形态上不需要 manager.py / auditor_agent.py 的等价物；driver + gate +
  state.update_policy 组合出相同语义。

## 8. 演进路线

- **P0（组合地基）**
  1. HarnessSpec schema（zod）+ extends/覆盖 + presets
  2. 通用 orchestrator（round-loop 解释器）+ driver 原语
  3. BackendAdapter（pi / mock 先行）+ Environment
  4. TaskStateStore + checkpoint/resume
- **P1（调试 + 论文语义）**
  5. debug CLI（逐步/暂停/检查/干预）+ 结构化 round 事件
  6. PermissionPolicy 执行层强制 + IntegrityMonitor
  7. Gate 原语（FinishGate 收敛）+ state.update_policy=audit_verified
  8. `presets/mea.yaml` 冒烟（与 stateact/m3 行为回归）
- **P2（实验效率）**
  9. matrix / compare / manifest / trajectory / result 落盘
  10. replay（基于 trace 确定性重放）
- **P3（体验）**
  11. doctor、路径配置化（.env）、安装脚本、任务级并行、dashboard

## 9. 风险与注意事项

1. **解释器复杂度**：round-loop 要覆盖 self_report / gate_verdict / manager_decision
   三种驱动，抽象要够小；先以"现有两个 YAML 原样跑通"为回归标准。
2. **外部后端只读强制**：codex/claude 子进程的工具调用不完全过执行层，
   只读需在环境层（tool server / VM）拒绝；`PermissionPolicy` 同时支持
   "执行层拦截"和"环境层拒绝"两道闸。
3. **GUI auditor 只读更难**：点击类动作不能用于审计，只允许截图 + a11y +
   只读 state 观察；需要单独的 `gui-readonly` capability。
4. **调试干预的副作用**：debug 时改状态/重放要明确写入干预日志，保证结果可追溯。
5. **不 fork OSWorld-V2**：维持 Python 侧 `sys.path` 方案；snapshot/verify 以独立
   工具挂到 tool server，不侵入官方代码。
6. **Pi session 持久化坑**：`PITFALLS.md` 记录的 `undefined` 字段、retainedTail
   顺序、compaction 依赖 assistant usage 锚点，在 checkpoint 实现中逐条规避。

## 10. P0 细化：HarnessSpec schema + orchestrator 接口

> 依据 `osworld-experiments/` 现有 YAML（`experiments/m3-single.yaml`、
> `experiments/stateact-minimal.yaml`）与 `runs/` 产物结构提炼。
> 兼容旧格式：`agents` / `topology` 写法经 `legacyCompat` 转换，行为不变。

### 10.1 HarnessSpec（schema 草案）

> 依赖说明：`zod` 为新增依赖；若不想加依赖，可先用手写 TS interface + 现有
> `validate()` 扩展，但报错信息会差一些。

```ts
// src/config/spec.ts (v2)
import { z } from "zod";

const BackendId = z.enum(["pi", "codex", "claude", "openclaw", "mock"]);

const BudgetSpec = z.object({
  max_seconds: z.number().optional(),   // v2 新增：角色秒级预算
  max_steps: z.number().optional(),     // 现有
  max_cost_usd: z.number().optional(),  // 现有
});

const ObservationPolicy = z.object({
  allow: z.array(z.enum(["screenshot", "accessibility_tree", "state", "user_response", "terminal", "tool_text"])),
  deny: z.array(z.string()).optional(),
});

const CompactionSpec = z.object({
  enabled: z.boolean().optional(),
  reserve_tokens: z.number().optional(),
  keep_recent_tokens: z.number().optional(),
  strategy: z.enum(["pi-summary", "turn-retention", "truncate", "none"]).optional(),
  turn_retention: z.object({
    screenshot_turns: z.number().optional(),
    text_turns: z.number().optional(),
    summarize_text: z.boolean().optional(),
  }).optional(),
});

const ContextSpec = z.union([
  z.string(),                          // 命名 profile（现有：main 用 "screenshot-recent"）
  z.object({
    engine: z.literal("pi-session").optional(),
    context_window: z.number().optional(),
    compaction: CompactionSpec.optional(),
    fresh_per_round: z.boolean().optional(),   // v2 新增：每轮全新上下文
  }),
]);

const Receives = z.array(z.enum([
  "task", "task_state", "contract", "evidence_refs",
  "executor_report", "audit_history", "env_state",
]));

const RoleSpec = z.object({
  backend: BackendId.default("pi"),    // v2 新增：角色级后端
  model: z.string(),                   // 引用 models 别名
  prompt: z.object({
    system: z.string(),
    append: z.array(z.string()).optional(),
    templates: z.array(z.object({ path: z.string(), args: z.array(z.string()).optional() })).optional(),
    context_files: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
  }),
  observation: ObservationPolicy,
  context: ContextSpec.optional(),
  memory: z.literal("none").optional(),
  tools: z.array(z.string()),          // 引用工具组：state.inspect / state.inspect_ro / computer.pyautogui / ...
  receives: Receives.optional(),       // v2 新增：每轮收到什么（决定 user 消息组装）
  read_only: z.enum(["enforce", "none"]).default("none"),  // v2 新增：执行层强制
  budget: BudgetSpec.optional(),
});

const StateSpec = z.object({
  schema: z.array(z.enum(["requirements", "artifacts", "facts"])).default(["requirements", "artifacts", "facts"]),
  store: z.enum(["file", "memory"]).default("file"),
  update_policy: z.enum(["audit_verified", "self_report"]).default("self_report"),
});

const GateSpec = z.object({
  role: z.string(),                    // 复用 roles 里的定义
  verdict_tool: z.string(),
  fresh_context: z.boolean().default(true),
});

const LoopSpec = z.discriminatedUnion("driver", [
  z.object({
    driver: z.literal("self_report"),          // m3-single：单角色自报
    done_tool: z.string(),
    max_rounds: z.number().default(30),
  }),
  z.object({
    driver: z.literal("gate_verdict"),         // stateact：finish gate 独立验证
    gate: z.string(),
    feedback_to: z.string(),
    max_rounds: z.number().default(3),
  }),
  z.object({
    driver: z.literal("manager_decision"),     // 论文 MEA
    decision_tool: z.string(),
    contract: z.object({
      produced_by: z.string(),
      fields: z.array(z.enum(["goal", "acceptance_criteria", "boundary_constraints", "evidence_refs", "target"])),
    }),
    routing: z.object({ gui: z.string(), cli: z.string() }),
    max_rounds: z.number().default(25),
  }),
  z.object({ driver: z.literal("policy"), policy: z.string() }),
]);

const TerminationSpec = z.object({
  on: z.array(z.enum(["done", "blocked", "ask", "max_rounds", "timeout"])),
  max_steps: z.number().optional(),    // 保留：OSWorld predict 步数上限（现有语义）
});

const DebugSpec = z.object({
  pause_after: z.array(z.string()).optional(),   // 角色结束后暂停
  inspect: z.array(z.string()).optional(),       // 暂停时可检查的产物
  hooks: z.record(z.string()).optional(),
});

const HarnessSpec = z.object({
  experiment: z.string(),
  description: z.string().optional(),
  extends: z.string().optional(),      // v2 新增：preset 组合
  benchmark: z.object({ name: z.string(), release: z.string() }),
  task_set: z.string(),
  observation_capture: z.object({
    require_a11y_tree: z.boolean().optional(),
    require_terminal: z.boolean().optional(),
  }).optional(),
  context: ContextSpec.optional(),     // 实验级默认（role 可覆盖）
  trace: z.object({
    llm_requests: z.boolean().optional(),
    include_images: z.boolean().optional(),
  }).optional(),
  models: z.record(z.string()),
  backends: z.record(z.object({
    command: z.string().optional(),    // codex/claude 子进程命令
    model: z.string().optional(),
  })).optional(),
  roles: z.record(RoleSpec),
  state: StateSpec.optional(),
  gates: z.record(GateSpec).optional(),
  loop: LoopSpec,
  termination: TerminationSpec,
  debug: DebugSpec.optional(),
  repetitions: z.number().optional(),  // 现有声明未用，v2 落地
  seed: z.number().optional(),
});
```

### 10.2 legacy 兼容（现有两个 YAML 原样可跑）

`legacyCompat.ts`：检测到顶层有 `agents` / `topology` 即按下表转换为 v2 spec，
打印 "loaded as legacy spec"；转换后语义与现状一致。

| 旧字段 | v2 映射 |
|---|---|
| `topology: m3-single` | `loop: {driver: self_report, done_tool: computer.done}` + 单角色 main |
| `topology: stateact-minimal` | `loop: {driver: gate_verdict, gate: finish, feedback_to: main}` + `gates.finish` + roles main/gui/finish_gate |
| `agents.<id>` | `roles.<id>`（字段同名直接搬） |
| `termination.require_finish_gate` / `finish_gate.*` | `loop.gate_verdict` 的 `gate` / `max_rounds` |
| `termination.max_steps` | `termination.max_steps`（保留） |
| `termination.budget.max_main_turns` | `roles.main.budget.max_steps`（收敛） |
| `subagents.gui.fresh_context` | `roles.gui.context.fresh_per_round: true` |

### 10.3 engine/orchestrator.ts（通用 round-loop 解释器）

```ts
// src/engine/orchestrator.ts
interface RoundContext {
  episodeId: string;
  index: number;                     // round 号
  state: TaskState;
  contract?: SubtaskContract;
  executorReport?: string;
  auditReport?: AuditReport;
  decision?: ManagerDecision;
}

class Orchestrator {
  constructor(
    private spec: HarnessSpec,
    private runtime: Runtime,        // roles / tools / stateStore / backend 实例
    private debugger?: Debugger,
  ) {}

  async runEpisode(input: {
    episodeId: string;
    task: string;
    observation: ObservationEnvelope;
  }): Promise<EpisodeSummary> {
    const state =
      (await this.runtime.stateStore.read(input.episodeId))
      ?? initTaskState(input.task, this.spec.state.schema);

    for (let round = state.rounds.length + 1;
         round <= this.spec.loop.max_rounds;
         round++) {
      const ctx: RoundContext = { episodeId: input.episodeId, index: round, state };
      this.debugger?.onRoundStart(ctx);
      const outcome = await this.driveRound(ctx, input);
      this.debugger?.onRoundEnd(ctx, outcome);
      if (outcome.kind === "done")    return { state, outcome: "done" };
      if (outcome.kind === "blocked") return { state, outcome: "blocked", reason: outcome.reason };
      if (outcome.kind === "ask")     return { state, outcome: "ask", question: outcome.question };
      if (outcome.kind === "max_rounds") return { state, outcome: "max_rounds" };
      // execute → 下一轮
    }
    return { state, outcome: "max_rounds" };
  }

  private async driveRound(ctx: RoundContext, input: StepInput): Promise<DecisionOutcome> {
    switch (this.spec.loop.driver) {
      case "manager_decision": return this.managerDrivenRound(ctx, input);
      case "gate_verdict":     return this.gateVerdictRound(ctx, input);
      case "self_report":      return this.selfReportRound(ctx, input);
      default: throw new Error(`unimplemented driver`);
    }
  }
}

// manager_decision 驱动（论文 MEA 的语义，全部由 spec 参数化）：
//   1) manager 角色（无环境工具，receives: [task, task_state, audit_history]）
//      → 决策 execute/done/blocked/ask（经 decision_tool 解析）
//   2) execute → 解析 contract（goal/acceptance_criteria/boundary_constraints/evidence_refs/target）
//   3) 按 routing[contract.target] 选 executor 角色（gui_executor / cli_executor），
//      fresh_per_round 上下文跑 episode，轨迹丢弃，只留 report
//   4) auditor 角色（read_only: enforce，receives: [task, contract, executor_report, env_state]）
//      → 结构化 AuditReport（completion / integrity / contractAudit / verifiedFacts / gaps）
//   5) state.update_policy=audit_verified：只有 clean 证据支持的记录才标记 completed
//   6) stateStore.appendRound + 发 round.* 事件
```

### 10.4 角色 receives → user 消息组装

```ts
// src/engine/runtime.ts
function buildRoleMessage(
  role: RoleSpec,
  ctx: RoundContext,
  obs: ObservationEnvelope,
): UserMessage {
  const parts: string[] = [];
  for (const source of role.receives ?? defaultReceives(role)) {
    parts.push(serializeSource(source, ctx, obs));
  }
  // 观察通道仍由 role.observation.allow/deny 控制，截图/a11y/terminal 按需附上
  return { role: "user", content: [{ type: "text", text: parts.join("\n\n") }] };
}

function defaultReceives(role: RoleSpec): Receives {
  if (role.read_only === "enforce") return ["task", "contract", "executor_report"];
  if (role.tools.includes("computer.pyautogui")) return ["task", "contract"];
  return ["task", "contract"];       // 默认执行类
}
```

### 10.5 调试器接口（debug / replay）

```ts
// src/engine/debugger.ts
interface Debugger {
  onRoundStart(ctx: RoundContext): Promise<void>;
  onRoundEnd(ctx: RoundContext, outcome: DecisionOutcome): Promise<void>;
  onRoleStart(role: string, req: EpisodeRequest): Promise<void>;
  onRoleEnd(role: string, result: EpisodeResult): Promise<void>;
  inspect(path: string): Promise<unknown>;          // task_state / contract / audit_report
  mutate(path: string, value: unknown): Promise<void>; // 干预式调试（记入干预日志）
}

class CliDebugger implements Debugger {
  // 触发：YAML debug.pause_after / 命令行 --pause-on round=N
  // 暂停时交互：[continue | step | inspect <path> | mutate <path> <json> | abort]
  // 每步打印：当前 round、contract 摘要、各角色输入/工具调用/输出、状态 diff
}

class ReplayDebugger implements Debugger {
  // 数据源：runs/<id>/events.jsonl + llm_traces.jsonl（不重跑模型）
  // 前提：事件必须携带真实 episodeId（现状 Python 侧传 "unknown"，需修复——
  // 见 bridge reset 调用，否则多任务 trace 无法关联）
}
```

### 10.6 P0 验收标准

1. `m3-single.yaml`、`stateact-minimal.yaml` 经 legacy 转换后在 v2 引擎下跑出与
   现状一致的结果（task_004 分数对齐现有 `summary/results.json`）。
2. `presets/mea.yaml` 在 mock backend + mock env 下跑完冒烟（≤ 数轮），
   contract / executor_report / audit_report / task_state 产物齐全且人类可读。
3. `debug` CLI 能在 mock 运行中暂停、`inspect task_state`、`mutate` 后继续，
   干预动作写入 `interventions.jsonl`。
4. `replay` 能从一次 mock 运行的 trace 无模型重放，复现相同决策序列。
