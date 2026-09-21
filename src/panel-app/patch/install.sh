#!/bin/bash
# Kimi Code Monitor 面板补丁 · 安装入口（macOS）
#
# 本文件只是「点火器」：找到可用的 Node 运行时，把同一份安装器 install.mjs
# 跑起来。安装逻辑全部在 install.mjs（跨平台唯一一份），这里不放任何安装行为。
#
# 运行时优先级：
#   ① Kimi Code 客户端自带的 Node——客户端是装面板的前提，它的 Node 一定在：
#      版本恒定（随客户端分发）、不依赖用户环境的 PATH / nvm 状态
#   ② 系统 node（手动装过 Node 的机器，行为与旧版一致）
#   ③ 都没有 → 提示后退出（正常用户走不到这）
#
# KCM_RUNTIME_EXE 可显式指定运行时可执行文件（测试注入 / 高级用法）。
#
# 用法：
#   bash install.sh              安装/更新补丁（幂等，可反复执行）
#   bash install.sh --uninstall  完整卸载（还原 index.html、删除补丁目录）
#   bash install.sh --app "/Applications/Kimi Code.app"   指定客户端位置
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.mjs"
if [ ! -f "$INSTALLER" ]; then
  echo "缺 install.mjs：请确认解压了完整补丁包" >&2
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

# 借客户端的 Node：ELECTRON_RUN_AS_NODE 是 Electron 的官方开关，让它不启动
# 界面、纯当 Node 跑（实测与系统 node 产物逐字节一致）。注意：若客户端将来
# 打包时禁用了该开关，这里会误启动客户端界面——届时请装 Node 后手动运行
# install.mjs（见 docs/DESKTOP-PATCH.md）。
if [ -n "$RUNTIME" ] && [ -x "$RUNTIME" ]; then
  exec env ELECTRON_RUN_AS_NODE=1 "$RUNTIME" "$INSTALLER" "$@"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$INSTALLER" "$@"
fi

echo "未找到 Kimi Code 客户端，也没有 Node。请先安装 Kimi Code 客户端后重试。" >&2
exit 1
