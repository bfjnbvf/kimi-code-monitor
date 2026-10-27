#!/bin/bash
# Web 扩展发行包（独立资产）：只含扩展运行文件，不含桌面补丁 / CLI worker。
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "缺少 node" >&2; exit 1; }
command -v zip >/dev/null || { echo "缺少 zip" >&2; exit 1; }

node scripts/build.mjs
VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")
OUT="kimi-code-monitor-v${VERSION}.zip"

rm -f "$OUT"
zip -r "$OUT" \
  manifest.json \
  dist \
  content.css popup.css \
  rive \
  rules \
  popup.html \
  icons \
  README.md LICENSE \
  -x "*.DS_Store" "__MACOSX/*" "*~" "dist/panel-app.js" "dist/quota-worker.cjs"

unzip -t "$OUT" >/dev/null
echo "已生成 $OUT"
unzip -l "$OUT"
