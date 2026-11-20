#!/bin/sh
set -e

CDPATH= cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '未找到 Node.js。请安装 Node.js 22.12 或更高稳定版本（包含 npm），然后重新打开终端。' >&2
  exit 1
fi
exec node tools/start-console.mjs "$@"
