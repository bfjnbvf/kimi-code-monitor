# Kimi Code CLI HUD

使用 Kimi 官方 `status_line.command`，显示在原生终端输入框下方。支持 Kimi 2.2.0 起沿用此接口的版本；本机已验证 2.2.0 和 2.3.0。

```text
● DeepSeek V4.1 Flash 思考 high 按需询问    5h/7d ▉░░░ 21% ██▋░ 67%    缓存 83% 上轮8.4s    gabriel
```

## 安装（Release zip）

从 Releases 下载 `kimi-code-monitor-cli-v3.6.0.zip`，解压后：

```bash
node scripts/install-cli-hud.mjs --width 120
kimi
```

包内已含构建好的 `dist/hud.cjs` 和 `dist/quota-worker.cjs`，不需要 `npm install`。要求 Node.js 20+、Kimi Code CLI >= 2.2.0，不需要 Python。

## 从源码安装（开发）

需要 Node.js 20+。构建使用仓库已锁定的 esbuild；状态栏和后台额度查询均使用 Node.js。

```powershell
npm ci --ignore-scripts
npm run hud:install -- --width 120
kimi
```

在 Kimi 中执行 `/reload-tui` 即可生效，也可以退出后重新启动。安装器备份 `~/.kimi-code/tui.toml`，只更新 `[status_line].command`，将运行文件放入 `~/.kimi-code/hud/kimi-code-monitor/releases/`；更新保留旧版文件和最初的状态栏设置。

可选参数：`--home DIR`、`--kimi EXE`、`--width 80`。`--home` 应与启动 Kimi 时的 `KIMI_CODE_HOME` 一致。宽度是配置上限；运行时从所属终端读取当前列数（Windows 使用 `CONOUT$`，其他系统使用 `/dev/tty`），预留 Kimi 两侧边距。窗口缩小时缩短彩条、减少间距并收起放不下的次要信息；无法读取所属终端时使用配置宽度。

恢复原状态栏，保留安装文件及备份：

```powershell
node scripts/install-cli-hud.mjs --uninstall
```

若状态栏命令已被其他程序修改，卸载会停止，避免覆盖。安装器支持单独的 `[status_line]` TOML 表；不支持内联表或多行命令。

## 显示与数据

- 模型和状态点位于最前，状态语义与网页面板一致：空闲与等待为灰色，主代理思考、回复与工具执行为蓝色，子代理为绿色，限流为琥珀色，离线与未授权为红色；任何轮次结束都回到灰色空闲，不再单独显示“已完成”绿色。加粗的模型名与状态点同色联动，辅助信息为灰色，分支为紫色。安装命令强制开启颜色，避免 `NO_COLOR` 环境变量吞掉颜色。
- `5h/7d` 后依次显示 5 小时与本周额度彩条和百分比，正常宽度下各 4 格，使用色块与八分格显示低占用，随占用从绿色变为琥珀色、红色。两个额度始终保留，避免右侧截断遮住额度；空间不足时先收起其他模块。组内统一 1 空格、组间 4 空格。自定义行不重复显示 Context Window，原生第二行继续显示上下文数值。
- 模型、目录、分支和权限模式来自官方 stdin JSON。状态来自当前 `sessionId` 的主代理日志末尾，最多读取 512 KiB；不会选择其他终端的最新会话。
- 思考强度显示在模型旁。官方输入若提供 `thinkingEffort` 则优先使用，否则读取当前会话的 `profile.bind`、`config.update`、`llm.request`。未建会话或未知时显示 `思考 --`，不把全局默认值当成当前会话的选择。
- 缓存率来自末次用量，输入包括非缓存输入、缓存读取和缓存写入；上轮耗时直接读取 `turn.ended.durationMs`；生成速度只计算生成阶段，不包含等待、工具和重试。
- 额度优先查询已登记的本地 Kimi 服务；不可用时，读取 Kimi 保存的 access token，查询官方 `https://api.kimi.com/coding/v1/usages`，global 区使用 `api.kimi.ai`。令牌只进入请求头，不打印、不另存、不跟随重定向，也不刷新或修改凭据。
- 底栏读取小型缓存，每 60 秒按需启动隐藏 worker。没有额度数据时保留两个额度窗口、阴影条和 `--%`，不冒充 0%；`quotaStatus` 模块可额外显示“额度暂无”、“需登录”及旧数据标记 `~`。
- 官方自定义接口仅接收第一行 stdout，无法把 Git 分支移到原生 context 下一行；原生 `/dance` 也只处理内置模型栏。双层自定义布局与彩虹联动需要改 Kimi 原生底栏，目前未支持。
- 官方状态栏每秒最多启动一次，执行上限 300ms；短工具调用可能来不及显示，日志格式变化也可能影响状态增强。macOS 的 Kimi 2.3.3 已完成安装和探针验证；Linux 与真实订阅额度尚未实测。

