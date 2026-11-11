# 独立发包组件与 HTTP 模式

这个版本将上游 HTTP/TLS 发送从 NextChat 的浏览器、网页 fetch 和 Tauri reqwest 中分离出来。运行时只需要 NextChat、插件包和独立的 `nextchat-wire-relay.exe`，**不需要 Claude Code 文件，也不启动 Claude Code**。

当前目标是**客户端请求特征兼容**：保留 NextChat 的提示词、消息和工具，不复刻完整 CLI 的提示词或工具环境。已通过本地基准的请求行/头、billing/身份、元数据、协议参数、缓存结构及初始 ClientHello 对照。它仍是实验版；这些检查不代表所有网关都会接受，也不证明无法识别客户端。具体范围见 [验证记录](claude-code-wire-parity.md)。

## 当前可运行产物

- `public/request-plugins/nextchat.claude-code-3.1.0-beta.1.json`：可切换 HTTP 和 CLI -p 的 SDK 2 插件包，默认使用 HTTP 模式。
- `public/request-plugins/nextchat.claude-code-3.0.0-beta.2.json`：仍可使用的独立 HTTP 插件包。
- `build/nextchat-wire-relay.exe`：在 Windows x64 上构建的独立可执行文件；该目录不进入 Git。
- `scripts/wire-relay/` 与 `scripts/wire-relay.mjs`：独立发包服务源码。

旧版插件包保持不变。已有接口不会自动升级。3.1.0-beta.1 的 HTTP 模式复用此组件，CLI 模式使用独立桥接服务，见 [切换说明](claude-code-modes.md)。

## 使用

Windows x64 安装版或完整解压的便携版可直接在 `NextChat.exe` 中管理服务：安装并绑定 **Claude Code 3.2.0-beta.1**，选择独立 HTTP 模拟，保持 **自动管理本地服务** 并保存接口。地址和令牌由软件自动填写，退出软件时关闭服务；再次打开自动恢复已保存模式，无需进入设置。切换模式后，旧服务会在不再被接口或进行中的请求使用时停止。详细步骤见 [桌面界面启动](claude-code-modes.md#桌面界面启动推荐)。

网页部署或手动管理时，在运行发包服务的 Windows x64 机器上设置一个私有令牌并启动：

```powershell
$env:NEXTCHAT_WIRE_TOKEN = '替换为至少16字符的随机令牌'
& ./build/nextchat-wire-relay.exe
```

默认监听 `127.0.0.1:8789`。`NEXTCHAT_WIRE_HOST`、`NEXTCHAT_WIRE_PORT` 可调整监听地址和端口。关闭终端或 Ctrl+C 即停止。所有接口均校验令牌，不提供未经认证的转发。

NextChat 设置 → 请求扩展插件 → Claude Code 请求插件 → 添加插件；在 Anthropic Messages 接口中绑定 **3.2.0-beta.1**，选择 **独立 HTTP 模拟**，填写发包服务 URL 和相同令牌。桌面版手动连接时选择 **连接外部服务**。网关 URL、网关 API Key、模型仍填在接口本身。预览会显示 `independent-transport`、发包服务地址及上游请求，凭据被遮盖；预览不会启动服务。

网页版由 NextChat 部署服务器连接发包服务；桌面版由本机连接。远程网页部署中的 `127.0.0.1` 指部署服务器，不是访问网页的电脑。跨机器部署应放在受控网络中，并通过 HTTPS 反向代理保护服务令牌和请求内容。

当前网络配置只验收了 **官方 Bun 1.4.4+38afee6c8 / Windows x64**。不匹配的运行时、平台或缺失服务都会明确报错，不回退到普通 fetch 或真实 CLI。默认使用 Claude Code 2.1.322 的请求特征基准；3.0.0-beta.2 新增“自定义版本标记（未验证）”，可配置版本、SDK、Node 标记、beta 等。修改标记不会重建另一版 CLI 的协议或网络栈；独立网络运行时始终固定在已测构建上。

不同版本的请求插件独立安装，旧版绑定不自动升级。首次测试先使用默认基准、供应商实际提供的模型名与认证方式；在聊天中发送一条短消息。成功 SSE、401/403、429 和其他错误分别记录为实际结果，不将普通连接成功视为网关接受了模型请求。地址和密钥只需填在自己的 NextChat 接口配置中。

## 构建与测试

Windows 安装包与便携包可用 `./scripts/package-windows.ps1 -BunExecutable C:/Tools/bun-1.4.4/bun.exe` 一起生成到 `release/`。脚本要求工作区已提交，校验固定 Bun 构建、打包附加组件及许可，并验证 ZIP 中每个文件的 SHA-256；同名发布产物不会覆盖。需要已安装项目依赖、Rust/MSVC 与 Node.js/Corepack。

使用官方独立 Bun 1.4.4 Windows x64，构建过程不需要 Claude Code：

```powershell
node scripts/build-wire-relay.mjs C:/Tools/bun-1.4.4/bun.exe
node scripts/pack-request-plugin.mjs plugins/claude-code-wire
node --test test/wire-relay.integration.mjs
node --no-warnings --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand test/request-plugin.test.ts test/request-plugins-ui.test.tsx
```

构建脚本校验 Bun revision，再编译并执行产物的 `--version` 检查。没有正确版本时不会使用系统中的其他运行时替代。集成测试通过 `NEXTCHAT_TEST_WIRE_EXE` 可指定另一个构建产物；没有 Windows 产物时只跳过需要它的集成项，纯校验测试仍运行。

测试不调用真实模型，使用占位密钥和本地模拟上游。覆盖实际编译产物的 ClientHello、头大小写/顺序、UTF-8 请求体、认证、SSE、thinking 签名透传、压缩、上游错误、手动重定向和取消。ClientHello 测试对照脱敏的真实交互式 CLI 基准，排除握手中本来就变化的密码学随机值。

## SDK 2 传输扩展

SDK 1 插件继续兼容。需要独立网络组件的插件声明：

```json
{
  "sdkVersion": 2,
  "capabilities": ["request", "transport"]
}
```

`prepareRequest` 返回正常上游请求，并附加 `transport: { profile: "bun-1.4.4-38afee6c8-win32-x64" }`。配置字段 `transportUrl` 与 `transportToken` 由宿主读取；插件不能通过返回值更换服务令牌或偷偷重定向上游凭据。

宿主将方法、原始头列表和**已经序列化的请求体字符串**放入 `/v1/requests` 的 JSON 信封。网页代理或原生网络库只处理这个外层信封，无法改变上游头的大小写。网络组件拆出信封后发送请求，不解释模型协议、不执行模型工具、不改写正文、不读取本机账户。

组件验证 profile、URL、方法、头名、重复头和正文大小；禁止调用方覆盖 Host、Content-Length、Connection 等运行时负责的字段。上游重定向不会自动跟随。响应保持原有状态和内容，支持流式反压；调用方取消或服务超时会终止上游连接。解压后的响应会移除过期的 Content-Encoding/Content-Length。

组件是一个拥有网络访问能力的转发服务，不是沙箱。它不加载用户提交的代码或指定的可执行文件；日志仅包含启动信息，不记录请求或凭据。
