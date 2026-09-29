#!/usr/bin/env bash
# 一条命令启动：自动准备环境、导入巡检样例并启动前后端（前端为随服务托管的静态页面）。
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
PORT="${MB_PORT:-8077}"
HOST="${MB_HOST:-127.0.0.1}"

# 如存在可用虚拟环境则使用（标准库即可运行，无强制依赖）
if [ -d ".venv" ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
  PYTHON=python
fi

echo "▶ 导入巡检样例并启动系统  http://${HOST}:${PORT}"
exec "$PYTHON" run.py --host "$HOST" --port "$PORT" "$@"
