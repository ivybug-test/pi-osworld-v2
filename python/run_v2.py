"""Minimal single-environment OSWorld runner for pi-osworld-v2.

与旧 run_multienv_pi.py 同构：复用官方 DesktopEnv / lib_run_single / evaluator，
但桥接的是 v2 `serve`（JSONL bridge），并给每个任务传真实 episodeId。
"""

from __future__ import annotations

import argparse
import os
import sys

# 自包含：本仓库 python 工具（pi_osworld_adapter / pi_osworld_logging）
_LEGACY_PYTHON_DIR = os.environ.get("PI_OSWORLD_PYTHON_DIR") or os.path.dirname(os.path.abspath(__file__))
if _LEGACY_PYTHON_DIR not in sys.path:
    sys.path.insert(0, _LEGACY_PYTHON_DIR)

import argparse
import queue
import datetime
import json
import os
import signal
import sys
import time
from multiprocessing import Manager, Process, current_process
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

from pi_osworld_logging import add_logging_args, attach_log_file, get_logger, setup_logging


def _normalize_task_id(task_id: str) -> str:
    return task_id[5:] if task_id.startswith("task_") else task_id


def _load_experiment(config_path: str, config_root: str) -> Dict[str, Any]:
    import yaml

    with open(config_path, "r", encoding="utf-8") as file_obj:
        return yaml.safe_load(file_obj)


def _load_tasks(config_root: str, task_set_ref: str) -> List[str]:
    import yaml

    task_set_path = Path(config_root) / task_set_ref
    with open(task_set_path, "r", encoding="utf-8") as file_obj:
        data = yaml.safe_load(file_obj)
    return [_normalize_task_id(str(task_id)) for task_id in data["tasks"]]


def _build_args(args: argparse.Namespace) -> SimpleNamespace:
    return SimpleNamespace(
        sleep_after_execution=args.sleep_after_execution,
        checkpoint_eval_mode=getattr(args, "checkpoint_eval_mode", "off"),
        checkpoint_steps=getattr(args, "checkpoint_steps", ""),
        save_model_eval_raw_info=getattr(args, "save_model_eval_raw_info", False),
        result_dir=args.result_dir,
        trace_guest=False,
        guest_trace_top_n=30,
        guest_trace_timeout=15,
        provider_name=args.provider_name,
        path_to_vm=args.path_to_vm,
        headless=args.headless,
        screen_width=args.screen_width,
        screen_height=args.screen_height,
        client_password=args.client_password,
        snapshot_name=args.snapshot_name,
        os_type=args.os_type,
    )


