#!/bin/bash
# 打包 Kimi Code Monitor 为可分发的 zip（仅包含运行必需文件）
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "缺少 node，无法构建" >&2; exit 1; }
command -v zip >/dev/null || { echo "缺少 zip 命令" >&2; exit 1; }

# 先从 src/ 构建 dist/ 产物
node build.mjs

VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")
OUT="kimi-code-monitor-v${VERSION}.zip"

rm -f "$OUT"
zip -r "$OUT" \
  manifest.json \
  dist \
  content.css popup.css web-token.js \
  rive \
  rules \
  popup.html \
  icons \
  README.md LICENSE \
  -x "*.DS_Store" "__MACOSX/*" "*~"

# 校验 zip 完整性
unzip -t "$OUT" >/dev/null

echo "已生成 $OUT"
unzip -l "$OUT"
