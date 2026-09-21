# Kimi Code 桌面端 · 用量面板补丁（Light 版）

> 状态：首版完成，本机实测中。补丁包与 Chrome 扩展同仓库同源码（`src/panel-app/`），一次改动两侧同时生效。
>
> **推荐的完整流程是技能**：把本仓库地址发给桌面客户端里的 Kimi，它会安装 `skill/` 下的运维技能并引导完成安装、自检、答疑与外部账户配置（技能文档见 `skill/SKILL.md`）。本文的下述提示词是"不带技能"的裸安装方式，功能等价、体验朴素。

## 这是什么

把 Kimi Code Monitor 的侧栏面板以**补丁**形式装进 Kim Code 桌面客户端：会话侧栏底部显示额度、token、缓存命中、速度、按天消耗图表与吉祥物。不改客户端代码逻辑，只往 `Contents/Resources/desktop-dist/` 放一个 `kcm/` 目录并在 `index.html` 注入一行 `<script>` 标签；原始 `index.html` 自动备份，`--uninstall` 可完整还原。

**分发方式：提示词。** 把下面的安装提示词发给桌面客户端里的 Kimi Code，它自己下载、解压、执行安装脚本。客户端自动更新会整体替换 `desktop-dist`（补丁随之消失，属预期），把同一段提示词再发一遍即可重装。

## 数据来源（三层）

1. **实时**：面板直连客户端内嵌的本地服务（kap-server），WS 事件流 + REST 轮询，与客户端页面同机回环，无任何外发；
2. **历史预填**：安装时全量扫描 `~/.kimi-code/sessions`（Kimi Code 自己的会话日志，桌面端与 CLI 共享），生成 `usage-daily.js`——需要本机有 node，没有则跳过；
3. **页内积累**：面板把每轮用量按天攒进页面 localStorage（存于客户端用户数据目录，**客户端更新不会清掉**），与历史文件按天取大合并，不双算。

## 安装提示词

正式版（与 README 头部内嵌的提示词一致，v3.5.0 起可直接复制）：

```text
请帮我安装 Kimi Code 桌面客户端的用量监控面板补丁：

1. 下载补丁包：到 https://github.com/bfjnbvf/kimi-code-monitor/releases 下载最新的 kcm-desktop-patch-v*.zip
2. 校验文件完整（zip 能正常列出 install.mjs、install.sh、scan.mjs、kcm/ 即可）
3. 解压到一个临时目录
4. 确认有 Node（node -v，需 ≥16；没有先引导我装，不要尝试其他安装方式）
5. 在该目录执行：node install.mjs（客户端不在默认位置时 node install.mjs --app "<客户端目录>"）
6. 完成后把这些告诉我：
   - install.mjs 的完整输出
   - 客户端版本（macOS：/Applications/Kimi Code.app/Contents/Info.plist 的 CFBundleShortVersionString；Windows：安装目录里 Kimi Code.exe 的文件版本）
   - 若弹出了系统权限确认框，弹的是什么、你怎么处理的
7. 提醒我重载客户端（macOS Cmd+R，Windows Ctrl+R），面板会出现在会话侧栏底部

要求：只运行补丁包里的 install.mjs（它只改 desktop-dist 并自动备份）；任何一步失败都不要尝试其他修改，把报错原样告诉我。
```

本机测试版（未发布前，把第一二步换成本地路径）：

```text
请帮我安装 Kimi Code 桌面客户端的用量监控面板补丁：

1. 补丁包在本地：/Users/gabriel/Documents/Coding/kimi-code-monitor/kcm-desktop-patch-v3.5.0.zip
2. 解压到一个临时目录，确认有 Node（node -v，需 ≥16），在其中执行：node install.mjs
3. 完成后把这些告诉我：install.mjs 的完整输出、客户端版本（macOS 读 Info.plist 的 CFBundleShortVersionString；Windows 读 Kimi Code.exe 的文件版本）、是否弹出权限确认
4. 提醒我重载客户端（macOS Cmd+R，Windows Ctrl+R）

要求：只运行补丁包里的 install.mjs；任何一步失败都不要尝试其他修改，把报错原样告诉我。
```

## 卸载提示词

```text
请卸载 Kimi Code 桌面客户端的用量面板补丁：在之前解压的补丁目录执行 node install.mjs --uninstall，把输出告诉我，并提醒我重载客户端（macOS Cmd+R，Windows Ctrl+R）。如果找不到原目录，重新下载/解压同一个补丁包后执行同样命令即可。
```

## 明确不做 / 边界

- 不修改客户端程序逻辑（app.asar 不动），只放静态资源 + 一行 script 标签；
- 注入面板的配置存页面 localStorage，与 Chrome 扩展的配置互不相通；
- 安装需 Node ≥16（历史预填与安装器同用）；没有 sessions 目录的机器跳过预填，面板从安装时刻开始积累（面板锁位会如实显示「统计积累中」与状态行）；
- 客户端大版本更新若改动侧栏 DOM 或本地服务接口，面板可能挂载失败（表现为不显示，无残缺 UI）——把安装提示词再发一遍，智能体会报告客户端版本，等待适配。
