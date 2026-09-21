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
# web-token.js 未在 manifest 注册（月额度通路停用备用），不进发行包
zip -r "$OUT" \
  manifest.json \
  dist \
  content.css popup.css \
  rive \
  rules \
  popup.html \
  icons \
  README.md LICENSE \
  -x "*.DS_Store" "__MACOSX/*" "*~" "dist/panel-app.js"

# 校验 zip 完整性
unzip -t "$OUT" >/dev/null

echo "已生成 $OUT"
unzip -l "$OUT"

# 技能包（固定名，随 Release 分发；版本号见包内 MAINTENANCE）。
# 顶层带 kimi-code-monitor/ 目录：解压到 ~/.kimi-code/skills/ 即就位。
SKILL_OUT="kimi-code-monitor-skill.zip"
SKILL_STAGE="$(mktemp -d)"
cp -R skill "$SKILL_STAGE/kimi-code-monitor"
rm -f "$SKILL_OUT"
(cd "$SKILL_STAGE" && zip -rq "$OLDPWD/$SKILL_OUT" kimi-code-monitor -x "*.DS_Store")
rm -rf "$SKILL_STAGE"
unzip -t "$SKILL_OUT" >/dev/null

echo "已生成 $SKILL_OUT"
unzip -l "$SKILL_OUT"
