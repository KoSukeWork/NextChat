# 真实 Claude Code CLI -p 桥接

这是继续维护的非交互式 `-p / --print` 驱动。新版 **3.2.0-beta.1** 可直接选择此模式，也可切回独立 HTTP 模拟；配置分别保留。Windows x64 桌面版可在界面中选择 CLI 并启动随包桥接，无需另装 Node.js，见 [模式切换说明](claude-code-modes.md)。旧版包与绑定仍可继续使用。

## 从源码手动部署桥接服务

1. 在运行桥接服务的机器上安装 Node.js 20+ 和 Claude Code，运行 `claude --version` 确认版本。
2. 在本仓库根目录启动附加服务。它不需要 NextChat 的 npm 依赖：

   ```powershell
   $env:NEXTCHAT_BRIDGE_TOKEN = '请替换为至少16字符的随机令牌'
   node scripts/client-bridge.mjs
   ```

   服务默认仅监听 `127.0.0.1:8788`，所有接口都需要这个令牌。关闭终端或按 Ctrl+C 停止服务。它通过参数数组启动 CLI，不经过 shell，也不接受 HTTP 请求指定任意可执行文件。

3. 打开 NextChat 设置 → **请求扩展插件** → **安装 Claude Code**。确认后，在接口配置中选择 Anthropic Messages，填写网关地址、网关 API Key，手动添加供应商提供的模型名。
4. 请求插件选择 **Claude Code 3.2.0-beta.1**，模式选择 **真实 Claude Code CLI（-p）**。填写上一步的桥接令牌及实际 CLI 版本，保存即可。旧版用户也可继续使用原有 CLI 模式。

网页请求通过 NextChat 的 `/api/endpoint` 转发。**网页模式的桥接地址由网页服务器访问**，不是浏览器电脑的地址。自部署时可将桥接服务放在同一台机器；容器内使用可达的服务名。Edge/云托管部署需使用部署平台可以访问的独立桥接服务。桌面版使用原生 HTTP 连接本地桥接服务。纯静态网页仍需提供已有 `/api/endpoint` 转发服务。

CLI 模式由实际 CLI 发出上游请求，包含该版本 CLI 生成的请求头、system、工具定义、会话信息和签名。它使用官方 `--print` / `stream-json` 模式，并非伪造一个版本号。CLI 会自行重试上游请求；插件不会在失败时切换为模拟或标准 API。

## CLI 版本和运行配置

插件版本与 CLI 版本彼此独立。每个接口固定一个已安装插件版本；安装新版本不会自动迁移已有接口，切换回旧版本即可回退。CLI 版本在接口中配置，桥接服务在每次请求前执行 `--version` 核对，实际版本不匹配时不会向网关发送请求。

桥接配置是管理员维护的本地 JSON 文件，例如：

```json
{
  "host": "127.0.0.1",
  "port": 8788,
  "timeoutMs": 600000,
  "drivers": [
    {
      "module": "plugins/claude-code/driver.mjs",
      "options": {
        "executable": "C:/Users/admin/.local/bin/claude.exe",
        "runtimes": {
          "2.1.322": "C:/Tools/Claude/2.1.322/claude.exe"
        },
        "workingDirectory": "C:/NextChat/cli-workspace",
        "dataDirectory": "C:/NextChat/cli-data",
        "settingsSources": "",
        "allowedTools": "Read,Glob,Grep"
      }
    }
  ]
}
```

保存为自己的配置文件后运行 `node scripts/client-bridge.mjs <配置路径>`。路径和驱动模块相对于启动目录解析。`runtimes` 可省略，默认使用 `executable`、环境变量 `NEXTCHAT_CLAUDE_PATH` 或 PATH 中的 `claude`。不会下载、安装或更新 CLI。配置对应版本的二进制文件后，前端才能真正切换到那个版本。

CLI 默认使用独立的配置目录、临时工作目录及 `dontAsk` 权限模式，不继承父进程的 Anthropic/Claude 凭据。不设置跳过权限检查选项。`settingsSources`、工作目录、允许的工具和可选 `mcpConfig` 文件由桥接管理员配置；设置它们可以接入自己的 CLI 工作环境。请求携带的 API Key 仅在子进程环境中使用，不写进命令行或桥接日志。

CLI 模式由 CLI 管理工具和 MCP，NextChat 的工具插件/MCP 选择器不参与 CLI 执行。CLI 工具事件会显示在聊天中。标题、摘要等辅助请求关闭 CLI 工具。需要使用 NextChat 原有工具执行器时，选择标准模式或模拟模式。

正常连续对话使用 CLI 原生会话续接，保留其历史和 thinking 签名。编辑、截断、导入聊天或更改模型/配置导致历史不一致时创建新 CLI 会话，将已有聊天作为带角色标记的上下文交给 CLI；不会伪造原有的工具结果或签名。桥接重启后会话映射重建，首次请求同样重新导入上下文。CLI 文件保存在配置的数据目录，可由管理员定期清理。
