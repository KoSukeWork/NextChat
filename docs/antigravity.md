# Antigravity ACP 请求插件

Antigravity 插件使用已安装的 `agy` CLI 和 ACP。使用第三方客户端是否符合 Google 条款需用户自行判断。

**开发状态：** 模型列表和普通回复已验证；实际 NextChat 工具的可用性及内置工具的完整禁用仍在验证。为避免在隔离未确认时运行，桌面和默认网页桥接暂时停用模型获取及对话请求。

功能开放后，可在设置中的请求扩展插件列表添加 Antigravity 1.0.0，创建 Anthropic 接口并选择该插件。此接口不需要网关地址或 API Key；点击获取模型选择 agy 返回的模型和思考档位。桌面选择内置连接，自动查找或手动指定 `agy.exe` 的绝对路径；网页版选择外部桥接并填写桥接地址、令牌及实际 agy 版本。

请先在运行 agy 的机器上完成登录。NextChat 不保存 Google 登录凭据。桌面驱动使用自己的 Gemini 配置目录和 agent 定义；由于 agy 1.5.11 拒绝绝对路径的 `--app-data-dir`，使用 agy 默认应用数据目录，NextChat 对话可能出现在 agy 的历史中。

系统消息通过 ACP 的 `systemPrompt.append` 扩展追加，未改写原文。模型选项来自 ACP `availableModels`；带档位的 ID 映射到基础模型与该档位，对话中显式设置的思考强度优先。会话记录与工具集合匹配时尝试续接，否则重放裁剪后的对话历史。

驱动通过 ACP 将当前对话启用的 NextChat MCP 和工具插件提供给 agy，工具执行仍由 NextChat 管理。驱动使用 `tools: []` 的隔离 agent、关闭默认自定义项，并拒绝非 NextChat 工具的权限请求；真实 agy 测试目前尚未证明它能调用这些工具，也未证明这些措施满足所有内置工具的禁用要求。

网页桥接部署见 [Node 桥接](request-plugins-legacy.md)。
