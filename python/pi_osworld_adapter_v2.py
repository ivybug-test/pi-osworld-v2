"""v2 bridge adapter：子类化旧 pi_osworld_adapter.PiOSWorldAgent。

只改两处：进程命令指向 v2 `serve`（而非旧 `run`），以及 episodeId 用真实任务 id
（旧版写死 "unknown"，导致多任务 replay 无法区分）。VM 工具执行、观察编码、
HTTP tool server 全部复用旧实现，不重写。
"""

from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Tuple

from pi_osworld_adapter import PiOSWorldAgent


class PiOSWorldV2Agent(PiOSWorldAgent):
    def __init__(
        self,
        config_path: str,
        root: str,
        result_dir: str,
        episode_id: str,
    ) -> None:
        super().__init__(config_path=config_path, root=root, result_dir=result_dir)
        self.episode_id = episode_id

    @staticmethod
    def _default_command() -> List[str]:
        configured = os.environ.get("PI_OSWORLD_V2_CLI")
        if configured:
            return configured.split()
        v2_root = Path(__file__).resolve().parent.parent
        return [
            os.environ.get("PI_OSWORLD_NODE", "node"),
            str(v2_root / "dist" / "cli.js"),
            "serve",
        ]

    def _ensure_process(self) -> None:
        """同旧实现，但子命令是 serve 且不带 run。"""
        if self._process is not None and self._process.poll() is None:
            return
        self._ensure_tool_server()
        command = [
            *self.command,
            "--config",
            self.config_path,
            "--root",
            self.root,
            "--result-dir",
            self.result_dir or os.path.join(os.getcwd(), "runs"),
        ]
        env = dict(os.environ)
        if self._tool_server_url:
            env["PI_OSWORLD_TOOL_SERVER"] = self._tool_server_url
        self._process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        if self._process.stderr is not None:
            threading.Thread(
                target=self._drain_bridge_stderr,
                args=(self._process.stderr,),
                daemon=True,
            ).start()

    def reset(self, runtime_logger: Any = None) -> None:
        self._step = 0
        try:
            self._request(
                {
                    "type": "reset",
                    "episodeId": self.episode_id,
                    "task_date": self.task_current_date,
                }
            )
        except Exception as exc:  # noqa: BLE001
            import logging

            logging.getLogger(__name__).exception("pi-osworld-v2 reset failed")
            raise RuntimeError(f"pi-osworld-v2 reset failed: {exc}") from exc

    def predict(self, instruction: str, obs: Dict[str, Any]) -> Tuple[str, List[str]]:
        self._step += 1
        try:
            result = self._request(
                {
                    "type": "predict",
                    "episodeId": self.episode_id,
                    "instruction": instruction,
                    "step": self._step,
                    "observation": self._encode_observation(obs),
                }
            )
        except Exception as exc:  # noqa: BLE001
            import logging

            logging.getLogger(__name__).exception("pi-osworld-v2 predict failed")
            return (f"pi-osworld-v2 bridge error: {exc}", ["FAIL"])
        return result["response"], result["actions"]
