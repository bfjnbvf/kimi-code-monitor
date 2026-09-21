# 技术方案 — Kimi Code 桌面伴侣 App（桌宠 + 用量面板 + 桌面端注入）

> 日期：2026-09-20 ｜ 状态：**已归档（历史方案记录）** ｜ 前置调研：[RESEARCH-desktop-client-adaptation.md](./RESEARCH-desktop-client-adaptation.md)
>
> 2026-09-21 更新：伴侣 App（VibePal / Swift 桥接）通路已于 v3.5.0 整体移除（见 [HANDOFF.md](./HANDOFF.md) §四），本文不再执行；保留作为桌宠与 KapClient 协议层的设计参考。当前桌面端路线为补丁注入（[DESKTOP-PATCH.md](./DESKTOP-PATCH.md)），Windows 适配计划见 [PLAN-windows-support.md](./PLAN-windows-support.md)。
>
> 目标约束：**稳定、低功耗、可维护**；安装对用户尽可能简单；不修改 Kimi Code 客户端任何文件。

---

## 一、产品定位

一个常驻的 macOS 小应用，**主打全局桌面宠物，用量监控为附带价值**。

定位逻辑：单独为「监测 Kimi Code 用量」装一个常驻 App 动机太弱；桌宠是用户愿意养在桌面上的东西，用量与状态感知是它的自然延伸。

三种呈现形态，共享一套数据层与 UI 代码：

1. **全局桌宠**：常驻桌面，动画反映 Kimi Code 实时状态（空闲/工作中/等待交互/完成/异常）
2. **菜单栏弹出面板**：点菜单栏图标弹出完整用量面板（额度、token、速度、图表）
3. **注入桌面端面板**（可选开启）：把面板注入 Kimi Code 桌面客户端窗口的侧栏左下角，与 Chrome 扩展版观感一致

## 二、范围界定

### v1 做

- 桌宠窗口：透明置顶、不抢焦点、可拖拽、登录项自启、多显示器/全屏 Space 跟随
- 宠物状态机：反映 Kimi Code 进程与会话状态（映射表见 §6.3）
- 菜单栏面板：额度条（5h/本周）、当前会话实时指标、近 7 天消耗图
- kap-server 数据层：实例发现、REST 轮询、WS 事件流
- 设置：开关、动画密度、通知偏好

### v1.1 做（预留接口，v1 不实现）

- CDP 注入桌面端面板（设计见 §7，架构上从 v1 就预留）
- 宠物点击展开用量卡片

### 明确不做

- 不修改客户端文件（patch 路线否决：签名失效 + 自动更新覆盖 + 安装信任成本）
- 不使用 Kimi Code 插件 API（能力面只有 skills/agents/MCP/hooks/commands，无 UI 注入口）
- 不注入宠物到桌面端页面内（宠物是 App 的全局形态）
- v1 不做 Windows（移植策略见 §10）

## 三、技术选型

| 部分 | 技术 | 理由 |
|---|---|---|
| App 骨架（生命周期、菜单栏、设置、登录项） | Swift / AppKit | `NSStatusItem`、`SMAppService` 等原生 API 最稳定；Xcode 27 环境现成 |
| 桌宠窗口与动画 | Swift / Core Animation 播 spritesheet | 无 webview 常驻，空闲功耗≈0；兼容 Codex 宠物包格式（pet.json + spritesheet.webp），自带 petdex.dev 等内容生态 |
| 跟窗/窗口几何 | CGWindowList | 原生 API，读窗口位置无需任何系统权限 |
| 菜单栏面板内容 | 内嵌 WKWebView 加载 App 内打包的 HTML | 复用 Kimi Code Monitor 扩展的 content.css / 渲染 / 图表代码；webview 仅在弹开时存活，不耗常态功耗 |
| 数据层 | Swift 原生 `URLSession` / `URLSessionWebSocketTask` | 零第三方依赖 |
| CDP 注入（v1.1） | 同一套 WS 栈 | CDP 即 JSON over WebSocket |

