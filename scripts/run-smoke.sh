#!/usr/bin/env bash
# mock 后端冒烟：不调模型、不依赖 VM，验证构建产物与引擎可运行。
set -euo pipefail
cd "$(dirname "$0")/.."

SMOKE_DIR="${PIOSWORLD_SMOKE_DIR:-/tmp/piosworld-smoke}"
rm -rf "$SMOKE_DIR"
node_modules/.bin/tsx src/cli/index.ts run \
  --config experiments/stateact-demo.yaml \
  --backend mock \
  --root . \
  --result-dir "$SMOKE_DIR"
echo "[smoke] ok: $SMOKE_DIR"
