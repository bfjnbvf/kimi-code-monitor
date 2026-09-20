#!/bin/bash
# Kimi Code 桌面端监控面板补丁 · 安装器
#
# 用法：
#   bash install.sh              安装/更新补丁（幂等，可反复执行）
#   bash install.sh --uninstall  完整卸载（还原 index.html、删除补丁目录）
#   bash install.sh --app "/Applications/Kimi Code.app"   指定客户端位置
#
# 行为：
#   1. 备份 desktop-dist/index.html 为 index.html.bak-vibepal（仅在备份
#      不存在时创建，重装永远保留最早的原始版本）
#   2. 把补丁包里的 vibepal/ 目录整体同步进 desktop-dist/
#   3. 有 node 时全量扫描 ~/.kimi-code/sessions 生成 usage-daily.js
#      （历史统计预填；没有 node 则跳过，面板从安装时刻开始积累）
#   4. 在 index.html 的 </head> 前注入 <script src="/vibepal/loader.js?v=哈希">
#      （哈希取自载荷内容，客户端更新缓存自动失效）
#
# 客户端自动更新会整体替换 desktop-dist（补丁随之消失，属预期）：
# 重新执行本脚本即可重装，历史统计会重新扫描补齐，页内积累的数据
# 存在客户端用户数据里，不受更新影响。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=""
ACTION="install"

for arg in "$@"; do
  case "$arg" in
    --uninstall) ACTION="uninstall" ;;
    --app) : ;;
    *) APP="$arg" ;;
  esac
done

# 定位客户端：--app 参数 > /Applications > ~/Applications
find_app() {
  for candidate in \
    ${APP:+"$APP"} \
    "/Applications/Kimi Code.app" \
    "$HOME/Applications/Kimi Code.app"; do
    if [ -n "$candidate" ] && [ -d "$candidate/Contents/Resources/desktop-dist" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! APP_PATH="$(find_app)"; then
  echo "[install] 未找到 Kimi Code 桌面客户端（需要含 Contents/Resources/desktop-dist 的应用包）" >&2
  echo "[install] 若客户端装在其他位置：bash install.sh --app <Kimi Code.app 路径>" >&2
  exit 1
fi
DIST="$APP_PATH/Contents/Resources/desktop-dist"
echo "[install] 客户端：$APP_PATH"

if [ "$ACTION" = "uninstall" ]; then
  # 还原原始 index.html；没有备份（从未装过/已被客户端更新重置）则只删注入行
  if [ -f "$DIST/index.html.bak-vibepal" ]; then
    mv "$DIST/index.html.bak-vibepal" "$DIST/index.html"
    echo "[install] 已还原原始 index.html"
  else
    sed -i '' '/\/vibepal\/loader\.js/d' "$DIST/index.html" 2>/dev/null || true
    echo "[install] 未找到备份，已移除注入行"
  fi
  rm -rf "$DIST/vibepal"
  echo "[install] 补丁目录已删除，卸载完成（重载客户端生效）"
  echo "[install] 注：面板写在页面 localStorage 的少量键（布局配置/按天积累）保留在客户端用户数据里，不影响运行；重装时会按新语义继续使用"
  exit 0
fi

# ---- 安装 ----

if [ ! -f "$SCRIPT_DIR/vibepal/loader.js" ]; then
  echo "[install] 补丁载荷不完整：缺 $SCRIPT_DIR/vibepal/loader.js（请确认解压了完整补丁包）" >&2
  exit 1
fi

if [ ! -f "$DIST/index.html.bak-vibepal" ]; then
  cp "$DIST/index.html" "$DIST/index.html.bak-vibepal"
  echo "[install] 已备份原始 index.html"
else
  echo "[install] 备份已存在，保留最早的原始版本"
fi

rm -rf "$DIST/vibepal"
# -X 不带扩展属性（com.apple.provenance 等可能干扰已签名应用包的资源读取）
cp -RX "$SCRIPT_DIR/vibepal" "$DIST/vibepal"
echo "[install] 载荷已同步（$(find "$DIST/vibepal" -type f | wc -l | tr -d ' ') 个文件）"

# 历史统计预填：没有 node 或没有 sessions 目录时跳过（面板从安装时刻积累）。
# 产出必须校验文件非空——scan.mjs 异常退出码 0 时不静默宣称成功
if command -v node >/dev/null 2>&1 && [ -d "$HOME/.kimi-code/sessions" ]; then
  if node "$SCRIPT_DIR/scan.mjs" --sessions "$HOME/.kimi-code/sessions" --out "$DIST/vibepal/usage-daily.js" \
     && [ -s "$DIST/vibepal/usage-daily.js" ]; then
    echo "[install] 历史统计已预填"
  else
    rm -f "$DIST/vibepal/usage-daily.js"
    echo "[install] 历史预填未生效（不影响安装，面板从安装时刻开始积累）" >&2
  fi
else
  echo "[install] 跳过历史预填（无 node 或无 ~/.kimi-code/sessions），面板从安装时刻开始积累"
fi

# 载荷内容哈希 → 缓存参数（usage-daily.js 是机器数据，不参与哈希，loader 用时间戳穿透它）
PAYLOAD_HASH="$(cd "$DIST/vibepal" && find . -type f ! -name 'usage-daily.js' ! -name 'external.js' -exec shasum -a 256 {} \; | sort | shasum -a 256 | cut -c1-8)"

# 注入 loader 标签：先移除旧标签行（幂等），再插到 </head> 前
sed -i '' '/\/vibepal\/loader\.js/d' "$DIST/index.html"
perl -pi -e "s|</head>|      <script src=\"/vibepal/loader.js?v=$PAYLOAD_HASH\"></script>\n</head>|" "$DIST/index.html"

if ! grep -q "vibepal/loader.js?v=$PAYLOAD_HASH" "$DIST/index.html"; then
  echo "[install] 注入标签失败：index.html 结构与预期不符（可能客户端大版本更新），已中止" >&2
  echo "[install] 正在还原备份……" >&2
  if [ -f "$DIST/index.html.bak-vibepal" ]; then
    cp "$DIST/index.html.bak-vibepal" "$DIST/index.html"
  fi
  rm -rf "$DIST/vibepal"
  exit 1
fi

echo "[install] 完成（载荷 v=${PAYLOAD_HASH}）"
echo "[install] 请重载 Kimi Code 客户端（Cmd+R）或重启客户端，面板将出现在会话侧栏底部"
