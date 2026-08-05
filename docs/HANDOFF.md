# 交接文档 — Kimi Code Monitor（2026-08-02）

> 写给下一个接手这个项目的会话/人。读完这份文档即可无缝继续。

## 一、项目是什么

Chrome MV3 扩展（未上架，本地解压加载），在 localhost 的 Kimi Code Web 页面侧栏注入一个**模块化状态面板**：额度/token/缓存/速度/消耗量统计 + Kimi 官方小蓝球宠物（Rive 动画）。当前版本 **2.1.1**。

## 二、文件夹里有什么

| 文件/目录 | 说明 |
|---|---|
| `manifest.json` | MV3 清单（v2.1.1）。content_scripts 注入 `rive/rive.js` + `metrics.js` + `cli-usage.js` + `content.js` + `content.css` 到 `127.0.0.1/localhost` |
| `content.js`（约 2000 行） | 面板全部逻辑：模块系统（三区域/拖拽/≡菜单/编辑模式）、Mini、额度/匀速参照线、消耗量柱图、会话折线图、宠物（Rive 驱动/状态动画/时钟计时/点击跳转/右侧数据选项）、新手引导卡片、侧栏改造开关、状态机（空闲/思考/执行/子代理/限流/重连/未连接/未授权） |
| `content.css` | 面板样式 + 宿主页面微调（隐藏侧栏 logo、footer 分隔线，受 `html.ksb-sidebar-tidy` 开关控制） |
| `background.js` | 设备 OAuth、额度 API（含 30s 缓存 + force 绕过）、按天/按会话分键持久化（写入队列串行化）、额度预警通知 |
| `metrics.js` | 纯函数共享库：usage 解析、配置归一化（v3 含迁移）、会话存档（分键+索引+6MB 剪枝）、quotaPercentage |
| `popup.html / popup.js` | 工具栏弹窗：授权管理、完整版消耗量（自定义日期范围）、导出 JSON、重置布局 |
| `web-token.js` | 停用备用的 kimi.com token 中转（月额度通路，已下线，代码保留） |
| `rive/` | Rive canvas-lite 运行时（rive.js + rive.wasm）+ 吉祥物 .riv 资产 ×2 |
| `rules/csp_relax.json` | 静态 DNR 规则：移除 `127.0.0.1/localhost` 文档响应的 CSP 头。**背景**：kimi web 0.32.0 起下发 `default-src 'self'`，Chrome 按页面 CSP 拦截 content script 内 WASM 编译，吉祥物 Rive 无法初始化；manifest 键名是蛇形 `declarative_net_request`（驼峰是 API 命名空间，写错会被忽略） |
| `tests/` | `node tests/metrics.test.js`（23 个用例）、`tests/theme.test.js` |
| `build.sh` | 打包 zip（含 rive/ 与 rules/，不含 docs/tests） |
| `CHANGELOG.md` | 完整更新说明（最新 v2.1.1），并保留此前版本历史 |
| `README.md` | 新文案已定稿（卖点前置、模块化+宠物+统计、安装/数据/结构） |
| `docs/` | `screenshots/`（六张成品图 + popup.png）、`screenshot-studio.html`（截图母版，假数据）、`head-image.html`（头图母版）、`window.png`（头图底图）、`guide-variants.html`（新手引导两版样式候选） |
| `docs/HANDOFF.md` | 本文档 |

## 三、已完成的（不要重做）

- 面板模块化三区域系统（灰隐藏/蓝展开/绿固定）、拖拽排序、≡菜单、Mini 自定义
- 宠物模块：官方 Rive 动画（stop 事件驱动、防递归、防 0 高度卡死）、状态动画映射、挂钟/回答计时（工具调用不打断）、点球动画池（已剔除纵向位移动画）、右侧数据六选一、点击跳转链接、侧栏改造开关
- 「执行中」状态拆分（tool.call.started / tool.result，WS 抓包确认）
- 会话存档分键存储 + 6MB 剪枝 + 导出（usageDaily/usageSessions/额度快照）
- 归零修复（快照缺失回退本地记录）、隐藏暂停拉取、force 刷新
- 代码审查 15 项修复（回声去重、剪枝入队、pointercancel、hello 看门狗等）
- 侧栏改造（去 logo + 新建对话对齐伸缩按钮 + footer 线隐藏，html class 开关）
- CHANGELOG v2.1.0、README 新文案、全部配图（hero 完整+Mini 对比图、pet、edit-mode、quota、modules、头图 2560×1280）

## 四、未完成事项（按此顺序做）

### 1. 新手引导卡片（首要，已定方向未落地）

结构已定：**操作区（授权 / Mini）→ 模块化通栏强调卡 → 模块区（每模块一卡）**。样式方向用户已选 **A 版「图标精致版」**（白卡 + 左侧淡色图标块，`docs/guide-variants.html` 里有完整母版可直接抄）。

但必须修掉用户最新批评（逐条落实）：

1. **「标题行」放错组**：它不是"操作"，是模块 → 移入模块区，并**改名「状态栏余额」**
2. **模块化卡下的三根"拖到这"条已失去指代**：用户原话"拖到哪呢？这三个没有任何意义了"。需要重新设计——要么删掉，要么改成"灰=隐藏区（顶部）、蓝=展开区（中间）、绿=固定区（底部）"的**位置图例**，让用户知道三个区域在面板上的方位
3. **A 版标题与正文没有视觉区分**：卡片标题要加粗/加大/换色，与正文形成层级（目前标题正文一样重）

落地方式：把 `guide-variants.html` 里 A 版结构改进后合入 `content.js` 的 `maybeShowGuide()` 与 `content.css`（替换现有 560px 网格版），用注入法在 studio 页预览确认后再发布。

### 2. README 图文结合（半成品）

文案与六张图都已各自完成，但**没有按文档做最终的图文对齐**：检查每张图位置是否与对应段落匹配（hero 完整+Mini 对比、pet、edit-mode、quota、modules、头图），图注是否准确，是否需要给"模块化自定义面板"一节补 edit-mode.png、给宠物一节用 pet.png。通读一遍 README 定稿。

### 3. 打包上传 GitHub（最后）

- 需要：用户确认后再运行 `bash build.sh`、提交改动、打 tag v2.1.1，并以 CHANGELOG 的 v2.1.1 段创建 GitHub Release

## 五、用户偏好与雷区（重要）

- **语气**：客观详实，不要 AI 味/营销腔/拟人化（"住进了面板""都由你定"这类全部被打回过）；但也不要黑话连篇（"游标""下沉""分键"不让用）
- **审美要求高**：截图/引导卡片必须实际渲染检查，不接受"差不多"；每改一版先看图再交付
- **禁止**：`UpDown / jump / look_forward / look_right` 四个 Rive 动画（纵向位移/裁切）；`reset()`（击穿 Rive 运行时导致每帧报错）；月度额度通路（token 18 分钟寿命，已下线勿复活）
- **git 操作一律需用户确认**，不要主动 commit/push

## 六、环境与工具备忘

- WebBridge 守护进程：`http://127.0.0.1:10086`（控制用户真实浏览器；用户的 Kimi Code Web 在 `127.0.0.1:58627`）
- 截图预览服务器：`python3 -m http.server 18766 --bind 127.0.0.1`（仓库根目录启动），studio/头图/引导变体页都靠它预览
- 常用验证：`node --check <file>`、`node tests/metrics.test.js`、`bash build.sh`
- 新手引导预览技巧：studio 页里注入 `#ksb-guide` DOM（content.css 已加载）
- Kimi WebBridge 单页工具只认"当前聚焦标签页"，借用用户页面用 `find_tab(url, active:true)`
