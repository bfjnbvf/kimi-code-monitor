# 调研评估报告 — Kimi Code Monitor 适配 Kimi Code 桌面客户端

> 日期：2026-09-20 ｜ 状态：调研评估完成，**未实施** ｜ 结论：推荐「方案 A（扩展直连本地服务）」，改动全部在扩展内，不动客户端文件。
>
> 本报告数据均来自本机实测（macOS，Kimi Code.app 1.0.2，正在运行）与参考项目源码通读。凡标注「实测」「待验证」的均为可复核结论。

---

## 一、背景与目标

Kimi Code Monitor（Chrome MV3 扩展，v3.4.0）原本面向 **Kimi Code Web 版**（kimi.com 网页）提供用量监控：额度、token、缓存命中、速度、会话统计、CLI 长期用量等。Kimi Code 现推出桌面客户端（Electron，`/Applications/Kimi Code.app`），目标评估：

1. 扩展如何适配桌面客户端（数据从哪来、要不要改客户端）；
2. 参考开源项目 [Link3750/kimi-code-usage-widget](https://github.com/Link3750/kimi-code-usage-widget) 的思路是否可借鉴、哪些不可照搬；
3. 给出方案对比、推荐方案、工作量与风险。

## 二、调研对象一：桌面客户端本体（本机实测）

### 2.1 应用形态

| 项 | 实测值 |
|---|---|
| 版本 / 标识 | 1.0.2，`com.kimi.code.desktop` |
| 技术形态 | Electron（app.asar + `resources/desktop-dist/` 明文 UI），当前正在运行 |
| 代码签名 | 有效签名（TeamIdentifier `2J9472RW75`，hardened runtime）。**修改 bundle 内任何文件会破坏代码盖章**，macOS 上可能拒绝启动 |

### 2.2 内嵌本地服务（kap-server，`127.0.0.1`，免认证）

实测监听 `127.0.0.1:52675`（端口每次启动动态分配），接口全部匿名可用：

| 接口 | 用途 | 实测返回要点 |
|---|---|---|
| `GET /api/v1/oauth/usage` | 配额 | `limit5h.usedRatio` + `resetAt`、`limit7d.usedRatio` + `resetAt`、`extraUsage`（加油包，当前为 null） |
| `GET /api/v1/sessions` | 会话列表 | 每会话含标题、workspace、busy、累计 `usage`（`input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_creation_tokens`/`total_cost_usd`/`context_tokens`/`context_limit`/`turn_count`） |
| `GET /api/v1/sessions/{id}/status` | 实时状态 | `context_tokens`/`max_context_tokens`/`context_usage`、`model`、`thinking_level`、`swarm_mode` 等 |
| `WS /api/v1/ws` | 实时事件流 | 握手返回 `server_hello`（`protocol_version: 2`，`heartbeat_ms: 10000`，`max_event_buffer_size: 1000`） |

**事件协议与 Web 版同族**：从桌面端 UI 代码提取到的事件名（`turn.started`、`turn.step.completed`、`turn.step.retrying`、`turn.ended`、`agent.status.updated`、`session.usage_updated`、`session.meta.updated`、`subagent.*`）与扩展现有 `src/content/websocket-session.js:332-451` 解析的事件表逐一致；`/api/v1/sessions` 的 usage 字段为 OpenAI 风格（`input_tokens` 那套），`src/metrics.js:17` 的 `normalizeUsage` 已原生支持。

### 2.3 端口发现机制（实测）

`~/.kimi-code/server/instances/*.json` 是实例注册表，每个运行中的实例（桌面、CLI）写一条记录，带心跳：

```json
{"server_id":"…","pid":56643,"host":"127.0.0.1","port":52675,
 "started_at":…,"heartbeat_at":…,"host_version":"2.0.1"}
```

实测同一台机器上同时存在两个实例：桌面（52675，host_version 2.0.1）与 CLI（58627，2.0.0）。**CLI 实例的同名路由返回 `40101 Unauthorized`，桌面实例完全免认证**——匿名访问成败可作为「桌面版在场」的判定信号。

### 2.4 存储共享（实测）

桌面客户端与 CLI 共用同一状态根 `~/.kimi-code/`：实例注册表由桌面进程写入；本地服务列出的会话 `session_e830ab43-…` 同时以 `~/.kimi-code/sessions/wd_kimi-code-monitor_1b831b98e115/session_e830ab43-…/agents/main/wire.jsonl` 落盘。**结论：桌面版的 agent 用量天然进入扩展现有 CLI 文件扫描的数据范围。**

## 三、调研对象二：参考开源项目

### 3.1 它是什么

「给 Kimi Code 桌面版（Windows）侧栏注入实时用量面板的非官方补丁」。不依赖浏览器扩展，直接改桌面版本地 UI 资源。三个组件：

- `patch-desktop.py`：安装器。定位 `resources/desktop-dist/`，把 `kimi-usage-widget.js`（787 行单文件零依赖）拷入，并在 `index.html` 的 `</head>` 前插入 `<script defer src="/kimi-usage-widget.js">`；首次修改前备份 `index.html.bak-kimi-widget`；幂等，`--uninstall` 还原。
- `watch-patch.py`：自愈监听。开机自启，每 30s 检查 `index.html` 是否仍含注入标记，被自动更新覆盖则重跑安装器（120s 冷却），日志 `watcher.log`。
- 面板本体：挂载在 `.side-footer` 前（失败退化为左下浮动卡片）；模块可拖拽排入 main/mini/hidden 三区；跟随深浅色。

### 3.2 它的关键技术手段（有借鉴价值）

- **origin 白拿**：桌面版页面 URL 自带 `?kimi_origin=http://127.0.0.1:端口`，面板按 `location.search` → `sessionStorage['kimi-desktop-server-origin']` → `localStorage['kum.origin']` 三级回退解析服务地址，因此完全不需要端口发现。
- **WS 协议细节**（作者从 kap-server 源码逆出，自称踩过坑）：收到 `server_hello` 后回 `client_hello`，`subscriptions` **必须嵌套在 `payload` 里**；服务端每 10s `ping`，必须回 `pong`（带 `nonce`），连续 2 次不应答被掐断；`ack` 里 `accepted_subscriptions` 为空的会话进 `resync_required` 需补订阅；重连带 `cursors`（seq 游标）续传去重，指数退避 1s→30s。
- **指标算法**：`agent.status.updated` 的 `payload.usage.currentTurn/total` 取当前轮与会话累计；速率用最近 10 step 样本滑动窗口；缓存命中率 total 口径；`turn.ended.payload.durationMs` 取上轮耗时；上下文占用随额度 60s 轮询。

### 3.3 它的固有缺陷（决定了不能照搬）

| 缺陷 | 说明 |
|---|---|
| 破坏应用完整性 | 改签名 bundle 内容；macOS 上可能直接无法启动（该项目只验证过 Windows，正是因为没有签名执法） |
| 更新即失效 | 桌面版每次自动更新覆盖补丁，靠常驻守护进程续命 |
| 历史数据断层 | 只积累补丁安装后、桌面版运行期间的用量（localStorage 差分），此前的历史全无 |
| 仅 Windows | 安装路径探测、开机启动项均为 Windows 形态 |

## 四、现有扩展能力盘点与可复用性

| 现有模块 | 能力 | 对桌面适配的可复用性 |
|---|---|---|
| `src/cli-usage.js`（499 行） | File System Access API 增量扫描 `~/.kimi-code/sessions/**/wire.jsonl`，索引/按天/按小时/会话汇总 | **直接覆盖桌面版历史统计**（存储共享，实测确认），零改动 |
| `src/metrics.js`（405 行） | 双风格 usage 归一化、分桶、速度聚合、热度图 | **直接复用**，本地接口的 OpenAI 风格字段已支持 |
| `src/background/quota.js` | api.kimi.com 设备 OAuth 取 5h/本周额度、80%/95% 告警、每日快照 | 可保留为降级通路；桌面在场时可切换为本地服务来源（口径需对齐，见待验证） |
| `src/content/websocket-session.js` | Web 版同源 WS 连接、server_hello 看门狗、退避重连、事件→面板 | **逻辑可整体迁移到 background**（协议同族，去掉 bearer 认证与页面依赖，加 `client_hello` 订阅握手） |
| `src/background/cli-scan.js` | 单飞扫描、storage 锁、广播刷新 | 端口发现 + 本地服务轮询可套用同一调度模式 |
| manifest host_permissions | 已含 `127.0.0.1`、`localhost` | **无需新增任何权限**；background 的 fetch 跨域与 WS 直连均被覆盖；不需要 nativeMessaging |

## 五、方案对比

| 维度 | 方案 A：扩展直连本地服务 | 方案 B：照搬参考项目 patch 客户端 | 方案 C：A 为主 + 可选 B |
|---|---|---|---|
| 改动对象 | 只改扩展 | 改签名应用文件 | A + 可选注入 |
| macOS 可行性 | 无障碍 | **签名执法风险，可能无法启动** | 同 A（B 部分仍不建议） |
| 客户端自动更新 | 免疫 | 每次被覆盖，需守护进程 | A 免疫 / B 需守护 |
| 端口发现 | 需实现（注册表 + 兜底） | 不需要（寄生页面白拿） | A 部分需 |
| 历史统计 | 全量 wire.jsonl，开箱即用 | 仅安装后 | 同 A |
| 用户安装成本 | 装扩展 + 授权目录（现有流程已内含） | 跑 Python + 装开机守护 | 同 A |
| Web Store 审核 | 127.0.0.1 fetch 属常见本地工具模式 | 不适用 | 同 A |

## 六、推荐方案 A：设计概要

### 6.1 数据流

```
~/.kimi-code/server/instances/*.json  ──发现──▶  background「本地服务客户端」
   （直播活实例端口 + host_version）                    │
                                                      ├─ 60s 轮询 /api/v1/oauth/usage ──▶ 额度/告警（quota 数据源之一）
                                                      ├─ 60s 轮询 /api/v1/sessions/{focus}/status ──▶ 上下文占用
                                                      ├─ WS /api/v1/ws（client_hello 订阅 + pong 心跳 + cursors 续传）
                                                      │      └─▶ turn/agent 事件 ──▶ 实时面板指标（metrics.js 归一化）
                                                      └─ 广播给 popup / Web 页面面板（复用现有消息总线）
~/.kimi-code/sessions/**/wire.jsonl   ──扫描──▶  长期统计（现有 cli-usage.js，零改动，已覆盖桌面）
```

### 6.2 新增模块（预估）

1. **端口发现**（新 `src/background/desktop-discovery.js`）：读注册表、按 `heartbeat_at` freshness 过滤存活实例、匿名探测区分桌面/CLI 实例；兜底端口扫描（可选）。授权入口扩到 `~/.kimi-code` 根目录（现有 popup 授权 `sessions` 的流程旁增加一次父目录授权，`src/popup/usage.js:454` 一带）。
2. **本地服务客户端**（新 `src/background/desktop-client.js`）：usage/status 轮询 + WS 连接管理；参照 `quota.js` 的单飞/缓存与 `cli-scan.js` 的调度模式。
3. **事件管道**：把 `src/content/websocket-session.js` 的连接/重连/事件分发逻辑抽取为 background 可用的模块（剥离页面依赖与 bearer 认证，补 `client_hello` 订阅握手）。
4. **数据源路由与降级**：popup/面板增加「桌面客户端」数据源指示；无桌面实例或接口失败时自动回落到 api.kimi.com 配额 + wire.jsonl 统计，并在 UI 明示当前通路。
5. **测试**：按 `tests/cli-usage.test.js` 的既有风格补 `tests/desktop-client.test.js`（mock fetch / mock WS / mock 目录句柄）。

### 6.3 manifest 与权限

无需任何变更：host_permissions 已覆盖 127.0.0.1/localhost；File System Access 走现有授权流；无 nativeMessaging、无新权限。

## 七、工作量估算（单人集中开发）

| 项 | 预估 |
|---|---|
| 端口发现 + 授权流程扩展 | 0.5 天 |
| 本地服务客户端（REST + WS） | 1.5 天 |
| 事件管道迁移与指标对接 | 1 天 |
| 数据源路由/降级/UI 指示 | 1 天 |
| 测试 | 0.5–1 天 |
| 本机实测调优（协议细节、边界） | 0.5–1 天 |
| **合计** | **约 5 个工作日** |

## 八、风险与缓解

| 风险 | 缓解 |
|---|---|
| 端口动态分配，注册表是唯一稳定发现机制 | 心跳 freshness + SW 唤醒/启动时重发现；端口扫描仅作兜底；发现失败 UI 明示 |
| 桌面版大版本更新改 API / WS 协议 | 错误可视 + 优雅降级（回落 api.kimi.com + wire.jsonl）；协议与 Web 版同族，破坏面小 |
| 多实例/多账号（桌面与 CLI 同时跑、账号不同） | 按实例独立条目聚合；额度按实例归属 |
| 免认证服务只听 127.0.0.1 | 理论本地攻击面，与官方 RC 机制同级，可接受 |
| Chrome 对扩展 SW 连 `ws://127.0.0.1` 的兼容性 | host permission 覆盖，实测连接成功；保留错误分支 |

## 九、待验证清单（实施前/实施中实测）

1. 桌面实际跑一轮 agent 时，WS 是否必须 `client_hello`（subscriptions 嵌在 payload）才推事件；`agent.status.updated` 的 `payload.usage.currentTurn/total` 字段名确认。
2. `/api/v1/oauth/usage` 的 `usedRatio` 与现有 `quota.js`（api.kimi.com `usages`，`window.duration=300`）口径是否一致；`extraUsage` 加油包在本地接口的表现。
3. 桌面产生的会话（含子代理、RC 会话）是否全部落 wire.jsonl——决定长期统计是否完全零改动。
4. 桌面版无前台界面（如仅托盘）时本地服务是否仍监听。
5. 多账号场景下各实例 usage/额度的归属与聚合策略。

## 十、结论

- **可行，且推荐方案 A**：扩展装在 Chrome 里即可监控桌面客户端的实时用量与配额，不需要打开 Web 页面，也不需要给客户端打任何补丁。
- 最大的既有红利：**历史统计已开箱即用**（桌面与 CLI 共享 `~/.kimi-code/sessions/`，扩展现有扫描逻辑零改动覆盖），WS 事件协议与 Web 版同族使解析层近乎零成本复用。
- 参考项目的价值在于**本地服务 WS 协议细节与指标算法**（可直接借鉴），其注入式落地在 macOS 上因签名执法不可取。
- 预估工作量约 5 个工作日；实施前建议先做第九节的 5 项实测验证以锁定协议细节。
