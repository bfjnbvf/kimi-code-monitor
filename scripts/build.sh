#!/bin/bash
# 打包四个发行资产：Web 扩展 / 桌面客户端补丁 / CLI HUD / 运维技能
set -euo pipefail
# 脚本在 scripts/，工作目录回到仓库根：下面所有路径与产物都相对仓库根
cd "$(dirname "$0")/.."

# 三个主资产 + 技能包：各自独立脚本，互不依赖
bash scripts/pack-web.sh
node scripts/build-patch.mjs
bash scripts/pack-cli-hud.sh

# 技能包（与其他主资产同规则命名；版本号见包内 MAINTENANCE）。
# 顶层带 kimi-code-monitor/ 目录：解压到 ~/.kimi-code/skills/ 即就位。
VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")
SKILL_OUT="kimi-code-monitor-skill-v${VERSION}.zip"
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
