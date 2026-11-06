import { getClientConfig } from "../config/client";
import { SubmitKey } from "../store/config";
import { SAAS_CHAT_UTM_URL } from "@/app/constant";

const isApp = !!getClientConfig()?.isApp;

const cn = {
  ModelFallback: {
    Switched: (from: string, to: string) =>
      `此对话使用的模型 ${from} 在本设备不可用，已切换为 ${to}`,
  },
  ModelDiscovery: {
    Placeholder: "gpt-4o,claude-sonnet-4-5@Anthropic,my-model=显示名",
    Title: "获取模型列表",
    Loading: "正在获取…",
    Saved: "已保存的模型",
    Search: "搜索模型",
    SelectAll: "全选",
    SelectNone: "全不选",
    Empty: "没有找到模型",
    Unsupported: "该服务商不支持自动获取，请手动添加",
    Failed: "获取模型失败",
    Unconfigured: "未配置模型",
    ConfigureFirst: "请先在设置中添加或获取模型",
  },
  WIP: "该功能仍在开发中……",
  Error: {
    Unauthorized: isApp
      ? `😆 对话遇到了一些问题，不用慌:
       \\ 1️⃣ 想要零配置开箱即用，[点击这里立刻开启对话 🚀](${SAAS_CHAT_UTM_URL})
       \\ 2️⃣ 如果你想消耗自己的 OpenAI 资源，点击[这里](/#/settings)修改设置 ⚙️`
      : `😆 对话遇到了一些问题，不用慌:
       \ 1️⃣ 想要零配置开箱即用，[点击这里立刻开启对话 🚀](${SAAS_CHAT_UTM_URL})
       \ 2️⃣ 如果你正在使用私有部署版本，点击[这里](/#/auth)输入访问秘钥 🔑
       \ 3️⃣ 如果你想消耗自己的 OpenAI 资源，点击[这里](/#/settings)修改设置 ⚙️
       `,
  },
  Auth: {
    Return: "返回",
    Title: "需要密码",
    Tips: "管理员开启了密码验证，请在下方填入访问码",
    SubTips: "或者输入你的 OpenAI 或 Google AI 密钥",
    Input: "在此处填写访问码",
    Confirm: "确认",
    Later: "稍后再说",
    SaasTips: "配置太麻烦，想要立即使用",
    TopTips: "🥳 NextChat AI 首发优惠，立刻解锁最新大模型",
  },
  ChatItem: {
    ChatItemCount: (count: number) => `${count} 条对话`,
  },
  Pin: {
    Action: "置顶",
    Undo: "取消置顶",
    Pinned: "已置顶",
  },
  EndpointConfig: {
    ToolCalling: "工具调用",
    ToolCallingAuto: "自动",
    ToolCallingText: "仅文字",
    Title: "接口配置",
    Add: "添加接口",
    Edit: "编辑接口",
    Delete: "删除",
    Save: "保存",
    Name: "名称",
    Protocol: "协议",
    BaseUrl: "基础地址",
    ApiKey: "API Key",
    RequestUrl: "请求地址",
    Models: "模型列表",
    ModelName: "模型名称",
    DisplayName: "显示名称（可选）",
    AddModel: "添加模型",
    FetchModels: "获取模型",
    AddSelected: "添加所选模型",
    DeleteSelected: "删除所选模型",
    NoModels: "暂无模型",
    Invalid: "请填写接口名称和有效的 HTTP(S) 基础地址",
    Remove: (name: string, count: number, isDefault: boolean) =>
      `删除接口“${name}”？将同时移除 ${count} 个模型。${
        isDefault ? "其中包含默认模型。" : ""
      }`,
    Unmigrated: (names: string) =>
      `以下旧接口无法自动迁移：${names}。原配置仍保留在本机。`,
    OpenSettings: "前往设置",
    LegacyImport: "旧备份中的接口配置已忽略；聊天、面具和提示词仍可导入。",
  },
  Chat: {
    ToolTextPluginUnavailable: "当前使用文字工具模式，本次无法调用插件工具。",
    ToolRoundsExceeded: "连续工具调用次数已达上限。",
    ToolCard: {
      Tool: "工具",
      ToolResult: "工具结果",
      Server: "服务",
      Separator: "：",
      Arguments: "参数",
      Result: "结果",
      Error: "错误",
      Running: "运行中",
      Stopped: "已停止",
      Succeeded: "已完成",
      Failed: "失败",
    },
    Thinking: { Title: "思考过程", Active: "思考中…", Done: "已思考" },
    SubTitle: (count: number) => `共 ${count} 条对话`,
    EditMessage: {
      Title: "编辑消息记录",
      Topic: {
        Title: "聊天主题",
        SubTitle: "更改当前聊天主题",
      },
    },
    Actions: {
      ChatList: "查看消息列表",
      CompressedHistory: "查看压缩后的历史 Prompt",
      Export: "导出聊天记录",
      Copy: "复制",
      Stop: "停止",
      Retry: "重试",
      Pin: "固定",
      PinToastContent: "已将 1 条对话固定至预设提示词",
      PinToastAction: "查看",
      Delete: "删除",
      Edit: "编辑",
      FullScreen: "全屏",
      RefreshTitle: "刷新标题",
      RefreshToast: "已发送刷新标题请求",
      Speech: "朗读",
      StopSpeech: "停止",
    },
    Commands: {
      new: "新建聊天",
      newm: "从面具新建聊天",
      next: "下一个聊天",
      prev: "上一个聊天",
      clear: "清除上下文",
      fork: "复制聊天",
      del: "删除聊天",
    },
    InputActions: {
      Stop: "停止",
      ToBottom: "滚到最新",
      Clear: "清除聊天",
      Settings: "对话设置",
    },
    Rename: "重命名对话",
    Typing: "正在输入…",
    Input: (submitKey: string) => {
      var inputHints = `${submitKey} 发送`;
      if (submitKey === String(SubmitKey.Enter)) {
        inputHints += "，Shift + Enter 换行";
      }
      return inputHints + "，/ 触发补全，: 触发命令";
    },
    Send: "发送",
    ImageInputHint: "，可拖拽或粘贴图片",
    ImageUploading: "正在处理图片…",
    ImageOnly: "请选择图片文件",
    StartSpeak: "说话",
    StopSpeak: "停止",
    Config: {
      Reset: "清除记忆",
      SaveAs: "存为面具",
    },
    IsContext: "预设提示词",
    ShortcutKey: {
      Title: "键盘快捷方式",
      newChat: "打开新聊天",
      focusInput: "聚焦输入框",
      copyLastMessage: "复制最后一个回复",
      copyLastCode: "复制最后一个代码块",
      showShortcutKey: "显示快捷方式",
      search: "搜索聊天记录",
      clearContext: "清除上下文",
    },
  },
  Export: {
    Title: "分享聊天记录",
    Copy: "全部复制",
    Download: "下载文件",
    Share: "分享到 ShareGPT",
    MessageFromYou: "用户",
    MessageFromChatGPT: "AI 助手",
    Format: {
      Title: "导出格式",
      SubTitle: "可以导出 Markdown 文本或者 PNG 图片",
    },
    IncludeContext: {
      Title: "包含面具上下文",
      SubTitle: "是否在消息中展示面具上下文",
    },
    Steps: {
      Select: "选取",
      Preview: "预览",
    },
    Image: {
      Toast: "正在生成截图",
      Modal: "长按或右键保存图片",
    },
    Artifacts: {
      Title: "分享页面",
      Error: "分享失败",
    },
  },
  Select: {
    Search: "搜索消息",
    All: "选取全部",
    Latest: "最近几条",
    Clear: "清除选中",
  },
  Memory: {
    Title: "历史摘要",
    EmptyContent: "对话内容过短，无需总结",
    Send: "自动压缩聊天记录并作为上下文发送",
    Copy: "复制摘要",
    Reset: "[unused]",
    ResetConfirm: "确认清空历史摘要？",
  },
  Home: {
    NewChat: "新的聊天",
    DeleteChat: "确认删除选中的对话？",
    DeleteToast: "已删除会话",
    Revert: "撤销",
  },
  Settings: {
    Title: "设置",
    SubTitle: "所有设置选项",
    ShowPassword: "显示密码",

    Danger: {
      Reset: {
        Title: "重置所有设置",
        SubTitle: "重置所有设置项回默认值",
        Action: "立即重置",
        Confirm: "确认重置所有设置？",
      },
      Clear: {
        Title: "清除所有数据",
        SubTitle: "清除所有聊天、设置数据",
        Action: "立即清除",
        Confirm: "确认清除所有聊天、设置数据？",
      },
    },
    Lang: {
      Name: "Language", // 注意：如果要添加新的翻译，请不要翻译此值，将它保留为 `Language`
      All: "所有语言",
    },
    Avatar: "头像",
    FontSize: {
      Title: "字体大小",
      SubTitle: "聊天内容的字体大小",
    },
    Zoom: {
      Title: "界面缩放",
      SubTitle: "Ctrl + = / - / 0，Ctrl + 滚轮（macOS 使用 Cmd）",
      Toast: (percent: string) => `缩放 ${percent}`,
    },
    FontFamily: {
      Title: "聊天字体",
      SubTitle: "聊天内容的字体，若置空则应用全局默认字体",
      Placeholder: "字体名称",
    },
    InjectSystemPrompts: {
      Title: "注入系统级提示信息",
      SubTitle: "强制给每次请求的消息列表开头添加一个模拟 AI 助手的系统提示",
    },
    InputTemplate: {
      Title: "用户输入预处理",
      SubTitle: "用户最新的一条消息会填充到此模板",
    },

    Update: {
      Version: (x: string) => `当前版本：${x}`,
      IsLatest: "已是最新版本",
      CheckUpdate: "检查更新",
      IsChecking: "正在检查更新...",
      FoundUpdate: (x: string) => `发现新版本：${x}`,
      GoToUpdate: "前往更新",
      Success: "更新成功！",
      Failed: "更新失败",
    },
    SendKey: "发送键",
    Theme: "主题",
    TightBorder: "无边框模式",
    SendPreviewBubble: {
      Title: "预览气泡",
      SubTitle: "在预览气泡中预览 Markdown 内容",
    },
    AutoGenerateTitle: {
      Title: "自动生成标题",
      SubTitle: "根据对话内容生成合适的标题",
    },
    Sync: {
      Scope:
        "云同步只同步聊天记录、面具和提示词；API 配置、模型列表、MCP 配置和应用设置只保存在本机。",
      CloudState: "云端数据",
      NotSyncYet: "还没有进行过同步",
      LastSync: (time: string, provider: string) =>
        `上次同步：${time}（${provider}）`,
      Success: "同步成功",
      Fail: "同步失败",
      CheckSuccess: "检查通过，可以正常同步",
      CheckFailed: "检查失败",
      Errors: {
        AUTH: "用户名或密码错误。坚果云请使用第三方应用密码，不是登录密码",
        FORBIDDEN: "没有访问或写入权限",
        PATH: "服务器路径不存在，请检查地址",
        BUSY: "请求太频繁或服务暂时不可用，请稍后重试。坚果云有请求频率限制",
        REDIRECT: "服务器返回重定向，请直接填写最终服务器地址",
        HTTP: "服务器请求失败",
        INVALID_JSON: "远程备份不是合法的 JSON 备份",
        INVALID_ENDPOINT:
          "服务器地址必须是 http/https 地址，不能包含登录信息、查询参数或片段",
        NETWORK_DNS: "网络错误：DNS 域名解析失败",
        NETWORK_TLS: "网络错误：TLS 连接或证书验证失败",
        NETWORK_TIMEOUT: "网络错误：请求超时",
        NETWORK_REFUSED: "网络错误：服务器拒绝连接，请确认服务已启动",
        NETWORK_CONNECT: "网络错误：无法连接服务器，请检查网络或代理",
        NETWORK_FAILED: "网络请求失败，请检查网络连接、服务器或浏览器跨域代理",
        REMOTE_ERROR: "远程服务返回了无效结果",
        UNKNOWN: "同步操作失败，请检查配置后重试",
      },

      Config: {
        Modal: {
          Title: "配置云同步",
          Check: "检查可用性",
        },
        SyncType: {
          Title: "同步类型",
          SubTitle: "选择喜爱的同步服务器",
        },
        Proxy: {
          Title: "启用代理",
          SubTitle: "在浏览器中同步时，必须启用代理以避免跨域限制",
        },
        ProxyUrl: {
          Title: "代理地址",
          SubTitle: "仅适用于本项目自带的跨域代理",
        },

        WebDav: {
          Endpoint: "WebDAV 地址",
          UserName: "用户名",
          Password: "密码",
        },

        UpStash: {
          Endpoint: "UpStash Redis REST Url",
          UserName: "备份名称",
          Password: "UpStash Redis REST Token",
        },
      },

      LocalState: "本地数据",
      Overview: (overview: any) => {
        return `${overview.chat} 次对话，${overview.message} 条消息，${overview.prompt} 条提示词，${overview.mask} 个面具`;
      },
      ImportFailed: "导入失败",
      ImportSuccess: "备份已导入",
      ImportConfirm:
        "导入此备份？聊天、面具、提示词、插件和 MCP 服务将合并；相同 ID 的接口、应用设置、访问码和同步账号以备份为准，本机独有的接口保留。MCP 服务可能运行程序，桌面版会另行确认。",
      McpNotImported: "其他数据已导入，但 MCP 服务未导入。",
      ExportWithoutMcp:
        "无法读取 MCP 配置，导出的备份将不包含 MCP。是否继续导出其他数据？",
      BackupSecrets: "备份包含 API 密钥和密码，并会使用密码加密。",
      SetBackupPassword: "设置备份密码",
      EnterBackupPassword: "输入备份密码",
      Password: "密码",
      ConfirmPassword: "再次输入密码",
      PasswordWarning: "忘记密码将无法恢复备份。",
      PasswordEmpty: "密码不能为空。",
      PasswordMismatch: "两次输入的密码不一致。",
      BadPassword: "密码错误或备份已被修改，请重新输入密码。",
      InvalidEncryptedBackup: "备份格式无效或文件已被修改。",
      BackupWorking: "正在处理备份",
      Encrypting: "正在加密备份，请勿关闭页面。",
      Decrypting: "正在读取或解密备份，请勿关闭页面。",
      Restoring: "正在恢复备份，请勿关闭页面。",
      ExportFailed: "导出备份失败。",
    },
    Mask: {
      Splash: {
        Title: "面具启动页",
        SubTitle: "新建聊天时，展示面具启动页",
      },
      Builtin: {
        Title: "隐藏内置面具",
        SubTitle: "在所有面具列表中隐藏内置面具",
      },
    },
    Prompt: {
      Disable: {
        Title: "禁用提示词自动补全",
        SubTitle: "在输入框开头输入 / 即可触发自动补全",
      },
      List: "自定义提示词列表",
      ListCount: (builtin: number, custom: number) =>
        `内置 ${builtin} 条，用户定义 ${custom} 条`,
      Edit: "编辑",
      Modal: {
        Title: "提示词列表",
        Add: "新建",
        Search: "搜索提示词",
      },
      EditModal: {
        Title: "编辑提示词",
      },
    },
    HistoryCount: {
      Title: "附带历史消息数",
      SubTitle: "每次请求携带的历史消息数",
    },
    CompressThreshold: {
      Title: "历史消息长度压缩阈值",
      SubTitle: "当未压缩的历史消息超过该值时，将进行压缩",
    },

    Access: {
      AccessCode: {
        Title: "访问密码",
        SubTitle: "管理员已开启加密访问",
        Placeholder: "请输入访问密码",
      },
    },

    Model: "模型 (model)",
    EnableParameter: (name: string) => `启用 ${name}`,
    JoinParameterDescriptions: (...parts: string[]) =>
      `${parts.map((part) => part.replace(/[。.!?\s]+$/u, "")).join("。")}。`,
    ParameterOptional: "关闭时不发送，使用模型默认值。",
    PenaltyProtocols: "Responses、Anthropic 协议没有此参数。",
    AnthropicMaxTokens: "Anthropic 协议必须发送，关闭时使用 16000。",
    ReasoningEffort: {
      Title: "思考档位",
      SubTitle:
        "留空则使用模型默认。可填档位或 Token 预算数字，取值以模型文档为准，不支持时会显示接口报错。",
    },
    ReasoningSummary: {
      Title: "请求思考内容",
      SubTitle: "关闭时不主动请求思考内容；接口返回的内容仍会显示。",
    },
    CompressModel: {
      Title: "对话摘要模型",
      SubTitle: "用于压缩历史记录、生成对话标题的模型",
    },
    Temperature: {
      Title: "随机性 (temperature)",
      SubTitle: "值越大，回复越随机",
    },
    TopP: {
      Title: "核采样 (top_p)",
      SubTitle: "与随机性类似，但不要和随机性一起更改",
    },
    MaxTokens: {
      Title: "单次回复限制 (max_tokens)",
      SubTitle: "单次交互所用的最大 Token 数",
    },
    PresencePenalty: {
      Title: "话题新鲜度 (presence_penalty)",
      SubTitle: "值越大，越有可能扩展到新话题",
    },
    FrequencyPenalty: {
      Title: "频率惩罚度 (frequency_penalty)",
      SubTitle: "值越大，越有可能降低重复字词",
    },
    TTS: {
      SystemEngine: "系统语音",
      Melo: {
        Engine: "MeloTTS（本地神经网络，中英混读）",
        Model: "MeloTTS 模型",
        Manage: "模型管理",
        Description: "约 167 MB，下载后离线使用，支持中英混读，单一女声。",
        Checking: "正在检查模型…",
        Missing: "未下载",
        Downloading: (percent: number) => `下载中 ${percent}%`,
        Verifying: "校验解压中…",
        Deleting: "正在删除模型…",
        Ready: (size: string) => `已就绪（${size} MiB）`,
        Progress: "模型下载进度",
        Download: "下载模型",
        Import: "从本地文件导入",
        Delete: "删除模型",
        Cancel: "取消下载/导入",
        Sample:
          "你好，这是本地 MeloTTS 试听。Python 和 API 已准备好，当前进度是 85%。",
        Fallback: (reason: string) =>
          `MeloTTS 暂不可用：${reason}，将使用系统语音。`,
        Stopped: (reason: string) => `MeloTTS 朗读已停止：${reason}。`,
        UnknownError: "本地语音操作失败，请重试",
        Errors: {
          MODEL_NOT_READY: "模型尚未就绪，请先下载或导入",
          MODEL_LOAD_FAILED: "模型加载失败，请重新下载或导入",
          MODEL_FILES_MISSING: "模型文件不完整，请删除后重新导入",
          MODEL_HASH_MISMATCH: "模型校验失败，请使用指定的官方模型文件",
          MODEL_SIZE_MISMATCH: "模型文件大小不正确，请重新下载",
          INVALID_ARCHIVE: "模型压缩包格式或路径不安全",
          INVALID_MODEL_PATH: "模型目录异常，请检查本地模型文件",
          MODEL_ALREADY_EXISTS: "模型目录已存在，请先删除模型",
          MODEL_BUSY: "模型操作尚未完成，请稍候",
          MODEL_IO: "无法读写模型文件，请检查磁盘空间和权限",
          MODEL_STATE_FAILED: "本地语音状态异常，请重启应用",
          DOWNLOAD_FAILED: "模型下载失败，请重试或从本地文件导入",
          SYNTHESIS_FAILED: "语音合成失败",
          EMPTY_SPEECH: "文本未生成可播放的语音",
          AUDIO_DECODE_FAILED: "无法解码生成的语音",
          INVALID_SPEECH_INPUT: "朗读文本或语速无效",
          AUDIO_UNAVAILABLE: "当前设备无法播放本地音频",
          CANCELLED: "操作已取消",
        },
      },
      LocalDescription: "仅使用本机语音，文本不会发送到网络",
      LocalVoice: "本地语音",
      Automatic: "自动（按文本语言选择）",
      Rate: "语速",
      Pitch: "音调",
      Preview: "试听",
      Sample:
        "你好，这是本地系统语音试听。你可以调整语速和音调，让朗读更舒适。",
      NoVoices:
        "系统中没有可用的本地语音，请在 Windows 设置 → 时间和语言 → 语音 中添加",
      Failed: "朗读失败，请检查系统语音设置后重试。",

      Enable: {
        Title: "启用文本转语音",
        SubTitle: "启用文本生成语音服务",
      },
      Autoplay: {
        Title: "启用自动朗读",
        SubTitle: "自动生成语音并播放，需先开启文本转语音开关",
      },
      Model: "模型",
      Engine: "转换引擎",
      Voice: {
        Title: "声音",
        SubTitle: "生成语音时使用的声音",
      },
      Speed: {
        Title: "速度",
        SubTitle: "生成语音的速度",
      },
    },
  },
  Store: {
    DefaultTopic: "新的聊天",
    BotHello: "有什么可以帮你的吗",
    Error: "出错了，稍后重试吧",
    Prompt: {
      History: (content: string) => "这是历史聊天总结作为前情提要：" + content,
      Topic:
        "使用四到五个字直接返回这句话的简要主题，不要解释、不要标点、不要语气词、不要多余文本，不要加粗，如果没有主题，请直接返回“闲聊”",
      Summarize:
        "简要总结一下对话内容，用作后续的上下文提示 prompt，控制在 200 字以内",
    },
  },
  Copy: {
    Success: "已写入剪贴板",
    Failed: "复制失败，请赋予剪贴板权限",
  },
  Download: {
    Success: "内容已下载到您的目录。",
    Failed: "下载失败。",
  },
  Context: {
    Toast: (x: any) => `包含 ${x} 条预设提示词`,
    Edit: "当前对话设置",
    Add: "新增一条对话",
    Clear: "上下文已清除",
    Revert: "恢复上下文",
  },
  Mcp: {
    Name: "MCP",
    Market: "MCP 市场",
    Configured: (count: number) => `已配置 ${count} 个服务器`,
    AddServer: "添加服务器",
    RestartAll: "全部重启",
    Configure: "配置",
    Tools: "工具",
    Stop: "停止",
    Start: "启动",
    Remove: "移除",
    Add: "添加",
    Save: "保存",
    Custom: "自定义",
    Search: "搜索 MCP 服务器",
    ServerId: "服务器 ID",
    Command: "命令",
    Arguments: "参数（JSON 数组）",
    Environment: "环境变量（JSON 对象）",
    ServerDetails: (id: string) => `服务器详情 - ${id}`,
    ConfigureTitle: (id: string) => `配置服务器 - ${id}`,
    AddItem: (name: string) => `添加 ${name}`,
    EnterItem: (name: string) => `输入 ${name}`,
    OpenRepository: "打开代码仓库",
    LoadingPresets: "正在加载预设服务器列表…",
    NoServers: "没有可用的服务器",
    LoadingTools: "正在加载…",
    NoTools: "没有可用工具",
    Initializing: "正在初始化",
    Running: "运行中",
    Stopped: "已停止",
    Error: "错误",
    ErrorSeparator: "：",
    Updating: "正在更新配置…",
    Creating: "正在创建 MCP 客户端…",
    Removing: "正在移除服务器…",
    Stopping: "正在停止服务器…",
    Starting: "正在启动服务器…",
    Restarting: "正在重启所有服务器…",
    ConfigUpdated: "服务器配置已更新",
    ServerStopped: "服务器已停止",
    RestartStarted: "正在重启所有客户端",
    LoadPresetsFailed: "加载预设服务器失败",
    LoadStateFailed: "加载服务器状态失败",
    LoadToolsFailed: "加载工具失败",
    SaveFailed: "保存配置失败",
    AddFailed: "添加服务器失败",
    RemoveFailed: "移除服务器失败",
    StopFailed: "停止服务器失败",
    StartFailed: "启动服务器失败",
    RestartFailed: "重启服务器失败",
    Errors: {
      Http: (status: string) => `远程 MCP 连接失败（HTTP ${status}）`,
      Timeout: "远程 MCP 网络请求超时",
      Refused: "远程 MCP 连接被拒绝",
      Dns: "远程 MCP 域名解析失败",
      Tls: "远程 MCP TLS 连接失败",
      Connect: "远程 MCP 网络连接失败",
      General: "MCP 网络或协议请求失败",
      Denied: "MCP 配置未获批准，未保存任何更改",
      Unauthorized: "MCP 访问码无效",
      Disabled: "MCP 未启用",
      Disconnected: "MCP 服务器已断开连接",
    },
    ConfigureServer: "配置 MCP 服务器",
    Transport: "连接类型",
    Local: "本地（stdio）",
    Remote: "远程（HTTP）",
    Url: "服务器地址",
    Headers: "请求头（JSON 对象）",
    HeaderNames: "请求头名称",
    PasteJson: "粘贴 JSON 添加",
    PasteHelp: "粘贴包含 mcpServers 的 JSON 对象",
    InvalidConfig: "MCP 配置格式无效",
    InvalidOrDenied: "MCP 配置无效或未获批准",
  },
  FineTuned: {
    Sysmessage: "你是一个助手",
  },
  SearchChat: {
    Name: "搜索聊天记录",
    Page: {
      Title: "搜索聊天记录",
      Search: "输入搜索关键词",
      NoResult: "没有找到结果",
      NoData: "没有数据",
      Loading: "加载中",

      SubTitle: (count: number) => `搜索到 ${count} 条结果`,
    },
    Item: {
      View: "查看",
    },
    Hint: "搜索未归档对话的标题和消息，多个关键词用空格分开",
    MatchCount: (count: number) => `${count} 条匹配`,
    Role: {
      User: "我",
      Bot: "助手",
    },
    More: (count: number) => `展开其余 ${count} 条`,
    TooMany: (limit: number) =>
      `结果太多，只显示最新的 ${limit} 条，请缩小搜索范围`,
    Keys: "↑↓ 选择 · Enter 打开 · Esc 关闭",
  },

  Archive: {
    Action: "归档",
    Toast: "已归档",
    View: "查看",
    Restore: "恢复",
    Delete: "删除",
    Banner: "此对话已归档，发送消息会自动恢复",
    Entry: (count: number) => `已归档 (${count})`,
    Page: {
      Title: "已归档的对话",
      SubTitle: (count: number) => `共 ${count} 个对话`,
      Search: "搜索归档对话的标题或消息",
      Empty: "没有已归档的对话",
      NoResult: "没有找到匹配的归档对话",
    },
  },
  Plugin: {
    Name: "插件",
    Page: {
      Title: "插件",
      SubTitle: (count: number) => `${count} 个插件`,
      Search: "搜索插件",
      Create: "新建",
      Find: "您可以在Github上找到优秀的插件：",
    },
    Item: {
      Info: (count: number) => `${count} 方法`,
      View: "查看",
      Edit: "编辑",
      Delete: "删除",
      DeleteConfirm: "确认删除？",
    },
    Auth: {
      None: "不需要授权",
      Basic: "Basic",
      Bearer: "Bearer",
      Custom: "自定义",
      CustomHeader: "自定义参数名称",
      Token: "Token",
      Proxy: "使用代理",
      ProxyDescription: "使用代理解决 CORS 错误",
      Location: "位置",
      LocationHeader: "Header",
      LocationQuery: "Query",
      LocationBody: "Body",
    },
    EditModal: {
      Title: (readonly: boolean) => `编辑插件 ${readonly ? "（只读）" : ""}`,
      Download: "下载",
      Auth: "授权方式",
      Content: "OpenAPI Schema",
      Load: "从网页加载",
      Method: "方法",
      Error: "格式错误",
    },
  },
  Mask: {
    Name: "面具",
    Page: {
      Title: "预设角色面具",
      SubTitle: (count: number) => `${count} 个预设角色定义`,
      Search: "搜索角色面具",
      Create: "新建",
    },
    Item: {
      Info: (count: number) => `包含 ${count} 条预设对话`,
      Chat: "对话",
      View: "查看",
      Edit: "编辑",
      Delete: "删除",
      DeleteConfirm: "确认删除？",
    },
    EditModal: {
      Title: (readonly: boolean) =>
        `编辑预设面具 ${readonly ? "（只读）" : ""}`,
      Download: "下载预设",
      Clone: "克隆预设",
    },
    Config: {
      Avatar: "角色头像",
      Name: "角色名称",
      Sync: {
        Title: "使用全局设置",
        SubTitle: "当前对话是否使用全局模型设置",
        Confirm: "当前对话的自定义设置将会被自动覆盖，确认启用全局设置？",
      },
      HideContext: {
        Title: "隐藏预设对话",
        SubTitle: "隐藏后预设对话不会出现在聊天界面",
      },
      Artifacts: {
        Title: "启用Artifacts",
        SubTitle: "启用之后可以直接渲染HTML页面",
      },
      CodeFold: {
        Title: "启用代码折叠",
        SubTitle: "启用之后可以自动折叠/展开过长的代码块",
      },
      Share: {
        Title: "分享此面具",
        SubTitle: "生成此面具的直达链接",
        Action: "复制链接",
      },
    },
  },
  NewChat: {
    Return: "返回",
    Skip: "直接开始",
    NotShow: "不再展示",
    ConfirmNoShow: "确认禁用？禁用后可以随时在设置中重新启用。",
    Title: "挑选一个面具",
    SubTitle: "现在开始，与面具背后的灵魂思维碰撞",
    More: "查看全部",
  },

  URLCommand: {
    Code: "检测到链接中已经包含访问码，是否自动填入？",
    Settings: "检测到链接中包含了预制设置，是否自动填入？",
  },

  UI: {
    Confirm: "确认",
    Cancel: "取消",
    Close: "关闭",
    Create: "新建",
    Edit: "编辑",
    Export: "导出",
    Import: "导入",
    Sync: "同步",
    Config: "配置",
  },
  Exporter: {
    Description: {
      Title: "只有清除上下文之后的消息会被展示",
    },
    Model: "模型",
    Messages: "消息",
    Topic: "主题",
    Time: "时间",
  },
};

type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

export type LocaleType = typeof cn;
export type PartialLocaleType = DeepPartial<typeof cn>;

export default cn;
