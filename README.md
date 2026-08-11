# pi-osworld-v2

可调试、靠 YAML 组合任意 harness 的实验框架。核心思想：**引擎唯一，harness = YAML 组合**。
论文 LongHorizon-Harness 的 MEA 只是 `presets/mea.yaml` 一份配置，不是代码模块。
旧 `pi-osworld` 的 `RoleAgent`/`PiContextManager`/`RoleSubagent` 只 import 不重写，
经 `src/legacy/imports.ts` 唯一通道接入。

> 设计文档 `DESIGN-v2.md`；落地计划见 `PLAN.md`（含 Phase E 单仓自包含迁移）。

## 单仓自包含布局

```text
pi-osworld-v2/
├── src/ python/ dist/           # 框架本体（dist 由 npm run build 生成，不入 git）
├── presets/ experiments/ task-sets/ prompts/   # 实验配置树，自包含
├── external/OSWorld-V2          # 官方 OSWorld-V2 git submodule（含 osworld-server）
├── patches/                     # 对官方仓库的必要补丁（如 docker port lock）
├── .env.example                 # 密钥模板，真实 .env 不入 git
└── scripts/setup.sh             # 一键初始化
```

准备与运行：

```bash
git clone <repo> && cd pi-osworld-v2
bash scripts/setup.sh             # submodule + npm install/build + .env + 资源检查
# 编辑 .env 填入 ANTHROPIC_API_KEY 等

# 本地 smoke / 真实验（config-root 指向仓库根，prompt/task-set 相对该根解析）
/home/binqiu/OSWorld-V2/.venv/bin/python python/run_v2.py   --config presets/m3-single.yaml   --config-root .   --result-dir runs   --osworld-root external/OSWorld-V2   --provider-name docker   --max-steps 3
```

## 已实现

- **引擎**：`src/engine/orchestrator.ts` 通用 round-loop 解释器，三种 driver：
  `self_report`（m3）/ `gate_verdict`（stateact）/ `manager_decision`（论文 MEA）
- **spec**：`src/config/spec.ts` zod schema，`extends` 深合并 + 循环检测 + config hash；
  `legacyCompat` 把旧 `agents/topology` YAML 自动转换为 v2 spec（含 pi 后端旋钮）
- **后端可插拔**：
  - `pi`：`src/backends/pi.ts` 包装旧 `RoleAgent`（消息拼法对齐旧 flow：
    `state_text` / `raw_task` / `gate`；内部工具循环 + plan 外部化 + 每轮 state 刷新；
    `read_only` 写工具拦截；`delegate.*` 委派给旧 `RoleSubagent`）
  - `mock`：脚本化行为，单测/调试/CI 无模型跑通
- **运行时**：`src/engine/runtime.ts` 角色 receives → user 消息组装；
  `TaskStateStore` 内存/文件，round 产物落盘
- **调试**：`debug` CLI（轮间暂停）、`replay`（events.jsonl 无模型重放）

## 使用

```bash
npm install
npm test                  # 单测（spec / legacy / piBackend / orchestrator / debugger / compare / matrix）
npm run build

# mock 冒烟（不调模型，config-root 指向仓库根）
node_modules/.bin/tsx src/cli.ts run \
  --config experiments/mea-demo.yaml --root . --result-dir /tmp/piosworld-demo
node_modules/.bin/tsx src/cli.ts run \
  --config experiments/stateact-demo.yaml --root . --result-dir /tmp/piosworld-sa

# 真实验入口：run_v2.py 内部起 v2 serve + OSWorld VM
# 首次先 bash scripts/setup.sh 初始化 external/OSWorld-V2 与 .env
/home/binqiu/OSWorld-V2/.venv/bin/python python/run_v2.py \
  --config presets/stateact.yaml \
  --config-root . \
  --result-dir runs \
  --osworld-root external/OSWorld-V2 \
  --provider-name docker
```

CLI 选项：`--root <dir>`（prompt 相对路径基准，默认自动探测 config 目录/父目录）、
`--backend pi|mock`（覆盖全部角色；默认按 spec.roles.<id>.backend，缺省 pi）、
`--episode-id`、`--task`、`--mock-script`、`--interactive`。

## 运行产物

```
runs/<run_id>/
├── result.json            # outcome / rounds / requirements 状态
├── events.jsonl           # round.* / role.* / manager.decision 等结构化事件
└── state/<episodeId>/
    ├── task_state.json    # 任务状态（requirements/artifacts/facts + 证据引用）
    └── round-<i>/         # contract.md / executor_report.md / audit_report.md / decision.json
```

## 路线

- Phase A（完成）：pi 后端适配层 + legacy 运行时桥 + 消息拼法对齐（31 单测通过）
- Phase B：环境层抽象 + read_only 执行层强制 + `serve` 命令（step 驱动 bridge）
- Phase C：OSWorld-V2 复现闭环（task_004 分数对齐 0.6556）
- Phase D：MEA 实跑 + IntegrityMonitor + debug 交互 + matrix/compare
- Phase E：单仓自包含迁移（OSWorld-V2 submodule、配置树并入、setup.sh、.env.example）

详见 `PLAN.md`。
