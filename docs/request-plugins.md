# 请求扩展插件与 Claude Code

当前目标是保留 NextChat 提示词和工具的**客户端请求特征兼容**，不再以完整 CLI 请求正文逐字节相同作为验收条件。原始完整对照结果保留在 [网络层验证记录](claude-code-wire-parity.md)，不会被改写成成功。

当前安装按钮提供 **3.1.0-beta.1 双模式插件**，可在接口配置中切换独立 HTTP 模拟与真实 CLI `-p / --print`，两种模式分别保留配置。操作步骤见 [模式切换说明](claude-code-modes.md)。HTTP 模式沿用 3.0.0-beta.2 的实现，其本地客户端特征和初始 TLS 指纹检查通过，实际网关接受情况仍需测试。下文的 2.0.0 用法保留供旧包回退使用。

请求扩展是独立于 OpenAPI/MCP 工具的插件系统：宿主管理安装、版本、配置和执行生命周期，协议特征由可安装的 ESM 包负责。标准 API 不绑定插件时保持原有流程。

## 使用交互式 HTTP 模拟

1. 设置 → **请求扩展插件** → **导入插件**，选择 `public/request-plugins/nextchat.claude-code-2.0.0.json`。
2. 在接口配置中选择 **Anthropic Messages**，填写第三方网关 URL 和 API Key，手动添加供应商提供的模型名。
3. 选择 **Claude Code 2.0.0** 请求插件，保留默认的 2.1.322 抓包预设即可开始测试。Bearer 网关改选认证方式。
4. **预览请求**可检查最终 URL、请求头和示例请求体，不发送网络请求；凭据会被遮盖。保存后发送聊天。

运行时不启动 CLI，不需要终端、桥接服务或 CLI 登录。网页版通过现有 `/api/endpoint` 转发自定义请求头与 SSE；桌面版走原生 HTTP。普通纯静态网页仍需要可用的 `/api/endpoint` 转发服务。网页传输避免浏览器丢弃 User-Agent 等客户端特征头。

旧版包和绑定保持不变。安装新版本后需在接口中显式选择版本；不会自动迁移或覆盖旧包。真实 `--print` 驱动继续维护，并在 3.1.0-beta.1 中作为独立模式提供，见 [CLI 桥接说明](request-plugins-legacy.md)。

## 当前复现范围

基准来自本机 Windows x64 上真实 **Claude Code 2.1.322 交互式 PTY 会话**，目标是使用占位 API Key 的本地模拟网关，模型为 `claude-sonnet-4-6`。采集没有使用 `--print`。脱敏基准保存在 `test/fixtures/claude-code-interactive-2.1.322.json`。

| 内容         | 2.0.0 行为                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| URL 与身份头 | `/v1/messages?beta=true`、`claude-cli/2.1.322 (external, cli)`、`x-app: cli`、Stainless SDK 头与基准 beta 列表                    |
| 系统块       | 首块 billing、第二块 CLI 身份文本、第三块原有系统指令及可选附加提示词                                                             |
| billing 后缀 | 对首条用户消息的首个文本块取 UTF-16 位置 4、7、20（缺失为 `0`），以已核验的 salt 和版本求 SHA-256，取前三位；基准探针结果为 `e3c` |
| 会话身份     | 头与 `metadata.user_id` 中的会话 UUID 一致；设备 ID 默认由接口 ID 稳定派生，也可指定                                              |
| 生成参数     | 默认 `max_tokens=32000`、adaptive thinking、`display=updates`、effort high、clear_thinking keep all；均可调整                     |
| 缓存         | 默认身份块、指令块与最后一条消息的末尾可缓存块设置 ephemeral，不给工具定义添加缓存断点                                            |
| 工具和历史   | 使用 NextChat 实际可执行的工具；每轮重新适配请求副本，保留工具 ID、输入、结果和服务端返回的 thinking 签名                         |
| 模型列表     | 默认提示手动添加，避免给 CLI 专用接口发送不支持的列表请求；可显式启用标准列表接口                                                 |

**这是有抓包依据的 HTTP 兼容实现，并非完整 CLI 的逐字节复刻。** 保留了 NextChat 的系统指令和工具，不复制 CLI 的完整内置提示词、环境提醒、文件权限状态或 `safeguards`。该 API Key/自定义地址基准没有 `cch`，因此没有凭空添加这一字段；OAuth/官方端点的请求不是当前已验证基准。Bearer 选项只切换网关认证格式，不实现官方 OAuth 登录。

Node 网页服务和 Tauri 原生网络库管理 TLS、HTTP 版本、头顺序、压缩及连接头，可能添加额外传输头；这些指纹与 Claude CLI 不保证相同。不同 CLI 版本、模型、权限模式和账户会改变请求。没有第三方网关资料或凭据，本项目的本地验收不能证明所有供应商接受请求。

## 可配置项与覆盖顺序

