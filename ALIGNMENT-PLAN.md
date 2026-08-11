# pi-osworld v1 -> v2 对齐计划

## 目标

- v2 与 v1 先在两个实验上对齐：`m3-single` 与 `stateact-minimal`（配置、prompts、运行时行为、产物语义）。
- 对齐完成后冻结 v1，后续只在 v2 上继续开发。
- v2 保持“独立可 clone、靠 YAML 组合 harness”的通用实验框架定位。

## 现状与差距

- v1 已是 git 仓库（commit `61235d6`）；v2 还不是 git 仓库。
- v2 采用“镜像旧 pi-osworld 实现”的方式（见 `src/legacy/imports.ts`），但 v1 在 8/10 之后的修复没有同步到 v2。
- v2 当前 `npm test` 有 **9 个失败用例**，根因是 v2 的 `HarnessSpec` / `legacyCompat`
  不认识 v1 新增的 `m3-image-truncation` 压缩策略和 `context.compaction.image_truncation`。
- 两份实验配置差异：
  - `presets/m3-single.yaml` 缺 `benchmark/task_set`、`llm_retry`、`model_options`、
    context compaction、`max_steps: 500` 等。
  - `presets/stateact.yaml` 缺 `model_options`、compaction、`observation_capture`、
    budget、checkpoint、finish gate 参数；gui 缺 `state.view_image`。
  - v2 `prompts/roles/` 缺 `m3-main.md`、`main-state-only.md`、`finish-gate.md`，
    也缺 `prompts/shared/osworld-environment.md`。

## 工作项

### 0. 基线

- 为 `pi-osworld-v2` 初始化 git，先打一个“对齐前”commit，保证每一步可 diff / 可回滚。
- 可选：同时把 `osworld-experiments` 初始化 git，让配置层也版本化。

### 1. 同步 v1 的 legacy 实现修复

以下文件以 v1 为源同步进 v2（v2 内 import 保持指向 `src/legacy-config/spec.js`）：

| 文件 | v1 修复内容 |
| --- | --- |
| `src/context/image-truncation.ts` | 新增：M3 确定性截图截断视图变换 |
| `src/agents/role.ts` | 接入 image truncation、`model_options` 采样、`modelErrorMessage` |
| `src/models/client.ts` | 把 temperature / max_tokens / thinking_mode 传给 Pi provider |
| `src/context/compaction.ts` | 新增 `m3-image-truncation` 策略 |
| `src/context/manager.ts` | `image_truncation` 配置透传与合并 |
| `src/gate/finish-gate.ts` | 模型错误记录 `finish_gate.error` 并拒绝 verdict |
| `src/subagents/role-subagent.ts` | subagent 模型错误处理、`screenshotMime` |
| `src/observation/router.ts` | `screenshotMime`、`normalizeObservation` |
| `src/tools/executor.ts` | observe 结果归一化 |
| `src/tools/computer.ts` | `computer.ask_user`、完整动作空间（click 变体/mouse/drag/hold_key/screenshot/wait） |
| `src/tools/registry.ts` | 注册 `computer.ask_user` |
| `src/actions/adapter.ts` | 坐标归一化、多动作类型、屏幕尺寸参数 |
| `python/pi_osworld_adapter.py` | JPEG 转码、真实分辨率坐标、`computer.screenshot/done/fail/ask_user`、`view_image` 非图片/超大文件拦截 |
| `src/legacy-config/spec.ts` | 从 v1 `src/config/spec.ts` 补齐 `model_options`、`image_truncation`、checkpoint、runtime 类型 |

### 2. 修 v2 自己的 schema

- `src/config/spec.ts`（`HarnessSpec`）：
  - `CompactionSpec.strategy` 增加 `m3-image-truncation`
  - `CompactionSpec` 增加 `image_truncation` 字段
  - `RoleSpec` 增加 `model_options`（temperature / max_tokens / top_p / thinking_mode / thinking_budget）
  - `TerminationSpec` 增加 checkpoint 相关字段
  - `HarnessSpec` 增加 `runtime`（num_envs / env_start_delay）
