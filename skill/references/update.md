# 更新检查与升级

每次用户调用本技能（安装、自检、答疑都算），先做一次更新检查——**只检查、只告知，不自动更新**。

## 检查步骤

1. 统一经 run 壳运行只读检查脚本：
   - macOS / Linux：`bash <技能目录>/scripts/run.sh check-update.mjs`
   - Windows：`<技能目录>\scripts\run.cmd check-update.mjs`
2. 脚本负责拉取远端 `skill/MAINTENANCE.md`，读取版本、校验两个官方 Release 下载地址、比较版本并输出 `SUMMARY`。
3. 需要给其他程序读取时加 `--json`。客户端不在默认位置时追加 `--app "<客户端目录>"`，也认环境变量 `KIMI_CODE_APP_DIR`。
4. 网络拉取失败：跳过检查，告知「本次未做更新检查（连不上 GitHub）」，不要重试轰炸。其他报错原样上报，不要猜版本、猜附件名或改用其他来源。

## 版本来源（不可混用）

| 判断对象 | 本地版本唯一来源 | 远端版本来源 |
|---|---|---|
| 技能 | 本地技能 `MAINTENANCE.md` 的 `skill-version`（旧包读 `MAINTENANCE`） | 远端说明书的 `skill-version` |
| 面板 | 客户端实际安装目录里的 `kcm/VERSION` | 远端说明书的 `patch-version` |

本地技能说明书里的 `patch-version` 只是该技能发行包的配套记录，**不是已装面板版本，不参与更新判断，也不要求与远端同步**。面板单独更新后，不得为了刷新这个数字而覆盖技能或手改说明书。

版本号按小数点分段、逐段数值比较（例如 13.10 > 13.2 > 13.1），不得转成浮点数。本地版本高于远端时如实说明，不要降级。

## 检查结果与动作

| 技能状态 | 面板状态 | 动作 |
|---|---|---|
| `update` | `update` | 分别更新技能与面板 |
| `up-to-date` / `ahead` | `update` | **只更新面板，不下载或覆盖技能** |
| `update` | `up-to-date` / `ahead` | **只更新技能，不重装面板** |
| `up-to-date` / `ahead` | `up-to-date` / `ahead` | 无需更新 |
| 任意 | `not-installed` | 按安装流程装面板；技能仅在自身 `update` 时更新 |
| 任意 | `unknown` | 先跑 doctor，不把版本缺失或读取失败当成可更新 |

更新前介绍和更新后总结从远端说明书选取本次实际覆盖的条目：技能按本地与远端的 `skill-version` 区间选择，面板按 **`kcm/VERSION` 与远端 `patch-version`** 区间内各条目的「配套补丁」选择；两者取并集并去重。即使技能版本没变，也要介绍面板实际跨过的条目。跨多个版本时合并重要变化，不逐条念完整日志。先用人话说明主要更新，**等用户同意**再动；用户不需要时不要反复推销。

用户主动要求更新时，也先运行检查并用一两句话说明实际变化，再按表中动作执行；`SUMMARY 无需更新` 时不要重装任何组件。

## 升级动作（用户同意后）

只执行检查结果需要的部分，不要预先下载另一组件。

### 技能需要更新时

1. 备份当前技能目录，再从远端说明书的 `skill-download` 下载技能包，先在临时目录解压。核对包内 `MAINTENANCE.md` 的 `skill-version` 等于远端目标版本；不一致则停止，不能覆盖现有技能。
2. 核对无误后覆盖本地技能目录。macOS/Linux 普通目录可 `unzip -o <包> -d ~/.kimi-code/skills/`；若技能目录是符号链接，先解析真实目录，再把临时目录中的包内容写入真实目录，不要直接对链接所在父目录解压。Windows 用 `Expand-Archive <包> -DestinationPath "$env:USERPROFILE\.kimi-code\skills\" -Force`。若本地还是旧路径 `kcm-panel/`，装到新目录后删掉旧目录。
3. 再次读取安装后的本机说明书，确认 `skill-version` 已等于目标版本；不一致则明确报告更新失败，不得宣称成功。

### 面板需要更新或安装时

1. 按 install.md 的环境预检与安装流程走，从同一份远端说明书的 `patch-download` 获取补丁包。
2. 安装前核对包内 `kcm/VERSION`，安装后核对客户端实际 `kcm/VERSION`，都必须等于远端 `patch-version`。幂等安装会重新扫描历史数据。
3. 完成后跑 `bash <技能目录>/scripts/run.sh doctor.mjs`（Windows：`run.cmd doctor.mjs`）确认，并提醒用户重载客户端（macOS Cmd+R，Windows Ctrl+R）。

### 收尾

1. 再跑一次 `check-update.mjs`：本次更新的组件应变为 `up-to-date`，另一组件保持原状态。
2. 汇报哪个组件从哪个版本升到了哪个版本，并概括实际覆盖的主要变化。若其中有面向用户的新功能，说明用途、风险和开启路径；默认关闭的功能同时给出手动开启与 Agent 代开选项。
3. 下载或安装失败时不要硬试、不要换其他来源，直接报告错误；网络不通时告知「网络错误，请稍后重试」。