- **版本**：已抓包预设只接受 2.1.322。选择“自定义版本（未验证）”可填写其他版本，同时核对 SDK 版本、Node 版本标记、平台、架构和 beta；修改版本字符串不会自动获得那个版本的协议实现。
- **认证与身份**：API Key/Bearer、64 位十六进制设备 ID、可选账户 UUID。不会读取用户本机 Claude 凭据。默认设备 ID 在同一接口的不同会话中稳定；复制接口配置会保留同一身份。
- **思考与输出**：模型不支持 adaptive 时选择“使用聊天设置”或关闭思考；最大 Token 和 effort 留空保留聊天设置。启用思考时删除冲突的 temperature/top_p/top_k。
- **系统与缓存**：附加系统提示词和原有系统指令保持系统角色，不移入用户消息。缓存选择“保留原有配置”时不自动增删原有断点。
- **高级覆盖**：请求头 JSON 使用字符串设置、`null` 删除，名称不区分大小写，传输头不可覆盖。请求体 JSON 替换顶层参数，随后统一生成 metadata/billing、整理系统块和缓存。beta 被移除时不注入依赖它的 context_management。若替换 messages，billing 以替换后的消息计算。

请求格式：原始协议请求 → 版本及头配置 → 生成参数 → body 覆盖 → 身份、系统和缓存规范化 → 宿主校验 → 网页/桌面传输。预览、聊天、标题和摘要共用同一插件链路；模型列表只应用头配置，不添加聊天请求体。

## 插件 SDK v1

插件包为 JSON `{ manifest, source }`。清单包含 `sdkVersion: 1`、ID、语义版本、名称、说明、支持的协议、能力与配置字段。字段支持 `string`、`secret`、`select`，宿主自动生成配置 UI。协议逻辑无需进入 React、Zustand、Next.js 或 Tauri。类型定义见 `app/request-plugins/sdk.ts`。

```js
export function prepareRequest(request, context) {
  // request: { url, headers, body? }
  // context: operation (chat/models), protocol, endpoint, config,
  //          stable sessionId, requestId
  return request;
}

// 可选 driver 扩展；HTTP 插件无需声明/导出。
export function prepareChat(chat, context) {
  // null 继续 HTTP 流程；返回请求时进入驱动 NDJSON 流程。
  return null;
}
```

每次钩子调用在独立 module Worker 中执行，10 秒超时并支持取消。不能依赖 Worker 全局状态跨请求保存数据。每次工具续接和重试都传入请求副本，避免污染原始历史。普通请求目的地必须与所配置网关同源；驱动目的地必须与 `config.bridgeUrl` 同源。

字段可声明 `when: { field: "mode", value: "cli" }`，仅在指定的顶层 select 字段取该值时显示。隐藏只影响界面，不删除已保存的配置；引用的字段和值在安装时校验。宿主不识别 Claude 专有模式，实际路由仍由插件的 `prepareChat` / `prepareRequest` 决定。

插件代码能读取消息和凭据并访问网络。Worker 提供执行隔离，**不是网络安全沙箱**，只应安装可信代码。安装、重新启用和启用陌生备份插件均显示信任提示。

开发时创建 `manifest.json` 与 `index.mjs`，运行：

```text
node scripts/pack-request-plugin.mjs plugins/your-plugin output/your-plugin.json
```

打包器将 ESM 及其浏览器兼容依赖打包成单个源文件。安装现成 JSON 包不需要重新编译宿主，也不需要下载运行时依赖。Claude Code 插件使用现有 `@noble/hashes` 依赖计算 SHA-256，避免依赖只在安全上下文中可用的 WebCrypto。

同一 ID/版本内容不可覆盖。插件支持导入、导出、启停、卸载和按接口绑定版本。缺失或禁用时明确报错，不偷偷退回标准 API。插件及配置进入本地备份；不进入云聊天同步。旧驱动支持 NDJSON 的 text、thinking、tool_start、tool_end、error、done，参见 [旧版说明](request-plugins-legacy.md)。

## 研究来源与验证

研究参考以下公开 MIT 社区实现的协议分析；没有执行社区安装脚本，也没有导入流传的完整 CLI 源码或其提示词：

- [opencode-cloak cch.go（固定提交）](https://github.com/conversun/cliproxy-plugin-opencode-cloak/blob/5ee0f9dafa4ec7e7ae2ad8a9f2788d21276a12f3/cch.go)：版本后缀的 salt、采样位置和哈希规则。本机抓包验证的是用户实际输入，不能把 CLI 注入的第一个 reminder 当成该输入；其 `cch` 实现未采用。
- [cc-mimicry surface.go（固定提交）](https://github.com/Arkptz/cc-mimicry/blob/ef1f6010476efe028a57f438f5c2754f641b5ffb/internal/mimicry/surface.go)：交互式与 SDK 模式身份差异及捕获方法。该项目的 OAuth beta、提示词替换和工具重命名没有直接套用。

```powershell
node scripts/pack-request-plugin.mjs
node --test test/claude-code-http.integration.mjs
node --no-warnings --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand test/request-plugin.test.ts test/request-plugins-ui.test.tsx
```

HTTP 测试直接载入最终安装包，与脱敏交互式基准比较；验证不同输入的动态后缀、工具续接和签名、配置覆盖、认证切换、模型列表、真实本地 SSE 与取消断连。应用测试检查版本固定、不可变安装、界面配置、请求副本和错误传播。网页与桌面共享插件代码，分别由转发和原生传输承载。

`scripts/capture-claude-request.mjs` 与 `test/client-bridge.integration.mjs` 是旧版 **非交互式** 驱动的测试，不能作为本版交互式一致性的证据。
