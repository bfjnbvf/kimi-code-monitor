# 设计与交接：扩展功能卡片（自动整理 / 自动命名 v2 / 收藏开关）

> 版本规划：v3.4.0 ｜ 文档日期：2026-09-04（同日实现，状态见下）
> **状态：已随 v3.4.0 实现**（§7 步骤 1–6 完成；§8 开放问题 1/2/3/5 仍待页面实测）。实现与本文有出入处以代码为准：判定在 `src/tidy-rules.js`，内容侧执行在 `src/content/session-tidy.js`，popup 在 `src/popup/tidy.js`，调度在 `src/background/tidy.js`。
> 性质：设计文档 + 实施交接文档。读完本文即可开工；实现时只需补「开放问题」一节列出的几项实测。
> 事实来源：本机 kimi web（127.0.0.1:58627）前端 bundle 静态读取（只读，未做任何写操作）+ 另一 agent 对归档/恢复接口的实测。

## 0. 已验证的事实基础

### 0.1 会话归档 API（已核实，可直接复刻）

| 动作 | 端点 | 说明 |
|---|---|---|
| 会话列表 | `GET /api/v2/sessions` | 参数：`sort`（如 `meta.updated_at_desc`）、`page_size`、`page_token`、`page`、`meta.archived`（`"true"`/`"false"`）、`meta.updated_after/before`、`include`（如 `git`）、`workspace.id`、`activity.status` |
| 单个归档 | `POST /api/v1/sessions/{id}:archive`，body `{}` | |
| 批量归档 | `POST /api/v2/sessions:archive`，body `{ids: [...]}` | |
| 单个恢复 | `POST /api/v1/sessions/{id}:restore`，body `{}` | |
| 批量恢复 | `POST /api/v2/sessions:restore`，body `{ids: [...]}` | |

列表项关键字段（原始 API 形态）：`id`、`title`、`created_at`、`updated_at`、`busy`、`main_turn_active`、`pending_interaction`、`last_turn_reason`、`archived`、`archived_at`、`metadata.cwd`、`metadata.parent_session_id`、`current_prompt_id`、`last_prompt`。

要点：

- 「已完成」tab 就是 `archived=true` 的视图；归档/恢复完全可逆，会话内容不受影响（另一 agent 已实测往返）。
- `created_at` / `updated_at` 直接来自列表接口 → **自动整理不依赖 CLI 连接**。CLI 的 `wire.jsonl` 活跃天数留作未来细化，v1 不用。
- 侧栏只显示「无父会话且未归档」的顶层会话（web 客户端按 `parentSessionId` / `archived` 过滤），整理器照做。
- 空会话过滤：`meta.has_prompt` 参数在 `listSessionGroupsV2` 确认存在；V2 平铺列表是否支持需实测（见开放问题），不支持则客户端按 `last_prompt` 为空跳过。

### 0.2 实验性功能（Lab）存储（已核实）

- Lab「多标签页侧栏」的持久化是 **页面 localStorage**：`kimi-web.sidebar-multi-tab`，值 `"1"` / `"0"`。
- web 客户端启动时读一次进内存，设置页切换是「内存 + localStorage」双写。**外部改 localStorage 不会热生效，需刷新页面**。
- 侧栏三个 tab：进行中（Open）/ 已完成（Done）/ 工作空间（Workspaces）。

### 0.3 系统自动命名现状（⚠ 与最初设想有出入）

当前 58627 构建里：

- Lab 区**只有**「多标签页侧栏」一个开关，**没有**「AI session titles」实验开关。
- 存在的是**手动**「生成标题」：右键/重命名菜单里的 `genTitle`，调 `POST /api/v1/sessions/{id}/title/generate`，由服务端生成。前置条件（客户端文案原文）：需要登录 Kimi Code 托管账号，且会话中已有消息。

结论：用户提到的实验性自动命名可能在更新的 CLI 版本里；**本版按当前构建落地**（方案见 §3），并留前向兼容钩子。

## 1. 用户可见设计：扩展功能卡片

popup 现有「宠物」卡片保留独立；新增「扩展功能」卡片承载三个功能（按使用频率排序：收藏 → 归档 → 命名，功能名直述用途），功能名直述用途：

