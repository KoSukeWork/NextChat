# Claude Code CLI 插件

Claude Code 请求插件 4.1.0 使用已安装的官方 Claude Code 的非交互式 `-p / --print`。在设置 → **请求扩展插件** 中点击 **Claude Code 请求插件 → 添加插件**，确认信任提示；在 Anthropic 接口选择插件并手动添加模型。凭据方式默认为网关地址和 API Key；也可选择 **使用 Claude 订阅登录**，此时无需填写网关地址或 API Key。

模型需按当前 Claude Code 版本和账户可用性手动填写，可参考官方 CLI 的模型别名（如 `sonnet`）或当前可用的完整模型 ID；不同订阅的模型权限和可用额度可能不同。当前环境的真实订阅请求因账单状态被官方 CLI 拒绝，因此尚未确认任何别名或完整 ID 能在该订阅下成功回复。

## 订阅登录的使用限制

此模式只供订阅持有人本人使用。NextChat 没有账号系统，多设备指同一人的设备；不要与其他人共享使用订阅模式的 NextChat 或桥接部署。先在运行 CLI 的机器上，在终端运行未经修改的官方 `claude` 并自行登录。NextChat 不读取、保存或转发 Claude 凭据，后台也不会发起登录；未登录时请自行在终端登录。使用量计入个人订阅的正常额度。若不确定适用规则，请使用 API Key。

Anthropic 规则在 2026 年多次变化，今后可能继续变化：请查看 [Claude Code 法律与合规](https://code.claude.com/docs/en/legal-and-compliance) 和 [使用 Claude 计划运行 Claude Agent SDK](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)（核对日期：2026-11-19）。

## 桌面内置

选择 **内置（桌面）**。桌面自动查找已安装的 `claude.exe`，也可在接口配置中选择绝对路径的程序；界面显示检测到的版本。使用安装的版本，程序文件更新后自动重新检测。NextChat 按请求启动和结束 CLI，无需另装 Node 或启动桥接服务。

选择订阅登录时，接口设置打开后会显示官方 CLI 报告的登录状态，可手动刷新，不会后台轮询。网关地址、API Key 和仅适用于 API Key 的 beta 标记不会传递给订阅请求。

**预先允许的 CLI 工具**是以逗号分隔的名称，默认 `Read,Glob,Grep`，留空禁用本地工具。列出的工具可以执行而不再逐次确认；这些设置为桌面 CLI 接口共享。请求时限以分钟设置，0 为不限，仍可手动取消。

## 外部桥接

网页版选择 **外部桥接服务**，填写桥接地址、令牌和实际 CLI 版本。桌面也可选择外部桥接。网页由 NextChat 服务器访问桥接地址。订阅模式默认关闭，管理员必须明确启用；桥接令牌仍必需。部署及配置见 [Node 桥接](request-plugins-legacy.md)。

## 会话和工具

系统提示词通过每次请求的临时文件传给 CLI，请求结束时清理。会话历史和配置一致时续接；上下文改变、失败或取消后使用新会话。网关模式的 CLI 配置和会话隔离在 NextChat 数据目录。

订阅模式由官方 CLI 使用默认 Claude 配置保存和读取其自身的登录，NextChat 只登记自己生成的会话 UUID。相应对话会出现在 Claude Code 历史中，文件位于 Claude 配置下 `projects/<NextChat 工作目录>`。清理目标为超过 100 个或闲置七天以上的已登记会话，只删除该项目目录中 UUID 精确匹配的 transcript；不会枚举或删除其他 Claude 会话。正在使用的会话以及其他仍存活进程拥有的会话会保留，进程号被重用时也会保守保留；清理在请求结束时触发。

订阅请求强制空 `--setting-sources`、`--strict-mcp-config`、`--permission-mode dontAsk`、`--disable-slash-commands`，并设置关闭 hooks、Claude.ai 连接器和自动记忆。用 Claude Code 2.1.328、隔离的合成用户配置和本地假网关测试时，全局 `CLAUDE.md`、skill、agent 和 output style 的测试标记未出现在网关请求中，合成 hook 也未执行；切换为允许用户设置的对照组后，标记出现且 hook 执行。显式的 NextChat MCP 正常工作。合成插件标记在对照组中也未出现，因此插件是否会加载尚未验证；托管策略及其他配置组合也未逐项验证，CLI 升级可能改变行为。不要把这些开关视为完整的安全沙箱；启用的 NextChat 工具仍可执行。

CLI 本地工具遵循上述预授权名单。当前对话启用的 NextChat MCP 和工具插件也可供 CLI 使用，由 NextChat 原有执行器处理；每次请求只开放该请求启用的工具。CLI 工具事件和分段文字在对话中显示。
