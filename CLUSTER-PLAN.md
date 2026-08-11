# pi-osworld-v2 集群实验改造计划

## 背景与目标

后续需要在集群（当前参考 `47.120.53.174` 上的 Aliyun ECS 环境）批量跑 OSWorld-V2
实验。目标不是复刻一套集群基建，而是让 **v2 harness 以最小改动跑进现有集群流程**，
并且保留 v2 的配置驱动特性（实验差异全部在 YAML，而不是改 runner）。

## 集群现状（2026-08-11 实测）

- 启动脚本：`/home/zhilongli/launch_qwen_4.sh`，实际执行的是
  `OSWorld-V2/scripts/python/run_multienv.py`：
  `--provider_name aliyun --model qwen3.7-plus --action_space pyautogui
  --observation_type screenshot --max_steps 500 --max_tokens 16384
  --sleep_after_execution 3.0 --test_all_meta_path meta_001_004.json
  --num_envs 4 --result_dir ./results_qwen`
- 集群 runner 已有能力：
  - Aliyun ECS 生命周期管理（`desktop_env/providers/aliyun/`，本机 OSWorld-V2 没有）
  - 每个 worker 复用 VM，任务失败后 `_discard_env()` 废弃旧 VM、下个任务重新创建
  - worker 进程死亡自动重启
  - `get_unfinished()` 跳过已有 `result.txt` 的任务，支持断点续跑
  - 结果布局 `result_dir/<action_space>/<observation_type>/<model>/<domain>/<task_id>`
  - 每任务结束 `mirror_task_dir()` 镜像到 OSS；启动时写 `args.json`
  - `shared_scores` 聚合，结束打印平均分
- 远程 `.env` 已配置：
  - `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`（MiniMax M3）
  - `OPENAI_BASE_URL=https://omni-gateway-sg.parametrix.cn/v1`（qwen3.7-plus）
- 远程已装 Node v22，但没有 pi-osworld / pi-osworld-v2 目录。

## 推荐架构：复用集群 runner，替换 agent 为 v2 桥

**方案 A（推荐）**：在 v2 里新增 `python/run_v2_cluster.py`，把集群
`run_multienv.py` 的调度骨架搬过来，只把 `PromptAgent` 换成
`PiOSWorldV2Agent`（JSONL bridge 到 v2 `serve`）。VM 复用、OSS、断点续跑、
worker 重启、args.json 全部保留。v2 不 fork OSWorld-V2，集群专用代码集中在
v2 的 `python/` 内，运行时 import 远端 OSWorld-V2 模块。

**方案 B（不推荐）**：把集群基建全部并入 `run_v2.py`。等于重写一遍
Aliyun/OSS/续跑/重启，改动面大，且把两套职责（本地实验 + 集群实验）耦合在一起。

## 改造清单

### Phase 0：前置条件

- [ ] 确认 parametrix 网关是否提供 Anthropic Messages 端点。
      若提供，YAML 里 `models.main: anthropic/qwen3.7-plus` 即可零代码接入；
      若不提供，需要给 v2 `src/models/client.ts` 增加 generic OpenAI 兼容
      provider（base URL + chat/completions）。
- [ ] 修复 `.env` 网关域名（session 中发现 `omni-gateway-sg.parametri.cn`
      已 NXDOMAIN，当前可用的是 `parametrix.cn/v1`），并确认 qwen 实验的
      `OPENAI_BASE_URL` / key。
- [ ] 部署：把 `pi-osworld-v2`（含 `dist/` 和 `python/`）复制到集群；
      `npm install && npm run build`。
- [ ] 部署实验配置树：`osworld-experiments` 的 YAML + `prompts/` +
      `task-sets/`，作为 `--config-root`。
- [ ] 对齐 OSWorld-V2：集群的 OSWorld-V2 带 aliyun provider / `oss_results.py`，
      与本机版本不同；部署时用集群版本，或把 aliyun provider 单独 vendor 进 v2。

### Phase 1：单任务冒烟

- [ ] `python/run_v2_cluster.py` 支持：
  - 读 v2 preset YAML（`models` / `termination` / `observation_capture`），
    同时保留 CLI 覆盖（`--model`、`--max-steps`、`--num-envs` 等）
  - 任务列表同时支持 `task-sets/*.yaml` 和集群 `test_all_meta.json`
    （如 `meta_001_004.json`，格式 `{domain: [task_id]}`）
  - agent 用 `PiOSWorldV2Agent(config_path, root, result_dir, episode_id)`
  - 单任务先在集群 Aliyun 上跑通 1 个 task，产物与本地 v2 run 结构一致
- [ ] 结果布局决策：集群保持
      `result_dir/<action_space>/<observation_type>/<model>/<domain>/<task_id>`，
      v2 的 `events.jsonl` / `state/` / `runner.log` 落在 task 目录下。

### Phase 2：并行 + 断点 + OSS

- [ ] worker 循环：`num_envs` 个进程 + 共享 task queue + `shared_scores`
- [ ] VM 复用与失败废弃（`_create_env` / `_discard_env`）
- [ ] `get_unfinished()`：跳过已有 `result.txt` 的任务
- [ ] `mirror_task_dir()`：每任务结束镜像到 OSS
- [ ] `args.json` 存档 + worker 死亡自动重启
- [ ] `--num-envs 4` 跑 `meta_001_004.json` 冒烟，与现有 qwen 流程对拍

### Phase 3：矩阵实验

- [ ] matrix 入口：`matrix.yaml` 或 CLI，组合 2+ 配置 × 2+ 任务集，
      每组合独立 run_id，避免结果目录互相覆盖
- [ ] 结果对比：score / success rate 聚合 + events 事件数 + delegate 次数
      + 轨迹形态，输出 markdown 对比报告
- [ ] 与 v1 基线做同配置对比，确认集群环境不改变 harness 语义

## 与本地 run_v2.py 的关系

- `run_v2.py`：本地单机/docker 调试与单任务复现，保持现状。
- `run_v2_cluster.py`：集群批处理入口，复用 `PiOSWorldV2Agent` 和同一套
  spec/prompts，只换 provider（aliyun）和调度层。
- 两个入口共享 `src/config`、`src/engine`、`python/pi_osworld_adapter*`，
  避免出现两套 harness 语义。

## 关键风险

1. 模型网关：qwen 走 parametrix OpenAI 端点，当前 pi provider 不支持，
   需要 Anthropic 兼容端点或新增 provider；这是 Phase 0 的阻塞项。
2. OSWorld-V2 版本漂移：集群版本含 aliyun / oss_results，部署时版本必须锁定。
3. VM 成本与配额：Aliyun 每任务建机很慢且可能撞配额，worker 复用 VM 是必须项。
4. prompt 路径：集群上 `--config-root` 必须指向部署的 osworld-experiments，
   且 v2 preset 的 prompt 路径与该目录保持一致。

## 验收标准

- [ ] Phase 1：集群 Aliyun 上单任务跑通，score 与本地同配置量级一致。
- [ ] Phase 2：4 env 并行跑完 meta_001_004，断点续跑、OSS 镜像、args.json 齐全。
- [ ] Phase 3：至少 2 配置 × 2 任务集的 matrix 一键跑完并输出对比报告。

## 决策点

1. 模型接入：Anthropic 兼容网关 vs 新增 OpenAI 兼容 provider。
2. OSWorld-V2 部署：直接使用集群版本 vs vendor aliyun provider 进 v2。
3. 结果目录：沿用集群布局 vs 保留 v2 `runs/<run_id>` 布局。
4. 是否把集群 runner 的调度层抽成 v2 通用 `ClusterRunner`，后续再接其他云。