- `src/config/legacyCompat.ts`：
  - 透传 `agent.model_options`、`termination.checkpoint_*`、`runtime.*`
  - 保证当前 v1 YAML（`m3-single.yaml` / `stateact-minimal.yaml`）可直接转换为 v2 spec
- 验收：`npm test` 的 9 个失败清零。

### 3. 对齐两个实验配置与 prompts

- `presets/m3-single.yaml`：与 v1 `experiments/m3-single.yaml` 对齐
  （benchmark、task_set、llm_retry、model_options、context compaction、`termination.max_steps: 500`）。
- `presets/stateact.yaml`：与 v1 `experiments/stateact-minimal.yaml` 对齐
  （model_options、compaction、observation_capture、budget、finish gate、
  gui 增加 `state.view_image`、`termination.max_steps: 500`）。
- 从 `osworld-experiments/prompts/` 同步真实 prompt 到 v2：
  `roles/m3-main.md`、`roles/main-state-only.md`、`roles/gui-specialist.md`、
  `roles/finish-gate.md`、`shared/osworld-environment.md`。
- v2 实验配置引用仓库内 prompt，保持独立可运行。

### 4. 验证

- `npm run build` 通过。
- `npm test` 全绿（当前 38 个用例，修复后应不少于该数）。
- mock 后端分别跑 `m3-single` / `stateact` 冒烟。
- 真实 MiniMax 冒烟 task 004，确认 v2 与 v1 行为/产物语义一致。

### 5. 真实运行对齐

- 用 v2 跑 `m3-single` task 004，与 v1 历史结果 `0.1444` 对比。
- 用 v2 跑 `stateact-minimal` task 004，与 v1 历史结果 `0.4778 / 0.8333` 对比。
- 对比维度：score 量级、finish gate 轮数、delegate 次数、轨迹形态、事件结构；
  单次分数不要求相等（模型随机）。

### 6. 防漂移与后续开发

- 建议加 `scripts/sync-legacy.sh` + drift 单测：镜像文件与 v1 不一致时测试失败，
  以后 v1 有修改可一键同步。
- v1 冻结后只开发 v2，继续执行现有 `PLAN.md` 的 Phase C/D：
  `run_v2.py`、task_004 复现、产物对齐、MEA / IntegrityMonitor / matrix。

## 决策点

1. **镜像 + 同步脚本**（推荐，v2 独立可 clone） vs **改为 `file:` 依赖 v1**（无漂移但不再独立）。
2. **prompts 复制进 v2**（推荐） vs 运行时引用 `osworld-experiments` 目录。
3. 真实对齐运行次数：默认每个实验各 1 次；要估方差则各 3 次。

## 验收标准

- [x] v2 建立 git 基线。
- [x] v2 `npm test` 全绿（38 个用例），`npm run build` 通过。
- [x] v2 能直接加载 v1 当前两个实验 YAML。
- [x] v2 两份 preset / prompts 与 v1 配置语义一致。
- [ ] v2 真实跑通 task 004 的 m3 与 stateact，行为与 v1 对齐。
- [ ] 对齐完成后 v1 冻结，后续修改只发生在 v2。

## 当前进度

- [x] 2026-08-11：v2 建立 git 基线（`078aff2`）。
- [x] 2026-08-11：同步 v1 legacy 实现修复（role/context/gate/subagent/observation/tools/python adapter 等），
  `HarnessSpec` 增加 `m3-image-truncation`、`image_truncation`、`model_options`、checkpoint、runtime；
  `legacyCompat` 支持当前 v1 YAML。
- [x] 2026-08-11：`presets/m3-single.yaml` 与 `presets/stateact.yaml` 对齐 v1 配置，
  真实 prompts 已复制进 v2；mock 冒烟 m3 / stateact 均通过。
- [ ] 待确认：task 004 真实运行对齐（v2 各跑一次 m3 / stateact）。
