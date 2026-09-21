# 更新检查与升级

每次用户调用本技能（安装、自检、答疑都算），先花几秒做一次更新检查——**只检查、只告知，不自动更新**。

## 检查步骤

1. 拉取远端版本文件：
   `https://raw.githubusercontent.com/bfjnbvf/kimi-code-monitor/main/skill/MAINTENANCE`
   读出 `skill-version` 与 `patch-version`。
2. 与本地比对：
   - 技能：`~/.kimi-code/skills/kimi-code-monitor/MAINTENANCE` 的 skill-version
   - 补丁：已装面板目录里的 `kcm/VERSION`（客户端 `…/desktop-dist/` 下；doctor.mjs 也会读）
3. 网络拉取失败：跳过检查，顺口告知「本次未做更新检查（连不上 GitHub）」，不要重试轰炸。

## 有新版本时怎么说

把更新记录里有意义的条目用人话告诉用户，例如：「面板有新版本了，主要改了 X 和 Y，要现在升级吗？」——**等用户同意**再动。用户不需要时不要反复推销。

## 升级动作（用户同意后）

1. 技能：重新下载技能包解压覆盖本地技能目录（Release 固定名，始终最新）：
   `https://github.com/bfjnbvf/kimi-code-monitor/releases/latest/download/kimi-code-monitor-skill.zip`
   macOS/Linux：`unzip -o <包> -d ~/.kimi-code/skills/`；Windows：`Expand-Archive <包> -DestinationPath "$env:USERPROFILE\.kimi-code\skills\" -Force`。
   Release 不可达时退回复拉 raw 文件覆盖。若本地还是旧路径 `kcm-panel/`（2026-09-21 前安装），装到新目录后删掉旧目录。
2. 补丁：按 install.md 的安装流程走（幂等重装），它会重新扫描历史数据。
3. 完成后跑 `node <技能目录>/scripts/doctor.mjs` 确认，并提醒用户重载客户端（macOS Cmd+R，Windows Ctrl+R）。

## 版本不一致的判断

- 技能新、补丁旧 → 建议顺手升级补丁（一次同意、两件事一起做）。
- 补丁新、技能旧 → 只更新技能文件。
- 本地补丁版本高于 MAINTENANCE 记载（内测/手工构建）→ 如实说明，不要降级。