def _run_one_task(
    task_id: str,
    run_args: SimpleNamespace,
    shared_scores: List[Any],
    topology: str,
    require_a11y_tree: bool,
    require_terminal: bool,
    max_steps: int,
    osworld_root: str,
    config_path: str,
    config_root: str,
    test_config_base_dir: str,
    eval_version: str,
    run_id: str,
) -> None:
    """Run one task in a worker process with its own VM and v2 serve bridge."""
    from desktop_env.desktop_env import DesktopEnv
    from lib_run_single import run_single_example
    from pi_osworld_adapter_v2 import PiOSWorldV2Agent
    from task_loader import load_task_config, resolve_task_json_path

    logger = get_logger()
    example_dir = os.path.join(run_args.result_dir, topology, task_id)
    os.makedirs(example_dir, exist_ok=True)
    agent = None
    env = None
    try:
        config_file = resolve_task_json_path(
            task_id=task_id,
            base_dir=test_config_base_dir,
            eval_version=eval_version,
        )
        example = load_task_config(
            config_file,
            task_id=task_id,
            base_dir=test_config_base_dir,
            eval_version=eval_version,
        )
        logger.info(
            "[%s] starting task %s -> %s",
            current_process().name,
            task_id,
            example_dir,
        )
        agent = PiOSWorldV2Agent(
            config_path=os.path.abspath(config_path),
            root=config_root,
            result_dir=run_args.result_dir,
            episode_id=f"task-{task_id}",
        )
        env = DesktopEnv(
            path_to_vm=run_args.path_to_vm
            or str(Path(osworld_root) / "docker_vm_data" / "osworld-v2-ubuntu-x86.qcow2"),
            action_space="pyautogui",
            provider_name=run_args.provider_name,
            snapshot_name=run_args.snapshot_name,
            screen_size=(run_args.screen_width, run_args.screen_height),
            headless=run_args.headless,
            os_type=run_args.os_type,
            require_a11y_tree=require_a11y_tree,
            require_terminal=require_terminal,
            enable_proxy=True,
            client_password=run_args.client_password,
            force_disable_vnc=True,
            force_disable_recording=True,
        )
        agent.attach_env(env)
        _record_owned_container(env, run_id, logger)
        logger.info(
            "[%s] running task %s with max_steps=%s",
            current_process().name,
            task_id,
            max_steps,
        )
        run_single_example(
            agent,
            env,
            example,
            max_steps,
            example["instruction"],
            run_args,
            example_dir,
            shared_scores,
        )
        logger.info("[%s] task %s finished", current_process().name, task_id)
    except Exception as exc:  # noqa: BLE001 - one task must not kill the worker
        logger.exception("[%s] task %s failed: %s", current_process().name, task_id, exc)
    finally:
        if env is not None:
            try:
                env.close()
                logger.info("[%s] environment closed", current_process().name)
            except Exception as exc:  # noqa: BLE001 - teardown must not mask real errors
                logger.warning("failed to close environment: %s", exc)
        if agent is not None:
            try:
                agent.close()
            except Exception as exc:  # noqa: BLE001 - teardown must not mask real errors
                logger.warning("failed to stop pi-osworld bridge: %s", exc)


def _run_env_tasks(
    task_queue: Any,
    run_args: SimpleNamespace,
    shared_scores: List[Any],
    topology: str,
    require_a11y_tree: bool,
    require_terminal: bool,
    max_steps: int,
    osworld_root: str,
    config_path: str,
    config_root: str,
    test_config_base_dir: str,
    eval_version: str,
    run_id: str,
) -> None:
    """Worker loop: pull task ids from the shared queue until it drains."""
    logger = get_logger()
    logger.info("%s started.", current_process().name)
    while True:
        try:
            task_id = task_queue.get(timeout=5)
        except queue.Empty:
            break
        _run_one_task(
            task_id,
            run_args,
            shared_scores,
            topology,
            require_a11y_tree,
            require_terminal,
            max_steps,
            osworld_root,
            config_path,
            config_root,
            test_config_base_dir,
            eval_version,
            run_id,
        )
    logger.info("%s finished its queue.", current_process().name)


_CONTAINER_STATE_PATH = os.path.join(
    os.path.expanduser("~"), ".cache", "pi-osworld-v2", "owned-containers.json"
)


def _owned_container_names() -> set:
    """Names of every container previously recorded by a pi-osworld-v2 run."""
    state_path = Path(_CONTAINER_STATE_PATH)
    if not state_path.exists():
        return set()
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - corrupted state must not block a run
        return set()
    names = set()
    for run_names in state.values():
        names.update(run_names)
    return names


def _prune_owned_state(client: Any) -> None:
    """Drop container names that no longer exist from the ownership file."""
    state_path = Path(_CONTAINER_STATE_PATH)
    if not state_path.exists():
        return
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        alive = {c.name for c in client.containers.list(all=True)}
        for run_id in list(state):
            state[run_id] = [n for n in state[run_id] if n in alive]
            if not state[run_id]:
                del state[run_id]
        state_path.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001 - pruning is best effort
        pass




