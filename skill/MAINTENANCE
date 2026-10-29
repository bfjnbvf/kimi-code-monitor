skill-version: 13.1
patch-version: 3.6.0
repo: https://github.com/bfjnbvf/kimi-code-monitor
skill-download: https://github.com/bfjnbvf/kimi-code-monitor/releases/download/v3.6.0/kimi-code-monitor-skill.zip
patch-download: https://github.com/bfjnbvf/kimi-code-monitor/releases/download/v3.6.0/kcm-desktop-patch.zip

# 更新记录

## 13.1（2026-10-29）

配套补丁 3.6.0：

- **更新地址收口到说明书**：新增 `skill-download` 与 `patch-download`；新版技能同时检查技能和面板版本，并从说明书读取实际下载地址，不再写死面板附件文件名
- **更新介绍读取远端记录**：更新前介绍和更新后总结均按本次实际覆盖的说明书条目生成，不再为特定功能预写本地话术
- **主说明书改为 `MAINTENANCE.md`**：旧 `MAINTENANCE` 在过渡期同步保留，旧版技能仍可正常检查和下载更新
- **旧附件名继续可用**：本版 Release 的桌面补丁与技能包保留 `kcm-desktop-patch.zip`、`kimi-code-monitor-skill.zip`
- **下载来源校验**：两个下载地址必须经过 URL 归一化与完整路径校验，拒绝路径穿越、编码斜杠和非官方来源
- **升级结果核验**：技能与补丁均在安装前核对包内版本、安装后复核实际版本；版本号按小数点分段比较，技能目录为符号链接时写入真实目录
- **发布守卫补强**：说明书顶条同时核对技能与补丁版本，检查 lockfile 版本、两份说明书同步及四个发行包完整性

## 13（2026-10-27）

配套补丁 3.6.0：

- **缓存提醒文档与升级介绍**：默认关闭；先说明上下文缓存失效后重新处理会消耗更多额度，再介绍侧栏 25–29 分钟标黄和宠物 29–30 分钟黄色一分钟提示；准备继续对话时续上可减少不必要的额度消耗，不必为保缓存专门发消息；升级后主动介绍用途、手动/Agent 代开方式及风险（时间仅为本机预估，官方可能调整，仅供参考，不保证节省额度）
- **移除缓存提醒预览**：宠物菜单只保留开关；SKILL / FAQ / 状态字典 / 更新话术同步

## 12（2026-10-26）

配套补丁 3.6.0：

- **新增对话缓存提醒（桌面端）**：侧栏会话列表里 25–29 分钟的空闲时间标黄；最后一轮模型请求后 29–30 分钟，宠物球持续变黄/琥珀（与警示文案同色），宠物四槽显示「对话缓存 / 即将过期 / 预估剩余 / 1:00 倒计时」；30 分钟恢复常规外观和数据显示。阈值是按本机实测约 30 分钟有效 TTL 的估算，文案带「预估」
- **status-dictionary 补缓存提醒状态**；宠物 ≡ 菜单新增「缓存提醒」开关
- angryface / angryeye 不再作为点击彩蛋；缓存提醒改用黄色/琥珀外观

## 11（2026-10-18）

配套补丁 3.5.4：