```
┌─ 扩展功能 ─────────────────────────────┐
│ ◉ AI 回复收藏                          │
│ ◻ 自动归档不活跃对话                    │
│   [手动确认 ▾]            [待确认 (5)]  │
│   单日对话，静默 [ 3] 天后归档           │
│   多日对话，静默 [14] 天后归档           │
│   所有对话，静默 [30] 天后归档           │
│ ◉ 新会话自动命名                      │
└────────────────────────────────────────┘
```

| 子块 | 默认 | 迁移 |
|---|---|---|
| AI 回复收藏 | 开 | 存量用户无感（现状即常开） |
| 自动归档不活跃对话 | 关 | 新功能 |
| 新会话自动命名 | 沿用旧设置 `rename.autoEnabled` 的值 | 语义变更见 §3 |

## 2. 自动整理规格

### 2.1 判定规则（纯函数，输入列表项 + 阈值 + 当前时间）

对每个未归档顶层会话计算：

- `idleDays = (now - updated_at) / 86400000`
- `spanDays = (updated_at - created_at) / 86400000`

三档规则（阈值均可调，默认 3 / 14 / 30，范围 1–365）：

| 档位 | 条件 | 含义 |
|---|---|---|
| 单日对话 | `spanDays < 2` 且 `idleDays ≥ T1(3)` | 活跃集中在 48 小时内的短任务，凉 3 天即视为结束 |
| 多日对话 | `spanDays ≥ 2` 且 `idleDays ≥ T2(14)` | 有跨天回访史，要凉得更久才动 |
| 所有对话 | `idleDays ≥ T3(30)` | 兜底，不论跨度 |

命中任意一档即为候选，展示理由取最先命中的档位。不强制 `T1 ≤ T2 ≤ T3`（各档独立判断，乱设只会影响理由归属，不会漏判/误伤）。

### 2.2 护栏（先于规则判断）

跳过以下会话，绝不归档：

1. `busy` / `main_turn_active` / `pending_interaction` 为真（正在工作或等待用户响应）
2. `archived` 已为真（只处理「进行中」）
3. `metadata.parent_session_id` 存在（子会话，归档动作只落在顶层会话上）
4. `now - created_at < 24h`（新会话，无论多冷）
5. 无 prompt 的空会话（占位会话；过滤方式见 §0.1 要点）

### 2.3 模式与门控

- **无模式下拉（实测反馈后简化）**：生命周期自动推进——开启即手动阶段，完成首次归档（或空结果确认）即自动阶段；想退出就关闭整个功能。内部存储值 `mode` 已废除。
- 初始为**手动阶段**。完成一次「整理」（API 执行成功）或空结果确认 → 写 `kimiTidyManualDoneAt` 进入自动阶段；同时写 `kimiTidyLastRun`，首次自动归档从 24 小时后开始（不立即清扫用户刻意留下的对话）。后台 alarm 以「开关已开且已解锁」为启动条件。
- **首跑一次性面板**（实测反馈两轮简化后的最终形态）：开启功能即 dry run——就地显示「有 {n} 条对话待归档」、具体会话名清单（最多 8 条，其余折入省略行）与蓝色「清理并解锁自动归档」按钮；点击归档全部候选、解锁、面板永久消失，配置区只剩阈值行。零候选时显示「没有符合条件的对话」与「点击解锁自动归档」。读取失败与零候选严格区分（前者给重试出口）。
- **不做撤销功能**（用户明确不需要；误整理可到 web 的「已归档会话」管理页手动恢复，该页面原生支持按归档时间排序与恢复）。

### 2.4 实验性功能联动

- 打开自动整理开关时：内容脚本检查 `localStorage['kimi-web.sidebar-multi-tab']`，非 `"1"` 则写 `"1"` 并**刷新当前 Kimi 页面**（Lab 开关需刷新才生效），刷新前用页面内提示告知用户。
- 关闭自动整理时：**不动** Lab 开关（用户明确要求）。
- 用户此后自己在设置里关掉 Lab：整理器照常工作（归档是 API 行为，不依赖侧栏 tab 显示），无副作用。