## 模块与顺序

默认模块依次为 `status,model,thinking,permission,quotaPair,cache,duration,project`：

| ID | 内容 | 默认 |
|---|---|---|
| `status` | 状态点 | 显示 |
| `model` | 模型名称 | 显示 |
| `thinking` | 思考强度 | 显示 |
| `permission` | 权限模式 | 显示 |
| `quotaPair` | `5h/7d` + 5 小时彩条与百分比 + 本周彩条与百分比 | 显示 |
| `cache` | 缓存率 | 显示 |
| `duration` | `上轮{耗时}` | 显示 |
| `project` | 当前目录名 | 显示 |
| `quota5h` / `quotaWeek` | 独立 5 小时 / 本周额度，替代合并显示时使用 | 可选 |
| `input` / `output` | 末次输入 / 输出 token（不是整轮合计） | 可选 |
| `speed` | 生成速度 | 可选 |
| `branch` | Git 分支 | 可选 |
| `quotaStatus` | 暂无、需登录、旧数据标记 | 可选 |

`--modules` 选择启用的模块，`--order` 只调整顺序；`--order` 未列出的启用模块会自动接在后面。安装时传入即可，例如：

```bash
# 默认模块 + 输入输出和生成速度
node scripts/install-cli-hud.mjs --modules status,model,thinking,permission,quotaPair,cache,duration,project,input,output,speed

# 只要状态、合并额度和缓存率，并调整顺序
node scripts/install-cli-hud.mjs --modules status,model,quotaPair,cache --order status,model,quotaPair,cache
```

匀速参照线当前没有 CLI 实现，不占用模块位。

## 开发与验证

```powershell
npm run hud:test
npm run hud:verify
node scripts/verify-cli-hud.mjs --installed
```

只有一套渲染和事件处理实现：`src/cli-hud/hud.mjs`。`quota-worker.mjs` 负责额度请求，`scripts/install-cli-hud.mjs` 负责安装和恢复。修改后重新执行 `npm run hud:install`。

2026-10-23 本机证据：

- Kimi 2.2.0 原生终端完成真实读取 README 和模型回复，HUD 更新为“已完成”；2.3.0 恢复同一会话也显示正常。
- 当前专项测试 16/16 通过，覆盖用量口径、状态、会话隔离、思考切换、不误用全局默认、窄窗口布局、额度缓存、颜色、配置恢复和中文空格路径。
- 在 80 列 Kimi 2.3.0 原生终端确认当前宽度被识别：左右彩条、完整模型名、思考字段和询问模式同屏显示，右侧不再截断。未操作用户现有窗口进行拖动缩放。
- 在专用原生测试会话中用 `/model` 的 session-only 选择验证 High → Max → High，HUD 随日志更新；也复现了无会话切换 Max 后全局默认仍为 High 的情况，并移除了读取全局默认的错误回退。
- 精简版安装后，在 Kimi 2.3.0 原生终端确认彩色 HUD 加载；已安装命令带真实会话读取的独立检查 10/10 通过，241–269ms，保留原生 300ms 限制。
- **尚未做真实订阅账号与额度验证：提交者没有 Kimi 订阅。** 额度解析和显示主要通过模拟响应测试；非订阅环境仅观察到官方接口 `200 {}` 和认证失败，不能证明付费账号的 5 小时/周额度、重置时间或实际消耗变化正确。
- 提交前 Windows 全仓测试为 321 项：310 通过、9 失败、2 跳过。失败涉及未修改的桌面/Web 测试中的 Windows 路径、CRLF、符号链接和 rename 权限；不视作全仓 CI 通过。

## 来源

- [Alpaca233114514/claude-hud](https://github.com/Alpaca233114514/claude-hud)：参考紧凑布局，没有复制实现代码。
- [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/src/tui/utils/status-line-command.ts)：核对官方协议、刷新节奏和超时，没有复制或修改 Kimi 本体。
- 额度计算与用量口径复用本仓库 [metrics.js](../src/metrics.js)，适用 [MIT License](../LICENSE)，Copyright (c) 2026 十叶。安装产物包含 LICENSE。