### 已排除的方案

- **Electron**：常驻 Chromium，200MB+ 包体积与常驻内存，低功耗目标不及格
- **Tauri**：需引入 Rust 工具链；桌宠所需的 macOS 窗口特技（透明置顶、non-activating、Space 跟随）在其生态中最薄弱
- **纯 Swift 原生面板**：稳定/功耗满分，但面板 UI（模块系统、折线图、容器查询降级）需整套重写，与扩展双侧维护

### 设计原则

- **常驻的部分全原生**（桌宠、菜单栏图标），**用户主动点开的部分用 webview**（面板）——功耗与复用各得其所
- **业务逻辑下沉 Swift 侧**，面板 JS 只做纯渲染，通过 versioned 桥接消息通信（见 §6.4）；JS 层越薄越好
- 新项目编译锁 Swift 5 mode，避免 Swift 6 严格并行的前期摩擦，稳定后再迁移

## 四、已验证的技术事实（本机实测，2026-09-20）

| 事实 | 证据 |
|---|---|
| 桌面端内嵌 kap-server 免认证，CLI 实例同端口路径返回 40101，可匿名探测区分 | `curl 127.0.0.1:55762/api/v1/oauth/usage` 返回额度；`58627`（CLI）返回 `{"code":40101}` |
| 实例注册表发现机制 | `~/.kimi-code/server/instances/*.json`：server_id、pid、host、port、心跳；两实例并存实测 |
| 端口每次启动动态分配 | 报告时 52675 → 复核时 55762 |
| `/api/v1/sessions` 含每会话 `busy`、`main_turn_active`、`pending_interaction` 与累计 usage | 实测返回（本会话 `"busy":true`） |
| `/api/v1/oauth/usage` 返回 `limit5h/limit7d` 的 `usedRatio` + `resetAt`、`extraUsage` | 实测返回 |
| 桌面端主窗口 `loadURL("http://127.0.0.1:<port>/...")` 加载 UI，**页面与 kap-server 同源** | app.asar 静态分析（`win.loadURL(url)` + 端口拼接 + `kimi_origin` 参数） |
| 桌面端伺服与窗口内逐字节相同的完整 Web UI | `curl 127.0.0.1:55762/` 与 `desktop-dist/index.html` shasum 一致 |
| 扩展面板在该地址零改动可用 | Chrome 打开实测截图：面板渲染桌面端实时数据（7d 消耗、5h/本周额度、宠物时钟全通） |
| WS 握手协议 | 参考项目逆向：`server_hello` → 回 `client_hello`（`payload.subscriptions`、`payload.cursors`）；`ping` 必回 `pong`（带 nonce，2 次不应答掐断）；`ack` 携带 `accepted_subscriptions`/`resync_required`；重连带 cursors 续传 |
| 桌面与 CLI 共享 `~/.kimi-code/sessions/` | 扩展的 wire.jsonl 扫描天然覆盖桌面端历史 |

## 五、数据层设计（KapClient）

```
~/.kimi-code/server/instances/*.json
        │ 按 heartbeat_at 过滤存活实例；匿名 GET /api/v1/oauth/usage
        │ 200 → 桌面端实例；40101 → CLI 实例
        ▼
   InstanceRegistry（实例列表、角色、心跳监控）
        │
        ▼
   KapClient（每个桌面端实例一个）
        ├─ REST：GET /api/v1/oauth/usage（60s 轮询）
        │        GET /api/v1/sessions（30s 兜底轮询）
        │        GET /api/v1/sessions/{id}/status（按需）
        ├─ WS：/api/v1/ws（client_hello 订阅 + pong 心跳 + cursors 续传 + 指数退避重连）
        └─ 输出统一状态流：AppState { instances, sessions, quota, agentStatus }
```

- WS 为主（秒级），断线退化为 REST 轮询兜底
- 多实例聚合：桌面端 + CLI 任一在忙 → 宠物呈现忙碌
- 额度口径：本地 `usedRatio`（0–1）为唯一来源，不与 api.kimi.com 混用（避免同 UI 双口径跳变）

