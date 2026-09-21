# 工作计划 — 桌面补丁 Windows 适配

> 日期：2026-09-21 ｜ 状态：**P1–P3 已完成（待验证），P4 Windows 真机验证待机器** ｜ 关联：[DESKTOP-PATCH.md](./DESKTOP-PATCH.md)、[HANDOFF.md](./HANDOFF.md) §八
>
> 前置结论：Kimi Code 桌面客户端 2026-09-18 官方发布，**macOS 与 Windows 双平台**（[开源中国报道](https://www.oschina.net/news/502565/kimi-code-desktop)）。Windows 适配不是「等客户端」，是直接开工项。
>
> 实施方式（对「同脚本还是双文件」问题的决策）：**同一个 install.mjs，平台差异收敛在三个纯函数**（appRootCandidates / distDirOf / readClientVersion），doctor.mjs 同构；参考项目 [Link3750/kimi-code-usage-widget](https://github.com/Link3750/kimi-code-usage-widget) 的 Windows 候选路径（%LOCALAPPDATA%\Programs、C:\Program Files、D:\kimi_code）已纳入。

## 一、背景与目标

补丁当前全链路仅支持 macOS：`install.sh` 的应用发现、路径、工具链（BSD sed / shasum / cp -RX / PlistBuddy）全部 macOS 专有；`doctor.sh` 同理。面板运行时代码（loader / panel-app / direct / scan.mjs / content.css / rive）不认平台，天然可带走的占大多数。

**目标**：

1. Windows 用户可用同款补丁（安装 / 卸载 / 自检 / 技能引导全流程）
2. 一套安装器跨双平台——维护不翻倍，路径发现等纯逻辑进 `npm test`

**非目标**：Windows 独有功能；自动更新守护进程（macOS 也没有，靠技能重装引导）；任何运行时代码改动；扩展（Chrome）侧零影响。

## 二、方案决策

| 选项 | 做法 | 取舍 |
|---|---|---|
| **选项 1（采纳）** | 安装器 node 化：`install.sh` → `install.mjs`，`doctor.sh` → `doctor.mjs`，一套代码双 OS 路径发现 | 安装前提新增 Node（scan.mjs 今天就已要求 Node，且分发模型是技能引导安装，无 node 时明确引导而非静默失败）；长期一套逻辑零漂移 |
| 选项 2（备选，记录在案） | 保留 bash + 新增 `install.ps1` | Windows 用户零依赖开箱即装；但哈希 / 幂等 / 备份还原两套逻辑永久双倍维护，正是要避免的漂移 |

采纳理由：与「减少后期维护工作量」的目标一致；安装逻辑可拆纯函数直接单测；Node 在 Kimi Code 用户群（CLI 走 npm 分发）覆盖率极高，技能安装流程可检测并引导。

## 三、改造范围

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/panel-app/patch/install.sh` | 重写为 `install.mjs` | 见 §四 Phase 1 |
| `skill/scripts/doctor.sh` | 重写为 `doctor.mjs` | 检查项不变，路径与版本读取跨平台 |
| `scripts/build-patch.mjs` | 拷贝 `install.mjs` 替代 `install.sh`（去掉 chmod） | zip 内容：`install.mjs` + `scan.mjs` + `kcm/` |
| `skill/references/install.md` | 命令 `bash install.sh` → `node install.mjs`；加 node 前置检查；Windows 路径与 Ctrl+R 话术 | 安装提示词同步 |
| `skill/references/update.md` / `doctor.md` / `guide-scripts.md` | Windows 分支话术 | 更新流程引用 install.md，改动集中 |
| `tests/` | 新增安装器路径逻辑测试（风格对齐 `patch-scan.test.js`） | findAppRoot / payloadHash / 标签注入等纯函数 |
| `loader.js` `panel-app.js` `direct.js` `accumulate.js` `bridge.js` `scan.mjs` `content.css` `rive/` | **不动** | 浏览器 JS 与 Node 脚本本就跨平台（scan.mjs 已用 `os.homedir()`） |

## 四、阶段拆解与验收

| 阶段 | 内容 | 产出 / 验收 | 预估 |
|---|---|---|---|
| **P0 侦察** | Windows 机器装官方客户端，逐项填 §五 表 | 四项未知数有实测结论；结论回填本文档 | 0.5 天 |
| **P1 install.mjs** | 双 OS 应用发现（多候选 + `--app` 覆盖 + `KIMI_CODE_APP_DIR`）；备份/还原、载荷同步、SHA-256 载荷哈希（与旧 bash 管线黄金值对齐）、`</head>` 前注入标签、`--uninstall`；调 `scan.mjs` 预填历史；node 缺失时的明确报错与引导 | ✅ 已完成：`src/panel-app/patch/install.mjs`；macOS 全流程与旧 `install.sh` 行为等价由 `tests/patch-install.test.js` 覆盖（装/幂等/卸逐字节还原、黄金哈希、预填） | 1.5 天 |
| **P2 doctor.mjs** | 检查项逐一平移（文件完整性 / 标签与哈希 / 数据文件 / kap 探测）；客户端版本读取跨平台（macOS 解析 Info.plist；Windows PowerShell 读 exe 版本信息） | ✅ 已完成：`skill/scripts/doctor.mjs`（自包含，输出格式与 bash 版一致；哈希与安装器一致性有测试互钉） | 0.5 天 |
| **P3 skill 文档** | install / update / doctor / guide-scripts 四篇加 Windows 分支 | ✅ 已完成：四篇 + SKILL.md + MAINTENANCE（skill-version 3）；install.md 含 node 前置检查与双平台命令 | 0.5 天 |
| **P4 真机验证** | Windows 客户端：安装→面板出现在侧栏底部→实时数据（WS+REST）→历史预填→卸载还原；macOS 回归全流程 | ⬜ 待 Windows 机器；验收标准见 §七 | 0.5–1 天 |
| **P5 发布** | 按 HANDOFF §八：版本号三处 + CHANGELOG + 双 zip + skill 同步检查表；**用户确认后** commit/tag/Release | ⬜ 待 P4 通过 | 0.5 天 |

**P1–P3 已完成（代码 + 测试 + 文档），剩 P4 真机验证与 P5 发布。**

## 五、待实测清单（P0 填空）

| # | 项目 | macOS 已知 | Windows 待确认 | 结论 |
|---|---|---|---|---|
| 1 | `desktop-dist` 布局 | `Kimi Code.app/Contents/Resources/desktop-dist` | `%LOCALAPPDATA%\Programs\Kimi Code\resources\desktop-dist`（electron-builder 默认，待验）；备选 `C:\Program Files\...` | 待填 |
| 2 | 页面加载协议 | `app://renderer`（1.0.2 起） | 待填（`file://` 或自定义协议？）——决定 `/kcm/...` 绝对路径是否可加载 | 待填 |
| 3 | kap-server | 内嵌免认证本地服务，WS+REST 实测通 | 同构性待验（curl 额度接口 200 + WS 握手） | 待填 |
| 4 | 自动更新 | 整体替换 desktop-dist，补丁被清后重装 | 行为待验（electron-updater 替换安装目录） | 待填 |
| 5 | 代码签名 | hardened runtime，改 bundle 资源（当前补丁路线实测可运行） | Authenticode 签名不校验 resources 内容，预期风险更低；待验 | 待填 |

## 六、风险与缓解

| 风险 | 缓解 |
|---|---|
| Windows 布局假设错误（第 1 项） | 路径发现多候选 + `--app` 参数；P0 先侦察再施工 |
| 用户无 Node 环境 | `install.mjs` 不可运行时的报错写明引导（winget / nodejs.cn）；技能安装流程前置 `node -v` 检查；scan.mjs 子进程用 `process.execPath` 不依赖 PATH |
| 页面协议差异导致资源 404 | P0 第 2 项验证；失败则 loader 资产路径加相对回退（与 kap 源三级回退同思路） |
| 双平台安装器行为漂移 | 纯函数单测 + macOS 等价性验收（P1）每次改动都跑 |
| 旧版 bash 安装器用户 | 见 §七 回退策略 |

## 七、回退策略

`install.mjs` 上线后**保留 `install.sh` 一个版本周期**（scripts/build-patch.mjs 两个都打，技能默认引导 node 安装器、注明 bash 为旧版兼容）；Windows 真机验证通过、macOS 等价性无回归后，下一个大版本删 `install.sh`。任何阶段出问题可单独回退安装器，不动运行时代码。

## 八、发布检查（按 HANDOFF §八）

1. 版本号三处一致（`manifest.json` / `package.json` / `skill/MAINTENANCE` 的 `patch-version`）+ CHANGELOG 顶部条目——`tests/release-sync.test.js` 自动把关
2. skill 同步检查表：install/update/doctor/guide-scripts 四篇本轮有变更 → bump `skill-version` 并在 MAINTENANCE 加条目
3. `npm test` 全绿 → `npm run pack` + `npm run pack:patch` 双产物
4. **用户确认后** commit / tag / GitHub Release（补丁 zip 随 Release 分发）
