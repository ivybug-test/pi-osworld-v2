"""Thin OSWorld agent adapter that talks to the pi-osworld bridge over JSONL."""

from __future__ import annotations

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
import re
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


class _ToolHttpHandler(BaseHTTPRequestHandler):
    """Serves VM tool calls from the Node bridge to the OSWorld controller."""

    adapter: Optional["PiOSWorldAgent"] = None

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        try:
            if self.path == "/observe":
                result = (
                    self.adapter._observe()
                    if self.adapter is not None
                    else {"ok": False, "error": "adapter not attached"}
                )
            else:
                length = int(self.headers.get("content-length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                name = payload.get("name", "")
                args = payload.get("arguments") or {}
                if self.adapter is None:
                    result = {"ok": False, "error": "adapter not attached", "output": ""}
                else:
                    result = self.adapter._execute_tool(name, args)
        except Exception as exc:  # noqa: BLE001 - report failures to the bridge
            result = {"ok": False, "error": str(exc), "output": ""}
        body = json.dumps(result).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _reject_whole_fs_find(command: str) -> Optional[str]:
    """Return an error message when a bash command scans the whole filesystem."""
    if re.match(r"^\s*find\s+/\s*($|[\s;&|])", command):
        return (
            "whole-filesystem find is not allowed; search a targeted directory "
            "inside the VM with -maxdepth and an explicit timeout"
        )
    return None

    def log_message(self, *args: Any) -> None:  # noqa: A002
        pass


class PiOSWorldAgent:
    """Implements the OSWorld agent contract: reset / predict / close."""

    def __init__(
        self,
        config_path: str,
        root: Optional[str] = None,
        result_dir: Optional[str] = None,
        command: Optional[List[str]] = None,
    ) -> None:
        self.config_path = config_path
        self.root = root or os.getcwd()
        self.result_dir = result_dir
        self.command = command or self._default_command()
        self.task_current_date: Optional[str] = None
        self._process: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._request_id = 0
        self._step = 0
        self.env: Optional[Any] = None
        self._tool_server: Optional[ThreadingHTTPServer] = None
        self._tool_server_url: Optional[str] = None
        self._tool_server_started = False

    @staticmethod
    def _default_command() -> List[str]:
        configured = os.environ.get("PI_OSWORLD_BIN")
        if configured:
            return configured.split()
        repo_root = Path(__file__).resolve().parent.parent
        return [os.environ.get("PI_OSWORLD_NODE", "node"), str(repo_root / "dist" / "cli.js")]

    def _ensure_process(self) -> None:
        if self._process is not None and self._process.poll() is None:
            return
        self._ensure_tool_server()
        command = [
            *self.command,
            "run",
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

    def _drain_bridge_stderr(self, stream: Any) -> None:
        """Forward pi-osworld bridge event lines into the runner log stream."""
        logger = logging.getLogger("pi-osworld.bridge")
        for raw in iter(stream.readline, ""):
            line = raw.rstrip("\n")
            if line:
                logger.info("%s", line)

    def attach_env(self, env: Any) -> None:
        """Bind the running DesktopEnv so VM tools can execute against it."""
        self.env = env

    def _ensure_tool_server(self) -> None:
        if self._tool_server is not None:
            return
        if self.env is None:
            return
        _ToolHttpHandler.adapter = self
        self._tool_server = ThreadingHTTPServer(("127.0.0.1", 0), _ToolHttpHandler)
        self._tool_server_url = f"http://127.0.0.1:{self._tool_server.server_address[1]}"
        threading.Thread(target=self._tool_server.serve_forever, daemon=True).start()
        self._tool_server_started = True

    def _execute_tool(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if self.env is None:
            return {"ok": False, "error": "VM env not attached", "output": ""}
        controller = self.env.controller
        if name == "state.bash":
            command = args.get("command") or args.get("script")
            if not command:
                return {"ok": False, "error": "state.bash requires 'command'", "output": ""}
            guard_error = _reject_whole_fs_find(command)
            if guard_error:
                return {"ok": False, "error": guard_error, "output": "", "returncode": -1}
            result = controller.run_bash_script(
                command,
                timeout=int(args.get("timeout", 30)),
                working_dir=args.get("working_dir"),
            )
            return self._normalize_tool_result(result)
        if name == "state.python":
            code = args.get("code")
            if not code:
                return {"ok": False, "error": "state.python requires 'code'", "output": ""}
            result = controller.run_python_script(
                code,
                timeout=int(args.get("timeout", 90)),
            )
            return self._normalize_tool_result(result)
        if name == "state.terminal":
            return {
                "ok": True,
                "output": controller.get_terminal_output() or "",
                "error": "",
            }
        if name == "state.read_file":
            path = args.get("path")
            if not path:
                return {"ok": False, "error": "state.read_file requires 'path'", "output": ""}
            result = controller.run_bash_script(
                f"cat -- {_shell_quote(str(path))}",
                timeout=int(args.get("timeout", 30)),
            )
            return self._normalize_tool_result(result)
        if name == "state.write_file":
            path = args.get("path")
            content = args.get("content")
            if not path or content is None:
                return {"ok": False, "error": "state.write_file requires 'path' and 'content'", "output": ""}
            script = (
                "import pathlib, json\n"
                "pathlib.Path(%r).write_text(json.loads(%r), encoding='utf-8')\n"
                "print('written')\n"
            ) % (str(path), json.dumps(str(content)))
            result = controller.run_python_script(script, timeout=int(args.get("timeout", 90)))
            return self._normalize_tool_result(result)
        if name == "state.edit_file":
            path = args.get("path")
            old_text = args.get("old_string")
            new_text = args.get("new_string")
            if not path or old_text is None or new_text is None:
                return {"ok": False, "error": "state.edit_file requires 'path', 'old_string', 'new_string'", "output": ""}
            script = (
                "import pathlib, json\n"
                "p = pathlib.Path(%r)\n"
                "text = p.read_text(encoding='utf-8')\n"
                "old = json.loads(%r)\n"
                "new = json.loads(%r)\n"
                "count = text.count(old)\n"
                "if count == 0:\n"
                "    print('no match')\n"
                "else:\n"
                "    p.write_text(text.replace(old, new, 1), encoding='utf-8')\n"
                "    print('replaced %d occurrence(s)' % count)\n"
            ) % (str(path), json.dumps(str(old_text)), json.dumps(str(new_text)))
            result = controller.run_python_script(script, timeout=int(args.get("timeout", 90)))
            return self._normalize_tool_result(result)
        if name == "state.view_image":
            path = args.get("path")
            if not path:
                return {"ok": False, "error": "state.view_image requires 'path'", "output": ""}
            raw = controller.get_file(str(path))
            if raw is None:
                return {"ok": False, "error": f"failed to read image: {path}", "output": ""}
            import base64 as _b64
            suffix = Path(str(path)).suffix.lower()
            mime = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".bmp": "image/bmp",
            }.get(suffix, "image/png")
            return {
                "ok": True,
                "output": f"image bytes: {len(raw)}",
                "error": "",
                "image_b64": _b64.b64encode(raw).decode("ascii"),
                "image_mime": mime,
            }
        if name.startswith("computer."):
            return self._execute_computer_tool(name, args)
        return {"ok": False, "error": f"unknown VM tool: {name}", "output": ""}

    def _execute_computer_tool(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a computer.* action inside the VM through pyautogui."""
        if self.env is None:
            return {"ok": False, "error": "VM env not attached", "output": ""}
        command = None
        if name == "computer.click":
            x = float(args.get("x", 0))
            y = float(args.get("y", 0))
            command = f"pyautogui.click({x}, {y})"
        elif name == "computer.type":
            text = str(args.get("text", ""))
            command = f"pyautogui.typewrite({text!r})"
        elif name == "computer.key":
            key = str(args.get("key", ""))
            command = f"pyautogui.press({key!r})"
        elif name == "computer.scroll":
            clicks = int(args.get("clicks", 0))
            command = f"pyautogui.scroll({clicks})"
        elif name == "computer.wait":
            command = "time.sleep(0.5)"
        elif name in ("computer.done", "computer.fail"):
            return {"ok": True, "output": "handled by flow", "error": ""}
        elif name == "computer.ask_user":
            return {"ok": True, "output": str(args.get("question", "")), "error": ""}
        if command is None:
            return {"ok": False, "error": f"unsupported computer tool: {name}", "output": ""}
        result = self.env.controller.execute_python_command(command)
        return self._normalize_tool_result(result) if isinstance(result, dict) else {
            "ok": result is None,
            "output": "",
            "error": "" if result is None else str(result),
            "returncode": 0 if result is None else -1,
        }

    @staticmethod
    def _shell_quote(value: str) -> str:
        return "'" + value.replace("'", "'\\''") + "'"

    def _observe(self) -> Dict[str, Any]:
        """Return the latest encoded observation (screenshot/a11y/terminal)."""
        if self.env is None:
            return {"ok": False, "error": "VM env not attached"}
        try:
            obs = self.env._get_obs()
        except AttributeError:
            obs = {}
        return {"ok": True, "observation": self._encode_observation(obs)}

    @staticmethod
    def _normalize_tool_result(result: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not isinstance(result, dict):
            return {"ok": False, "error": "tool returned no result", "output": "", "returncode": -1}
        status = str(result.get("status") or "")
        ok = status in ("", "success", "ok", "completed") or bool(result.get("ok"))
        return {
            "ok": ok,
            "output": result.get("output") or "",
            "error": result.get("error") or result.get("message") or "",
            "returncode": result.get("returncode"),
        }

    def _stop_tool_server(self) -> None:
        server = self._tool_server
        self._tool_server = None
        self._tool_server_url = None
        if server is None:
            return
        try:
            if self._tool_server_started:
                server.shutdown()
            server.server_close()
        except Exception:  # noqa: BLE001 - teardown must not mask real errors
            pass
        self._tool_server_started = False

    def _request(self, payload: Dict[str, Any]) -> Any:
        self._ensure_process()
        assert self._process is not None
        self._request_id += 1
        request = {"id": str(self._request_id), **payload}
        with self._lock:
            self._process.stdin.write(json.dumps(request) + "\n")
            self._process.stdin.flush()
            line = self._process.stdout.readline()
        if not line:
            raise RuntimeError("pi-osworld process closed unexpectedly")
        response = json.loads(line)
        if not response.get("ok"):
            raise RuntimeError(response.get("error", "pi-osworld request failed"))
        return response.get("result")

    def set_api_log_dir(self, path: str) -> None:
        pass

    def reset(self, runtime_logger: Any = None) -> None:
        self._step = 0
        try:
            self._request(
                {
                    "type": "reset",
                    "episodeId": "unknown",
                    "task_date": self.task_current_date,
                }
            )
        except Exception as exc:  # noqa: BLE001 - let the runner surface reset failures
            logging.getLogger(__name__).exception("pi-osworld reset failed")
            raise RuntimeError(f"pi-osworld reset failed: {exc}") from exc

    def predict(self, instruction: str, obs: Dict[str, Any]) -> Tuple[str, List[str]]:
        self._step += 1
        try:
            result = self._request(
                {
                    "type": "predict",
                    "episodeId": "unknown",
                    "instruction": instruction,
                    "step": self._step,
                    "observation": self._encode_observation(obs),
                }
            )
        except Exception as exc:  # noqa: BLE001 - keep the episode alive on bridge errors
            logging.getLogger(__name__).exception("pi-osworld predict failed")
            return (f"pi-osworld bridge error: {exc}", ["FAIL"])
        return result["response"], result["actions"]

    def close(self) -> None:
        try:
            if self._process is not None and self._process.poll() is None:
                try:
                    self._request({"type": "close"})
                finally:
                    self._process.wait(timeout=5)
                    self._process = None
        finally:
            self._stop_tool_server()

    def terminate(self) -> None:
        """Kill the bridge without the close handshake, for interrupted runs."""
        try:
            if self._process is not None and self._process.poll() is None:
                self._process.terminate()
                try:
                    self._process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait()
            self._process = None
        finally:
            self._stop_tool_server()

    @staticmethod
    def _encode_observation(obs: Dict[str, Any]) -> Dict[str, Any]:
        encoded: Dict[str, Any] = {}
        screenshot = obs.get("screenshot")
        if screenshot is not None:
            encoded["screenshot_b64"] = (
                base64.b64encode(screenshot).decode("ascii")
                if isinstance(screenshot, bytes)
                else screenshot
            )
        accessibility_tree = obs.get("accessibility_tree")
        if accessibility_tree is not None:
            encoded["accessibility_tree"] = (
                json.dumps(accessibility_tree)
                if not isinstance(accessibility_tree, str)
                else accessibility_tree
            )
        user_response = obs.get("user_response")
        if user_response is not None:
            encoded["user_response"] = user_response
        terminal = obs.get("terminal")
        if terminal is not None:
            encoded["terminal"] = terminal
        return encoded
