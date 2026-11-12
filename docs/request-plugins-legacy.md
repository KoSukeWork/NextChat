# Node CLI 桥接部署

网页版的 Claude Code 插件连接自行部署的 Node 桥接；桌面可直接使用内置驱动。插件安装和会话说明见 [Claude Code CLI 插件](claude-code-modes.md)。

在运行桥接的机器安装 Node.js 20+ 和 Claude Code，确认 `claude --version`，然后在仓库根目录运行：

```powershell
$env:NEXTCHAT_BRIDGE_TOKEN = '替换为至少16字符的随机令牌'
node scripts/client-bridge.mjs
```

默认监听 `127.0.0.1:8788`，接口需要令牌。网页接口配置的桥接地址必须能从 NextChat 服务器访问；填写相同令牌和实际 CLI 版本。停止进程即可关闭桥接。

可用 `node scripts/client-bridge.mjs <配置文件路径>` 指定管理员维护的 JSON，例如：

```json
{
  "host": "127.0.0.1",
  "port": 8788,
  "timeoutMs": 0,
  "drivers": [{
    "module": "plugins/claude-code/driver.mjs",
    "options": {
      "executable": "C:/Users/admin/.local/bin/claude.exe",
      "workingDirectory": "C:/NextChat/cli-work",
      "dataDirectory": "C:/NextChat/cli-data",
      "allowedTools": "Read,Glob,Grep",
      "maxSessions": 100,
      "retentionMs": 604800000
    }
  }]
}
```

路径相对于启动目录解析。省略 `executable` 时使用 `NEXTCHAT_CLAUDE_PATH` 或 PATH 中的 `claude`。外部桥接默认核对插件配置的 CLI 版本；文件更新后重新检测版本。`timeoutMs` 为 0 表示不限。管理员应根据部署环境保护桥接连接和令牌。

桥接隔离 CLI 配置及凭据，通过临时文件传递系统提示词。预授权 CLI 工具由管理员的 `allowedTools` 控制；NextChat 当前对话启用的 MCP 和插件工具仍由 NextChat 执行。每次请求使用独立授权的临时 MCP 入口。桥接重启后重新导入 NextChat 的对话历史。
