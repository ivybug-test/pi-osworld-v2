# pi-osworld-v2 落地计划

目标：把 v2 做成"可调试、靠 YAML 组合任意 harness"的实验框架；论文 LongHorizon-Harness
的 MEA 只是 `presets/mea.yaml` 一份配置。**模块化与易用性优先，不贪快**。

原则：
- 引擎唯一一份 round-loop 解释器，行为全由 `HarnessSpec` 参数化，不写论文专属类名。
- 后端可插拔：`pi`（默认主力）/ `codex` / `claude` / `openclaw` / `mock`。
- 旧 `pi-osworld` 代码只 import 不重写；v2 是独立目录，不改旧仓库。
- 每一步都有验证点（单测 / 冒烟 / 分数对齐）。

---

## Phase A — Pi 后端适配层（真实模型执行，stateact 复现的前提）

| # | 任务 | 验证 |
|---|------|------|
| A1 | 建立 legacy 包链接：`file:` 依赖 `pi-osworld`，验证 `RoleAgent`/`PiContextManager`/`RoleSubagent` 可从 v2 import（类型 + 运行时） | `npm install` 后 tsc 通过；node 可动态 import 旧 dist |
| A2 | `src/backends/pi.ts`：`PiBackend implements BackendAdapter`。把 `EpisodeRequest`（system/user/tools/budget/freshPerRound）映射到旧 `RoleAgent.stepUntilDecision`：tool executor 注入、`budget.max_steps → maxToolCalls`、`freshPerRound → reset`、terminal 工具集合从 spec 参数化 | 单测：注入 fake client，验证消息/工具/轮次/预算/重置行为 |
| A3 | legacy 运行时桥：v2 内构造旧 `FlowContext` 等价物（`RunWriter` 复用、模型 alias 映射、`PI_OSWORLD_TOOL_SERVER` 地址），不依赖旧 config 加载 | 单测：RunWriter 事件落盘、model 映射正确 |
| A4 | 消息拼法对齐：Pi 模式下 user 消息 = 旧 `buildRoleView` + stateText/plan 注入格式；main 的 plan 注入与动态 observation 刷新参数化进 spec（默认关闭，stateact preset 开启） | 快照测试：main/gui/finish_gate 的 user 消息与旧 flow 逐字段一致 |

**阶段验收**：`stateact-minimal.yaml`（legacy 转换）在 mock env + 真实 MiniMax-M3 模型下
跑通一轮 main predict + 一次 finish gate，事件与产物齐全。

## Phase B — 环境层 + step 驱动（接 OSWorld-V2 VM）

| # | 任务 | 验证 |
|---|------|------|
| B1 | `src/env/`：`Environment` 抽象（observe/execute/snapshot）+ 复用旧 `HttpToolExecutor` | 单测：fake tool server 协议往返 |
| B2 | read_only 执行层强制：`read_only: enforce` 的角色自动拦截写工具（写工具集合上移为常量），双闸（执行层 + 环境层） | 单测：auditor/finish_gate 角色写工具被拒 |
| B3 | `serve` 命令：JSONL bridge（复用旧 `BridgeRequest/BridgeResponse` 类型），每次 `predict` = v2 一轮 + FileTaskStateStore resume | 冒烟：`serve` 下 mock 跑 3 个 step，状态跨 step 延续 |
| B4 | observation 文件/JSON 传入通道 + 事件落盘（events.jsonl 每 step 追加） | 冒烟：step 驱动 run 产物完整 |

**阶段验收**：python 侧 fake VM 通过 `serve` 驱动 v2 完成多 step 任务，轨迹可 replay。

## Phase C — OSWorld-V2 复现闭环（回答"什么时候能复现"）

| # | 任务 | 验证 |
|---|------|------|
| C1 | `python/run_v2.py`：复用旧 `PiOSWorldAgent`（command 指向 v2 serve），修 `episodeId: "unknown"` 问题；加载 v2 spec（`task_set` / `termination` / `observation_capture`） | 语法/导入检查 + docker 不可用时的 dry-run |
| C2 | task_004 单任务实跑（MiniMax-M3 同端点、同 prompts），分数对齐 `runs/.../summary/results.json` 的 0.6556（允许 LLM 随机波动） | `results.json` score > 0 且量级一致 |
| C3 | 产物落盘对齐：`result.json` / `events.jsonl` / `state/` / trajectory；README 更新复现命令 | 文档 + 一次实跑产物检查 |

**阶段验收**：`task_004 → score ≈ 0.6556`，README 有"一键复现"命令。

## Phase D — 组合能力补全（MEA 实跑 + 调试体验）

| # | 任务 | 验证 |
|---|------|------|
| D1 | `manager_decision` driver 接 Pi 后端：manager 决策契约 → executor → auditor（read_only）消息拼法；auditor 只读强制 | 单测 + `mea.yaml` 实跑 1-2 轮 |
| D2 | IntegrityMonitor + 环境侧 snapshot/diff（挂到 tool server，不侵入 OSWorld-V2） | 单测：diff 检测 violation |
| D3 | debug 交互完善：`mutate` 干预写入 `interventions.jsonl`，可追溯 | 冒烟 + 单测 |
| D4 | matrix / compare / manifest：多任务、多配置一键跑 + 结果对比 | 冒烟：2 配置 × 2 任务 |

**阶段验收**：`presets/mea.yaml` 与 `presets/stateact.yaml` 同框架实跑，产物结构一致，可对比。

---

## 时间量级（路径依赖）

- Phase A：1–2 天（含消息对齐的逐字段核对）
- Phase B：约 1 天
- Phase C：1–2 天（含实跑与波动分析）
- Phase D：持续迭代（每项独立可交付）

## 当前状态

- [x] P0 骨架（spec / legacy / orchestrator / runtime / mock / debug / replay）
- [x] A1 导入通道（file: 依赖 + src/legacy/imports.ts 唯一出口，运行时与类型均验证）
- [x] A2 PiBackend（interior_loop / terminal_tools / plan_tool / refresh_state / read_only /
      delegations 旋钮；fake client 11 个单测）
- [x] A3 运行时桥（buildLegacyConfig / buildLegacyFlowContext + RunWriter）
- [x] A4 消息对齐（state_text / raw_task / gate / delegate 任务文本快照测试）
- [x] B1 环境层抽象（src/env/types.ts + HttpEnvironment，复用旧 HttpToolExecutor）
- [x] B2 read_only 双闸（PiBackend 执行层 + HttpEnvironment 环境层；写工具集合统一）
- [x] B3 serve 命令（JSONL bridge，复用旧 BridgeRequest/BridgeResponse；roundLimit+resume）
- [x] B4 step 驱动冒烟（3 个 predict 状态跨 step 落盘，replay 可复现；37 单测通过）
- [ ] C1–C3 复现闭环
- [ ] D1–D4 组合能力
- [x] B1 环境层抽象（src/env/types.ts + HttpEnvironment，复用旧 HttpToolExecutor）
- [x] B2 read_only 双闸（PiBackend 执行层 + HttpEnvironment 环境层；写工具集合统一）
- [x] B3 serve 命令（JSONL bridge，复用旧 BridgeRequest/BridgeResponse；roundLimit+resume）
- [x] B4 step 驱动冒烟（3 个 predict 状态跨 step 落盘，replay 可复现；37 单测通过）
- [ ] C1–C3 复现闭环
- [ ] D1–D4 组合能力
