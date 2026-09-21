#!/bin/bash
# KCM 面板外部级自检：只读检查，不改任何文件。
# 输出 PASS/FAIL/WARN 逐项结论 + 建议动作，供 Agent（技能 doctor.md）解读。
set -uo pipefail

APP_CANDIDATES=("/Applications/Kimi Code.app" "$HOME/Applications/Kimi Code.app")
PASS=0; FAIL=0; WARN=0

ok()   { echo "PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
warn() { echo "WARN  $1"; WARN=$((WARN+1)); }

# 1. 客户端与补丁目录
APP=""
for c in "${APP_CANDIDATES[@]}"; do
  [ -d "$c/Contents/Resources/desktop-dist" ] && APP="$c" && break
done
if [ -z "$APP" ]; then
  bad "未找到 Kimi Code 桌面客户端（含 desktop-dist 的应用包）"
  echo "建议：确认客户端已安装；若装在其他位置，用 --app 参数指定"
  exit 1
fi
ok "客户端：$APP"
DIST="$APP/Contents/Resources/desktop-dist"
VIB="$DIST/kcm"

CLIENT_VER=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo '?')
echo "INFO  客户端版本：$CLIENT_VER"

# 2. 补丁文件完整性
if [ ! -d "$VIB" ]; then
  bad "补丁目录不存在（${VIB}）——面板未安装，或客户端更新后补丁被清除"
  echo "建议：重跑安装流程（install.md）"
  exit 1
fi
for f in loader.js panel-app.js content.css rive/rive.js rive/rive.wasm; do
  [ -s "$VIB/$f" ] && ok "文件存在：$f" || bad "文件缺失或为空：$f（建议重装）"
done
if [ -f "$VIB/VERSION" ]; then
  ok "补丁版本：$(cat "$VIB/VERSION")"
else
  warn "补丁无版本标记（较老版本，建议重装升级）"
fi

# 3. index.html 注入标签与缓存参数一致性
TAG=$(grep -o 'kcm/loader\.js?v=[a-f0-9]*' "$DIST/index.html" 2>/dev/null | head -1)
if [ -z "$TAG" ]; then
  bad "index.html 无 loader 注入标签——补丁未生效"
  echo "建议：重跑安装流程"
elif [ -f "$DIST/index.html.bak-kcm" ]; then
  ok "注入标签存在（${TAG}），原始备份在场"
else
  warn "注入标签存在（${TAG}），但原始备份缺失（卸载时只能删标签无法整体还原）"
fi
EXPECT_V=$(cd "$VIB" && find . -type f ! -name 'usage-daily.js' ! -name 'wallet.js' ! -name 'fetch-wallet.mjs' -exec shasum -a 256 {} \; 2>/dev/null | sort | shasum -a 256 | cut -c1-8)
ACTUAL_V=$(echo "$TAG" | sed 's/.*v=//')
if [ "$EXPECT_V" = "$ACTUAL_V" ]; then
  ok "缓存参数与载荷哈希一致（${ACTUAL_V}）"
else
  bad "缓存参数过期（页面 v=${ACTUAL_V}，实际载荷 v=${EXPECT_V}）——客户端可能加载旧缓存"
  echo "建议：重跑安装流程刷新标签"
fi

# 4. 数据文件
if [ -s "$VIB/usage-daily.js" ]; then
  if head -c 40 "$VIB/usage-daily.js" | grep -q '__kcmUsageDaily'; then
    ok "历史统计数据文件在位"
  else
    bad "usage-daily.js 内容异常（应以 window.__kcmUsageDaily 开头）"
  fi
else
  warn "无历史统计数据文件（全新环境正常；否则重跑安装预填）"
fi
[ -s "$VIB/external.js" ] && echo "INFO  发现旧版外部账户快照 external.js（新版不再使用，重跑安装即可清掉）"
[ -s "$VIB/wallet.js" ] && ok "加油包余额快照在位（$(stat -f '%Sm' -t '%m-%d %H:%M' "$VIB/wallet.js")）" \
  || warn "无加油包余额快照（面板余额位显示 --；可让技能刷新余额）"

# 5. kap 本地服务（发现 + 探测）
KAP_PORT=""
for f in "$HOME"/.kimi-code/server/instances/*.json; do
  [ -f "$f" ] || continue
  P=$(python3 -c "import json;print(json.load(open('$f')).get('port',''))" 2>/dev/null)
  [ -z "$P" ] && continue
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$P/api/v1/oauth/usage" 2>/dev/null)
  if [ "$CODE" = "200" ]; then KAP_PORT="$P"; break; fi
done
if [ -n "$KAP_PORT" ]; then
  ok "本地服务在线（端口 ${KAP_PORT}，额度接口 200）"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$KAP_PORT/kcm/loader.js" 2>/dev/null)
  [ "$CODE" = "200" ] && ok "本地服务能伺服补丁文件（/kcm/loader.js 200）" \
    || warn "本地服务未伺服补丁文件（HTTP ${CODE}）——面板可能依赖注入标签本地路径"
else
  bad "本地服务不可达（无实例注册或额度接口非 200）——客户端可能未运行"
  echo "建议：确认 Kimi Code 客户端正在运行后重试"
fi

echo "-----"
echo "结论：PASS=$PASS FAIL=$FAIL WARN=$WARN"
[ "$FAIL" -eq 0 ] && echo "外部检查全部通过。页面内状态请按 doctor.md 的页面级通道继续。"
