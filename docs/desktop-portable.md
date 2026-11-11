# NextChat Windows x64 便携版

完整解压 ZIP 后，双击 **NextChat.exe**。不需要逐个运行其他文件，也不需要打开终端。

- `NextChat.exe`：软件入口。
- `claude-code-tools`：软件自动调用的附加组件，保留在 EXE 同目录。
- `build-info.json`、`LICENSE`：构建信息和许可。

## 在界面里使用 Claude Code 请求插件

1. 打开设置 → **请求扩展插件** → **Claude Code 请求插件** → **添加插件**。这会把请求插件添加到 NextChat；已安装的 Claude Code CLI 可直接使用。
2. 编辑接口，协议选择 **Anthropic Messages**，填写网关地址、API Key，并添加供应商提供的模型名。
3. 请求插件选择 **Claude Code 3.2.0-beta.1**，再选择运行模式。
4. **独立 HTTP 模拟**：点击 **启动并连接**，服务地址和令牌自动填入，然后保存接口。不需要安装 Claude Code。
5. **真实 CLI（-p）**：自动查找本机已安装的 Claude Code，也可点 **选择程序** 指定 `claude.exe`；点击 **启动并连接**，地址、令牌、实际版本自动填入，然后保存接口。尚未安装 CLI 时才需要自行安装，无需另装 Node.js。

**从文件导入其他插件**只用于添加外部或曾从 NextChat 导出的请求插件 JSON 文件。使用上面的 Claude Code 请求插件不需要导入任何文件。

运行状态和 **停止服务** 按钮就在接口配置内。退出 NextChat 时，会关闭它启动的服务；重新打开软件后，重新点击 **启动并连接** 并保存。多个接口共用同一服务，已启动时点击 **使用此服务** 更新连接信息。

旧插件不会自动升级，已有接口需要手动选择 3.2.0-beta.1 才能显示管理按钮。更详细的模式、配置和网页部署说明位于 `claude-code-tools/docs/claude-code-modes.md`。

“便携版”表示免安装启动；聊天、设置和 CLI 会话仍存储在 Windows 用户数据目录中，不是全部保存在解压目录。迁移聊天和配置请使用软件的本地备份功能。
