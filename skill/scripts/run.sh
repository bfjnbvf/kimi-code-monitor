#!/bin/bash
# 技能脚本的统一运行入口（macOS / Linux）。
#
# 与 install.sh 同一原则：运行时的选择逻辑全项目只活在这一处——所有技能脚本
# （doctor.mjs / refresh-stats.mjs / client-providers.mjs …）都经本壳启动，
# 无系统 Node 的用户也能用（借客户端自带的 Node）。
#
# 运行时优先级：
#   ① Kimi Code 客户端自带的 Node（ELECTRON_RUN_AS_NODE，版本恒定、不依赖 PATH）
#   ② 系统 node
#   ③ 都没有 → 提示退出
# KCM_RUNTIME_EXE 可显式指定运行时（测试注入 / 高级用法）。
#
# 用法：bash run.sh <脚本名或路径> [参数...]
#   bash run.sh doctor.mjs                    # 相对名：按本壳所在目录解析
#   bash run.sh /abs/path/script.mjs --app .  # 绝对/相对路径亦可
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -lt 1 ]; then
  echo "用法: bash run.sh <脚本名或路径> [参数...]" >&2
  exit 1
fi

TARGET="$1"
shift
case "$TARGET" in
  */*) ;;                            # 带斜杠 = 路径（绝对或相对），原样用
  *) TARGET="$SCRIPT_DIR/$TARGET" ;; # 裸脚本名：按本壳所在目录解析
esac
if [ ! -f "$TARGET" ]; then
  echo "脚本不存在：$TARGET" >&2
  exit 1
fi

RUNTIME="${KCM_RUNTIME_EXE:-}"
if [ -z "$RUNTIME" ]; then
  for candidate in \
    "/Applications/Kimi Code.app/Contents/MacOS/Kimi Code" \
    "$HOME/Applications/Kimi Code.app/Contents/MacOS/Kimi Code"; do
    if [ -x "$candidate" ]; then RUNTIME="$candidate"; break; fi
  done
fi

if [ -n "$RUNTIME" ] && [ -x "$RUNTIME" ]; then
  exec env ELECTRON_RUN_AS_NODE=1 "$RUNTIME" "$TARGET" "$@"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$TARGET" "$@"
fi

echo "未找到 Kimi Code 客户端，也没有 Node。请先安装 Kimi Code 客户端后重试。" >&2
exit 1