### 2.5 自动模式调度

- 后台 `chrome.alarms` 每 24h 触发一次（另加 storage 记录 `kimiTidyLastRun`，不足 24h 跳过，防 alarm 重复注册）。
- 执行走**中继**：background → `relayToKimiWebTab('tidy.auto.run')` → 内容脚本拉列表、判定、批量归档 → 结果回传。没有打开的 Kimi 页面则本轮跳过（与额度预警同款低功耗原则）。
- 自动整理完成后发一条桌面通知（归档 N 条；0 条不打扰）。
- 列表分页拉取（`page_size=100` 循环 `page_token`），全量「进行中」会话。

## 3. 自动命名（终态：整体移除）

> **终态（2026-09-05，两轮迭代）**：官方实验 auto_session_title（KIMI_CODE_EXPERIMENTAL_FLAG
> 锁定，经 config.experimental 下发，web 第一轮即自动生成）已覆盖此能力，扩展端
> 生成管线整体退役（代码注释保留）。popup 保留「新会话自动命名」入口作为引导：
> 点击复制提示词 → 粘贴到 kimi web 对话框 → kimi 修改 ~/.kimi-code/config.toml
> 开启官方实验（副本编辑 + kimi doctor config 校验 + 时间戳备份替换）→ /reload 生效。

### 3.1 方案（按当前构建落地）

- **保留**现有触发逻辑（第 3 轮后触发、手动改过的名字永不覆盖、尝试次数上限、失败静默）。
- **替换执行后端**：不再调用扩展自己的模型管线，改为 `POST /api/v1/sessions/{id}/title/generate`（系统服务端生成，与右键「生成标题」同一通路）。
- 开关即卡片里的「新会话自动命名」，打开 = 允许扩展在该时机自动调系统生成。
- 前置条件随系统：未登录托管账号时接口报错（客户端已有 `genTitleUnavailable` 同款语义），扩展把失败静默计入尝试上限，不弹错误。

### 3.2 旧代码处置（本版注释，下版删）

用户指示：本版先把扩展自己的命名引擎注释掉，不物理删除。

| 处置 | 范围 |
|---|---|
| 注释/停用 | `src/session-rename/rename-model.js`（模型调用）；`rename-content.js` 中「取样→组 prompt→发 rename.model」链路（改为直接调系统端点）；`src/background/rename.js` 的 `renameModelCall` / `listExternalRenameModels` / `getRenameUsage` 及 router 三个消息类型 `rename.model` / `rename.usage.get` / `rename.external.models.list`（`rename.models.list` 保留——中继拉模型清单不再需要，一并注释） |
| 同步收尾 | sender-guard 白名单移除 `rename.model`；popup 的模型下拉、emoji 开关、命名用量显示移除；`rename.usage` 存储键保留不读 |
| 保留 | 触发时机与命名记录逻辑（`rename-shared.js` 的去重/锁/标题消毒）、`writeTitle`（系统端点生成后仍可能需要写回？——实测：若 `title/generate` 直接落库则不需要，见开放问题） |

### 3.3 前向兼容钩子

若未来 kimi web 出现真正的「AI session titles」Lab 开关（localStorage key 形如 `kimi-web.*`，实现时在设置页实际切换一次即可取证）：本开关改为直接翻转该设置（同 §2.4 的写入+刷新模式），自动触发逻辑整体下线。文档更新本节即可。

## 4. 收藏开关

- 存储：`kimiFeatureBookmarks`（默认 `true`）。
- 关闭时：内容脚本跳过 `initBookmarks`（无星标、无目录交错行、无收藏页入口），已有收藏数据**保留**（重新打开即恢复）。
- 不引入其他配置。

## 5. 技术设计

### 5.1 模块划分