## 六、App 架构

```
KimiPal.app
├── AppKit 壳
│   ├── AppDelegate / 生命周期 / SMAppService 登录项
│   ├── StatusBarController（菜单栏图标 + NSPopover）
│   ├── PetWindowController（透明置顶窗口、拖拽、跟窗、Space 行为）
│   ├── PetAnimator（spritesheet 帧播放，CVDisplayLink 驱动）
│   ├── PetStateMachine（状态 → 动画映射，JSON 配置驱动）
│   ├── Settings（设置窗口）
│   └── KapClient（§5）
├── Injector（v1.1，§7）
└── Resources/
    ├── panel/            ← 面板 HTML/CSS/JS（与扩展同源维护）
    └── pets/             ← 内置宠物包 + 支持安装 codex 宠物包
```

### 6.1 桌宠窗口

- `NSWindow`：borderless、transparent、`level = .floating`、non-activating、可选点击穿透
- `collectionBehavior` 含 `.fullScreenAuxiliary`，全屏 Space 跟随
- 拖拽移动 + 位置记忆；多显示器取光标所在屏
- 客户端未运行时的行为做成设置项：趴下睡觉（默认）/ 隐藏

### 6.2 菜单栏面板

- `NSStatusItem` + `NSPopover`，内嵌 WKWebView 加载打包的 `panel/`
- UI 复用扩展的 content.css 与渲染/图表模块；挂载层写独立壳页面
- popover 关闭即销毁 webview 内容加载，控制常态功耗

### 6.3 宠物状态机

| Kimi Code 状态 | 判定来源 | 宠物动画 |
|---|---|---|
| 客户端未运行 | NSWorkspace + 注册表 | 睡觉/灰化（或隐藏，设置项） |
| 在线空闲 | WS/REST：无 busy 会话 | 待机呼吸，低频眨眼/侧看 |
| 工作中 | 任一会话 `busy` / `turn.started` | 埋头干活循环 |
| 等待交互 | 任一会话 `pending_interaction != none` | 举手招呼（**独占价值：被动感知「AI 在等我确认」**） |
| 一轮完成 | `turn.ended` | 撒花一次后回待机 |
| 限流 / 掉线 | 429 事件 / WS 断开 | 红脸 / 沮丧 |
| 子代理工作中 | `subagent.*` 事件 | 绿色系状态动画 |

状态 → 动画映射写在 JSON 配置（宠物包自带、可被覆盖），**不写死在 Swift 里**——这是未来 Windows 版的直接输入。

### 6.4 桥接协议（Swift ↔ 面板 WKWebView）

- Swift → JS：`window.__kimiPal.push(state)`，state 为 versioned JSON（`{v:1, quota, sessions, status}`）
- JS → Swift：`webkit.messageHandlers.kimiPal`，仅动作类消息（refresh、openSettings）
- 桥协议写成独立文档，作为未来 Windows 壳的实现规格书

## 七、CDP 注入桌面端面板（v1.1）

### 7.1 机制

1. App 作为 launcher：`open -a "Kimi Code" --args --remote-debugging-port=<随机端口>`
2. 轮询 `http://127.0.0.1:<port>/json/list`，识别主窗口 target（URL 为 kap-server 地址）
3. `Page.addScriptToEvaluateOnNewDocument`（刷新/导航存活）+ `Runtime.evaluate`（当前页面立即生效）
4. 面板 bundle 以字符串内联注入——**注入代码与 kap-server 同源**，直接 `fetch('/api/v1/...')`，零认证零 CORS，配置存页面 localStorage，无需任何 chrome.* 适配层

### 7.2 管理能力

- 开关即插即拔：关闭时注入代码自行卸载 DOM、断开 WS，桌面端完全复原
- 新窗口自动补注（轮询 target 列表）
- 客户端自动更新免疫（零文件依赖）
- 检测「Kimi Code 在跑但调试口不在」（用户从 Dock 启动/客户端自启），设置页提供「一键重启启用面板」

