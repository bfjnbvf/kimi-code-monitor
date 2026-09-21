# 工作计划 — 桌面补丁安装去 Node 化（零前提安装）

> 日期：2026-09-21 ｜ 状态：**已被取代，仅留档**——B1/B2 未采纳：实测发现客户端自带 Electron 内置 Node（`ELECTRON_RUN_AS_NODE`），最终方案是「install.mjs 唯一逻辑 + install.sh/install.cmd 点火壳」，见 docs/DESKTOP-PATCH.md 与本机交接文档 `docs/HANDOFF.md` §八（该文件不进仓库）｜ 关联：[DESKTOP-PATCH.md](./DESKTOP-PATCH.md)、[PLAN-windows-support.md](./PLAN-windows-support.md)
>
> 一句话结论：把 Node 从「安装前提」降为「可选增强」——用各平台原生工具完成全部安装动作，Node 只在你手边时多跑一次历史预填。本文上半部分是调研依据，下半部分是实施方案。

## 一、结论与建议

**推荐方案 B2**：macOS 用 `install.sh`（bash，系统自带）、Windows 用 `install.ps1`（PowerShell 5.1，系统自带），弃掉 `install.mjs`；Node 仅在存在时被两个原生安装器自动调用一次 `scan.mjs` 预填历史统计。若想保留 `install.mjs` 作为第三条路径，退而求其次选 B1（见 §四）。

## 二、调研发现

### 2.1 安装链路里 Node 到底占了多少

对 `src/panel-app/patch/install.mjs`（约 300 行）的动作逐条盘点：

| 安装动作 | 是否真需要 Node | 原生工具可否完成 |
|---|---|---|
| 参数解析 / 应用发现（平台候选路径 + `--app` + `KIMI_CODE_APP_DIR`） | 否 | ✅ bash 数组 / PowerShell 函数 |
| 备份 `index.html` → `.bak-kcm`（保留最早） | 否 | ✅ `cp` / `Copy-Item` |
| 同步 `kcm/` 载荷目录 | 否 | ✅ `cp -R` / `Copy-Item -Recurse` |
| **载荷哈希**（SHA-256，排除 4 个机器数据文件，排序，取前 8 位） | 否 | ✅ `shasum` / `Get-FileHash` |
| 注入 loader 标签（先剥旧行，首个 `</head>` 前插入） | 否 | ✅ `sed`+`perl` / 字符串拼接 |
| 失败回滚（还原备份 + 删载荷） | 否 | ✅ |
| 卸载（备份还原或剥标签 + 删载荷目录） | 否 | ✅ |
| 客户端版本读取 | 否 | ✅ PlistBuddy / `VersionInfo` |
| **历史预填**（`scan.mjs` 全量扫 wire.jsonl） | **是** | ❌ 唯一真需要 Node 的动作 |
| 余额快照（`fetch-wallet.mjs`） | **是** | ❌ 可选，无凭据时也跳过 |

**关键事实：整个安装链路里只有「历史预填」和「余额快照」两个动作真需要 Node，且两者都是可选的**（缺失时已有正常降级路径：面板从安装时刻开始积累）。其余全部动作用平台原生工具即可完成——`install.sh` 现在就已经是这样（它的 `command -v node` 检查只出现在 scan 和 wallet 两处，失败即跳过）。

### 2.2 各平台运行时预装事实（实测 + 官方文档）

| 能力 | macOS | Windows |
|---|---|---|
| bash | ✅ 系统自带（`/bin/bash` 3.2） | ❌（Git Bash/WSL 不算预装） |
| `shasum` | ✅ | ❌（`certUtil` 输出格式不同，不可直用） |
| `cp -R` / `sed`（BSD） | ✅ | — |
| PowerShell | ❌（可另装 pwsh） | ✅ 5.1 随系统 |
| `Get-FileHash` / `Copy-Item` | — | ✅（PSv3 起） |
| `python3` | ⚠️ 仅为 Command Line Tools stub，装完 CLT 才可用 | ❌（微软商店 stub） |
| **Node** | ❌ | ❌ |

