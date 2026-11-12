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

3. 打开 NextChat 设置 → **请求扩展插件** → **Claude Code 请求插件** → **添加插件**。确认后，在接口配置中选择 Anthropic Messages，填写网关地址、网关 API Key，手动添加供应商提供的模型名。
4. 请求插件选择 **Claude Code 3.2.0-beta.1**，模式选择 **真实 Claude Code CLI（-p）**。填写上一步的桥接令牌及实际 CLI 版本，保存即可。旧版用户也可继续使用原有 CLI 模式。

网页请求通过 NextChat 的 `/api/endpoint` 转发。**网页模式的桥接地址由网页服务器访问**，不是浏览器电脑的地址。自部署时可将桥接服务放在同一台机器；容器内使用可达的服务名。Edge/云托管部署需使用部署平台可以访问的独立桥接服务。桌面版使用原生 HTTP 连接本地桥接服务。纯静态网页仍需提供已有 `/api/endpoint` 转发服务。

CLI 模式由实际 CLI 发出上游请求，包含该版本 CLI 生成的请求头、system、工具定义、会话信息和签名。它使用官方 `--print` / `stream-json` 模式，并非伪造一个版本号。CLI 会自行重试上游请求；插件不会在失败时切换为模拟或标准 API。

## CLI 版本和运行配置

插件版本与 CLI 版本彼此独立。每个接口固定一个已安装插件版本；安装新版本不会自动迁移已有接口，切换回旧版本即可回退。桌面自动管理模式使用当前安装的 CLI，CLI 自动更新后会刷新实际版本，无需重启服务。版本探测按可执行文件路径、真实目标和文件元数据缓存，文件未改变时不重复启动 `claude --version`。手动桥接默认仍严格核对接口指定版本，管理员可明确配置 `versionPolicy: "installed"` 跟随当前安装版本。

桥接配置是管理员维护的本地 JSON 文件，例如：

```json
{
  "host": "127.0.0.1",
  "port": 8788,
  "timeoutMs": 0,
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
        "allowedTools": "Read,Glob,Grep",
        "maxSessions": 100,
        "retentionMs": 604800000
      }
    }
  ]
}
```

保存为自己的配置文件后运行 `node scripts/client-bridge.mjs <配置路径>`。路径和驱动模块相对于启动目录解析。`runtimes` 可省略，默认使用 `executable`、环境变量 `NEXTCHAT_CLAUDE_PATH` 或 PATH 中的 `claude`。不会下载、安装或更新 CLI。配置对应版本的二进制文件后，前端才能真正切换到那个版本。

CLI 默认使用独立的配置目录、临时工作目录及 `dontAsk` 权限模式，不继承父进程的 Anthropic/Claude 凭据。不设置跳过权限检查选项。本地工具默认仅开放 `Read,Glob,Grep`；桌面设置中的 **预先允许的 CLI 工具** 可填写 `Bash,Write,Edit,WebFetch` 等需要的名称，填写即授权对应工具执行，留空禁用本地工具。该设置由当前 NextChat 实例的 CLI 接口共享，下次请求生效。没有逐次弹窗；未预授权的工具不开放。

手动桥接由管理员设置 `allowedTools`、`settingsSources`、工作目录和可选的 `mcpConfig` 文件，默认并不加载用户本机的 MCP 或授权配置。请求携带的 API Key 仅在子进程环境中使用，不写进命令行或桥接日志。长系统提示词写入请求专属临时文件，通过 `--append-system-prompt-file` 传入，请求结束、失败或取消时删除。

当前桥接支持 NextChat 的 MCP 和工具插件：宿主只向 CLI 提供当前对话启用的工具定义，执行仍由 NextChat 原有的已注册执行器完成；每个对话的 MCP 禁用列表和插件选择生效。桥接为每个请求提供带独立随机令牌的临时 MCP 入口，不把 NextChat 的 MCP 服务器凭据或启动命令复制给 CLI。关闭工具的请求不会建立此入口，标题、摘要等辅助请求也关闭 CLI 本地工具。CLI 工具事件会显示在聊天中，工具调用前后的文字分段显示。手动部署须同步更新桥接代码才能使用此功能。

默认不设桥接总时限，长工具任务不会在十分钟时被桥接主动中断；用户仍可取消。桌面可配置 **CLI 请求时限（分钟）**，0 表示不限；手动部署使用 `timeoutMs`，独立组件使用 `NEXTCHAT_BRIDGE_TIMEOUT_MS`。上传请求仍有单独的两分钟限制；模型服务或网页部署平台自身的超时由对应服务决定。

只有历史与配置一致时才使用 CLI 原生续接，保留其历史和 thinking 签名。NextChat 的历史条数限制或长期记忆更新经常会改变上下文，此时创建新会话并立即回收同一对话旧的原生会话目录；不会伪造原有的工具结果或签名。失败或取消的会话也会删除。默认最多保留 100 个闲置会话，七天未使用的会话定期清理；活动请求不会被回收。

新版会话位于数据目录的 `managed-v2/run-*/session-*`。桥接重启时清理已退出实例留下的会话，首次请求重新导入 NextChat 历史；旧版本产生的 64 位哈希目录仅在其中所有文件超过七天未修改后清理。清理不涉及 NextChat 聊天记录或用户原有的 Claude Code 配置。手动部署可以通过 `maxSessions`、`retentionMs` 调整保留上限和期限。
