import { getClientConfig } from "../config/client";
import { SubmitKey } from "../store/config";
import { LocaleType } from "./index";
import { SAAS_CHAT_UTM_URL } from "@/app/constant";
// if you are adding a new translation, please use PartialLocaleType instead of LocaleType

const isApp = !!getClientConfig()?.isApp;
const en: LocaleType = {
  ModelFallback: {
    Switched: (from: string, to: string) =>
      `This chat's model ${from} is unavailable on this device. Switched to ${to}.`,
  },
  ModelDiscovery: {
    Placeholder: "gpt-4o,claude-sonnet-4-5@Anthropic,my-model=Display name",
    Title: "Fetch models",
    Loading: "Fetching…",
    Saved: "Saved models",
    Search: "Search models",
    SelectAll: "Select all",
    SelectNone: "Select none",
    Empty: "No models found",
    Unsupported:
      "This provider does not support model discovery. Please add models manually.",
    Failed: "Failed to fetch models",
    Unconfigured: "No models configured",
    ConfigureFirst: "Add or fetch models in Settings first.",
  },
  WIP: "Coming Soon...",
  Error: {
    Unauthorized: isApp
      ? `😆 Oops, there's an issue. No worries:
     \\ 1️⃣ New here? [Click to start chatting now 🚀](${SAAS_CHAT_UTM_URL})
     \\ 2️⃣ Want to use your own OpenAI resources? [Click here](/#/settings) to change settings ⚙️`
      : `😆 Oops, there's an issue. Let's fix it:
     \ 1️⃣ New here? [Click to start chatting now 🚀](${SAAS_CHAT_UTM_URL})
     \ 2️⃣ Using a private setup? [Click here](/#/auth) to enter your key 🔑
     \ 3️⃣ Want to use your own OpenAI resources? [Click here](/#/settings) to change settings ⚙️
     `,
  },
  Auth: {
    Return: "Return",
    Title: "Need Access Code",
    Tips: "Please enter access code below",
    SubTips: "Or enter your OpenAI or Google API Key",
    Input: "access code",
    Confirm: "Confirm",
    Later: "Later",
    SaasTips: "Too Complex, Use Immediately Now",
    TopTips:
      "🥳 NextChat AI launch promotion: Instantly unlock the latest models!",
  },
  ChatItem: {
    ChatItemCount: (count: number) => `${count} messages`,
  },
  Folder: {
    All: "All",
    Ungrouped: "Ungrouped",
    Create: "New folder",
    Name: "Folder name",
    Rename: "Rename folder",
    Delete: "Delete folder",
    Options: (name: string) => `Folder “${name}”`,
    MoveChat: "Move to folder",
    MovedTo: (name: string) => `Chat moved to ${name}`,
    MoveCancelled: "Chat was not moved",
    MoveLeft: "Move left",
    MoveRight: "Move right",
    EmptyName: "Folder name cannot be empty",
    DuplicateName: "A folder with this name already exists",
    Missing: "Folder no longer exists",
    Current: (name: string) => `${name} (current)`,
    Empty:
      "This folder has no chats yet. Drag a chat to its tab above, or use the chat's Move to folder action.",
    DeletedWithChats: (name: string, count: number) =>
      `Deleted folder “${name}” and ${count} chats`,
    DeleteQuestion: (name: string, count: number, archived: number) =>
      `“${name}” contains ${count} chats${
        archived ? `, including ${archived} archived` : ""
      }. Choose how to delete it.`,
    DeleteFolderOnly: "Delete folder only",
    DeleteWithChats: "Delete folder and chats",
    SearchAll: "All chats",
    SearchCurrent: (name: string) => `Current folder (${name})`,
  },
  Pin: {
    Action: "Pin chat",
    Undo: "Unpin chat",
    Pinned: "Pinned",
  },
  RequestPlugins: {
    Preview: "Preview request",
    PreviewDescription:
      "Uses a sample message without sending it. In CLI mode this shows the bridge request; Claude Code generates the upstream request.",
    Title: "Request extensions",
    Description:
      "Install client drivers and request adapters, then bind a version to an API endpoint. Packages stay on this device.",
    Import: "Import plugin",
    InstallClaude: "Install Claude Code",
    Export: "Export",
    Remove: "Uninstall",
    Enabled: "Enabled",
    Bound: "Bound endpoints",
    Select: "Request plugin",
    Standard: "Standard API",
    Unavailable: "Unavailable",
    Trust:
      "This package contains executable JavaScript. It can read requests and credentials and access the network. Install only a package you trust?",
    RemoveConfirm:
      "Uninstall this version? Endpoints bound to it will report an error until you select another version or Standard API.",
  },
  EndpointConfig: {
    ToolCalling: "Tool calling",
    ToolCallingAuto: "Automatic",
    ToolCallingText: "Text only",
    Title: "API endpoints",
    Add: "Add endpoint",
    Edit: "Edit endpoint",
    Delete: "Delete",
    Save: "Save",
    Name: "Name",
    Protocol: "Protocol",
    BaseUrl: "Base URL",
    ApiKey: "API key",
    RequestUrl: "Request URL",
    Models: "Models",
    ModelName: "Model name",
    DisplayName: "Display name (optional)",
    AddModel: "Add model",
    FetchModels: "Fetch models",
    AddSelected: "Add selected models",
    DeleteSelected: "Delete selected models",
    NoModels: "No models yet",
    Invalid: "Enter a name and a valid HTTP(S) base URL",
    Remove: (name: string, count: number, isDefault: boolean) =>
      `Delete endpoint “${name}” and its ${count} models?${
        isDefault ? " This includes the default model." : ""
      }`,
    Unmigrated: (names: string) =>
      `These old endpoints could not be migrated: ${names}. Their original settings remain on this device.`,
    OpenSettings: "Open settings",
    LegacyImport:
      "API settings in the old backup were ignored; chats, masks, and prompts can still be imported.",
  },
  Chat: {
    ToolTextPluginUnavailable:
      "Text tool mode is active; plugin tools are unavailable for this request.",
    ToolRoundsExceeded: "Too many consecutive tool calls",
    ToolCard: {
      Tool: "Tool",
      ToolResult: "Tool result",
      Server: "Server",
      Separator: ": ",
      Arguments: "Arguments",
      Result: "Result",
      Error: "Error",
      Running: "Running",
      Stopped: "Stopped",
      Succeeded: "Completed",
      Failed: "Failed",
    },
    Thinking: {
      Title: "Thinking process",
      Active: "Thinking…",
      Done: "Thought",
    },
    SubTitle: (count: number) => `${count} messages`,
    EditMessage: {
      Title: "Edit All Messages",
      Topic: {
        Title: "Topic",
        SubTitle: "Change the current topic",
      },
    },
    Actions: {
      More: "More",
      ChatList: "Go To Chat List",
      CompressedHistory: "Compressed History Memory Prompt",
      Export: "Export All Messages as Markdown",
      Copy: "Copy",
      Stop: "Stop",
      Retry: "Retry",
      Pin: "Pin",
      PinToastContent: "Pinned 1 messages to contextual prompts",
      PinToastAction: "View",
      Delete: "Delete",
      Edit: "Edit",
      FullScreen: "FullScreen",
      RefreshTitle: "Refresh Title",
      RefreshToast: "Title refresh request sent",
      RefreshTitleFailed: (reason: string) =>
        `Failed to refresh title: ${reason}`,
      RefreshTitleEmpty: "The model did not return a title",
      RefreshTitleUnknownError:
        "Request failed. Check the configuration and try again",
      Speech: "Play",
      StopSpeech: "Stop",
    },
    Commands: {
      new: "Start a new chat",
      newm: "Start a new chat with mask",
      next: "Next Chat",
      prev: "Previous Chat",
      clear: "Clear Context",
      fork: "Copy Chat",
      del: "Delete Chat",
    },
    InputActions: {
      Stop: "Stop",
      ToBottom: "To Latest",
      Clear: "Clear Context",
      Settings: "Settings",
    },
    Rename: "Rename Chat",
    Typing: "Typing…",
    MobileInput: "/ for prompts, paste images",
    Input: (submitKey: string) => {
      var inputHints = `${submitKey} to send`;
      if (submitKey === String(SubmitKey.Enter)) {
        inputHints += ", Shift + Enter to wrap";
      }
      return inputHints + ", / to search prompts, : to use commands";
    },
    Send: "Send",
    ImageInputHint: ", drag or paste images",
    ImageUploading: "Processing images…",
    ImageOnly: "Please use image files only",
    StartSpeak: "Start Speak",
    StopSpeak: "Stop Speak",
    Config: {
      Reset: "Reset to Default",
      SaveAs: "Save as Mask",
    },
    IsContext: "Contextual Prompt",
    ShortcutKey: {
      Title: "Keyboard Shortcuts",
      newChat: "Open New Chat",
      focusInput: "Focus Input Field",
      copyLastMessage: "Copy Last Reply",
      copyLastCode: "Copy Last Code Block",
      showShortcutKey: "Show Shortcuts",
      search: "Search chat history",
      clearContext: "Clear Context",
    },
  },
  Export: {
    Title: "Export Messages",
    Copy: "Copy All",
    Download: "Download",
    MessageFromYou: "Message From You",
    MessageFromChatGPT: "Message From AI Assistant",
    Share: "Share to ShareGPT",
    Format: {
      Title: "Export Format",
      SubTitle: "Markdown or PNG Image",
    },
    IncludeContext: {
      Title: "Including Context",
      SubTitle: "Export context prompts in mask or not",
    },
    Steps: {
      Select: "Select",
      Preview: "Preview",
    },
    Image: {
      Toast: "Capturing Image...",
      Modal: "Long press or right click to save image",
    },
    Artifacts: {
      Title: "Share Artifacts",
      Error: "Share Error",
    },
  },
  Select: {
    Search: "Search",
    All: "Select All",
    Latest: "Select Latest",
    Clear: "Clear",
  },
  Memory: {
    Title: "Memory Prompt",
    EmptyContent: "Nothing yet.",
    Send: "Send Memory",
    Copy: "Copy Memory",
    Reset: "Reset Session",
    ResetConfirm:
      "Resetting will clear the current conversation history and historical memory. Are you sure you want to reset?",
  },
  Home: {
    NewChat: "New Chat",
    DeleteChat: "Confirm to delete the selected conversation?",
    DeleteToast: "Chat Deleted",
    Revert: "Revert",
  },
  Settings: {
    Title: "Settings",
    SubTitle: "All Settings",
    ShowPassword: "ShowPassword",
    Danger: {
      Reset: {
        Title: "Reset All Settings",
        SubTitle: "Reset all setting items to default",
        Action: "Reset",
        Confirm: "Confirm to reset all settings to default?",
      },
      Clear: {
        Title: "Clear All Data",
        SubTitle: "Clear all messages and settings",
        Action: "Clear",
        Confirm: "Confirm to clear all messages and settings?",
      },
    },
    Lang: {
      Name: "Language", // ATTENTION: if you wanna add a new translation, please do not translate this value, leave it as `Language`
      All: "All Languages",
    },
    Avatar: "Avatar",
    FontSize: {
      Title: "Font Size",
      SubTitle: "Adjust font size of chat content",
    },
    Zoom: {
      Title: "Interface Zoom",
      SubTitle: "Ctrl + = / - / 0, Ctrl + scroll (Cmd on macOS)",
      Toast: (percent: string) => `Zoom ${percent}`,
    },
    FontFamily: {
      Title: "Chat Font Family",
      SubTitle:
        "Font Family of the chat content, leave empty to apply global default font",
      Placeholder: "Font Family Name",
    },
    InjectSystemPrompts: {
      Title: "Inject System Prompts",
      SubTitle: "Inject a global system prompt for every request",
    },
    InputTemplate: {
      Title: "Input Template",
      SubTitle: "Newest message will be filled to this template",
    },

    Update: {
      Version: (x: string) => `Version: ${x}`,
      IsLatest: "Latest version",
      CheckUpdate: "Check Update",
      IsChecking: "Checking update...",
      FoundUpdate: (x: string) => `Found new version: ${x}`,
      GoToUpdate: "Update",
      Success: "Update Successful.",
      Failed: "Update Failed.",
    },
    SendKey: "Send Key",
    Theme: "Theme",
    TightBorder: "Tight Border",
    SendPreviewBubble: {
      Title: "Send Preview Bubble",
      SubTitle: "Preview markdown in bubble",
    },
    AutoGenerateTitle: {
      Title: "Auto Generate Title",
      SubTitle: "Generate a suitable title based on the conversation content",
    },
    Sync: {
      Scope:
        "Cloud sync includes only chats, masks, and prompts. API configuration, model lists, MCP configuration, and app settings stay on this device.",
      CloudState: "Last Update",
      NotSyncYet: "Not sync yet",
      LastSync: (time: string, provider: string) =>
        `Last sync: ${time} (${provider})`,
      Success: "Sync Success",
      Fail: "Sync Fail",
      CheckSuccess: "Connection check passed",
      CheckFailed: "Connection check failed",
      Errors: {
        AUTH: "Incorrect username or password. Jianguoyun requires a third-party app password, not your login password",
        FORBIDDEN: "Access or write permission denied",
        PATH: "The server path does not exist; check the endpoint",
        BUSY: "Too many requests or service temporarily unavailable. Retry later; Jianguoyun has rate limits",
        REDIRECT:
          "The server redirected the request; enter the final endpoint directly",
        HTTP: "Server request failed",
        INVALID_JSON: "The remote backup is not a valid JSON backup",
        INVALID_ENDPOINT:
          "Use an http/https endpoint without embedded credentials, query parameters or fragments",
        NETWORK_DNS: "Network error: DNS name resolution failed",
        NETWORK_TLS:
          "Network error: TLS connection or certificate validation failed",
        NETWORK_TIMEOUT: "Network error: request timed out",
        NETWORK_REFUSED:
          "Network error: connection refused; check that the server is running",
        NETWORK_CONNECT:
          "Network error: cannot connect to the server; check the network or proxy",
        NETWORK_FAILED:
          "Network request failed; check connectivity, the server or the browser CORS proxy",
        REMOTE_ERROR: "The remote service returned an invalid result",
        UNKNOWN: "Sync operation failed; check your configuration and retry",
      },

      Config: {
        Modal: {
          Title: "Config Sync",
          Check: "Check Connection",
        },
        SyncType: {
          Title: "Sync Type",
          SubTitle: "Choose your favorite sync service",
        },
        Proxy: {
          Title: "Enable CORS Proxy",
          SubTitle: "Enable a proxy to avoid cross-origin restrictions",
        },
        ProxyUrl: {
          Title: "Proxy Endpoint",
          SubTitle:
            "Only applicable to the built-in CORS proxy for this project",
        },

        WebDav: {
          Endpoint: "WebDAV Endpoint",
          UserName: "User Name",
          Password: "Password",
        },

        UpStash: {
          Endpoint: "UpStash Redis REST Url",
          UserName: "Backup Name",
          Password: "UpStash Redis REST Token",
        },
      },

      LocalState: "Local Data",
      Overview: (overview: any) => {
        return `${overview.chat} chats，${overview.message} messages，${overview.prompt} prompts，${overview.mask} masks`;
      },
      ImportFailed: "Failed to import from file",
      ImportSuccess: "Backup imported",
      ImportConfirm:
        "Import this backup? Chats, masks, prompts, plugins and MCP servers will be merged. Endpoints with the same ID, app settings, access code and sync accounts will use the backup; local-only endpoints are kept. MCP servers can run programs; the desktop app asks for separate approval.",
      McpNotImported:
        "Other data was imported, but MCP servers were not imported.",
      ExportWithoutMcp:
        "MCP configuration is unavailable and will not be included. Export the remaining data?",
      BackupSecrets:
        "Backups contain API keys and passwords and are password encrypted.",
      SetBackupPassword: "Set a backup password",
      EnterBackupPassword: "Enter the backup password",
      Password: "Password",
      ConfirmPassword: "Confirm password",
      PasswordWarning:
        "If you forget the password, the backup cannot be restored.",
      PasswordEmpty: "The password cannot be empty.",
      PasswordMismatch: "The passwords do not match.",
      BadPassword:
        "Incorrect password or modified backup. Try the password again.",
      InvalidEncryptedBackup: "The backup is invalid or has been modified.",
      BackupWorking: "Processing backup",
      Encrypting: "Encrypting the backup. Please keep this page open.",
      Decrypting:
        "Reading or decrypting the backup. Please keep this page open.",
      Restoring: "Restoring the backup. Please keep this page open.",
      ExportFailed: "Failed to export the backup.",
    },
    Mask: {
      Splash: {
        Title: "Mask Splash Screen",
        SubTitle: "Show a mask splash screen before starting new chat",
      },
      Builtin: {
        Title: "Hide Builtin Masks",
        SubTitle: "Hide builtin masks in mask list",
      },
    },
    Prompt: {
      Disable: {
        Title: "Disable auto-completion",
        SubTitle: "Input / to trigger auto-completion",
      },
      List: "Prompt List",
      ListCount: (builtin: number, custom: number) =>
        `${builtin} built-in, ${custom} user-defined`,
      Edit: "Edit",
      Modal: {
        Title: "Prompt List",
        Add: "Add One",
        Search: "Search Prompts",
      },
      EditModal: {
        Title: "Edit Prompt",
      },
    },
    HistoryCount: {
      Title: "Attached Messages Count",
      SubTitle: "Number of sent messages attached per request",
    },
    CompressThreshold: {
      Title: "History Compression Threshold",
      SubTitle:
        "Will compress if uncompressed messages length exceeds the value",
    },
    Access: {
      AccessCode: {
        Title: "Access Code",
        SubTitle: "Access control Enabled",
        Placeholder: "Enter Code",
      },
    },

    Model: "Model",
    EnableParameter: (name: string) => `Enable ${name}`,
    JoinParameterDescriptions: (...parts: string[]) =>
      `${parts.map((part) => part.replace(/[。.!?\s]+$/u, "")).join(". ")}.`,
    ParameterOptional:
      "When off, this parameter is omitted and the model default is used.",
    PenaltyProtocols: "Responses and Anthropic do not support this parameter.",
    AnthropicMaxTokens:
      "Anthropic requires this parameter; 16000 is used when off.",
    ReasoningEffort: {
      Title: "Reasoning effort",
      SubTitle:
        "Leave empty to use the model default. Enter a level or token budget; accepted values depend on the model. Unsupported values return an API error.",
    },
    ReasoningSummary: {
      Title: "Request reasoning content",
      SubTitle:
        "When off, reasoning content is not requested; content returned by the API is still shown.",
    },
    CompressModel: {
      Title: "Summary Model",
      SubTitle: "Model used to compress history and generate title",
    },
    Temperature: {
      Title: "Temperature",
      SubTitle: "A larger value makes the more random output",
    },
    TopP: {
      Title: "Top P",
      SubTitle: "Do not alter this value together with temperature",
    },
    MaxTokens: {
      Title: "Max Tokens",
      SubTitle: "Maximum length of input tokens and generated tokens",
    },
    PresencePenalty: {
      Title: "Presence Penalty",
      SubTitle:
        "A larger value increases the likelihood to talk about new topics",
    },
    FrequencyPenalty: {
      Title: "Frequency Penalty",
      SubTitle:
        "A larger value decreasing the likelihood to repeat the same line",
    },
    TTS: {
      SystemEngine: "System voice",
      Melo: {
        Engine: "MeloTTS (local neural voice, Chinese + English)",
        Model: "MeloTTS model",
        Manage: "Manage model",
        Description:
          "About 167 MB. Works offline after download, with one female Chinese/English voice.",
        Checking: "Checking model…",
        Missing: "Not downloaded",
        Downloading: (percent: number) => `Downloading ${percent}%`,
        Verifying: "Verifying and extracting…",
        Deleting: "Deleting model…",
        Ready: (size: string) => `Ready (${size} MiB)`,
        Progress: "Model download progress",
        Download: "Download model",
        Import: "Import local file",
        Delete: "Delete model",
        Cancel: "Cancel download/import",
        Sample:
          "Hello, this is a local MeloTTS preview. Python and the API are ready, and progress is 85%.",
        Fallback: (reason: string) =>
          `MeloTTS is unavailable: ${reason}. Using the system voice.`,
        Stopped: (reason: string) => `MeloTTS playback stopped: ${reason}.`,
        UnknownError: "Local speech operation failed. Please try again",
        Errors: {
          MODEL_NOT_READY: "Download or import the model first",
          MODEL_LOAD_FAILED:
            "Model loading failed; download or import it again",
          MODEL_FILES_MISSING:
            "Model files are incomplete; delete and import again",
          MODEL_HASH_MISMATCH:
            "Model verification failed; use the specified official model archive",
          MODEL_SIZE_MISMATCH:
            "Model file size is incorrect; download it again",
          INVALID_ARCHIVE:
            "The model archive has an invalid format or unsafe paths",
          INVALID_MODEL_PATH: "The model directory is invalid",
          MODEL_ALREADY_EXISTS:
            "The model directory already exists; delete the model first",
          MODEL_BUSY: "A model operation is still in progress",
          MODEL_IO:
            "Cannot access model files; check disk space and permissions",
          MODEL_STATE_FAILED: "Local speech state is invalid; restart the app",
          DOWNLOAD_FAILED: "Download failed; retry or import a local file",
          SYNTHESIS_FAILED: "Speech synthesis failed",
          EMPTY_SPEECH: "The text produced no playable speech",
          AUDIO_DECODE_FAILED: "The generated speech could not be decoded",
          INVALID_SPEECH_INPUT: "The text or speech rate is invalid",
          AUDIO_UNAVAILABLE: "Local audio playback is unavailable",
          CANCELLED: "The operation was cancelled",
        },
      },
      LocalDescription:
        "Uses installed local voices. Text stays on this device.",
      LocalVoice: "Local voice",
      Automatic: "Automatic (match text language)",
      Rate: "Speech rate",
      Pitch: "Pitch",
      Preview: "Preview voice",
      Sample:
        "Hello, this is a preview of your local system voice. Adjust the rate and pitch to make reading comfortable.",
      NoVoices:
        "No local voices available. Add a voice in Windows Settings → Time & language → Speech.",
      Failed: "Speech failed. Check your system voice settings and try again.",

      Enable: {
        Title: "Enable TTS",
        SubTitle: "Enable text-to-speech service",
      },
      Autoplay: {
        Title: "Enable Autoplay",
        SubTitle:
          "Automatically generate speech and play, you need to enable the text-to-speech switch first",
      },
      Model: "Model",
      Voice: {
        Title: "Voice",
        SubTitle: "The voice to use when generating the audio",
      },
      Speed: {
        Title: "Speed",
        SubTitle: "The speed of the generated audio",
      },
      Engine: "TTS Engine",
    },
  },
  Store: {
    DefaultTopic: "New Conversation",
    BotHello: "Hello! How can I assist you today?",
    Error: "Something went wrong, please try again later.",
    Prompt: {
      History: (content: string) =>
        "This is a summary of the chat history as a recap: " + content,
      Topic:
        "Please generate a four to five word title summarizing our conversation without any lead-in, punctuation, quotation marks, periods, symbols, bold text, or additional text. Remove enclosing quotation marks.",
      Summarize:
        "Summarize the discussion briefly in 200 words or less to use as a prompt for future context.",
    },
  },
  Copy: {
    Success: "Copied to clipboard",
    Failed: "Copy failed, please grant permission to access clipboard",
  },
  Download: {
    Success: "Content downloaded to your directory.",
    Failed: "Download failed.",
  },
  Context: {
    Toast: (x: any) => `With ${x} contextual prompts`,
    Edit: "Current Chat Settings",
    Add: "Add a Prompt",
    Clear: "Context Cleared",
    Revert: "Revert",
  },
  Mcp: {
    Login: "Sign in",
    Logout: "Sign out",
    LoginRequired: "Sign-in required",
    OAuthUnsupportedShort: "Sign-in unsupported",
    OAuthUnsupported:
      "This service requires a pre-registered client, which is not supported yet.",
    OAuthFailed: "Sign-in did not complete. Please try again.",
    OAuthTimeout: "Sign-in timed out. Please try again.",
    OAuthPopupBlocked:
      "Could not open the sign-in page. Allow pop-ups and try again.",
    OAuthSignedOut: "Signed out",
    LoggingIn: "Signing in…",
    LoggingOut: "Signing out…",
    Name: "MCP",
    Market: "MCP Market",
    Configured: (count: number) => `${count} servers configured`,
    AddServer: "Add Server",
    RestartAll: "Restart All",
    Configure: "Configure",
    Tools: "Tools",
    Stop: "Stop",
    Start: "Start",
    Remove: "Remove",
    Add: "Add",
    Save: "Save",
    Custom: "Custom",
    Search: "Search MCP Server",
    ServerId: "Server ID",
    Command: "Command",
    Arguments: "Arguments (JSON array)",
    Environment: "Environment (JSON object)",
    ServerDetails: (id: string) => `Server Details - ${id}`,
    ConfigureTitle: (id: string) => `Configure Server - ${id}`,
    AddItem: (name: string) => `Add ${name}`,
    EnterItem: (name: string) => `Enter ${name}`,
    OpenRepository: "Open repository",
    LoadingPresets: "Loading preset server list…",
    NoServers: "No servers available",
    LoadingTools: "Loading…",
    NoTools: "No tools available",
    Initializing: "Initializing",
    Running: "Running",
    Stopped: "Stopped",
    StoppedForAllChats:
      "Stopped on the MCP page; unavailable in all conversations",
    StatusUnknown: "Status unknown",
    Error: "Error",
    ErrorSeparator: ": ",
    Updating: "Updating configuration…",
    Creating: "Creating MCP client…",
    Removing: "Removing server…",
    Stopping: "Stopping server…",
    Starting: "Starting server…",
    Restarting: "Restarting all servers…",
    ConfigUpdated: "Server configuration updated successfully",
    ServerStopped: "Server stopped successfully",
    RestartStarted: "Restarting all clients",
    LoadPresetsFailed: "Failed to load preset servers",
    LoadStateFailed: "Failed to load server state",
    LoadToolsFailed: "Failed to load tools",
    SaveFailed: "Failed to save configuration",
    AddFailed: "Failed to add server",
    RemoveFailed: "Failed to remove server",
    StopFailed: "Failed to stop server",
    StartFailed: "Failed to start server",
    RestartFailed: "Failed to restart servers",
    Errors: {
      Http: (status: string) => `Remote MCP connection failed (HTTP ${status})`,
      Timeout: "Remote MCP network request timed out",
      Refused: "Remote MCP network connection was refused",
      Dns: "Remote MCP DNS lookup failed",
      Tls: "Remote MCP TLS connection failed",
      Connect: "Remote MCP network connection failed",
      General: "MCP network or protocol request failed",
      Denied: "MCP configuration was not approved. No changes were saved.",
      Unauthorized: "Invalid MCP access code",
      Disabled: "MCP is not enabled",
      Disconnected: "MCP server disconnected",
    },
    ConfigureServer: "Configure MCP Server",
    Transport: "Connection type",
    Local: "Local (stdio)",
    Remote: "Remote (HTTP)",
    Url: "Server URL",
    Headers: "Request headers (JSON object)",
    HeaderNames: "Request header names",
    PasteJson: "Add from JSON",
    PasteHelp: "Paste an object containing mcpServers",
    InvalidConfig: "Invalid MCP configuration",
    InvalidOrDenied: "Invalid MCP configuration or the change was not approved",
  },
  FineTuned: {
    Sysmessage: "You are an assistant that",
  },
  SearchChat: {
    Name: "Search",
    Page: {
      Title: "Search Chat History",
      Search: "Enter search query to search chat history",
      NoResult: "No results found",
      NoData: "No data",
      Loading: "Loading...",

      SubTitle: (count: number) => `Found ${count} results`,
    },
    Item: {
      View: "View",
    },
    Hint: "Search titles and messages in unarchived chats. Separate keywords with spaces.",
    MatchCount: (count: number) =>
      `${count} ${count === 1 ? "match" : "matches"}`,
    Role: {
      User: "You",
      Bot: "Assistant",
    },
    More: (count: number) => `Show ${count} more`,
    TooMany: (limit: number) =>
      `Too many results. Showing the latest ${limit}. Try narrowing your search.`,
    Keys: "↑↓ Select · Enter Open · Esc Close",
  },
  Archive: {
    Action: "Archive",
    Toast: "Chat archived",
    View: "View",
    Restore: "Restore",
    Delete: "Delete",
    Banner: "This chat is archived. Sending a message restores it.",
    Entry: (count: number) => `Archived (${count})`,
    Page: {
      Title: "Archived Chats",
      SubTitle: (count: number) => `${count} chats`,
      Search: "Search archived chat titles or messages",
      Empty: "No archived chats",
      NoResult: "No matching archived chats",
    },
  },
  Plugin: {
    Name: "Plugin",
    Page: {
      Title: "Plugins",
      SubTitle: (count: number) => `${count} plugins`,
      Search: "Search Plugin",
      Create: "Create",
      Find: "You can find awesome plugins on github: ",
    },
    Item: {
      Info: (count: number) => `${count} method`,
      View: "View",
      Edit: "Edit",
      Delete: "Delete",
      DeleteConfirm: "Confirm to delete?",
    },
    Auth: {
      None: "None",
      Basic: "Basic",
      Bearer: "Bearer",
      Custom: "Custom",
      CustomHeader: "Parameter Name",
      Token: "Token",
      Proxy: "Using Proxy",
      ProxyDescription: "Using proxies to solve CORS error",
      Location: "Location",
      LocationHeader: "Header",
      LocationQuery: "Query",
      LocationBody: "Body",
    },
    EditModal: {
      Title: (readonly: boolean) =>
        `Edit Plugin ${readonly ? "(readonly)" : ""}`,
      Download: "Download",
      Auth: "Authentication Type",
      Content: "OpenAPI Schema",
      Load: "Load From URL",
      Method: "Method",
      Error: "OpenAPI Schema Error",
    },
  },
  Mask: {
    Name: "Mask",
    Page: {
      Title: "Prompt Template",
      SubTitle: (count: number) => `${count} prompt templates`,
      Search: "Search Templates",
      Create: "Create",
    },
    Item: {
      Info: (count: number) => `${count} prompts`,
      Chat: "Chat",
      View: "View",
      Edit: "Edit",
      Delete: "Delete",
      DeleteConfirm: "Confirm to delete?",
    },
    EditModal: {
      Title: (readonly: boolean) =>
        `Edit Prompt Template ${readonly ? "(readonly)" : ""}`,
      Download: "Download",
      Clone: "Clone",
    },
    Config: {
      Avatar: "Bot Avatar",
      Name: "Bot Name",
      Sync: {
        Title: "Use Global Config",
        SubTitle: "Use global config in this chat",
        Confirm: "Confirm to override custom config with global config?",
      },
      HideContext: {
        Title: "Hide Context Prompts",
        SubTitle: "Do not show in-context prompts in chat",
      },
      Artifacts: {
        Title: "Enable Artifacts",
        SubTitle: "Can render HTML page when enable artifacts.",
      },
      CodeFold: {
        Title: "Enable CodeFold",
        SubTitle:
          "Automatically collapse/expand overly long code blocks when CodeFold is enabled",
      },
      Share: {
        Title: "Share This Mask",
        SubTitle: "Generate a link to this mask",
        Action: "Copy Link",
      },
    },
  },
  NewChat: {
    Return: "Return",
    Skip: "Just Start",
    Title: "Pick a Mask",
    SubTitle: "Chat with the Soul behind the Mask",
    More: "Find More",
    NotShow: "Never Show Again",
    ConfirmNoShow: "Confirm to disable？You can enable it in settings later.",
  },

  UI: {
    Confirm: "Confirm",
    Cancel: "Cancel",
    Close: "Close",
    Create: "Create",
    Edit: "Edit",
    Export: "Export",
    Import: "Import",
    Sync: "Sync",
    Config: "Config",
  },
  Exporter: {
    Description: {
      Title: "Only messages after clearing the context will be displayed",
    },
    Model: "Model",
    Messages: "Messages",
    Topic: "Topic",
    Time: "Time",
  },
  URLCommand: {
    Code: "Detected access code from url, confirm to apply? ",
    Settings: "Detected settings from url, confirm to apply?",
  },
};

export default en;