推论：**没有一个「单脚本跨两平台且不依赖预装运行时」的选项**——Node/Python 两边都不可靠预装；包里塞 Node 二进制（约 40–100MB × 三平台）否决。唯一可靠形态是**双原生安装器**。

### 2.3 当初为什么选了 Node（以及为什么现在要改）

v3.5.0 把 `install.mjs` 定为双平台主路径，出发点是对的：一套安装器跨平台、逻辑可在 node 里单测（13 个用例）、与 bash 版有黄金哈希互钉。但代价现在显现了：**装机前提从「零」变成「Node ≥16」**。这个代价在早期可接受（彼时用户画像偏开发者），但面板现在的目标用户是 Kimi 桌面客户端的一般用户——非开发者没有 Node，装机要多跨「装运行时」这道坎（官网 pkg / brew / winget，可能涉及 UAC、路径配置、重启终端）。

### 2.4 Windows 侧的纸屑（全部有解，需在脚本/文档里处理）

1. **执行策略**：`powershell -File install.ps1` 可能被执行策略拦截。文档命令统一给 `powershell -ExecutionPolicy Bypass -File <路径>\install.ps1`。
2. **Zone 标记（Mark of the Web）**：从网上下载的 zip 解压出的 `.ps1` 可能带 `Zone.Identifier`，PowerShell 默认拒绝运行。脚本首行 `Unblock-File -LiteralPath $PSCommandPath` 自处理（失败不影响继续）。
3. **排序文化敏感性（最易埋雷）**：PowerShell 的 `Sort-Object` 默认按当前文化排序，与 bash 管线的字节序**不一定一致**——哈希行排序必须显式用字节序：`[System.Array]::Sort($lines, [System.StringComparer]::Ordinal)`。这是与 bash 安装器算出同一个 8 位黄金哈希的前提。
4. **路径分隔符**：哈希行格式是 `./relative/path`（find 风格，正斜杠）。ps1 里遍历得到的 `\` 路径必须 `Replace('\','/')` 后再拼行。
5. **哈希大小写**：`Get-FileHash` 输出大写十六进制，bash 管线是小写——必须 `.ToLower()` 后才拼行。
6. **CRLF**：客户端 `index.html` 在 Windows 上可能是 CRLF。读取用 `-Raw` 原样保留，只插入一个 LF 结尾的标签行（与 `install.mjs`/bash 版行为一致，不做行尾转换）。
7. **注入用字符串拼接而非正则**：按 `IndexOf('</head>')` 切分拼接，避免正则转义类问题（与 install.mjs 同法）。
8. **载荷定位**：用 `$PSScriptRoot` 找同目录的 `kcm/` 载荷，不依赖当前工作目录。

## 三、方案对比

| 维度 | A 维持现状 | **B1 双原生 + 保留 mjs** | **B2 双原生 + 弃 mjs** | C 包内带 Node | D Python 单脚本 |
|---|---|---|---|---|---|
| 装机前提 | Node ≥16 | 零 | 零 | 零 | 零 |
| 安装器数量 | 1（mjs）+ 1 遗留（sh） | 3 | 2 | 1 + 二进制 | 1 |
| 跨平台单测资产 | ✅ 13 用例 | ✅ 保留 | ❌ 需迁移到双平台 CI | ✅ | ✅ |
| Windows 主路径测试 | ✅（node 侧） | ✅ | ✅（windows-latest CI） | ✅ | ✅ |
| 分发体积 | 490KB | ~495KB | ~495KB | 40–100MB | 490KB |
| 长期维护 | 一套逻辑 | 三套入口、逻辑双份 | 两套入口、逻辑双份 | 一套逻辑 | 一套逻辑 |
| 工作量 | 0 | ~2–2.5 天 | ~2.5–3 天 | ~1 天但否决 | 不可靠否决 |

**A 的问题**：每次新用户装机多一道「装 Node」；非开发者用户被劝退。
**B1/B2 的核心代价**：安装逻辑从一份变两份（sh + ps1）——用 §五 的测试策略把漂移风险钉死。
**B2 优于 B1**：最终态最干净（每平台一个原生安装器、无第三个入口），且逼着把两个原生安装器都补上真机 CI 覆盖——注意 `install.sh` 至今只有黄金哈希对着 bash 管线、**没有全流程集成测试**（它的全流程只在生产里跑过），这个洞在 B2 里必须补。

## 四、实施方案

### 4.0 阶段总览（B2，共约 2.5–3 天；B1 跳过 Phase 5）

| 阶段 | 内容 | 产出 / 验收 | 预估 |
|---|---|---|---|
| P0 脚手架 | fake-app 测试 fixture 整理成双平台可复用；CI 增加 windows-latest 作业骨架 | fixture 与断言参数化（路径、哈希、标签） | 0.5 天 |
| P1 install.ps1 | 按 §2.4 逐条实现：参数/发现/备份/同步/哈希（ordinal 排序）/注入/回滚/卸载/版本读取；Unblock-File 自处理 | 本机无法跑（Mac 开发）——由 P3 的 Windows CI 验证；先做语法与逻辑走查 | 1 天 |
| P2 install.sh 全流程测试 | 把 `tests/patch-install.test.js` 的集成用例移植一份到 bash：装→幂等→卸（`index.html` 逐字节还原）、备份沿用、无效目录退出码 | macOS/ubuntu CI 可跑；覆盖此前只有黄金哈希的缺口 | 0.5 天 |
| P3 Windows CI + 哈希互钉 | windows-latest 作业跑 install.ps1 全流程；**两个原生安装器对同一 fixture 必须算出同一个黄金哈希**（f6b964f9） | 双平台 CI 全绿即验收 | 0.5 天 |
| P4 文档与技能 | 见 §六清单 | README 提示词按平台分叉；技能安装流程更新；MAINTENANCE bump | 0.5 天 |
| P5 弃 install.mjs（仅 B2） | 删 `src/panel-app/patch/install.mjs`；其 13 个用例中：路径发现纯函数测试、黄金哈希测试弃（改为两安装器互钉）；装/卸/幂等集成用例已由 P2/P3 的双平台版本覆盖 | `npm test` 全绿；zip 内容不再含 install.mjs | 0.5 天 |
| P6 发布 | 按 HANDOFF §八：版本三处 + CHANGELOG + 双 zip；**用户确认后** commit/tag/Release | 发版守卫测试绿 | 0.5 天 |

### 4.1 install.ps1 行为规格（与 install.sh / install.mjs 逐条对齐）

```
参数：      -Uninstall [switch]；-App <string>；环境变量 KIMI_CODE_APP_DIR 同参
发现：      -App > KIMI_CODE_APP_DIR > 候选（%LOCALAPPDATA%\Programs\Kimi Code、
            C:\Program Files\Kimi Code、D:\kimi_code\Kimi Code）；判据 = 候选\resources\desktop-dist\index.html 存在
备份：      index.html.bak-kcm 不存在才创建（保留最早）；无备份卸载时只剥标签
载荷：      Remove-Item -Recurse -Force 旧 kcm\；Copy-Item -Recurse 新载荷；
            旧版 vibepal\ 目录（v3.5 前）若存在一并清除
哈希：      Get-FileHash -Algorithm SHA256，排除 usage-daily.js / wallet.js / fetch-wallet.mjs；
            行格式 "<小写hex>  ./<正斜杠相对路径>"；[StringComparer]::Ordinal 排序；
            整体 SHA256 取前 8 位（黄金值必须与 bash 版一致）
注入：      剥旧行（含 /kcm/loader.js 与 /vibepal/loader.js 的行）；首个 </head> 前插
            "      <script src=\"/kcm/loader.js?v=哈希\"></script>\n"；写入后校验，失败回滚
Node 增强：  command -v 等价物（Get-Command node）存在且 sessions 目录存在 → 跑 scan.mjs 预填；
            fetch-wallet.mjs 同理；缺失皆跳过并明说
版本：      (Get-Item "<root>\Kimi Code.exe").VersionInfo.ProductVersion，取不到为 ?
卸载：      备份还原（或剥标签）+ 删 kcm\ 与 vibepal\
```

### 4.2 Node 的最终定位

- 安装器本身：不再需要
- 历史预填 / 余额快照：有 Node 自动多做这两步，没有就跳过（降级话术 faq.md 已有）
- 技能自检 `doctor.mjs`：需要 Node；无 Node 时 macOS 用 `doctor.sh`（bash 版随包保留），Windows 无 bash——该场景下降级到「页面内诊断串」（doctor.md 的保险一/三本来就不依赖脚本）。**不接受降级的话需再写 `doctor.ps1`（+0.5 天，本次不建议）**

## 五、测试策略（防双安装器漂移的生命线）

1. **黄金哈希互钉**：fixture 载荷的 8 位哈希 `f6b964f9` 已由 bash 管线产出并钉在现有测试里；改造后由三个安装器（sh / ps1 / 弃用前的 mjs）对同一 fixture 分别计算，必须三方一致。
2. **全流程集成测试双平台各一份**（fake-app + `--app` 指向临时目录）：安装 → 标签就位且哈希一致 → 重装逐字节不变 → 卸载还原逐字节 → 无效目录非零退出。
3. **CI matrix**：ubuntu（或 macos）作业跑 `install.sh` 全流程 + `npm test`；windows-latest 作业跑 `install.ps1` 全流程。GitHub Actions 对公开仓库免费，仓库已是公开。
4. **本机不可跑 ps1**（开发机是 Mac）——P1 阶段只做静态走查，真实验收完全押给 P3 的 Windows CI；合入前必须见 Windows 作业绿。

## 六、文档与技能改动清单

| 文件 | 改动 |
|---|---|
| README.md / README.en.md 头部提示词 | 删「确认有 Node」必选步；安装命令按平台分叉（macOS `bash install.sh` / Windows `powershell -ExecutionPolicy Bypass -File install.ps1`）；Node 改为一句「有则顺带预填历史统计」 |
| docs/SKILL-INSTALL.md | 同上；⚠ 坑位换成 Windows 执行策略 / Zone 标记两条 |
| skill/references/install.md | §2 步骤重写：按平台选安装器；node 检查从「前提」改为「可选增强」；输出核对项不变 |
| skill/SKILL.md | 组件速览与脚本说明更新（install.mjs → install.sh / install.ps1）；doctor 的无 Node 降级路径写进 doctor.md |
| docs/DESKTOP-PATCH.md | 安装/卸载提示词按平台分叉 |
| docs/HANDOFF.md | §二 命令表（zip 内容）、§八 发版流程 |
| skill/MAINTENANCE + CHANGELOG | skill-version bump + 条目；下版本 changelog（「安装零前提：双原生安装器，Node 退为可选」） |
| build-patch.mjs | zip 内容增删 install.ps1（B2 删 install.mjs） |

## 七、风险与缓解

| 风险 | 缓解 |
|---|---|
| 双安装器行为漂移（哈希不一致/标签格式差异） | 黄金哈希三方互钉 + 双平台 CI 全流程 |
| PowerShell 文化排序致哈希与 bash 不一致 | 显式 `[StringComparer]::Ordinal`，代码注释标明原因 |
| CRLF / 编码问题改坏 index.html | `-Raw` 读写、只插 LF 标签行、卸载逐字节还原断言 |
| 执行策略 / Zone 标记拦 ps1 | `-ExecutionPolicy Bypass` 进文档命令；脚本首行 Unblock-File 自处理 |
| B2 弃 mjs 后失去本机可跑的跨平台测试 | 双平台 CI 顶上；合入门槛设为 Windows 作业必须绿 |
| install.sh 补测试时发现隐藏 bug |  Phase 2 的价值正在于此；发现即修，测试同步钉住 |
| 无 Node 的 Windows 用户失去技能自检脚本 | 降级到页面内诊断串（一等公民）；doctor.ps1 列为未来可选项 |

## 八、待决策点（开工前需拍板）

1. **B1 还是 B2**：install.mjs 保留为第三路径，还是弃掉换最干净的终态？
2. **Windows CI 作业**：加（B2 必须；B1 也强烈建议，否则 ps1 是唯一无测试的路径）。
3. **doctor.ps1**：本次不做（接受降级），还是接受 +0.5 天一并做掉？
4. **install.sh 的旧版标签剥离**：保留现有「/vibepal/ 与 /kcm/ 都剥」逻辑（内部版本从未发布，其实可简化只剥 /kcm/）——倾向简化，减少无谓兼容代码。