### 7.3 安全

- 调试端口是本地完全控制面（高于 kap-server 的只读风险）：随机端口、仅功能开启时存续、设置里明示风险、**默认关闭**
- 注入面板与扩展配置不互通（localStorage 独立），用户须知

## 八、安全与隐私

- 全部数据通路为本机回环：注册表读取 + `127.0.0.1` REST/WS，无任何外发
- `/api/v1/sessions` 返回含会话标题与 last_prompt 明文——面板只取状态与数字字段，隐私声明需披露读取范围
- 无辅助功能/屏幕录制等系统权限需求（CGWindowList 读窗口几何免权限）
- CDP 注入为显式开启项（§7.3）

## 九、分发

- Developer ID 签名 + 公证（notarize），双击安装无警告；可选 Homebrew cask
- 登录项由设置页开关（SMAppService）
- v1 可先 TestFlight 外无分发内测或直接 GitHub Release + 公证

## 十、Windows 移植策略

- 可带走 100%：kap-server 协议层知识、面板 UI（WebView2 兼容更好）、CDP 注入逻辑、宠物状态机 JSON
- 必须重写：宠物窗口（WS_EX_LAYERED 分层窗口）、托盘+弹出窗口、跟窗（EnumWindows/GetWindowRect）、登录项与签名分发
- 预计为重写量的 30–40%，且全部是成熟窗口 API 的「按规格施工」；宠物动画保持原生（方案甲），不为了移植性牺牲 macOS 功耗与质感

## 十一、里程碑与工作量

| 里程碑 | 内容 | 预估 |
|---|---|---|
| M0 技术原型 | CGWindowList 读窗口位置 + kap-server WS 握手 + 透明窗口播一段动画，三个未知数一次验完 | 0.5 天 |
| M1 桌宠 v1 | 窗口管理、spritesheet 播放器、状态机、登录项、拖拽 | 3–4 天 |
| M2 数据层 | KapClient 全量（发现/REST/WS/聚合/退避） | 1 天 |
| M3 菜单栏面板 | popover + webview + 面板 UI 移植 + 桥接 | 2–3 天 |
| M4 打磨与发布 | 边界情况、签名公证、设置页、文档 | 1–2 天 |
| M5 CDP 注入（v1.1） | launcher + 目标识别 + 注入/卸载 + 引导流程 | 1–2 天 |

**v1（M0–M4）约 1.5 周；含注入约 2 周。**

## 十二、风险与缓解

| 风险 | 缓解 |
|---|---|
| kap-server 接口随客户端大版本变化 | 版本探测 + 优雅降级（WS 断 → REST 兜底 → 明示离线）；协议与 Web 版同族，破坏面小 |
| 桌宠窗口细节（多屏、Space、层级、讨不讨人厌） | M4 集中打磨；所有行为进设置项 |
| WKWebView 复用折扣（挂载层需壳页面） | 样式与模块渲染代码直搬，壳层工作量已计入 M3 |
| Swift 6 并发摩擦 | 项目锁 Swift 5 mode |
| 面板动画常驻功耗 | spritesheet 帧步进 + 不可见即停帧；webview 仅弹开时存活 |
| 参考项目协议逆向的准确性 | M0 原型首要验证项；失败则退化为纯 REST 轮询（30s），功能仍在、实时性降级 |

## 十三、M0 原型验证清单

1. CGWindowList 能稳定读到 Kimi Code 主窗口几何（含最小化/全屏/多屏行为）
2. WS 连 `ws://127.0.0.1:<port>/api/v1/ws`：`client_hello`（subscriptions 嵌 payload）→ 收 `ack`；桌面端跑一轮对话收到 `turn.*` / `agent.status.updated` 事件；`ping`/`pong` 心跳不触断线
3. 透明置顶 non-activating 窗口播放 spritesheet 动画，CPU 占用实测（目标：空闲 <1%）
