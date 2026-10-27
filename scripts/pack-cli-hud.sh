#!/bin/bash
# CLI HUD 独立发行包：只含 hud.py、quota worker、安装器与文档。
# 与 Web 扩展 / 桌面补丁完全解耦；安装器从包根解析 src/cli-hud 与 dist。
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "缺少 node" >&2; exit 1; }
command -v zip >/dev/null || { echo "缺少 zip" >&2; exit 1; }

VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")
OUT="$PWD/kimi-code-monitor-cli-v${VERSION}.zip"

node scripts/build-cli-hud.mjs
[ -s dist/quota-worker.cjs ] || { echo "quota worker 构建失败" >&2; exit 1; }

STAGE=$(mktemp -d)
mkdir -p "$STAGE/scripts" "$STAGE/src/cli-hud" "$STAGE/dist" "$STAGE/docs"
cp scripts/install-cli-hud.mjs scripts/verify-cli-hud.mjs "$STAGE/scripts/"
cp src/cli-hud/hud.py "$STAGE/src/cli-hud/"
cp dist/quota-worker.cjs "$STAGE/dist/"
cp LICENSE "$STAGE/"
cp docs/CLI-HUD.md "$STAGE/docs/"

cat > "$STAGE/README.md" <<EOF
# Kimi Code Monitor · CLI HUD v${VERSION}

Kimi Code CLI 的状态栏 HUD（实验性）。通过官方 \`status_line.command\` 显示模型、
会话状态与 Kimi 额度；不修改 Kimi 本体。

## 要求

- Kimi Code CLI >= 2.2.0（\`kimi --version\`）
- Node.js 20+
- Python 3.10+

## 安装

\`\`\`bash
node scripts/install-cli-hud.mjs --width 120
\`\`\`

在 Kimi 中执行 \`/reload-tui\`（或重启窗口）。安装器会备份 \`~/.kimi-code/tui.toml\`，
只更新 \`[status_line].command\`。

## 自定义

\`\`\`bash
node scripts/install-cli-hud.mjs \\
  --modules status,model,quotaPair,cache \\
  --order status,model,quotaPair,cache
\`\`\`

模型名与状态灯同色联动，回复结束后回到灰色空闲。

## 卸下

\`\`\`bash
node scripts/install-cli-hud.mjs --uninstall
\`\`\`

## 说明

- 详细布局与额度口径见 \`docs/CLI-HUD.md\`。
- 本包只包含 CLI HUD，不含 Web 扩展或桌面补丁。
EOF

rm -f "$OUT"
(cd "$STAGE" && zip -rq "$OUT" . -x "*.DS_Store" "__MACOSX/*")
rm -rf "$STAGE"
unzip -t "$OUT" >/dev/null

echo "已生成 $OUT"
unzip -l "$OUT"
