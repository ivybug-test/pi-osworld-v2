# 主控机同步 + 冒烟 Runbook（踩坑记录）

> 主控机：`root@47.120.53.174`（密码登录，sshpass）。实验用户 `zhilongli`。
> v2 部署：`/home/zhilongli/pi-osworld-v2`；OSWorld fork：`/home/zhilongli/OSWorld-V2`（分支 `dev/zhilongli`）。
> 实验必须用 git 同步（先本地 commit，再主控机拉），**不要在主控机手改代码**。

## 坑 1：logs 目录权限导致冒烟启动即失败（2026-08-12 踩到）

- 现象：`su zhilongli -c '... > .../logs/audit_smoke.out'` 报 `Permission denied`，runner 没起来。
- 原因：用 `root` 先 `mkdir -p /home/zhilongli/pi-osworld-v2/logs`，目录属主是 root，zhilongli 无写权限。
- 修复：`chown -R zhilongli:zhilongli /home/zhilongli/pi-osworld-v2/logs` 后再以 zhilongli 启动。
- 避免：在主控机以 root 创建/操作目录后，**先 chown 给 zhilongli，再 `su zhilongli` 跑实验**；log 重定向、结果目录同理。

## 坑 2：多步初始化脚本里 set -e 会跳过 chown

- 现象：`git remote add origin` 报 "origin already exists"（clone bundle 已自动建了 origin），脚本 `set -e` 直接退出，
  后面的 `chown -R zhilongli:zhilongli` 没执行；随后 `su zhilongli && npm run build` 报 `EACCES` 写不进 dist。
- 避免：clone 后立刻 `chown -R zhilongli:zhilongli <repo>`；多步脚本别盲目 `set -e`，或每步独立确认。

## 坑 3：adapter 默认找 `dist/cli.js`，重构后入口是 `dist/cli/index.js`

- 现象：`python/pi_osworld_adapter_v2.py` 的 `_default_command()` 用 `node dist/cli.js serve`；G1 重构后
  tsconfig 产出 `dist/cli/index.js`，不 build 或按旧路径启动会找不到入口。
- 修复/避免：clone 后必须 `npm run build`；启动实验时显式传
  `PI_OSWORLD_V2_CLI="node /home/zhilongli/pi-osworld-v2/dist/cli/index.js"`（adapter 支持该环境变量覆盖）。

## 坑 4：git bundle clone 后 HEAD 未检出、origin 指向 bundle

- 现象：`git clone /tmp/xxx.bundle` 警告 "remote HEAD refers to nonexistent ref"，工作区为空；
  `git remote add origin <github>` 报已存在（origin 自动指向 bundle 文件）。
- 修复：clone 后 `git checkout main`（或 `git checkout -b main refs/heads/main`），再
  `git remote set-url origin https://github.com/ivybug-test/pi-osworld-v2.git`。
- 备注：本地当前没有 github 写凭据（无 gh/token/ssh key），push 不可用；用 bundle 中转后，
  主控机 `git fetch <bundle> main && git merge FETCH_HEAD` 即可增量拉取。

## 坑 5：v2 任务文件在 `task_class/task_*.py`，json 缺失不是阻塞

- 现象：`evaluation_examples/examples/examples_v2_backup/*.json` 已被 fork commit `c971df5`
  （"Remove evaluation backups"）删除，`resolve_task_json_path` 返回的 canonical 路径不存在。
- 结论：`task_loader.load_task_config(..., prefer_class=True)` 默认走
  `evaluation_examples/task_class/task_001.py`，任务照常加载，不需要 json。
- 避免：看到任务 json 缺失不要慌，先确认 `task_class/task_<id>.py` 存在。

## 坑 6：task-set 的任务 id 必须写成 `task_NNN` 字符串

- 现象：冒烟在 `load_task_config` 报
  `FileNotFoundError: .../examples_v2_backup/1.json`，且 VM 被 discard。
- 原因：`task-sets/smoke-001.yaml` 里裸写 `- 001`，YAML 解析成整数 `1`，
  `str(1)="1"` 丢了前导零，任务文件找不到（还白创建了一台 ECS）。
- 修复：照官方 `task-sets/smoke.yaml` 的写法用 `- task_001`（字符串），
  `run_v2_cluster._normalize_task_id` 会去掉前缀得到 `001`。
- 避免：task-set 一律写 `task_<id>` 字符串，不要写裸数字。

## 冒烟启动模板（1 env，max_steps 调小）

```bash
chown -R zhilongli:zhilongli /home/zhilongli/pi-osworld-v2/logs
su zhilongli -c 'cd /home/zhilongli/OSWorld-V2 && \
  PI_OSWORLD_V2_CLI="node /home/zhilongli/pi-osworld-v2/dist/cli/index.js" \
  setsid nohup /home/zhilongli/OSWorld-V2/.venv/bin/python \
    /home/zhilongli/pi-osworld-v2/python/run_v2_cluster.py \
    --config /home/zhilongli/pi-osworld-v2/presets/stateact-qwen-audit-smoke.yaml \
    --config-root /home/zhilongli/pi-osworld-v2 \
    --osworld-root /home/zhilongli/OSWorld-V2 \
    --task-set task-sets/smoke-001.yaml \
    --max-steps 30 --num-envs 1 \
    --result-dir /home/zhilongli/results_v2_audit_smoke \
    --result-model stateact-qwen-audit-smoke \
    --provider-name aliyun --action-space pyautogui --observation-type screenshot \
    --sleep-after-execution 1.0 \
    --log-file /home/zhilongli/pi-osworld-v2/logs/audit_smoke.log \
    > /home/zhilongli/pi-osworld-v2/logs/audit_smoke.out 2>&1 < /dev/null &'
```