- **更新流程补两条软指令**（update.md）：用户主动要求更新时，先拉远端更新记录、用一两句话简要说明这个版本改了什么再动手；升级完成后收尾汇报一句「哪个版本升到哪个版本、主要改了什么」，说主要的就行，不用贴完整日志
- **技能脚本修 kap 鉴权**（client-providers.mjs / doctor.mjs / doctor.sh + 新增 src/kap-auth.mjs）：客户端 2.x 起所有 /api/v1/* 都要求 Bearer 令牌，三个脚本裸调全部 401——provider 探测报「探测不到客户端」、doctor 的本地服务检查 FAIL。改为读 ~/.kimi-code/server.token（KIMI_CODE_HOME 可改根）带头请求，读不到时裸调（老客户端无鉴权，向后兼容）
- 配套（面板侧）：外部账户新增**阶跃星辰 StepFun** 适配（GET api.stepfun.com/v1/accounts，余额/充值/赠送）；external-accounts / SKILL.md / guide-scripts 的供应商清单同步

## 10（2026-10-18）

配套补丁 3.5.3：

- **加油包余额通路描述改正**（faq.md / external-accounts.md / doctor.sh）：3.5.3 起桌面端标题行余额改读 kap 的 extraUsage 活数据（每 60s，失败沿用上次成功值），wallet.js 快照降级为兜底（活数据未到位 / 客户端没在运行 / 用户刚刷新过时显示）。「余额怎么不变化」的答疑从「那是快照」改为活数据口径；doctor 的快照检查措辞同步
- 补丁 3.5.3 另含（与扩展同源码，随 v3.5.3 发版；均为配套小修复，不影响技能行为与文档）：子代理总览按模型合并为一行（同模型多实例名称标 ×N，200 个代理从 200 行变 1 行）；收藏消毒器补 base/style/SMIL 与全属性 URL 拦截；外部账户状态时间注入修 flaky 测试；开发依赖 undici 升级

## 9（2026-09-28）

配套补丁 3.5.2：

- **首装引导补充「客户端更新后需重装」的预告**（guide-scripts.md）：客户端大版本更新会清除面板文件，面板消失属正常，重跑一次安装即可恢复、数据不丢——安装时就告知，避免用户日后误以为故障
- **安装器完成时输出同一条提示**（install.mjs）：跑安装的用户在终端即可看到
- **SKILL.md 触发描述补「面板消失不见（如客户端更新后）」**：用户说「面板没了/不见了」时能正确路由到本技能
- 补丁 3.5.2 另含（与扩展同源码，随 v3.5.2 发版）：options 标签页活跃热力图溢出盖住指标下拉框的修复（issue #10）；桌面端宠物 ≡ 菜单移除「侧栏改造」死开关（独立面板本就不生效）

## 8（2026-09-21）

配套补丁仍为 3.5.0（内容合并进同日发版）：

- **安装零前提**：安装入口改为 `install.sh`（macOS）/ `install.cmd`（Windows，可双击）——优先借客户端自带的 Node（Electron 内置），系统 Node 兜底；不再要求用户装 Node。安装逻辑唯一保留在 install.mjs
- **外部账户改为自动跟随客户端供应商配置**：不再代查、不向用户索取 key；新增 `scripts/client-providers.mjs`（探测 + 三类分类报告，含"不支持余额查询"话术），删除 `fetch-external.mjs` 与 external.js 兜底快照
- 新增 `scripts/refresh-stats.mjs` 与 `references/refresh-stats.md`：「刷新本地统计」一句话入口（补丁载荷自带 `kcm/scan.mjs` 原地重写）
- 技能脚本用 esbuild 打成零依赖单文件（修复已装技能跑不起来的问题）；doctor 的外部账户检查改为"残留旧快照提示重装"
- faq / guide-scripts / SKILL-INSTALL 话术全面对齐当前行为（key 相关、代查相关、表头时间）
- Windows 安装两则修复（用户实测反馈）：install.cmd 改纯 ASCII + CRLF（GBK 代码页下 UTF-8 中文注释被 cmd 按字节切分成垃圾命令，Git Bash 场景无法执行）；客户端装在系统目录且未提权时，安装器先做可写性预检并给出管理员运行指引，不再裸抛 EPERM 堆栈；install.md 的 Windows 预检标注 Git Bash 的 ps 不可用


## 7（2026-09-21）

首装引导的「编辑模式详解」补第二步：每个模块右上角的 ≡ 小菜单，点击可调该模块的专属设置（图表范围/倒计时格式/匀速参照线/宠物数据位/小球跳转等）。

## 6（2026-09-21）

首装引导补一句：先介绍「点一下面板底部可收起/展开」，再讲原来的长按进入编辑模式。

## 5（2026-09-21）

分发方式改为 Release 技能包：安装/更新走固定名直链 `releases/latest/download/kimi-code-monitor-skill.zip`（解压即就位），raw 逐文件拉取降级为备选；入口文档为仓库 docs/SKILL-INSTALL.md。面板补丁同样改固定名（kcm-desktop-patch.zip）。安装目录变更：`~/.kimi-code/skills/kimi-code-monitor/`（旧 `kcm-panel/` 目录请删）。

## 4（2026-09-21）

技能改名为 `kimi-code-monitor`（原 `kcm-panel`）：安装目录变为 `~/.kimi-code/skills/kimi-code-monitor/`。配套补丁的运行时命名空间由 `vibepal` 改为 `kcm`（载荷目录 / 加载路径 / 全局变量 / 就绪事件全部更名）。面板功能与统计口径不变。

## 3（2026-09-21）

配套补丁 3.5.0：安装器与自检脚本 node 化（install.mjs / doctor.mjs），**新增 Windows 支持**——同一脚本内按平台分支（应用发现 / 路径推导 / 版本读取），安装命令由 `bash install.sh` 改为 `node install.mjs`（需 Node ≥16，包内保留旧 bash 安装器作备选）。面板功能与统计口径不变。

## 2（2026-09-21）

配套补丁 3.5.0（桌面补丁首个完整发版）。面板功能与统计口径不变；内部移除两条停用通路（旧命名管线、VibePal 伴侣 App），已装补丁行为不受影响。

## 1（2026-09-21）

首版技能，配套补丁 3.4.3：

- 面板状态文案改为分级制（加载中 / 从现在统计 / 连接中 / 重试 / 异常），诊断串降为锁位第二行小字
- 诊断六段（路径 / kap / 数据 / WS / 焦点 / 桥）与状态字典
- 外部账户快照模式（fetch-external.mjs，key 不落盘）
- doctor.sh 外部级自检（文件 / 标签 / 哈希 / 本地服务 / 数据文件 / 版本）
- install.sh 幂等安装与完整卸载；安装时全量预填历史（与扩展同一套解析口径）
