# 更新检查与升级

每次用户调用本技能（安装、自检、答疑都算），先花几秒做一次更新检查——**只检查、只告知，不自动更新**。

## 检查步骤

1. 拉取远端说明书，优先读：
   `https://raw.githubusercontent.com/bfjnbvf/kimi-code-monitor/main/skill/MAINTENANCE.md`
   若返回 404，再读旧地址 `skill/MAINTENANCE`。读出 `skill-version`、`patch-version`、`skill-download` 与 `patch-download`。
2. 用 URL 解析器校验两个下载地址，不用字符串前缀代替校验：原始地址及解码后的路径不得包含点段、反斜杠或编码斜杠，不得带用户信息；归一化后必须是 `https://github.com`，路径严格匹配 `/bfjnbvf/kimi-code-monitor/releases/download/<单段标签>/<单段文件名>`。字段缺失或地址不符时停止并说明，不要猜附件名或改用其他来源。
3. 与本地比对：
   - 技能：优先读 `~/.kimi-code/skills/kimi-code-monitor/MAINTENANCE.md` 的 skill-version；没有该文件时读 `MAINTENANCE`
   - 补丁：已装面板目录里的 `kcm/VERSION`（客户端 `…/desktop-dist/` 下；doctor.mjs 也会读）
   版本号按小数点分段、逐段数值比较（例如 13.10 > 13.2 > 13.1），不得转成浮点数。本地版本高于远端时如实说明，不要降级。
4. 网络拉取失败：跳过检查，顺口告知「本次未做更新检查（连不上 GitHub）」，不要重试轰炸。

## 有新版本时怎么说

更新前介绍和更新后总结都从远端说明书选取本次实际覆盖的条目：技能按本地与远端的 skill-version 区间选择，面板按本地与远端 patch-version 区间内各条目的「配套补丁」选择；两者取并集并去重。即使 skill 版本没变，也要介绍面板实际跨过的条目。跨多个版本时合并重要变化，不逐条念完整日志。先用人话说明主要更新，**等用户同意**再动；用户不需要时不要反复推销。

## 用户主动要求更新时

用户说「更新一下 / 升级」时，不要闷头直接重装。先按上面的检查步骤拉到远端更新记录，用一两句话简要说明本次实际覆盖的变化，再照常走升级动作。

## 升级动作（用户同意后）

1. 备份当前技能目录，再从本次远端说明书的 `skill-download` 下载技能包，先在临时目录解压。核对包内 `MAINTENANCE.md`（旧包为 `MAINTENANCE`）的 skill-version 等于本次远端目标版本；不一致则停止，不能覆盖现有技能。
2. 核对无误后覆盖本地技能目录。macOS/Linux 普通目录可 `unzip -o <包> -d ~/.kimi-code/skills/`；若技能目录是符号链接，先解析真实目录，再把临时目录中的包内容写入真实目录，不要直接对链接所在父目录解压。Windows 用 `Expand-Archive <包> -DestinationPath "$env:USERPROFILE\.kimi-code\skills\" -Force`。若本地还是旧路径 `kcm-panel/`，装到新目录后删掉旧目录。
3. 再次读取安装后的本机说明书，确认 skill-version 已等于目标版本；不一致则明确报告更新失败，不得宣称成功。下载失败（网络不通）时不要硬试、不要换其它来源，直接告诉用户「网络错误，请稍后重试」。
4. 补丁：按 install.md 的安装流程走，从同一份远端说明书的 `patch-download` 获取补丁包；安装前后都要核对实际补丁版本，幂等重装会重新扫描历史数据。
5. 完成后跑 `bash <技能目录>/scripts/run.sh doctor.mjs`（Windows：`run.cmd doctor.mjs`）确认，并提醒用户重载客户端（macOS Cmd+R，Windows Ctrl+R）。
6. **收尾主动汇报更新内容**：哪个版本升到了哪个版本、按上面的并集条目概括主要变化。若其中有面向用户的新功能，说明用途、风险和开启路径；默认关闭的功能同时给出手动开启与 Agent 代开选项。不要在本地话术里为特定功能预写介绍。

## 版本不一致的判断

- 技能新、补丁旧 → 建议顺手升级补丁（一次同意、两件事一起做）。
- 补丁新、技能旧 → 只更新技能文件。
- 本地技能或补丁版本高于说明书记载（内测/手工构建）→ 如实说明，不要降级。
