# pi-osworld-v2

可调试、靠 YAML 组合任意 harness 的实验框架。核心思想：**引擎唯一，harness = YAML 组合**。
论文 LongHorizon-Harness 的 MEA 只是 `presets/mea.yaml` 一份配置，不是代码模块。
`RoleAgent` / `PiContextManager` / `RoleSubagent` 等 Pi 运行时实现收在
`src/backends/pi/`，由 `PiBackend` 唯一出口接入引擎。

## 文档地图

| 文档 | 内容 |
|---|---|
| `docs/DESIGN-v2.md` | 设计基线：原语 / 组合 / 解释器模型（实现已落地，进度以 PLAN 为准） |
| `docs/PLAN.md` | 落地计划与当前状态（Phase A–G） |
| `docs/CODE-READING.md` | **代码阅读与运行流程说明**：从哪读起、任务怎么从 YAML 流到结果 |
| `docs/CLUSTER-PLAN.md` | 集群适配（Aliyun / OSS / parametrix） |

## 单仓自包含布局

```text
pi-osworld-v2/
├── src/                        # 框架本体
│   ├── config/                 # HarnessSpec schema + 加载/extends/兼容
│   ├── engine/                 # 编排层：round-loop / Runtime / TaskState / 调试
│   ├── backends/               # 后端适配层（pi / mock；pi/ 收编旧 Pi 运行时）
│   ├── env/                    # 环境桥（OSWorld tool server + 只读双闸）
│   ├── bridge/                 # serve JSONL 协议
│   ├── cli/                    # run / serve / debug / compare / matrix
│   └── primitives/             # 通用小原语（permission）
├── python/                     # OSWorld runner（run_v2.py / run_v2_cluster.py）
├── docs/                       # 文档：DESIGN / PLAN / CLUSTER-PLAN / CODE-READING
├── presets/ experiments/ task-sets/ prompts/   # 实验配置树，自包含
├── external/OSWorld-V2         # 官方 OSWorld-V2 git submodule（含 osworld-server）
├── patches/                    # 对官方仓库的必要补丁（如 docker port lock）
├── scripts/                    # setup.sh / run-smoke.sh / sync-legacy.mjs
├── test/                       # vitest 单测
└── .env.example                # 密钥模板，真实 .env 不入 git
```

## 快速开始

```bash
git clone <repo> && cd pi-osworld-v2
bash scripts/setup.sh             # submodule + npm install/build + .env + 资源检查
# 编辑 .env 填入 ANTHROPIC_API_KEY 等

# 1) mock 冒烟（不调模型、不需要 VM）
bash scripts/run-smoke.sh
node_modules/.bin/tsx src/cli/index.ts run \
  --config experiments/mea-demo.yaml --root . --result-dir /tmp/piosworld-demo

# 2) 真实验（需要 OSWorld VM 镜像与 .env 密钥；config-root 指向仓库根）
external/OSWorld-V2/.venv/bin/python python/run_v2.py \
  --config presets/stateact.yaml --config-root . \
  --result-dir runs --osworld-root external/OSWorld-V2 \
  --provider-name docker --max-steps 3
```

## 已实现

- **引擎**：`src/engine/orchestrator.ts` 通用 round-loop 解释器，三种 driver：
  `self_report`（m3）/ `gate_verdict`（stateact）/ `manager_decision`（论文 MEA）
- **spec**：`src/config/spec.ts` zod schema，`extends` 深合并 + 循环检测 + config hash；
  `src/config/compat.ts` 把旧 `agents/topology` YAML 自动转换为 v2 spec（含 pi 后端旋钮）
- **后端可插拔**：
  - `pi`：`src/backends/pi/backend.ts` 包装 `RoleAgent`（消息拼法对齐旧 flow：
    `state_text` / `raw_task` / `gate`；内部工具循环 + plan 外部化 + 每轮 state 刷新；
    `read_only` 写工具拦截；`delegate.*` 委派给旧 `RoleSubagent`）
  - `mock`：脚本化行为，单测 / 调试 / CI 无模型跑通
- **运行时**：`src/engine/runtime.ts` 角色 receives → user 消息组装；
  `TaskStateStore` 内存 / 文件，round 产物落盘
- **step 驱动**：`serve` JSONL bridge + `FileTaskStateStore` resume（run_v2.py 使用）
- **调试**：`debug` CLI（轮间暂停 / 干预，写 `interventions.jsonl`）
- **实验效率**：`matrix` / `compare` / manifest（run_v2.py 启动时写 manifest.json）

## CLI 一览

```text
piosworld run --config <yaml> [--root <dir>] [--episode-id <id>] [--task <text>]
              [--result-dir <dir>] [--backend pi|mock] [--mock-script <yaml>] [--interactive]
piosworld serve --config <yaml> [--root <dir>] [--result-dir <dir>]
                [--backend pi|mock] [--mock-script <yaml>]     # JSONL bridge（OSWorld step 驱动）
piosworld debug <run-dir>
piosworld compare <run-dir> [<run-dir> ...]
piosworld matrix --matrix <matrix.yaml> [--dry-run] [--python <py>] [--config-root <dir>]
                 [--result-dir <dir>] [--osworld-root <dir>] [--provider-name docker|aws|...]
                 [--max-steps <n>] [--num-envs <n>]
```

`--root <dir>` 是 prompt 相对路径基准，默认自动探测 config 目录/父目录；
`--backend pi|mock` 覆盖全部角色（默认按 `spec.roles.<id>.backend`，缺省 pi）。

## 运行产物

```text
runs/<run_id>/
├── result.json            # outcome / rounds / requirements 状态
├── events.jsonl           # round.* / role.* / manager.decision 等结构化事件
└── state/<episodeId>/
    ├── task_state.json    # 任务状态（requirements / artifacts / facts + 证据引用）
    └── round-<i>/         # contract.md / executor_report.md / audit_report.md / decision.json
```

## 路线与状态

- Phase A（完成）：pi 后端适配层 + legacy 运行时桥 + 消息拼法对齐
- Phase B（完成）：环境层抽象 + read_only 执行层强制 + `serve` step 驱动
- Phase C（进行中）：OSWorld-V2 复现闭环（task_004 分数对齐 0.6556）
- Phase D（大部分完成）：MEA driver + debug 干预 + matrix/compare；IntegrityMonitor 待做
- Phase E（完成）：单仓自包含迁移（submodule / 配置树 / setup.sh / .env.example）
- Phase F（进行中）：集群适配（Aliyun / OSS / parametrix，详见 `docs/CLUSTER-PLAN.md`）
- Phase G（G1 完成 / G2 待做）：结构整理 + MEA 补齐（IntegrityMonitor / deadline / GUI 审计）

详见 `docs/PLAN.md`。

## 代码阅读

从 `docs/CODE-READING.md` 开始：先读 spec → engine/types → orchestrator → runtime → backends →
env → cli → python，含 mock 与真实验两条运行流程的逐步走读，以及关键概念速查。
