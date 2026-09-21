#!/bin/bash
# 打包 Kimi Code Monitor 为可分发的 zip（仅包含运行必需文件）
set -euo pipefail
# 脚本在 scripts/，工作目录回到仓库根：下面所有路径与产物都相对仓库根
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "缺少 node，无法构建" >&2; exit 1; }
command -v zip >/dev/null || { echo "缺少 zip 命令" >&2; exit 1; }

# 先从 src/ 构建 dist/ 产物
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
# run.cmd 强制 CRLF：批处理在 LF 下解析有坑，不信任工作区行尾状态
node -e "const fs=require('fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/\\r?\\n/g,'\\r\\n'))" "$SKILL_STAGE/kimi-code-monitor/scripts/run.cmd"
# 技能脚本打成零依赖单文件：技能包不含 src/，脚本里对 ../../src/* 的导入
# 装到 ~/.kimi-code/skills/ 后会解析失败（曾导致「刷新余额」报模块不存在）
# 从仓库源码打包（不能打包暂存目录里的副本：脚本里的 ../../src/* 是相对
# 仓库根的，复制到暂存目录后解析不到），产物直接覆盖暂存目录里的同名文件
for script in skill/scripts/*.mjs; do
  name="$(basename "$script")"
  ./node_modules/.bin/esbuild "$script" \
    --bundle --platform=node --format=esm --target=node16 --log-level=warning \
    --outfile="$SKILL_STAGE/kimi-code-monitor/scripts/$name"
done
rm -f "$SKILL_OUT"
(cd "$SKILL_STAGE" && zip -rq "$OLDPWD/$SKILL_OUT" kimi-code-monitor -x "*.DS_Store")
rm -rf "$SKILL_STAGE"
unzip -t "$SKILL_OUT" >/dev/null

echo "已生成 $SKILL_OUT"
unzip -l "$SKILL_OUT"
