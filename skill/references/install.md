# 安装 / 重装 / 卸载

## 0. 环境预检（一切安装动作的第一步）

先弄清两件事：**你现在（Agent）跑在哪里**、**这台机器上有没有 Kimi Code 桌面客户端**。三种情况，处理不同：

### 判定方法

1. 你是否运行在 Kimi Code 客户端里——查父进程链上有没有 Kimi Code.app：

   ```bash
   p=$$; found=0
   while [ "$p" -gt 1 ]; do
     p=$(ps -o ppid= -p "$p" | tr -d ' '); [ -z "$p" ] && break
     ps -o command= -p "$p" 2>/dev/null | grep -q "Kimi Code.app" && found=1 && break
   done
   [ "$found" = 1 ] && echo "在客户端内" || echo "不在客户端内"
   ```

2. 本机是否装有客户端：

   ```bash
   ls -d "/Applications/Kimi Code.app" "$HOME/Applications/Kimi Code.app" 2>/dev/null
   ```

   （要连"客户端是否正在运行"一起查，直接跑 doctor.sh。）

### 三种情况

- **A. 你就在 Kimi Code 客户端里**（最佳）：正常走下面的流程，装完提醒用户重载本客户端。
- **B. 你在别的工具里，本机装有客户端**：可以安装——安装只是对本机客户端目录做文件操作，与你在哪个工具里无关。但必须先向用户说明白：「我现在运行在（当前工具）里，将给这台电脑上的 Kimi Code 桌面客户端安装面板；装好后要在 Kimi Code 客户端里查看。」征得同意后继续。
- **C. 本机没有客户端**：不要安装。直接告诉用户「这台电脑上没有检测到 Kimi Code 桌面客户端，这个面板是装在它里面的」，流程到此为止。用户如果其实用的是网页版 Kimi，可以提一句那是 Chrome 扩展的事（另一条产品线，见仓库 README）。

## 1. 本技能自身的安装（仅首次，A/B 情况下）

用户把仓库地址发给你时，先完成技能安装，再走面板安装流程：

1. 从 GitHub 拉取技能文件（raw 直链，主分支 `main`）：
   - `skill/SKILL.md`、`skill/MAINTENANCE`
   - `skill/references/` 下全部 `.md`
   - `skill/scripts/` 下 `doctor.sh`、`fetch-external.mjs`
   直链形如 `https://raw.githubusercontent.com/bfjnbvf/kimi-code-monitor/main/skill/SKILL.md`。
2. 安装到用户级技能目录：`~/.kimi-code/skills/kcm-panel/`（保持 SKILL.md 在根、references/ 与 scripts/ 在旁）。已存在则先比对 MAINTENANCE 的 skill-version，按 update.md 处理。
3. 告诉用户技能已就位，新会话（或重启客户端）后可持续使用。

拉取失败（网络不通）时不要硬试：向用户说明无法连接 GitHub，询问是否使用本地已有的技能文件或补丁包继续，并提示本地版本可能过旧、与当前客户端可能不适配的风险。

## 2. 面板安装（先自我介绍、再征得同意；话术见 guide-scripts.md）

1. **确定补丁包**：GitHub Releases 最新版
   `https://github.com/bfjnbvf/kimi-code-monitor/releases` 的
   `kcm-desktop-patch-v<版本>.zip`。与 MAINTENANCE 的 patch-version 对照，别装旧包。
2. **下载并解压**到临时目录。下载失败 → 同上面的网络回退说明。
3. **执行**：`bash install.sh`（客户端不在默认位置时 `bash install.sh --app "<路径>"`）。
4. **核对输出**应包含：客户端路径、备份（新建或已存在）、载荷同步、`[scan]` 扫描摘要（文件数/天数）、`历史统计已预填` 或明确的跳过原因、`完成（载荷 v=…）`。任何一行报错 → 停止并原样上报。
5. **跑一遍外部自检**：`bash <技能目录>/scripts/doctor.sh`，全部 PASS 才算装好。
6. **提醒用户重载客户端**（Cmd+R），然后按 guide-scripts.md 做首装引导。

注意：全新机器没有历史会话时，`install.sh` 会跳过预填并明说——这是正常分支，不是故障；面板会从安装时刻开始统计。

## 3. 重装（客户端更新后面板消失 / 自检发现文件缺失）

与首次安装完全相同的流程（install.sh 幂等）。要向用户说明两点：历史会重新扫描补齐、页面内积累的数据在客户端自己的存储里不受影响。

## 4. 卸载

用户明确要求时：

1. 在补丁解压目录（或重新下载补丁包解压）执行 `bash install.sh --uninstall`。
2. 核对输出：已还原原始 index.html（或已移除注入行）、补丁目录已删除。
3. 告知：面板写在页面存储里的少量配置（布局等）仍留在客户端用户数据里，不影响运行；彻底清掉需要用户在客户端里自行清除站点数据。
