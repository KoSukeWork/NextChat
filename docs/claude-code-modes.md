# 切换 HTTP 模拟与真实 CLI -p

安装 **Claude Code 3.1.0-beta.1** 后，同一个接口可选择两种运行模式。旧版 1.0.0、2.0.0、3.0.0-beta.x 的插件包和接口绑定保留，不自动迁移。

1. 设置 → **请求扩展插件** → **安装 Claude Code**，安装新版。
2. 编辑一个 Anthropic Messages 接口，在“请求扩展插件”中选择 **Claude Code 3.1.0-beta.1**。
3. 在 **运行模式 / Mode** 中选择“独立 HTTP 模拟”或“真实 Claude Code CLI（-p）”，填写该模式的配置并保存。

| 模式                       | 发包者                 | 所需组件                                           | 工具执行             |
| -------------------------- | ---------------------- | -------------------------------------------------- | -------------------- |
| 独立 HTTP 模拟（默认）     | 固定构建的独立网络组件 | `nextchat-wire-relay.exe`，默认端口 8789           | NextChat 工具与 MCP  |
| 真实 CLI（`-p / --print`） | 安装的真实 Claude Code | Node.js、CLI 和 `client-bridge.mjs`，默认端口 8788 | CLI 自己的工具与 MCP |

界面只展示当前模式的字段，隐藏另一模式时不会清除它的配置。HTTP 版本标记和实际 CLI 版本分别保存，两个服务的地址、令牌和 beta 配置也分别保存；接口网关地址、API Key、模型与认证方式共用。切换模式并保存后，后续请求使用新模式；已经开始的请求继续使用启动时的配置。

## 启动 HTTP 模式

```powershell
$env:NEXTCHAT_WIRE_TOKEN = '替换为至少16字符的随机令牌'
& ./build/nextchat-wire-relay.exe
```

在 HTTP 模式填写相同令牌，默认服务地址 `http://127.0.0.1:8789`。此模式不加载 CLI 文件，详情见 [独立发包组件](wire-relay.md)。

## 启动 CLI -p 模式

```powershell
claude --version
$env:NEXTCHAT_BRIDGE_TOKEN = '替换为至少16字符的随机令牌'
node scripts/client-bridge.mjs
```

在 CLI 模式填写实际 CLI 版本、相同令牌和默认桥接地址 `http://127.0.0.1:8788`。桥接服务每次核验真实版本，随后启动 `--print`、以 `stream-json` 输入输出；`-p` 是 `--print` 的短选项。这是非交互式调用，不启动交互式终端会话。额外 CLI beta 留空时采用 CLI 默认值，CLI 模式的模型列表需要手动添加。

CLI 路径、多版本映射、工作目录及工具配置见 [CLI 桥接说明](request-plugins-legacy.md)。HTTP 模式不要求启动此服务；CLI 模式不要求启动独立 HTTP 服务。缺少当前模式的组件或版本不匹配时会报错，不自动切换另一模式。

网页模式由 NextChat 部署服务器连接上述服务，桌面版由本机连接；网页版的 `127.0.0.1` 指部署服务器。工具由所选模式对应的执行器管理，切换模式不会迁移 CLI 内部的工具状态或签名历史。已有聊天仍作为上下文传递；不满足原生续接条件时，CLI 创建新的原生会话。
