# 交互式采集与完整请求对比

这些脚本仅用于开发验收。产品插件和独立发包程序不导入、不调用它们，也不需要 Claude Code 文件。采集阶段才需要被对照的真实 CLI；对比和产品运行不需要 CLI。

## 采集

启动本地模拟网关：

```powershell
node scripts/capture-interactive-request.mjs
```

它只监听随机的 `127.0.0.1` 端口，生成占位 API Key，将 `probe.json`、完整 `captures.json` 写入一个独立的系统临时目录。终端只打印路径、端口和请求计数，不打印请求内容。目录不受 Next.js 构建清理影响。

在另一个终端启动标准交互式 CLI，传入上一步打印的 `probe` 路径：

```powershell
node scripts/run-interactive-probe.mjs C:/.../nextchat-interactive-capture-.../probe.json
```

默认通过 PATH 查找 `claude`；可用 `NEXTCHAT_CLAUDE_PATH` 指定待对照的可执行文件。启动器继承终端，不传 `--print`，不管道输入。它隔离配置和工作目录、剔除继承的 Anthropic/Claude 认证配置，并使用模拟网关和占位密钥。实际版本与启动参数写入 `client.json`。首次使用需在交互界面完成主题、占位密钥及测试目录确认。

发送一个简单文本，例如 `Reply exactly INTERACTIVE_PARITY_PROBE.`，等待模拟回复；可再发第二条文本观察历史变化。然后输入 `/exit` 关闭 CLI，保留采集服务运行。模拟服务仅返回固定文本，不请求模型、不发起工具调用。

## 比较插件实际生成的请求

先按 [发包组件说明](wire-relay.md) 构建独立程序，再运行：

```powershell
node scripts/check-interactive-plugin.mjs C:/.../nextchat-interactive-capture-.../probe.json
```

该检查使用第一条捕获的实际用户文本、模型和明确的设备/会话身份，加载最终的 3.0.0-beta.2 安装包，独立生成请求并通过编译产物发包。它不复制原生系统块、工具、提醒或 safeguards。它会自动启动及关闭临时发包程序，将脱敏报告写入同一临时目录。比较服务需保持空闲，避免其他请求混入。

当前插件在此检查中**预期失败并返回退出码 1**，不能将其纳入必须通过的普通回归集，或删去差异字段来使其通过。退出码 0 也只证明这一条 HTTP 请求相同，不证明任意输入、多轮会话或 TLS 完整一致。

现在还支持显式的客户端特征检查，适用于保留 NextChat 提示词和工具的兼容目标：

```powershell
node scripts/check-interactive-plugin.mjs C:/.../nextchat-interactive-capture-.../probe.json client-surface
```

此模式检查请求头、协议参数、billing/身份、元数据和缓存结构，允许消息、长系统指令、工具及工具环境内容不同。输出同时保留 `equal`（完整 HTTP 字节是否相同）与 `clientSurfaceChecksPass`（指定客户端特征是否通过）。退出码只依据显式选择的范围。它不检查 TLS，也不预测网关是否接受；允许差异和未评估项始终随报告输出。

比较两份原始捕获中的指定请求：

```powershell
node scripts/request-parity.mjs reference.json candidate.json 0 0
```

默认索引为 0。比较器检查完整原始请求字节，包括头大小写、顺序、空白和正文序列化。JSON 字段对比仅用于定位差异，不改变字节级结果；即使 JSON 对象语义相同，键顺序不同也不通过。脱敏/部分基准不能作为完整原始捕获输入。

## 范围

采集服务目前只接受带 Content-Length 的 HTTP/1 请求，响应后关闭连接；它用于验证请求内容，不用于推断 TLS、连接复用或时序。独立 TLS 测试仍使用 `test/wire-relay.integration.mjs`。完整捕获含 CLI 系统文本与临时工作目录，仅供本地验证；报告用长度及哈希描述字段，不展示字段原文。完成后在采集服务终端按 Ctrl+C 停止。
