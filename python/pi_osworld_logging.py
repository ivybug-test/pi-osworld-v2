"""Framework-level logging for pi-osworld Python runners.

Every runner should configure logging through this module instead of calling
logging.basicConfig() directly, so experiments get consistent console and file
output regardless of which runner is used.
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import sys
from typing import Optional, TextIO

FRAMEWORK_LOGGER = "pi-osworld"
BRIDGE_LOGGER = f"{FRAMEWORK_LOGGER}.bridge"
DEFAULT_FORMAT = "[%(asctime)s %(levelname)s %(name)s/%(lineno)d] %(message)s"

RESET = "\x1b[0m"
BOLD = "\x1b[1m"
RED = "\x1b[31m"
GREEN = "\x1b[32m"
YELLOW = "\x1b[33m"
BLUE = "\x1b[34m"
MAGENTA = "\x1b[35m"
CYAN = "\x1b[36m"
GRAY = "\x1b[90m"

_LEVEL_COLORS = {
    logging.DEBUG: GRAY,
    logging.INFO: BLUE,
    logging.WARNING: YELLOW,
    logging.ERROR: RED,
    logging.CRITICAL: f"{BOLD}{RED}",
}
_ROLE_COLORS = {
    "main": CYAN,
    "gui": MAGENTA,
    "finish_gate": YELLOW,
    "flow": BLUE,
}
_ROLE_RE = re.compile(r"\[(main|gui|finish_gate|flow|sub:[a-z0-9_]+)\]")


def add_logging_args(parser: argparse.ArgumentParser) -> None:
    """Add the standard --log-level / --log-file arguments to a runner CLI."""
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Console log level",
    )
    parser.add_argument(
        "--log-file",
        default=None,
        help="Optional file path to mirror all runner logs to",
    )
    parser.add_argument(
        "--force-color",
        action="store_true",
        help="Force ANSI colors even when stdout is not a TTY (or set FORCE_COLOR=1)",
    )


def setup_logging(
    level: str = "INFO",
    stream: Optional[TextIO] = None,
    log_file: Optional[str] = None,
    force_color: bool = False,
) -> logging.Logger:
    """Configure root logging and return the framework logger."""
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    force = force_color or bool(os.environ.get("FORCE_COLOR"))
    if force:
        color = True
    elif os.environ.get("NO_COLOR"):
        color = False
    else:
        color = bool((stream or sys.stdout).isatty()) and os.environ.get("TERM", "") != "dumb"
    formatter = ColorFormatter(DEFAULT_FORMAT, color=color)
    has_console = any(
        isinstance(handler, logging.StreamHandler)
        and getattr(handler, "_pi_osworld_console", False)
        for handler in root.handlers
    )
    if not has_console:
        handler = logging.StreamHandler(stream or sys.stdout)
        handler.setFormatter(formatter)
        handler._pi_osworld_console = True  # type: ignore[attr-defined]
        root.addHandler(handler)

    # OSWorld modules log under desktopenv.*; make sure INFO is visible.
    logging.getLogger("desktopenv").setLevel(logging.INFO)

    logger = get_logger()
    if log_file:
        add_file_handler(root, log_file)
    return logger


def get_logger() -> logging.Logger:
    return logging.getLogger(FRAMEWORK_LOGGER)


def attach_log_file(log_file: str) -> None:
    """Mirror all logs (including OSWorld) to a file."""
    add_file_handler(logging.getLogger(), log_file)


def add_file_handler(logger: logging.Logger, log_file: str) -> None:
    log_file = os.path.abspath(log_file)
    os.makedirs(os.path.dirname(log_file), exist_ok=True)
    formatter = ColorFormatter(DEFAULT_FORMAT, color=False)
    for handler in logger.handlers:
        if (
            isinstance(handler, logging.FileHandler)
            and os.path.abspath(handler.baseFilename) == log_file
        ):
            return
    handler = logging.FileHandler(log_file, encoding="utf-8")
    handler.setFormatter(formatter)
    logger.addHandler(handler)


class ColorFormatter(logging.Formatter):
    """Console-friendly formatter that keeps bridge lines single-part and colors
    everything else by level. File handlers use color=False so runner.log stays
    plain text."""

    def __init__(self, fmt: str = DEFAULT_FORMAT, color: bool = True) -> None:
        super().__init__(fmt)
        self.color = color

    def format(self, record: logging.LogRecord) -> str:
        if record.name == BRIDGE_LOGGER:
            message = record.getMessage()
            return colorize_bridge(message) if self.color else message
        message = super().format(record)
        if not self.color:
            return message
        message = re.sub(
            r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})",
            f"{GRAY}\\1{RESET}",
            message,
            count=1,
        )
        color = _LEVEL_COLORS.get(record.levelno)
        if color:
            message = message.replace(record.levelname, f"{color}{record.levelname}{RESET}", 1)
        return message


def colorize_bridge(line: str) -> str:
    """Color bridge event lines by status and by role badge."""
    lowered = line.lower()
    if any(marker in lowered for marker in (" error ", " failed ", " rejected ")):
        return f"{RED}{line}{RESET}"
    if "accepted=true" in lowered:
        return f"{GREEN}{line}{RESET}"
    if any(marker in lowered for marker in ("compacted", "budget", "retry", "exhausted")):
        return f"{YELLOW}{line}{RESET}"

    def replace_role(match: re.Match[str]) -> str:
        role = match.group(1)
        color = _ROLE_COLORS.get(role, CYAN)
        return f"{color}[{role}]{RESET}"

    return _ROLE_RE.sub(replace_role, line)
