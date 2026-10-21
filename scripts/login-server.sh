#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec xvfb-run -a --server-args="-screen 0 1280x900x24 -nolisten tcp" \
  node "$task_root/scripts/login-server.mjs" "$@"
