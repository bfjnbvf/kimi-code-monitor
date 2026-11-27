# Release 资产

仓库同时产出三个可独立安装的版本，外加一个运维技能包。Release 页面按资产分开上传，不要合并成一个 zip。

| 资产 | 版本 | 构建命令 | 内容 |
|---|---|---|---|
| **Web 扩展** `kimi-code-monitor-web-v3.8.1.zip` | 3.8.1 | `npm run pack:web` | `manifest.json`、`dist/`（content/background/popup）、`content.css`、`popup.*`、`rive/`、`rules/`、`icons/` |
| **桌面客户端补丁** `kimi-code-monitor-desktop-v3.8.1.zip` | 3.8.1 | `npm run pack:desktop`（等价 `pack:patch`） | `install.sh` / `install.cmd` / `install.mjs`、`client-app.mjs`、`scan.mjs`、`fetch-wallet.mjs`、`kcm/`（loader、panel-app、样式、Rive、默认关闭的宠物配置、VERSION） |
| **CLI HUD** `kimi-code-monitor-cli-v3.8.1.zip` | 3.8.1 | `npm run pack:cli` | `dist/hud.cjs`、`dist/quota-worker.cjs`、`scripts/install-cli-hud.mjs`、`scripts/verify-cli-hud.mjs`、`docs/CLI-HUD.md`、`LICENSE` |
| 运维技能 `kimi-code-monitor-skill-v3.8.1.zip` | 技能版本见包内 `MAINTENANCE.md` | `npm run pack` | `skill/` 打成 `kimi-code-monitor/` 目录，解压到 `~/.kimi-code/skills/` |

从 3.7.3 起只生成以上版本化资产，不再提供 `kcm-desktop-patch.zip` 与 `kimi-code-monitor-skill.zip` 旧固定别名；下载与升级地址由当前说明书中的版本化链接驱动。

## 一条命令全部构建

```bash
npm run pack
```

它依次执行：

1. `scripts/pack-web.sh` —— Web 扩展 zip（`dist/panel-app.js` 与 `dist/quota-worker.cjs` 不会被打进去）
2. `scripts/build-patch.mjs` —— 桌面补丁 zip
3. `scripts/pack-cli-hud.sh` —— 先 `node scripts/build-cli-hud.mjs` 产出 `dist/hud.cjs` 和 `dist/quota-worker.cjs`，再打 CLI HUD zip
4. 技能包（esbuild 单文件化脚本）

三个主资产互不依赖：Web/桌面的 `npm run build` 不会构建 CLI worker；CLI 的 `hud:build` 也不会碰 Web/桌面 bundle。

## 发布检查

- `manifest.json`、`package.json`、`package-lock.json`、`CHANGELOG.md` 顶部与 `skill/MAINTENANCE.md` 的 `patch-version` 一致；说明书顶条分别对应当前 `skill-version` 与 `patch-version`，两者无需相等（`tests/release-sync.test.js` 会守）
- 三个主资产都存在且 `unzip -t` 通过；CLI zip 里能看到 `dist/hud.cjs` 与 `dist/quota-worker.cjs`
- `npm run pack` 同时生成 `SHA256SUMS`，发布时随四个 zip 上传。逐个计算已下载文件的 SHA-256 并与清单对应行比较即可，不要求用户下载全部资产；载荷里的短哈希只用于缓存失效，不替代该校验
- CLI HUD 的安装、布局自定义与卸载说明见 `docs/CLI-HUD.md`
- Web/桌面/CLI 的安装说明分别对应各自的资产，不要把源码包（Code → Download ZIP）当成发行包
- 技能包是可选组件，不占“三个版本”的名额；`skill-version` 与 `patch-version` 分开维护
