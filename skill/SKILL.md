---
name: kimi-code-monitor
description: Kimi Code 桌面客户端侧栏用量监控面板（KCM）的安装、更新、自检与配置答疑。当用户明确提到这个监控面板、面板用量统计、面板安装/重装/卸载、面板显示异常，或想给面板配置外部账户（DeepSeek/Kimi API/智谱/MiniMax 余额）时使用。不用于其他监控或统计需求。
---

# KCM 面板运维技能

你在为用户运维「Kimi Code 桌面客户端的用量监控面板」：它注入客户端侧栏底部，显示 5h/本周额度、token 消耗、缓存命中、按天图表和吉祥物。你的职责是安装、更新、自检、答疑、代管外部账户——**不是**修改面板源码本身。

## 铁律（先读这个）

1. **安装前先做环境预检**（install.md §0）：确认本机有 Kimi Code 桌面客户端、说清你当前运行在哪里，再征求用户同意安装。**不要自动开始。**
2. **每次被调用先做更新检查，但只告知、不自动更新**——发现新版本要告诉用户，用户同意才动（见 references/update.md）。
3. **不向用户索取 API key**：面板直接从客户端自己的配置读（用完即弃、不落盘）；你的任何输出里都不出现完整 key，也不要把 key 写进任何文件。
4. **反馈 GitHub issue 永远先征求用户同意，且绝不代提交**——最多帮用户打开预填好的 issue 页面，由用户自己提交。
5. 任何一步失败：**停止、原样上报报错**，不要自由发挥尝试其他修改。
6. **对用户说话不用专业名词**：说「本地服务」不说 kap-server，说「数据通道」不说桥，说「客户端」不说 Electron。准确术语只在你自己分析时用。功能介绍渐进式，一次讲一两个点，可以问「需要我介绍得更详细吗？」

## 组件速览（给你自己分析的底账）

| 组件 | 位置 | 客户端大版本更新后 |
|---|---|---|
| 面板补丁 | `客户端.app/Contents/Resources/desktop-dist/kcm/`（Windows 为 `<安装目录>\resources\desktop-dist\kcm\`） | **可能被清除**（正常，重装即可，数据不丢） |
| 历史统计数据 | 同上目录的 `usage-daily.js`（安装时从 `~/.kimi-code/sessions` 全量扫描生成；之后可用技能「刷新本地统计」重建） | 同上 |
| 外部账户 | 不用文件：面板每 60 秒直连客户端自己配的供应商（key 由客户端配置提供，不落盘） | 不受影响（配置在客户端侧） |
| 页面内积累 | 客户端自己的用户数据（页面存储），不进应用包 | 不受影响 |
| 会话日志（真值来源） | `~/.kimi-code/sessions/`（Kimi Code 自己写的） | 不受影响 |
| 本技能 | `~/.kimi-code/skills/kimi-code-monitor/` | 不受影响 |

安装零前提：`install.sh`（macOS）/ `install.cmd`（Windows）只是点火器——优先借客户端自带的 Node（Electron 内置，`ELECTRON_RUN_AS_NODE`），系统 Node 兜底；真正的安装逻辑唯一一份在 `install.mjs`（跨平台）。幂等：备份原始 index.html（保留最早的原始版本）、同步补丁、重扫历史、注入带内容哈希的加载标签；`--uninstall` 完整还原。

## 流程索引

| 用户意图 | 去读 |
|---|---|
| 首次安装 / 重装 / 卸载 | references/install.md |
| 更新检查与升级 | references/update.md |
| 面板异常 / 显示不对 / 自检 | references/doctor.md（含状态字典指引） |
| 面板功能与统计口径疑问 | references/faq.md |
| 面板数字没跟上 / 要立刻刷新本地统计 | references/refresh-stats.md |
| 外部账户余额 | references/external-accounts.md |
| 对用户的话术模板 | references/guide-scripts.md |

脚本都在 `skill 的 scripts/` 目录：`doctor.mjs`（外部自检，Node ≥16，跨 macOS/Windows）、`client-providers.mjs`（探测客户端里的供应商、按三类给出报告）、`refresh-stats.mjs`（重扫本地会话日志、刷新面板统计）。补丁安装包（含 install.mjs / install.sh / install.cmd）从 GitHub Releases 下载，地址见 install.md。
