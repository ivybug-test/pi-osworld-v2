#!/usr/bin/env bash
# pi-osworld-v2 自包含初始化：submodule + npm + .env + 运行资源检查。
# 用法：bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[setup] v2 root: $(pwd)"

command -v node >/dev/null 2>&1 || { echo "[setup] node not found"; exit 1; }

# 1) OSWorld-V2 submodule（含官方 osworld-server 嵌套 submodule）
if [ -f .gitmodules ]; then
  git submodule update --init --recursive
  PATCH="$(pwd)/patches/osworld-docker-port-lock.patch"
  PROVIDER="external/OSWorld-V2/desktop_env/providers/docker/provider.py"
  if rg -q "OSWORLD_DOCKER_PORT_LOCK" "$PROVIDER" 2>/dev/null; then
    echo "[setup] osworld docker port-lock patch already applied"
  else
    git -C external/OSWorld-V2 apply "$PATCH"
    echo "[setup] applied patches/osworld-docker-port-lock.patch"
  fi
else
  echo "[setup] warning: no .gitmodules; run git submodule add first"
fi

# 2) Node 依赖与构建
npm install
npm run build

# 3) .env
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "[setup] created .env from .env.example; edit it with real keys"
fi

# 4) Python venv 检查
OSWORLD_ROOT="${OSWORLD_ROOT:-external/OSWorld-V2}"
if [ -x "$OSWORLD_ROOT/.venv/bin/python" ]; then
  echo "[setup] python venv: $OSWORLD_ROOT/.venv/bin/python"
else
  echo "[setup] warning: venv not found at $OSWORLD_ROOT/.venv"
  echo "  cd $OSWORLD_ROOT && python3 -m venv .venv && .venv/bin/pip install -e ."
fi

# 5) VM 镜像检查
VM_IMAGE="$OSWORLD_ROOT/docker_vm_data/osworld-v2-ubuntu-x86.qcow2"
if [ ! -f "$VM_IMAGE" ]; then
  echo "[setup] warning: VM image not found: $VM_IMAGE"
  echo "  download osworld-v2-ubuntu-x86.qcow2 and place/symlink it under $OSWORLD_ROOT/docker_vm_data/"
else
  echo "[setup] VM image: $VM_IMAGE"
fi

echo "[setup] done. run: bash scripts/run-smoke.sh (or use presets with --config-root .)"
