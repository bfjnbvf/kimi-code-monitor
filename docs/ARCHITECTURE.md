# 源码结构

> 从 README「技术实现」一节移出，供贡献者查阅。功能与使用说明以 README 为准。

源码在 `src/`（ES modules），`npm run build` 用 esbuild 打出 `dist/`（content/background/popup/bookmarks-page/panel-app 五个 bundle（CLI HUD 的 worker 由 `hud:build` 单独产出）），manifest 与 popup.html 只引用 `dist/` 产物。`npm test` 先构建再跑全部测试（含发版守卫），`npm run lint` 做引用检查（no-undef 等）。

六个运行面各自一个目录，共享模块在 `src/` 根部：

- `src/content.js` + `src/content/`：页面内面板——`content.js`（编排入口与生命周期）、`panel-state.js`（共享状态容器）、`render.js`（渲染层）、`widget-structure.js`（DOM 结构与编辑模式）、`websocket-session.js`（WS 状态机）、`session.js`（会话与快照）、`quota.js`（额度与授权）、`usage-daily.js`（CLI 长期统计与外部账户）、`pet-panel.js`（Rive 吉祥物与桌面宠物驱动）、`bookmarks.js`（AI 回复收藏：星标注入、目录交错行、当前轮次捕获与跨会话跳转；列表/详情渲染也由扩展收藏页复用）、`cache-hint.js`（桌面端缓存过期提醒：轮次计时、宠物四槽接管与两段状态）、`session-tidy.js`（自动整理：内容脚本执行器）、`utils.js` / `walkthrough.js`
- `src/background/`：后台域模块——`store.js`（存储锁/fetch/中转）、`vault.js`（密钥库）、`oauth.js`（授权与账户）、`quota.js`（额度/预警/快照）、`external.js`（外部 provider）、`pet.js`、`cli-scan.js`、`dynamic-hosts.js`（默认端口之外的站点授权）、`sender-guard.js`（消息来源守卫）、`tidy.js`（自动归档调度）；`src/background.js` 是消息路由入口
- `src/popup/`：弹窗板块——`shared.js`、`usage.js`、`accounts.js`、`external.js`、`tidy.js`（扩展功能卡片：整理配置/待确认列表/收藏开关）、`pets.js`、`share-card.js`（分享卡片取数/预览/导出）；`src/popup.js` 是装配入口，样式在 `popup.css`
- `src/bookmarks-page.js` + `bookmarks.html` + `bookmarks-page.css`：收藏页入口（独立扩展标签页，渲染不落在宿主页面）
- `src/host-patterns.js`：静态注入的端口范围（与 `manifest.json`、`rules/csp_relax.json` 三处同步）
- `src/cache-hint-rules.js`：缓存提醒的纯规则（27/30 分钟阈值、阶段判定、倒计时格式），供 Node 测试直接引用
- `src/share-card.js`：分享卡片构图（纯函数，输入按天数据输出 SVG）
- `src/i18n.js`：中英文案（gettext 风格，跟随 Kimi Web 语言设置）
- `src/metrics.js`：共享纯函数（用量解析、日期汇总、配置归一化、余额双形状解析）
- `src/tidy-rules.js`：自动归档判定纯函数（三档规则 + 护栏，输入列表元数据输出候选）
- `src/cli-usage.js`：本地 CLI 目录授权、增量读取和按天汇总
- `src/session-files.js`：本地会话目录布局规则（wire.jsonl 的枚举与命名，扩展侧与安装器侧共用同一份）
- `src/providers.js`：外部 provider 的端点与解析
- `src/pet/`：桌面宠物——`sprites.js`（图集播放器 + 行为）、`install.js`（画廊命令解析与下载）、`store.js`（IndexedDB 素材库）
- `src/panel-app.js` + `src/panel-app/`：桌面补丁的独立面板页（与侧栏面板共用 `content/` 的本体与渲染）——`panel-app.js`（入口：挂载/配置/直连启动）、`bridge.js`（push 总线与消息分发）、`direct.js`（kap-server 直连：WS 事件流 + REST 轮询 + 外部账户抓取）、`shims.js`（chrome.* 替代）、`accumulate.js`（页内按天积累）、`status-copy.js`（状态文案分级）、`patch/`（`loader.js` 注入器、`install.mjs` 安装器（跨 macOS/Windows 唯一逻辑，`install.sh`/`install.cmd` 为点火壳——借客户端自带的 Node，零安装前提）、`scan.mjs` 历史扫描、`fetch-wallet.mjs` 余额快照）
- `src/cli-hud/` + `scripts/build-cli-hud.mjs` / `install-cli-hud.mjs` / `verify-cli-hud.mjs`：CLI HUD——Python 标准库渲染，Node worker 负责额度查询，安装走官方 `status_line.command`；独立于 Web/桌面 bundle，只在 `npm run hud:build` / `pack:cli` 时构建
- `rive/`：吉祥物动画运行时与资产（本地打包，无远程依赖）