| 文件 | 职责 |
|---|---|
| `src/tidy-rules.js`（新） | 纯函数：`classifyTidyCandidates(sessions, now, thresholds)` + 护栏过滤；输入输出可 JSON 序列化 |
| `src/content/session-tidy.js`（新） | 列表拉取（分页）、调 classify、批量归档、Lab 开关联动（写 localStorage + 刷新）、结果回报；凭据沿用页面 localStorage（同 rename-content 模式） |
| `src/popup/tidy.js`（新） | 卡片子块：开关、模式下拉（含解锁门控）、三档阈值输入、待确认列表与整理按钮 |
| `src/popup.js` / `popup.html` / `popup.css` | 卡片合并改版；rename/宠物卡片移除与并入 |
| `src/background.js` | 新增 `tidy.candidates` / `tidy.apply` / `tidy.status` handler（全部走 `relayToKimiWebTab` 转发，自身不碰凭据）；`tidy.auto.run` alarm |
| `src/i18n.js` | 新增全部文案（中英） |

**sender-guard 白名单不需要新增条目**：所有 tidy 动作由 popup（扩展页面，全量放行）或 background alarm 发起，内容脚本只被动应答中继消息（`rename.models.fetch` 同款模式）。

### 5.2 存储键

| 键 | 内容 |
|---|---|
| `kimiFeatureBookmarks` | boolean，默认 true |
| `kimiRenameSettingsV2` | `{ enabled }`（沿用旧键读迁移，见 §1 表） |
| `kimiTidySettings` | `{ enabled, singleDayIdleDays: 3, multiDayIdleDays: 14, allIdleDays: 30 }`（阈值键名与 tidy-rules 的阈值字段一致；mode 已废除） |
| `kimiTidyManualDoneAt` | 时间戳；存在即进入自动阶段（后台 alarm 的启动条件之一） |
| `kimiTidyLastRun` | `{ at, archived }`，24h 节流与通知用 |

### 5.3 消息流

```
popup ──tidy.candidates──▶ background ──relay──▶ content(session-tidy)
popup ──tidy.apply {ids}──▶ background ──relay──▶ content → POST /api/v2/sessions:archive
alarm(24h) ──tidy.auto.run──▶ background ──relay──▶ content → 判定+归档 → 通知
```

## 6. 测试计划

- `tests/tidy-rules.test.js`：三档命中与优先级、五条护栏逐条、阈值边界（2 天跨度分界、24h 新会话、阈值可调后的行为）、空输入/脏数据（缺字段、时间非法）。
- popup 装配测试扩展：卡片渲染、模式下拉禁用态与解锁流转、阈值输入校验。
- i18n 测试：新增键中英成对。
- smoke：开关关闭时无 bookmarks DOM 注入。
- `tidy.candidates` 等 handler 的 relay 失败路径（无 Kimi 标签页 → `NO_WEB_TAB`）。

## 7. 实施顺序

1. `tidy-rules.js` 纯函数 + 测试（UI 无关，先行合入）
2. `content/session-tidy.js` + background 中继 + 消息
3. popup 卡片改版——**先出 HTML 视觉稿截图交用户确认，再动真实 popup**（项目惯例：改版必先看图）
4. 自动命名 v2 切换 + 旧引擎注释 + 白名单/路由收尾
5. 收藏开关
6. README（中英）/ CHANGELOG / HANDOFF 更新，版本 3.4.0

## 8. 开放问题（实现时实测，每项 10 分钟内可验）

1. **归档后续聊**：对 `archived=true` 的会话再发 prompt，服务端是否自动 restore？（决定要不要做"当前会话被归档又有新 prompt 则自动 :restore"的兜底；实测方法：归档一条 → 在该会话发消息 → 查 `archived` 字段。）
2. **父子连带**：归档带子会话的父会话，子会话 `archived` 是否联动？（实测方法：fork 一条子会话 → 归档父 → 查子。）
3. **V2 平铺列表的 `meta.has_prompt`** 是否可用；不可用则按 `last_prompt` 空跳过（代码两条路都写，实测后删一条）。
4. **`title/generate` 是否直接落库**：调用后不 `writeTitle` 直接读会话标题，确认是否已更新；若是，v2 不再需要 `writeTitle`。
5. **RC（kimi rc）页面**上 `/api/v2/sessions` 与归档端点是否同样可用（中继鉴权回源注入 token，GET/POST 行为需各验一次）。
6. （低优先）未来 Lab 出现「AI session titles」key 时切换 §3.3 方案。
