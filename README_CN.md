<div align="center">

<a href='#企业版'>
  <img src="./docs/images/ent.svg" alt="icon"/>
</a>

<h1 align="center">NextChat</h1>

一键免费部署你的私人 AI 助手网页应用，支持 Claude, GPT4 & Gemini Pro 模型。

[NextChatAI](https://nextchat.club?utm_source=readme) / [企业版](#%E4%BC%81%E4%B8%9A%E7%89%88) / [演示 Demo](https://chat-gpt-next-web.vercel.app/) / [反馈 Issues](https://github.com/Yidadaa/ChatGPT-Next-Web/issues) / [加入 Discord](https://discord.gg/zrhvHCr79N)

[<img src="https://vercel.com/button" alt="Deploy on Zeabur" height="30">](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FChatGPTNextWeb%2FChatGPT-Next-Web&env=CODE&project-name=nextchat&repository-name=NextChat) [<img src="https://zeabur.com/button.svg" alt="Deploy on Zeabur" height="30">](https://zeabur.com/templates/ZBUEFA) [<img src="https://gitpod.io/button/open-in-gitpod.svg" alt="Open in Gitpod" height="30">](https://gitpod.io/#https://github.com/Yidadaa/ChatGPT-Next-Web)

</div>

## Sponsor AI API

<a href='https://302.ai/'>
  <img src="https://github.com/user-attachments/assets/d8c0c513-1e18-4d3b-a2a9-ff3696aec0d4" width="100%" alt="icon"/>
</a>

[302.AI](https://302.ai/) 是一个按需付费的AI应用平台，提供市面上最全的AI API和AI在线应用。

## 企业版

满足您公司私有化部署和定制需求

- **品牌定制**：企业量身定制 VI/UI，与企业品牌形象无缝契合
- **资源集成**：由企业管理人员统一配置和管理数十种 AI 资源，团队成员开箱即用
- **权限管理**：成员权限、资源权限、知识库权限层级分明，企业级 Admin Panel 统一控制
- **知识接入**：企业内部知识库与 AI 能力相结合，比通用 AI 更贴近企业自身业务需求
- **安全审计**：自动拦截敏感提问，支持追溯全部历史对话记录，让 AI 也能遵循企业信息安全规范
- **私有部署**：企业级私有部署，支持各类主流私有云部署，确保数据安全和隐私保护
- **持续更新**：提供多模态、智能体等前沿能力持续更新升级服务，常用常新、持续先进

企业版咨询: **business@nextchat.dev**

<img width="300" src="https://github.com/user-attachments/assets/bb29a11d-ff75-48a8-b1f8-d2d7238cf987">

## 开始使用

1. 准备好所用接口的 API Key；
2. 点击右侧按钮开始部署：
   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYidadaa%2FChatGPT-Next-Web&env=CODE&project-name=chatgpt-next-web&repository-name=ChatGPT-Next-Web)，直接使用 Github 账号登录即可，记得在环境变量页填入 [页面访问密码](#配置页面访问密码) CODE；
3. 部署完毕后，即可开始使用；
4. （可选）[绑定自定义域名](https://vercel.com/docs/concepts/projects/domains/add-a-domain)：Vercel 分配的域名 DNS 在某些区域被污染了，绑定自定义域名即可直连。

<div align="center">
   
![主界面](./docs/images/cover.png)

</div>

## 保持更新

如果你按照上述步骤一键部署了自己的项目，可能会发现总是提示“存在更新”的问题，这是由于 Vercel 会默认为你创建一个新项目而不是 fork 本项目，这会导致无法正确地检测更新。
推荐你按照下列步骤重新部署：

- 删除掉原先的仓库；
- 使用页面右上角的 fork 按钮，fork 本项目；
- 在 Vercel 重新选择并部署，[请查看详细教程](./docs/vercel-cn.md#如何新建项目)。

### 打开自动更新

> 如果你遇到了 Upstream Sync 执行错误，请[手动 Sync Fork 一次](./README_CN.md#手动更新代码)！

当你 fork 项目之后，由于 Github 的限制，需要手动去你 fork 后的项目的 Actions 页面启用 Workflows，并启用 Upstream Sync Action，启用之后即可开启每小时定时自动更新：

![自动更新](./docs/images/enable-actions.jpg)

![启用自动更新](./docs/images/enable-actions-sync.jpg)

### 手动更新代码

如果你想让手动立即更新，可以查看 [Github 的文档](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork) 了解如何让 fork 的项目与上游代码同步。

你可以 star/watch 本项目或者 follow 作者来及时获得新功能更新通知。

## 配置页面访问密码

> 配置密码后，用户需要在设置页手动填写访问码才可以正常聊天，否则会通过消息提示未授权状态。

> **警告**：请务必将密码的位数设置得足够长，最好 7 位以上，否则[会被爆破](https://github.com/Yidadaa/ChatGPT-Next-Web/issues/518)。

本项目提供有限的权限控制功能，请在 Vercel 项目控制面板的环境变量页增加名为 `CODE` 的环境变量，值为用英文逗号分隔的自定义密码：

```
code1,code2,code3
```

增加或修改该环境变量后，请**重新部署**项目使改动生效。

## 环境变量

请在设置的“接口配置”中选择 OpenAI Chat、OpenAI Responses、Anthropic Messages 或 Gemini，填写基础地址、API Key 和模型。接口配置仅保存在本机，本地导出会包含这些配置，云同步不会上传。

需要 Claude Code CLI 专用接口时，可以安装独立的请求插件，直接模拟交互式 CLI 的 HTTP 请求，无需启动 CLI；版本、平台和协议参数均可配置，支持网页版与桌面版。兼容范围和使用方式参见 [请求扩展插件与 Claude Code](docs/request-plugins.md)。

可选服务端配置见 `.env.template`。`CODE` 用于网页版访问验证；启用 `ENABLE_MCP=true` 时也必须配置 `CODE`。`WHITE_WEBDAV_ENDPOINTS` 用于增加允许的 WebDAV 转发地址。

## 开发

点击下方按钮，开始二次开发：

[![Open in Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/Yidadaa/ChatGPT-Next-Web)

请在设置的“接口配置”中选择 OpenAI Chat、OpenAI Responses、Anthropic Messages 或 Gemini，填写基础地址、API Key 和模型。接口配置仅保存在本机，本地导出会包含这些配置，云同步不会上传。

### 本地开发

1. 安装 nodejs 18 和 yarn，具体细节请询问 ChatGPT；
2. 执行 `yarn install && yarn dev` 即可。⚠️ 注意：此命令仅用于本地开发，不要用于部署！
3. 如果你想本地部署，请使用 `yarn install && yarn build && yarn start` 命令，你可以配合 pm2 来守护进程，防止被杀死，详情询问 ChatGPT。

## 部署

### 宝塔面板部署

> [简体中文 > 如何通过宝塔一键部署](./docs/bt-cn.md)

### 容器部署 （推荐）

> Docker 版本需要在 20 及其以上，否则会提示找不到镜像。

> ⚠️ 注意：docker 版本在大多数时间都会落后最新的版本 1 到 2 天，所以部署后会持续出现“存在更新”的提示，属于正常现象。

```shell
docker pull yidadaa/chatgpt-next-web

docker run -d -p 3000:3000 \
   -e CODE=页面访问密码 \
   yidadaa/chatgpt-next-web
```

你也可以指定 proxy：

```shell
docker run -d -p 3000:3000 \
   -e CODE=页面访问密码 \
   --net=host \
   -e PROXY_URL=http://127.0.0.1:7890 \
   yidadaa/chatgpt-next-web
```

如需启用 MCP 功能，可以使用：

```shell
docker run -d -p 3000:3000 \
   -e CODE=页面访问密码 \
   -e ENABLE_MCP=true \
   yidadaa/chatgpt-next-web
```

如果你的本地代理需要账号密码，可以使用：

```shell
-e PROXY_URL="http://127.0.0.1:7890 user password"
```

如果你需要指定其他环境变量，请自行在上述命令中增加 `-e 环境变量=环境变量值` 来指定。

### 本地部署

在控制台运行下方命令：

```shell
bash <(curl -s https://raw.githubusercontent.com/Yidadaa/ChatGPT-Next-Web/main/scripts/setup.sh)
```

⚠️ 注意：如果你安装过程中遇到了问题，请使用 docker 部署。

## 鸣谢

### 捐赠者

> 见英文版。

### 贡献者

[见项目贡献者列表](https://github.com/Yidadaa/ChatGPT-Next-Web/graphs/contributors)

### 相关项目

- [one-api](https://github.com/songquanpeng/one-api): 一站式大模型额度管理平台，支持市面上所有主流大语言模型

## 开源协议

[MIT](https://opensource.org/license/mit/)
