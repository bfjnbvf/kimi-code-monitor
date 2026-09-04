# 交接文档 — Kimi Code Monitor（2026-09-05）

> 写给下一个接手这个项目的会话/人。读完这份文档即可无缝继续。
> 功能与架构的权威描述在 `README.md`（中英双份，持续维护），本文只讲 README 里没有的：怎么干活、雷区在哪。进行中功能的设计/交接见 `docs/DESIGN-extensions-card.md`。

## 一、项目是什么

Chrome MV3 扩展（未上架，本地解压加载 / GitHub Releases 发 zip），在 Kimi Code Web 页面侧栏注入模块化状态面板：额度/token/缓存/速度统计、会话折线图、CLI 长期用量、AI 回复收藏、分享卡片、Rive 吉祥物与桌面宠物、新会话自动命名、自动整理「已完成」、动态站点授权（`kimi web --host` 局域网地址）。当前版本 **3.4.0**。

## 二、怎么干活

| 命令 | 作用 |
|---|---|
| `npm run build` | esbuild 把 `src/` 打成 `dist/` 三个 iife bundle；**改了源码必须重跑**，manifest 只引用 `dist/` |
| `npm test` | 先构建再跑全部测试（node:test，含 jsdom smoke），当前 220+ 用例 |
| `npm run lint` | eslint 检查 no-undef / no-unused-vars（拆分事故防线，不做风格限制） |
| `bash build.sh` | 打发行 zip（含 dist/rive/rules/icons，**不含** docs/tests/web-token.js） |

- 在 `chrome://extensions` 重载扩展后，Kimi Web 页面要手动刷新一次面板才恢复（Chrome 不会重新注入 content script）。
- 架构分层：`src/content.js`+`src/content/`（页面面板）、`src/background.js`+`src/background/`（后台域）、`src/popup.js`+`src/popup/`（弹窗），共享纯函数在 `src/` 根（`metrics.js`、`i18n.js`、`cli-usage.js`、`providers.js`、`share-card.js`）。模块职责见 README「项目结构」。

## 三、安全模型（v3.3.1 起固化，改动前先读）

- **密钥**：OAuth token 与外部 API key 一律 AES-GCM 加密落盘（`src/background/vault.js`，non-extractable key 存 IndexedDB）。
- **消息来源守卫**（`src/background/sender-guard.js`）：扩展页面（popup/options）全量放行；内容脚本仅「回环 + 动态授权 origin」来源且限白名单消息类型。**内容侧新增 `chrome.runtime.sendMessage` 调用点时必须同步维护守卫的白名单**，否则消息会被 `UNTRUSTED_SENDER` 拒绝。v3.4.0 起 `rename.model` 已移出白名单（命名走系统「生成标题」）；tidy 消息全部由 popup/background 发起，内容脚本只被动应答中继，不在白名单之列。
- **动态站点授权**（`src/background/dynamic-hosts.js`）：`hosts.grant` 在后台复核 optional host 权限（`chrome.permissions.contains`）后才登记内容脚本注册与 CSP 规则；浏览器侧撤销权限由 `permissions.onRemoved` 同步清理。
- **CSP 放行**（`rules/csp_relax.json` 静态 + dynamic-hosts 动态）：只摘 **main_frame** 的 CSP 头（Rive WASM 需要；扩展无 `all_frames`，从不在子框架运行，摘 sub_frame 纯属风险）。背景：kimi web 0.32.0 起下发 `default-src 'self'`，Chrome 按页面 CSP 拦截 content script 内 WASM 编译。manifest 键名是蛇形 `declarative_net_request`（驼峰是 API 命名空间，写错会被忽略）。
- **静态注入面**：content_scripts 匹配所有 localhost 端口（无法按端口匹配），面板只在出现 Kimi 侧栏 DOM（`aside.side > .col`）后挂载；路由轮询在无 Kimi 迹象的页面上会从 1s 退避到 5s。
- `web_accessible_resources` 对全部 http(s) 放开（动态授权站点无法静态列举）——已知取舍，README 数据与隐私一节有披露。

## 四、停用/搁置的通路（勿轻易复活）

- **自动命名旧模型管线**（v3.4.0 停用）：`src/background/rename.js` 整模块、`rename-content.js` 的取样/写回段、background 路由与 sender-guard 的 `rename.model`——全部**注释保留**，恢复步骤见 `docs/DESIGN-extensions-card.md` §3.2。现行方案：触发后由 content 直调系统 `POST /api/v1/sessions/{id}/title/generate`。
- **月度额度**（`resolveMonthlyStats` / `requestMonthlyStats` / `web-token.js`）：web token 寿命仅约 18 分钟，中转方案体验差已下线，`data.monthly` 恒为 null。若重启：manifest 需补 `https://www.kimi.com/*` host_permissions 与 web-token.js 的 content_scripts，**并把该 origin 加进 sender-guard 放行集合**。
- **web-token.js 不进发行 zip**（未注册的死文件，仅仓库保留）。
- **自动整理开放问题**（实现时留待实测，见 DESIGN 文档 §8）：归档后续聊是否自动恢复、父子会话归档联动、RC 页面 V2 接口可用性——若用户反馈异常先查这三项。

## 五、用户偏好与雷区（重要）

- **语气**：客观详实，不要 AI 味/营销腔/拟人化（"住进了面板""都由你定"这类全部被打回过）；但也不要黑话连篇（"游标""下沉""分键"不让用）。
- **审美要求高**：截图/引导卡片必须实际渲染检查，不接受"差不多"；每改一版先看图再交付。
- **禁止**：`UpDown / jump / look_forward / look_right` 四个 Rive 动画（纵向位移/裁切）；`reset()`（击穿 Rive 运行时导致每帧报错）；月度额度通路（见上）。
- **git 操作一律需用户确认**，不要主动 commit/push。

## 六、环境与工具备忘

- WebBridge 守护进程：`http://127.0.0.1:10086`（控制用户真实浏览器；用户的 Kimi Code Web 在 `127.0.0.1:58627`，端口可能变化，以实际为准）。
- 截图预览服务器：`python3 -m http.server 18766 --bind 127.0.0.1`（仓库根目录启动），studio/头图/引导变体页都靠它预览。
- 常用验证：`npm test`、`npm run lint`、`bash build.sh`。
- 新手引导预览技巧：studio 页里注入 `#ksb-guide` DOM（content.css 已加载）。
- Kimi WebBridge 单页工具只认"当前聚焦标签页"，借用用户页面用 `find_tab(url, active:true)`。

## 七、发版流程

1. 改 `manifest.json` + `package.json` 版本号（两处必须一致），`CHANGELOG.md` 顶部加条目。
2. `npm test` 全绿 → `bash build.sh` 出 zip。
3. **经用户确认后**再 commit / 打 tag / 以 CHANGELOG 对应段落建 GitHub Release。
