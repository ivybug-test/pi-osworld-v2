# pi-osworld-v2 代码阅读与运行流程说明

> 配套文档：`README.md`（入口）、`docs/DESIGN-v2.md`（设计基线）、`docs/PLAN.md`（落地进度）。
> 本文回答两个问题：**代码从哪里读起**、**一条任务从 YAML 到结果是怎么流过的**。

## 1. 总览：两条主线

- **数据流（一次运行）**：YAML 配置 → `HarnessSpec` → CLI 装配（Runtime + Orchestrator +
  Backends）→ 角色执行（PiBackend/RoleAgent 或 mock）→ Environment（OSWorld tool server）→
  状态/产物落盘。
- **控制流（一个 round）**：Orchestrator 按 `spec.loop.driver` 驱动 → 依次调用角色
  （`backend.runEpisode`）→ 收集 contract / executor_report / audit_report → 更新 TaskState →
  判断是否终止。

引擎里没有 manager/executor/auditor 专属类；MEA、stateact、m3 的差异全部在 YAML
（`presets/*.yaml`），引擎是唯一一份 round-loop 解释器（`src/engine/orchestrator.ts`）。

## 2. 目录地图

| 路径 | 职责 | 关键文件 |
|---|---|---|
| `src/config/` | HarnessSpec zod schema、加载/extends/兼容 | `spec.ts` `load.ts` `compat.ts` `runtime-spec.ts` |
| `src/engine/` | 编排层：round-loop、Runtime 装配、TaskState、调试 | `orchestrator.ts` `runtime.ts` `taskState.ts` `debugger.ts` `types.ts` |
| `src/backends/` | 后端适配层（pi / mock 可插拔） | `base.ts` `factory.ts` `mock.ts` `pi/` |
| `src/backends/pi/` | Pi 运行时（镜像的旧 pi-osworld 实现，唯一出口 `index.ts`） | `backend.ts` `agent.ts` `compat.ts` `tools/` `context/` `subagents/` `models/` |
| `src/env/` | 环境桥：Environment 抽象 + HTTP tool server + 写工具集合 | `types.ts` `http.ts` `actions.ts` |
| `src/bridge/` | serve JSONL 协议 | `protocol.ts` |
| `src/cli/` | 命令入口：run / serve / debug / compare / matrix | `index.ts` `serve.ts` |
| `src/primitives/` | 通用小原语 | `permission.ts` |
| `python/` | OSWorld runner（真实 VM 驱动 v2） | `run_v2.py` `run_v2_cluster.py` `pi_osworld_adapter_v2.py` |
| `presets/ experiments/ task-sets/ prompts/` | 实验配置树（自包含） | `stateact.yaml` `mea.yaml` `m3-single.yaml` |
| `scripts/` | 初始化 / 冒烟 / legacy 同步 | `setup.sh` `run-smoke.sh` `sync-legacy.mjs` |
| `test/` | vitest 单测 | `*.test.ts` |

## 3. 推荐阅读顺序

1. `src/config/spec.ts` — HarnessSpec 全量 schema（roles / loop / state / gates / termination /
   debug）。先知道 YAML 能表达什么。
2. `src/engine/types.ts` — 核心类型：TaskState / RoundContext / EpisodeResult /
   ObservationEnvelope / ReceivesSource，是各层之间的契约。
3. `src/engine/orchestrator.ts` — 唯一一份 round-loop：`runEpisode` → `driveRound` → 三种 driver。
4. `src/engine/runtime.ts` — Runtime 装配 + `receives → user 消息组装`（`buildRoleMessage`）。
5. `src/backends/base.ts` + `factory.ts` — BackendAdapter 接口与装配（`--backend` 覆盖）。
6. `src/backends/pi/backend.ts` + `index.ts` — PiBackend 如何包装旧 RoleAgent（行为旋钮）。
7. `src/env/types.ts` + `http.ts` — Environment 抽象与 tool server 协议（含只读双闸）。
8. `src/cli/index.ts` + `serve.ts` — 命令入口；serve 是"每次 predict = 引擎一轮"的桥。
9. `python/run_v2.py` — 真实验怎么用 serve 驱动 OSWorld VM 并打分。
10. `src/engine/taskState.ts` + `debugger.ts` — 状态落盘与轮间调试/干预。

## 4. 运行流程

### 4.1 本地 mock 冒烟（不调模型、不需要 VM）

```bash
bash scripts/setup.sh        # submodule + npm install/build + .env
bash scripts/run-smoke.sh    # stateact-demo mock 冒烟
node_modules/.bin/tsx src/cli/index.ts run \
  --config experiments/mea-demo.yaml --root . --result-dir /tmp/piosworld-demo
```

调用链：`cli/index.ts run` → `loadHarnessSpec`（extends 合并 + config hash）→ `buildBackends`
（全部 mock，行为由 `spec.loop.driver` 的默认脚本决定）→ `Runtime` + `Orchestrator.runEpisode`
→ 每轮 `runtime.runRoleEpisode` → mock 返回 decision/report/audit → `appendRound` 落盘 →
`result.json`。

产物（result-dir 下）：

```text
runs/<run_id>/
├── result.json            # outcome / rounds / requirements 状态
├── events.jsonl           # round.start/decision/contract/audit/state_update, role.start/end, manager.decision
└── state/<episodeId>/
    ├── task_state.json    # requirements / artifacts / facts + evidence 引用
    └── round-<i>/         # contract.md / executor_report.md / audit_report.md / decision.json
```