def _active_experiment_runners(logger: Any) -> List[int]:
    """PIDs of other live experiment runner processes.

    Matches v2 runners (python *run_v2.py*) and legacy v1 runners
    (node *cli.js run*) only, so shell/screen wrappers never count.
    Our own process and its ancestors are excluded.
    """
    import subprocess

    try:
        output = subprocess.run(
            ["ps", "-eo", "pid=,ppid=,comm=,args="],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
    except Exception as exc:  # noqa: BLE001 - best effort scan
        logger.warning("could not scan for parallel runners: %s", exc)
        return []

    def _is_runner(comm: str, args: str) -> bool:
        if comm.startswith("python"):
            return "run_v2.py" in args
        if comm.startswith("node"):
            return "cli.js run" in args
        return False

    me = os.getpid()
    ancestors: set[int] = set()
    seen: set[int] = set()
    ppid = os.getppid()
    while ppid > 1 and ppid not in seen:
        seen.add(ppid)
        ancestors.add(ppid)
        try:
            with open(f"/proc/{ppid}/stat", encoding="utf-8") as stat_file:
                rest = stat_file.read().rsplit(")", 1)[1].split()
            ppid = int(rest[1])
        except Exception:  # noqa: BLE001 - ancestor chain walk is best effort
            break

    runners: List[int] = []
    for line in output.splitlines():
        fields = line.split(None, 3)
        if len(fields) < 4:
            continue
        pid_str, _, comm, args = fields
        try:
            pid = int(pid_str)
        except ValueError:
            continue
        if pid == me or pid in ancestors:
            continue
        if _is_runner(comm, args):
            runners.append(pid)
    return runners


def _clean_stale_containers(provider_name: str, mode: str, logger: Any) -> None:
    """Remove orphaned OSWorld Docker VMs left by interrupted earlier runs.

    mode="tagged" (default): only containers previously recorded by a
    pi-osworld-v2 run (owned-containers.json) are removed, so parallel legacy
    (v1) runs or unrelated osworld VMs are never touched. mode="all": legacy
    full cleanup of every osworld-docker container. mode="off": no cleanup.
    In every mode the cleanup is skipped while another experiment runner
    process is alive, to never delete a VM in active use.
    """
    if provider_name != "docker" or mode == "off":
        return
    try:
        import docker

        client = docker.from_env()
        candidates = [
            container
            for container in client.containers.list(all=True)
            if any("osworld-docker" in tag for tag in container.image.tags)
        ]
        if not candidates:
            return
        runners = _active_experiment_runners(logger)
        if runners:
            logger.warning(
                "skipping stale container cleanup: active experiment runner(s) %s",
                runners,
            )
            return
        owned = _owned_container_names()
        removed_any = False
        for container in candidates:
            if mode == "tagged" and container.name not in owned:
                continue
            removed_any = True
            logger.info(
                "removing stale osworld container %s (status=%s)",
                container.name,
                container.status,
            )
            try:
                container.remove(force=True)
            except Exception as exc:  # noqa: BLE001 - best effort cleanup
                logger.warning("failed to remove container %s: %s", container.name, exc)
        if mode == "tagged" and removed_any:
            _prune_owned_state(client)
    except Exception as exc:  # noqa: BLE001 - cleanup must never block a run
        logger.warning("stale container cleanup skipped: %s", exc)




def _record_owned_container(env: Any, run_id: str, logger: Any) -> None:
    """Record the docker container backing ``env`` as owned by this run.

    Safe cleanup later only deletes containers listed here, so parallel
    legacy (v1) runs and unrelated VMs are never touched.
    """
    provider = getattr(env, "provider", None)
    container = getattr(provider, "container", None)
    if container is None:
        return
    try:
        name = container.name
        state_path = Path(_CONTAINER_STATE_PATH)
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state = {}
        if state_path.exists():
            state = json.loads(state_path.read_text(encoding="utf-8"))
        state.setdefault(run_id, [])
        if name not in state[run_id]:
            state[run_id].append(name)
        state_path.write_text(
            json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        logger.info("recorded osworld container %s for run %s", name, run_id)
    except Exception as exc:  # noqa: BLE001 - recording is best effort
        logger.warning("failed to record container: %s", exc)


def _raise_keyboard_interrupt(signum: int, frame: Any) -> None:
    raise KeyboardInterrupt


def main() -> None:
    parser = argparse.ArgumentParser(description="Run pi-osworld experiments on OSWorld-V2")
    parser.add_argument("--config", required=True, help="Experiment YAML path")
    parser.add_argument("--config-root", required=True, help="osworld-experiments root")
    parser.add_argument("--result-dir", default="runs", help="Result output directory")
    parser.add_argument("--osworld-root", default="/home/binqiu/OSWorld-V2")
    parser.add_argument("--provider-name", default="docker", choices=["aws", "virtualbox", "vmware", "docker", "azure"])
    parser.add_argument("--path-to-vm", default=None)
    parser.add_argument("--headless", dest="headless", action="store_true", default=True)
    parser.add_argument("--no-headless", dest="headless", action="store_false")
    parser.add_argument("--screen-width", type=int, default=1920)
    parser.add_argument("--screen-height", type=int, default=1080)
    parser.add_argument("--client-password", default="")
    parser.add_argument("--snapshot-name", default="init_state")
    parser.add_argument("--os-type", default="Ubuntu")
    parser.add_argument("--sleep-after-execution", type=float, default=3.0)
    parser.add_argument("--max-steps", type=int, default=None, help="Override termination.max_steps from the experiment YAML")
    parser.add_argument("--num-envs", type=int, default=None, help="Number of parallel VM environments (default: runtime.num_envs in YAML, then 1)")
    parser.add_argument("--env-start-delay", type=float, default=1.0, help="Seconds to stagger worker startup")
    parser.add_argument(
        "--checkpoint-eval-mode",
        choices=["off", "inline"],
        default=None,
        help="Override termination.checkpoint_eval_mode from the experiment YAML",
    )
    parser.add_argument(
        "--checkpoint-steps",
        type=str,
        default=None,
        help="Comma-separated logical steps for inline checkpoint evals, e.g. 150,300",
    )
    parser.add_argument(
        "--clean-stale-containers",
        dest="clean_stale_containers",
        choices=["tagged", "all", "off"],
        default="tagged",
        help=(
            "Stale osworld container cleanup before starting: "
            "'tagged' (default) removes only containers recorded by a previous "
            "pi-osworld-v2 run (safe for parallel legacy v1 runs); "
            "'all' removes every osworld-docker VM; 'off' keeps all. "
            "Cleanup is always skipped while another experiment runner is alive."
        ),
    )
    parser.add_argument(
        "--no-clean-stale-containers",
        dest="clean_stale_containers",
        action="store_const",
        const="off",
        help="Keep all existing OSWorld Docker containers (same as --clean-stale-containers off)",
    )
    parser.add_argument("--test-config-base-dir", default="evaluation_examples")
    parser.add_argument("--eval-version", default="v2", choices=["v1", "v2", "windows"])
    add_logging_args(parser)
    args = parser.parse_args()

    logger = setup_logging(
        args.log_level,
        log_file=args.log_file,
        force_color=args.force_color,
    )

    osworld_root = Path(args.osworld_root).resolve()
    sys.path.insert(0, str(osworld_root))
    sys.path.insert(0, str(osworld_root / "scripts" / "python"))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    os.environ.setdefault(
        "OSWORLD_DOCKER_PORT_LOCK",
        os.path.join(os.path.expanduser("~"), ".cache", "osworld", "docker_port_allocation.lck"),
    )

    from dotenv import load_dotenv

    load_dotenv(osworld_root / ".env")

    # Official task configs, proxy settings and cache paths are relative to the
    # OSWorld-V2 repository root, and some modules load them at import time,
    # so switch cwd before importing desktop_env / lib_run_single.
    os.chdir(osworld_root)

    if args.clean_stale_containers:
        _clean_stale_containers(args.provider_name, args.clean_stale_containers, logger)
    signal.signal(signal.SIGTERM, _raise_keyboard_interrupt)

    experiment = _load_experiment(args.config, args.config_root)
    task_ids = _load_tasks(args.config_root, experiment["task_set"])
    # v2 spec 没有 topology 字段；用 loop.driver 作为目录名标识
    topology = (experiment.get("loop") or {}).get("driver", "self_report")
    logger.info(
        "experiment=%s topology=%s tasks=%s",
        experiment.get("experiment"),
        topology,
        task_ids,
    )
    observation_capture = experiment.get("observation_capture", {})
    require_a11y_tree = bool(observation_capture.get("require_a11y_tree", False))
    require_terminal = bool(observation_capture.get("require_terminal", False))
    max_steps = args.max_steps or int(experiment.get("termination", {}).get("max_steps", 100))
    termination = experiment.get("termination", {})
    args.checkpoint_eval_mode = args.checkpoint_eval_mode or termination.get(
        "checkpoint_eval_mode", "off"
    )
    if args.checkpoint_steps is None:
        configured_steps = termination.get("checkpoint_steps")
        if isinstance(configured_steps, list):
            args.checkpoint_steps = ",".join(str(step) for step in configured_steps)
        else:
            args.checkpoint_steps = str(configured_steps or "")
    runtime_config = experiment.get("runtime", {}) or {}
    num_envs = args.num_envs or int(runtime_config.get("num_envs", 1))
    num_envs = max(1, num_envs)
    env_start_delay = max(0.0, float(args.env_start_delay))
    run_id = (
        f"{datetime.datetime.now():%Y%m%dT%H%M%S}-"
        f"{experiment['experiment']}-{topology}"
    )
    run_dir = os.path.join(args.result_dir, run_id)
    os.makedirs(run_dir, exist_ok=True)
    attach_log_file(os.path.join(run_dir, "runner.log"))
    logger.info(
        "run_dir=%s max_steps=%s num_envs=%s checkpoint=%s/%s",
        run_dir,
        max_steps,
        num_envs,
        args.checkpoint_eval_mode,
        args.checkpoint_steps,
    )
    args.result_dir = run_dir
    run_args = _build_args(args)

    try:
        if num_envs == 1:
            scores: List[Any] = []
            for task_id in task_ids:
                _run_one_task(
                    task_id,
                    run_args,
                    scores,
                    topology,
                    require_a11y_tree,
                    require_terminal,
                    max_steps,
                    str(osworld_root),
                    os.path.abspath(args.config),
                    args.config_root,
                    args.test_config_base_dir,
                    args.eval_version,
                    run_id,
                )
            return

        with Manager() as manager:
            shared_scores = manager.list()
            task_queue = manager.Queue()
            for task_id in task_ids:
                task_queue.put(task_id)
            processes = []
            for index in range(num_envs):
                process = Process(
                    target=_run_env_tasks,
                    args=(
                        task_queue,
                        run_args,
                        shared_scores,
                        topology,
                        require_a11y_tree,
                        require_terminal,
                        max_steps,
                        str(osworld_root),
                        os.path.abspath(args.config),
                        args.config_root,
                        args.test_config_base_dir,
                        args.eval_version,
                        run_id,
                    ),
                    name=f"V2Env-{index + 1}",
                )
                process.daemon = True
                process.start()
                processes.append(process)
                if env_start_delay > 0 and index < num_envs - 1:
                    time.sleep(env_start_delay)
            try:
                while True:
                    alive = [process for process in processes if process.is_alive()]
                    if not alive and task_queue.empty():
                        break
                    if not alive:
                        raise RuntimeError("all worker processes died")
                    time.sleep(5)
                for process in processes:
                    process.join()
            except KeyboardInterrupt:
                logger.warning("run interrupted; terminating workers")
                for process in processes:
                    if process.is_alive():
                        process.terminate()
                for process in processes:
                    process.join()
                raise
    except KeyboardInterrupt:
        logger.warning("run interrupted; cleaning up")
        raise


if __name__ == "__main__":
    main()
