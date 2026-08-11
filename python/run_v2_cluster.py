"""Cluster runner for pi-osworld-v2 experiments.

The scheduling skeleton mirrors the colleague fork's
``scripts/python/run_multienv.py``: VM reuse, ``_discard_env`` on failure,
``get_unfinished`` resume, ``args.json`` archive and OSS mirroring. The agent is
replaced with :class:`PiOSWorldV2Agent`, which bridges each OSWorld step to the
v2 ``serve`` command, so the harness semantics stay entirely config-driven.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
from multiprocessing import Manager, Process, current_process
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Sequence, Tuple

_LEGACY_PYTHON_DIR = os.environ.get("PI_OSWORLD_PYTHON_DIR") or os.path.dirname(
    os.path.abspath(__file__)
)
if _LEGACY_PYTHON_DIR not in sys.path:
    sys.path.insert(0, _LEGACY_PYTHON_DIR)

from pi_osworld_logging import add_logging_args, attach_log_file, get_logger, setup_logging

active_environments: List[Any] = []
processes: List[Process] = []
is_terminating = False


def _normalize_task_id(task_id: str) -> str:
    return task_id[5:] if task_id.startswith("task_") else task_id


def _load_yaml(path: str) -> Dict[str, Any]:
    import yaml

    with open(path, "r", encoding="utf-8") as file_obj:
        return yaml.safe_load(file_obj)


def _load_task_set(config_root: str, ref: str) -> Dict[str, List[str]]:
    data = _load_yaml(str(Path(config_root) / ref))
    return {"tasks": [_normalize_task_id(str(task_id)) for task_id in data.get("tasks", [])]}


def _load_meta(path: str) -> Dict[str, List[str]]:
    with open(path, "r", encoding="utf-8") as file_obj:
        return json.load(file_obj)


def config(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run pi-osworld-v2 experiments on a cluster (Aliyun + OSS)"
    )
    parser.add_argument("--config", required=True, help="Experiment YAML path")
    parser.add_argument("--config-root", required=True, help="v2 config tree root")
    parser.add_argument("--result-dir", default="results", help="Cluster result root")
    parser.add_argument("--osworld-root", required=True, help="OSWorld-V2 repo root (fork)")
    parser.add_argument("--task-set", default=None, help="Task-set YAML under config-root")
    parser.add_argument("--test-all-meta-path", default=None, help="Cluster meta JSON path")
    parser.add_argument("--result-model", default=None, help="Model label used in result paths")
    parser.add_argument("--domain", default="all", help="Domain filter for meta JSON")
    parser.add_argument("--max-steps", type=int, default=None)
    parser.add_argument("--num-envs", type=int, default=1)

    parser.add_argument("--provider-name", default="aliyun", choices=["aws", "virtualbox", "vmware", "docker", "azure", "aliyun", "volcengine"])
    parser.add_argument("--region", default="cn-heyuan")
    parser.add_argument("--path-to-vm", default=None)
    parser.add_argument("--headless", dest="headless", action="store_true", default=True)
    parser.add_argument("--no-headless", dest="headless", action="store_false")
    parser.add_argument("--screen-width", type=int, default=1920)
    parser.add_argument("--screen-height", type=int, default=1080)
    parser.add_argument("--client-password", default="")
    parser.add_argument("--snapshot-name", default="init_state")
    parser.add_argument("--os-type", default="Ubuntu")
    parser.add_argument("--use-public-ip", action="store_true")
    parser.add_argument("--enable-vnc", action="store_true")
    parser.add_argument("--enable-recording", action="store_true")
    parser.add_argument("--action-space", default="pyautogui")
    parser.add_argument("--observation-type", default="screenshot", choices=["screenshot", "a11y_tree", "screenshot_a11y_tree", "som"])
    parser.add_argument("--sleep-after-execution", type=float, default=3.0)
    parser.add_argument("--test-config-base-dir", default="evaluation_examples")
    parser.add_argument("--eval-version", default="v2", choices=["v1", "v2", "windows"])
    add_logging_args(parser)
    return parser.parse_args(list(argv) if argv is not None else None)


def build_run_args(
    args: argparse.Namespace, experiment: Dict[str, Any], config_root: str
) -> SimpleNamespace:
    termination = experiment.get("termination", {}) or {}
    runtime = experiment.get("runtime", {}) or {}
    observation_capture = experiment.get("observation_capture", {}) or {}
    max_steps = args.max_steps or int(termination.get("max_steps", 100))
    num_envs = max(1, args.num_envs or int(runtime.get("num_envs", 1)))
    result_model = args.result_model or experiment.get("experiment", "v2")
    return SimpleNamespace(
        result_dir=os.path.abspath(args.result_dir),
        config_path=os.path.abspath(args.config),
        config_root=os.path.abspath(config_root),
        osworld_root=os.path.abspath(args.osworld_root),
        action_space=args.action_space,
        observation_type=args.observation_type,
        result_model=result_model,
        provider_name=args.provider_name,
        region=args.region,
        path_to_vm=args.path_to_vm,
        headless=args.headless,
        screen_width=args.screen_width,
        screen_height=args.screen_height,
        client_password=args.client_password,
        snapshot_name=args.snapshot_name,
        os_type=args.os_type,
        use_public_ip=args.use_public_ip,
        enable_vnc=args.enable_vnc,
        enable_recording=args.enable_recording,
        sleep_after_execution=args.sleep_after_execution,
        max_steps=max_steps,
        num_envs=num_envs,
        require_a11y_tree=bool(observation_capture.get("require_a11y_tree", False)),
        require_terminal=bool(observation_capture.get("require_terminal", False)),
        test_config_base_dir=args.test_config_base_dir,
        eval_version=args.eval_version,
        log_level=args.log_level,
        log_file=args.log_file,
        force_color=args.force_color,
    )


def _example_result_dir(run_args: SimpleNamespace, domain: str, example_id: str) -> str:
    return os.path.join(
        run_args.result_dir,
        run_args.action_space,
        run_args.observation_type,
        run_args.result_model,
        domain,
        example_id,
    )


def run_env_tasks(
    task_queue: Any,
    run_args: SimpleNamespace,
    shared_scores: List[Any],
) -> None:
    logger = get_logger()
    from desktop_env.desktop_env import DesktopEnv
    from lib_run_single import run_single_example
    from oss_results import mirror_task_dir, set_result_root
    from pi_osworld_adapter_v2 import PiOSWorldV2Agent
    from task_loader import load_task_config, resolve_task_json_path

    set_result_root(run_args.result_dir)
    env: Optional[DesktopEnv] = None

    def _create_env() -> DesktopEnv:
        nonlocal env
        env = DesktopEnv(
            path_to_vm=run_args.path_to_vm,
            action_space=run_args.action_space,
            provider_name=run_args.provider_name,
            region=run_args.region,
            snapshot_name=run_args.snapshot_name,
            screen_size=(run_args.screen_width, run_args.screen_height),
            headless=run_args.headless,
            os_type=run_args.os_type,
            require_a11y_tree=run_args.require_a11y_tree,
            require_terminal=run_args.require_terminal,
            enable_proxy=True,
            client_password=run_args.client_password,
            use_public_ip=run_args.use_public_ip,
            force_disable_vnc=not run_args.enable_vnc,
            force_disable_recording=not run_args.enable_recording,
        )
        active_environments.append(env)
        return env

    def _discard_env(reason: str) -> None:
        nonlocal env
        if env is None:
            return
        logger.warning("[%s] discarding VM: %s", current_process().name, reason)
        try:
            env.close()
            logger.info("[%s] discarded VM closed", current_process().name)
        except Exception as close_error:  # noqa: BLE001 - TTL is the fallback
            logger.error("failed to close discarded VM (TTL will clean up): %s", close_error)
        try:
            active_environments.remove(env)
        except ValueError:
            pass
        env = None

    _create_env()
    logger.info("[%s] worker started", current_process().name)
    while True:
        try:
            domain, example_id = task_queue.get(timeout=5)
        except Exception:
            break
        try:
            if env is None:
                logger.info("[%s] recreating VM after failure", current_process().name)
                _create_env()
            config_file = resolve_task_json_path(
                task_id=example_id,
                base_dir=run_args.test_config_base_dir,
                domain=domain,
                eval_version=run_args.eval_version,
            )
            example = load_task_config(
                config_file,
                task_id=example_id,
                base_dir=run_args.test_config_base_dir,
                domain=domain,
                eval_version=run_args.eval_version,
            )
            instruction = example["instruction"]
            example_result_dir = _example_result_dir(run_args, domain, example_id)
            os.makedirs(example_result_dir, exist_ok=True)
            logger.info(
                "[%s] starting %s/%s -> %s",
                current_process().name,
                domain,
                example_id,
                example_result_dir,
            )
            agent = PiOSWorldV2Agent(
                config_path=run_args.config_path,
                root=run_args.config_root,
                result_dir=example_result_dir,
                episode_id=f"task-{example_id}",
            )
            agent.attach_env(env)
            try:
                run_single_example(
                    agent,
                    env,
                    example,
                    run_args.max_steps,
                    instruction,
                    run_args,
                    example_result_dir,
                    shared_scores,
                )
            except Exception as exc:  # noqa: BLE001 - one task must not kill the worker
                import traceback

                logger.error(
                    "[%s] task %s/%s failed: %s",
                    current_process().name,
                    domain,
                    example_id,
                    exc,
                )
                logger.error(traceback.format_exc())
                try:
                    env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))
                except Exception:  # noqa: BLE001 - recording is best effort
                    pass
                with open(os.path.join(example_result_dir, "traj.jsonl"), "a", encoding="utf-8") as file_obj:
                    file_obj.write(json.dumps({"Error": f"{domain}/{example_id} - {exc}"}, ensure_ascii=False) + "\n")
                _discard_env(f"{domain}/{example_id} execution failed")
            finally:
                try:
                    agent.close()
                except Exception:  # noqa: BLE001 - teardown must not mask real errors
                    pass
                mirror_task_dir(example_result_dir)
        except Exception as exc:  # noqa: BLE001 - task-level error
            logger.error("[%s] task-level error: %s", current_process().name, exc)
            import traceback

            logger.error(traceback.format_exc())
            _discard_env(f"{domain}/{example_id} task-level error")
    logger.info("[%s] queue drained", current_process().name)
    try:
        if env is not None:
            env.close()
    except Exception as exc:  # noqa: BLE001 - teardown
        logger.error("failed to close env: %s", exc)


def signal_handler(signum: int, frame: Any) -> None:
    global is_terminating
    if is_terminating:
        return
    is_terminating = True
    logger = get_logger()
    logger.info("received %s; shutting down", signum)
    for env in active_environments:
        try:
            env.close()
        except Exception:  # noqa: BLE001
            pass
    for proc in processes:
        if proc.is_alive():
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001
                pass
    time.sleep(1)
    for proc in processes:
        if proc.is_alive():
            try:
                os.kill(proc.pid, signal.SIGKILL)
            except Exception:  # noqa: BLE001
                pass
    sys.exit(0)


def distribute_tasks(test_all_meta: Dict[str, List[str]]) -> List[Tuple[str, str]]:
    tasks: List[Tuple[str, str]] = []
    for domain, examples in test_all_meta.items():
        for example_id in examples:
            tasks.append((domain, _normalize_task_id(str(example_id))))
    return tasks


def get_unfinished(
    run_args: SimpleNamespace, total_file_json: Dict[str, List[str]]
) -> Dict[str, List[str]]:
    target_dir = os.path.join(
        run_args.result_dir,
        run_args.action_space,
        run_args.observation_type,
        run_args.result_model,
    )
    if not os.path.exists(target_dir):
        return total_file_json

    finished: Dict[str, List[str]] = {}
    for domain in os.listdir(target_dir):
        domain_path = os.path.join(target_dir, domain)
        if not os.path.isdir(domain_path):
            continue
        finished[domain] = []
        for example_id in os.listdir(domain_path):
            example_path = os.path.join(domain_path, example_id)
            if not os.path.isdir(example_path):
                continue
            if os.path.exists(os.path.join(example_path, "result.txt")):
                finished[domain].append(example_id)
                continue
            for item in os.listdir(example_path):
                item_path = os.path.join(example_path, item)
                try:
                    if os.path.isdir(item_path):
                        import shutil

                        shutil.rmtree(item_path)
                    else:
                        os.remove(item_path)
                except Exception:  # noqa: BLE001 - stale cleanup is best effort
                    pass

    if not finished:
        return total_file_json

    remaining: Dict[str, List[str]] = {}
    for domain, examples in total_file_json.items():
        done_ids = set(finished.get(domain, []))
        left = [example_id for example_id in examples if example_id not in done_ids]
        if left:
            remaining[domain] = left
    return remaining


def run_batch(run_args: SimpleNamespace, test_all_meta: Dict[str, List[str]]) -> None:
    global processes
    logger = get_logger()
    all_tasks = distribute_tasks(test_all_meta)
    logger.info("total tasks: %d", len(all_tasks))
    with Manager() as manager:
        shared_scores = manager.list()
        task_queue = manager.Queue()
        for task in all_tasks:
            task_queue.put(task)
        processes = []
        for index in range(run_args.num_envs):
            proc = Process(
                target=run_env_tasks,
                args=(task_queue, run_args, shared_scores),
                name=f"EnvProcess-{index + 1}",
            )
            proc.daemon = True
            proc.start()
            processes.append(proc)
            logger.info("started %s pid=%s", proc.name, proc.pid)
        try:
            while True:
                alive_count = 0
                for index, proc in enumerate(processes):
                    if not proc.is_alive():
                        logger.warning("%s died; restarting", proc.name)
                        new_proc = Process(
                            target=run_env_tasks,
                            args=(task_queue, run_args, shared_scores),
                            name=f"EnvProcess-Restart-{index + 1}",
                        )
                        new_proc.daemon = True
                        new_proc.start()
                        processes[index] = new_proc
                        logger.info("restarted %s pid=%s", new_proc.name, new_proc.pid)
                    else:
                        alive_count += 1
                if task_queue.empty():
                    logger.info("all tasks queued; waiting for workers")
                    break
                if alive_count == 0:
                    logger.error("all workers died; aborting")
                    break
                time.sleep(5)
            for proc in processes:
                proc.join()
        except KeyboardInterrupt:
            raise
        scores = list(shared_scores)
    logger.info("average score: %s", (sum(scores) / len(scores)) if scores else 0)


def main(argv: Optional[Sequence[str]] = None) -> int:
    global processes
    args = config(argv)
    logger = setup_logging(
        args.log_level,
        log_file=args.log_file,
        force_color=args.force_color,
    )

    osworld_root = os.path.abspath(args.osworld_root)
    sys.path.insert(0, osworld_root)
    sys.path.insert(0, os.path.join(osworld_root, "scripts", "python"))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    from dotenv import load_dotenv, dotenv_values

    v2_root = Path(__file__).resolve().parent.parent
    load_dotenv(v2_root / ".env")
    for key, value in dotenv_values(os.path.join(osworld_root, ".env")).items():
        if value and not os.environ.get(key):
            os.environ[key] = value

    os.chdir(osworld_root)
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    experiment = _load_yaml(args.config)
    run_args = build_run_args(args, experiment, args.config_root)
    if args.test_all_meta_path:
        test_all_meta = _load_meta(args.test_all_meta_path)
    else:
        task_set_ref = args.task_set or experiment.get("task_set")
        if not task_set_ref:
            raise RuntimeError("experiment YAML has no task_set and --task-set was not given")
        test_all_meta = _load_task_set(args.config_root, task_set_ref)
    if args.domain != "all":
        test_all_meta = {args.domain: test_all_meta.get(args.domain, [])}

    args_dir = os.path.join(
        run_args.result_dir,
        run_args.action_space,
        run_args.observation_type,
        run_args.result_model,
    )
    os.makedirs(args_dir, exist_ok=True)
    with open(os.path.join(args_dir, "args.json"), "w", encoding="utf-8") as file_obj:
        json.dump(vars(args), file_obj, indent=2, ensure_ascii=False, default=str)

    left = get_unfinished(run_args, test_all_meta)
    left_info = "".join(f"{domain}: {len(examples)}\n" for domain, examples in left.items())
    logger.info("left tasks:\n%s", left_info)

    manifest = {
        "experiment": experiment.get("experiment"),
        "task_set": args.task_set or experiment.get("task_set"),
        "result_model": run_args.result_model,
        "tasks": distribute_tasks(test_all_meta),
        "max_steps": run_args.max_steps,
        "num_envs": run_args.num_envs,
        "provider_name": run_args.provider_name,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    manifest_path = os.path.join(args_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as file_obj:
        json.dump(manifest, file_obj, indent=2, ensure_ascii=False)

    run_batch(run_args, left)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
