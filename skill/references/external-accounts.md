# 外部账户（余额快照代管）

面板的「外部账户」模块显示第三方平台的 API 余额：DeepSeek、Kimi API（Moonshot）、智谱（BigModel）、MiniMax。Light 版没有配置界面——**你就是配置界面**：用户把 key 给你，你抓一次余额写成快照，面板显示「截至 HH:MM」的数字。

## 安全规则（不可让步）

1. key **不回显**：你的任何输出里不出现完整 key（尾 4 位可以，用于让用户辨认）。
2. key **不持久化**：不写进任何文件、不存进对话摘要、不放进 issue 报告。每次刷新由用户重新提供。
3. 只允许请求 providers 白名单端点（脚本内部已限定），不要手动构造其他请求。
4. 用户主动把 key 粘贴到对话里后，提醒一句「对话记录会保留这个 key，建议用可轮换的 key」。

## 添加 / 刷新（同一流程，整体替换快照）

1. 问用户要：哪家平台 + API key（可选：备注名）。key 获取入口：
   - DeepSeek：platform.deepseek.com → API keys
   - Kimi API：platform.moonshot.cn → API Key 管理
   - 智谱：bigmodel.cn → API keys
   - MiniMax：平台控制台 → API key
2. 执行（key 通过参数传入脚本，脚本不落盘）：

   ```bash
   node <技能目录>/scripts/fetch-external.mjs \
     --fetch '[{"provider":"deepseek","key":"用户的key","label":"可选备注"}]' \
     --out "<客户端>/Contents/Resources/desktop-dist/vibepal/external.js"
   ```

   多家就数组里多个对象。客户端路径可用 doctor.sh 第一行输出。
3. 核对输出：每家「抓取成功」或明确的失败原因（401=key 无效）。失败的那家把原因转述给用户，其余照常写入。
4. 告诉用户：面板稍后自动刷新（约一分钟内）或重载客户端立即生效；显示的是**快照**，之后的花费不会自动更新，想刷新就再说一声。

## 移除

```bash
 node <技能目录>/scripts/fetch-external.mjs --clear --out <同上路径>
```

移除单个平台 = 用剩下的账号重跑一次 --fetch（整体替换）。

## 预期管理（对用户如实说）

- 快照非实时：两次刷新之间的消耗不反映。
- 客户端大版本更新可能清掉快照文件：重新提供 key 刷一次即可。