### 4.2 真实验（serve 桥 + OSWorld VM）

```bash
external/OSWorld-V2/.venv/bin/python python/run_v2.py \
  --config presets/stateact.yaml --config-root . \
  --result-dir runs --osworld-root external/OSWorld-V2 \
  --provider-name docker --max-steps 3
```

```text
python/run_v2.py ──spawn──> piosworld serve（JSONL bridge, src/cli/serve.ts）
      │                           │  predict(episodeId, step) → 引擎跑 1 轮（resume）
      │                           │  ← StepOutput { response, actions }
      │   env.step(actions)       │
      └──> DesktopEnv（OSWorld VM）│  工具调用 → HttpEnvironment → OSWorld tool server
            └─ screenshot / a11y / terminal ─┘
```

要点：
- 每个 `predict` = Orchestrator 跑一轮（roundLimit=1），状态经 `FileTaskStateStore` 跨 step 延续；
- 工具执行发生在 python 侧 `env.step`，观察回传后下一个 predict 继续（step 驱动）；
- 分数由官方 evaluator 计算并写入 `summary/results.json`（对齐目标 0.6556，见 PLAN Phase C）。

### 4.3 CLI 命令一览

| 命令 | 作用 |
|---|---|
| `run` | 单次 episode（mock 或真实后端） |
| `serve` | JSONL bridge，step 驱动（run_v2.py 内部使用） |
| `debug` | 轮间暂停 / 检查 / 干预（写 `interventions.jsonl`） |
| `compare` | 多 run 结果对比 |
| `matrix` | matrix.yaml 展开多任务 × 多配置并顺序执行 |

## 5. 一个 round 的走读（driver: manager_decision / MEA）

对应 `orchestrator.ts` 的 `managerDecisionRound`：

1. **manager**：`runtime.runRoleEpisode(manager)` → decision `{ kind: "execute", contract }`。
   事件：`role.start` / `role.end` / `manager.decision` / `round.contract`。
2. **executor**：按 `contract.target` 路由 `loop.routing.cli|gui` → executor_report。
3. **auditor**：`read_only: enforce` 的角色（orchestrator 自动挑选）→ auditReport
   （completion / integrity / contractAudit / gaps）。事件：`round.audit`。
4. **state update**：`update_policy=audit_verified` → `applyAuditToState`：只有 clean 审计
   证据支持的 requirement 才能标 `completed`；integrity 非 clean → 全部 `untrusted`。
   事件：`round.state_update`。
5. **决策 / 终止**：audit complete+clean → 下一轮由 manager 判断；manager 返回 `done` → 结束。
   事件：`round.decision`。

落盘：每轮 `round-<i>/{contract.md, executor_report.md, audit_report.md, decision.json}`，
`task_state.json` 同步更新。gate_verdict（stateact）多一个跨轮 feedback 回灌与拒绝计数
（存在 task_state.gate，serve 模式下也能跨 step 延续）。

## 6. 关键概念速查

| 概念 | 位置 | 说明 |
|---|---|---|
| HarnessSpec | `src/config/spec.ts` | 全量 schema；extends 深合并 + 循环检测 + config hash |
| driver | `spec.loop.driver` | `self_report`(m3) / `gate_verdict`(stateact) / `manager_decision`(MEA) |
| receives | `src/engine/runtime.ts` | 角色 user 消息来源；`defaultReceives` 按角色推导（read_only 角色默认注入 executor_report） |
| read_only 双闸 | `src/backends/pi/backend.ts` + `src/env/http.ts` | 执行层拦截 + 环境层 `execute(readOnly)` 兜底；写工具集合统一（`WRITE_TOOLS`） |
| TaskStateStore | `src/engine/taskState.ts` | 内存 / 文件；resume 靠已落盘的 rounds |
| BackendAdapter | `src/backends/base.ts` | `runEpisode` / `resetEpisode` / `close` |
| Environment | `src/env/types.ts` | `observe` / `execute`；`HttpEnvironment` 直连 tool server |
| budget.max_steps | PiBackend | 已接线 → `maxToolCalls`（A2） |
| budget.max_seconds | `spec.ts` 已定义 | **未接线 AbortController（G2.2 待办）** |
| Runtime.checkIntegrity | `src/engine/runtime.ts` | **占位返回 clean（G2.1 待办）**，当前 integrity 语义由 auditor 的 auditReport 承担 |

## 7. 调试与对照

- `debug <run-dir>`：轮间暂停，`mutate` 干预写 `interventions.jsonl`
  （RecordingDebugger / CliDebugger 均落盘）。
- `--mock-script <yaml>`：给 mock 后端喂脚本化行为（fixtures）。
- `compare` / `matrix`：多任务多配置对照与批量执行（run_v2.py 启动时写 manifest.json）。
- 产物一致性：stateact / m3 / MEA 走同一引擎，产物结构一致，可对比（PLAN Phase D/G 验收）。

## 8. 当前状态与待办（对应 docs/PLAN.md）

- G1 结构整理已完成：`src/legacy*` 移除、类型去重、环境层归位；build + 69 单测 + mock 冒烟通过。
- G2 待办：IntegrityMonitor 真实 snapshot/diff（G2.1）、max_seconds 超时（G2.2）、
  GUI 只读审计工具集（G2.3）、mea.yaml 关闭 executor_report 注入（G2.4）、MEA 实跑（G2.5）。
