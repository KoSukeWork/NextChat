import { IconButton } from "./button";
import { ErrorBoundary } from "./error";
import styles from "./mcp-market.module.scss";
import EditIcon from "../icons/edit.svg";
import AddIcon from "../icons/add.svg";
import CloseIcon from "../icons/close.svg";
import DeleteIcon from "../icons/delete.svg";
import RestartIcon from "../icons/reload.svg";
import EyeIcon from "../icons/eye.svg";
import GithubIcon from "../icons/github.svg";
import { List, ListItem, Modal, showToast } from "./ui-lib";
import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  addMcpServer,
  getClientsStatus,
  getClientTools,
  getMcpConfigFromFile,
  isMcpEnabled,
  pauseMcpServer,
  restartAllClients,
  resumeMcpServer,
  removeMcpServer,
  mergeMcpServers,
  beginMcpOAuth,
  cancelMcpOAuth,
  logoutMcpOAuth,
} from "../mcp/actions";
import {
  ListToolsResponse,
  McpConfigData,
  PresetServer,
  ServerConfig,
  ServerStatusResponse,
  isRemoteServer,
} from "../mcp/types";
import { parseMcpConfig, parsePastedMcpConfig } from "../mcp/config";
import { localizedMcpError } from "../mcp/error-message";
import Locale from "../locales";
import clsx from "clsx";
import PlayIcon from "../icons/play.svg";
import StopIcon from "../icons/pause.svg";
import { Path } from "../constant";
import { useAccessStore } from "../store";
import { fetch } from "../utils/stream";
import { isTauri } from "../mcp/tauri-api";
import { httpUrl } from "../mcp/oauth";

interface ConfigProperty {
  type: string;
  description?: string;
  required?: boolean;
  minItems?: number;
}

type Operation =
  | "updating"
  | "creating"
  | "removing"
  | "stopping"
  | "starting"
  | "logging-in"
  | "logging-out"
  | "restarting";

export function McpMarketPage() {
  const navigate = useNavigate();
  const accessCode = useAccessStore((state) => state.accessCode);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [userConfig, setUserConfig] = useState<Record<string, any>>({});
  const [editingServerId, setEditingServerId] = useState<string | undefined>();
  const [tools, setTools] = useState<ListToolsResponse["tools"] | null>(null);
  const [viewingServerId, setViewingServerId] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [config, setConfig] = useState<McpConfigData>();
  const [clientStatuses, setClientStatuses] = useState<
    Record<string, ServerStatusResponse>
  >({});
  const [loadingPresets, setLoadingPresets] = useState(true);
  const [presetServers, setPresetServers] = useState<PresetServer[]>([]);
  const [customServer, setCustomServer] = useState<{
    id: string;
    originalId?: string;
    type: "local" | "remote";
    command: string;
    args: string;
    env: string;
    url: string;
    headers: string;
  }>();
  const [pastedConfig, setPastedConfig] = useState<string>();
  const [loadingStates, setLoadingStates] = useState<Record<string, Operation>>(
    {},
  );
  const loginAttempts = useRef<Record<string, number>>({});

  // 检查 MCP 是否启用
  useEffect(() => {
    const checkMcpStatus = async () => {
      const enabled = await isMcpEnabled();
      setMcpEnabled(enabled);
      if (!enabled) {
        navigate(Path.Home);
      }
    };
    checkMcpStatus();
  }, [navigate]);

  // 添加状态轮询
  useEffect(() => {
    if (!mcpEnabled || !config) return;

    const updateStatuses = async () => {
      const statuses = await getClientsStatus(accessCode);
      setClientStatuses(statuses);
    };

    // 立即执行一次
    updateStatuses();
    // 每 1000ms 轮询一次
    const timer = setInterval(updateStatuses, 1000);

    return () => clearInterval(timer);
  }, [mcpEnabled, config, accessCode]);

  // 加载预设服务器
  useEffect(() => {
    const loadPresetServers = async () => {
      if (!mcpEnabled) return;
      try {
        setLoadingPresets(true);
        const response = await fetch("https://nextchat.club/mcp/list");
        if (!response.ok) {
          throw new Error(Locale.Mcp.LoadPresetsFailed);
        }
        const data = await response.json();
        setPresetServers(data?.data ?? []);
      } catch (error) {
        console.error("Failed to load preset servers:", error);
        showToast(Locale.Mcp.LoadPresetsFailed);
      } finally {
        setLoadingPresets(false);
      }
    };
    loadPresetServers();
  }, [mcpEnabled]);

  // 加载初始状态
  useEffect(() => {
    const loadInitialState = async () => {
      if (!mcpEnabled) return;
      try {
        setIsLoading(true);
        const config = await getMcpConfigFromFile(accessCode);
        setConfig(config);

        // 获取所有客户端的状态
        const statuses = await getClientsStatus(accessCode);
        setClientStatuses(statuses);
      } catch (error) {
        console.error("Failed to load initial state:", error);
        showToast(localizedMcpError(error, Locale.Mcp.LoadStateFailed));
      } finally {
        setIsLoading(false);
      }
    };
    loadInitialState();
  }, [mcpEnabled, accessCode]);

  // 加载当前编辑服务器的配置
  useEffect(() => {
    if (!editingServerId || !config) return;
    const currentConfig = config.mcpServers[editingServerId];
    if (currentConfig) {
      // 从当前配置中提取用户配置
      const preset = presetServers.find((s) => s.id === editingServerId);
      if (preset?.configSchema) {
        const userConfig: Record<string, any> = {};
        Object.entries(preset.argsMapping || {}).forEach(([key, mapping]) => {
          if (mapping.type === "spread") {
            // For spread types, extract the array from args.
            const startPos = mapping.position ?? 0;
            userConfig[key] = (currentConfig.args ?? []).slice(startPos);
          } else if (mapping.type === "single") {
            // For single types, get a single value
            userConfig[key] = (currentConfig.args ?? [])[mapping.position ?? 0];
          } else if (
            mapping.type === "env" &&
            mapping.key &&
            currentConfig.env
          ) {
            // For env types, get values from environment variables
            userConfig[key] = currentConfig.env[mapping.key];
          }
        });
        setUserConfig(userConfig);
      }
    } else {
      setUserConfig({});
    }
  }, [editingServerId, config, presetServers]);

  if (!mcpEnabled) {
    return null;
  }

  // 检查服务器是否已添加
  const savedServers: PresetServer[] = Object.entries(config?.mcpServers ?? {})
    .filter(([id]) => !presetServers.some((server) => server.id === id))
    .map(([id, server]) => ({
      id,
      name: id,
      description: isRemoteServer(server) ? server.url : server.command,
      repo: "",
      tags: [Locale.Mcp.Custom],
      command: isRemoteServer(server) ? "" : server.command,
      baseArgs: isRemoteServer(server) ? [] : server.args,
      configurable: false,
    }));
  const allServers = [...presetServers, ...savedServers];

  const saveCustomServer = async () => {
    if (!customServer) return;
    try {
      const id = customServer.id.trim();
      const raw =
        customServer.type === "remote"
          ? {
              url: customServer.url.trim(),
              headers: JSON.parse(customServer.headers),
            }
          : {
              command: customServer.command.trim(),
              args: JSON.parse(customServer.args),
              env: JSON.parse(customServer.env),
            };
      const parsed = parseMcpConfig({ mcpServers: { [id]: raw } });
      const previous = config?.mcpServers[id];
      const server = {
        ...parsed.mcpServers[id],
        ...(previous?.status ? { status: previous.status } : {}),
      } as ServerConfig;
      setIsLoading(true);
      setConfig(await addMcpServer(id, server, accessCode));
      setCustomServer(undefined);
    } catch (error) {
      showToast(localizedMcpError(error, Locale.Mcp.InvalidOrDenied));
    } finally {
      setIsLoading(false);
    }
  };

  const savePastedConfig = async () => {
    if (pastedConfig === undefined) return;
    try {
      const parsed = parsePastedMcpConfig(JSON.parse(pastedConfig));
      if (!Object.keys(parsed.mcpServers).length) throw new Error();
      setIsLoading(true);
      setConfig(await mergeMcpServers(parsed, accessCode));
      setPastedConfig(undefined);
    } catch (error) {
      showToast(localizedMcpError(error, Locale.Mcp.InvalidOrDenied));
    } finally {
      setIsLoading(false);
    }
  };

  const isServerAdded = (id: string) => {
    return id in (config?.mcpServers ?? {});
  };

  // 保存服务器配置
  const saveServerConfig = async () => {
    const preset = presetServers.find((s) => s.id === editingServerId);
    if (!preset || !preset.configSchema || !editingServerId) return;

    const savingServerId = editingServerId;
    setEditingServerId(undefined);

    try {
      updateLoadingState(savingServerId, "updating");
      // 构建服务器配置
      const args = [...preset.baseArgs];
      const env: Record<string, string> = {};

      Object.entries(preset.argsMapping || {}).forEach(([key, mapping]) => {
        const value = userConfig[key];
        if (mapping.type === "spread" && Array.isArray(value)) {
          const pos = mapping.position ?? 0;
          args.splice(pos, 0, ...value);
        } else if (
          mapping.type === "single" &&
          mapping.position !== undefined
        ) {
          args[mapping.position] = value;
        } else if (
          mapping.type === "env" &&
          mapping.key &&
          typeof value === "string"
        ) {
          env[mapping.key] = value;
        }
      });

      const serverConfig: ServerConfig = {
        command: preset.command,
        args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };

      const newConfig = await addMcpServer(
        savingServerId,
        serverConfig,
        accessCode,
      );
      setConfig(newConfig);
      showToast(Locale.Mcp.ConfigUpdated);
    } catch (error) {
      showToast(localizedMcpError(error, Locale.Mcp.SaveFailed));
    } finally {
      updateLoadingState(savingServerId, null);
    }
  };

  // 获取服务器支持的 Tools
  const loadTools = async (id: string) => {
    try {
      const result = await getClientTools(id, accessCode);
      if (result) {
        setTools(result);
      } else {
        throw new Error(Locale.Mcp.LoadToolsFailed);
      }
    } catch (error) {
      showToast(localizedMcpError(error, Locale.Mcp.LoadToolsFailed));
      console.error(error);
      setTools(null);
    }
  };

  // 更新加载状态的辅助函数
  const updateLoadingState = (id: string, message: Operation | null) => {
    setLoadingStates((prev) => {
      if (message === null) {
        const { [id]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: message };
    });
  };

  // 修改添加服务器函数
  const addServer = async (preset: PresetServer) => {
    if (!preset.configurable) {
      try {
        const serverId = preset.id;
        updateLoadingState(serverId, "creating");

        const serverConfig: ServerConfig = {
          command: preset.command,
          args: [...preset.baseArgs],
        };
        const newConfig = await addMcpServer(
          preset.id,
          serverConfig,
          accessCode,
        );
        setConfig(newConfig);

        // 更新状态
        const statuses = await getClientsStatus(accessCode);
        setClientStatuses(statuses);
      } catch (error) {
        showToast(localizedMcpError(error, Locale.Mcp.AddFailed));
      } finally {
        updateLoadingState(preset.id, null);
      }
    } else {
      // 如果需要配置，打开配置对话框
      setEditingServerId(preset.id);
      setUserConfig({});
    }
  };

  const removeServer = async (id: string) => {
    try {
      updateLoadingState(id, "removing");
      setConfig(await removeMcpServer(id, accessCode));
      setClientStatuses(await getClientsStatus(accessCode));
    } catch (error) {
      showToast(localizedMcpError(error, Locale.Mcp.RemoveFailed));
    } finally {
      updateLoadingState(id, null);
    }
  };

  // 修改暂停服务器函数
  const pauseServer = async (id: string) => {
    try {
      updateLoadingState(id, "stopping");
      const newConfig = await pauseMcpServer(id, accessCode);
      setConfig(newConfig);
      showToast(Locale.Mcp.ServerStopped);
    } catch (error) {
      showToast(localizedMcpError(error, Locale.Mcp.StopFailed));
      console.error(error);
    } finally {
      updateLoadingState(id, null);
    }
  };

  // Restart server
  const restartServer = async (id: string) => {
    try {
      updateLoadingState(id, "starting");
      await resumeMcpServer(id, accessCode);
    } catch (error) {
      showToast(localizedMcpError(error, Locale.Mcp.StartFailed));
      console.error(error);
    } finally {
      updateLoadingState(id, null);
    }
  };

  const signIn = async (id: string) => {
    const desktop = isTauri();
    const popup = desktop ? null : window.open("about:blank", "_blank");
    if (!desktop && !popup) {
      showToast(Locale.Mcp.OAuthPopupBlocked);
      return;
    }
    const attempt = (loginAttempts.current[id] ?? 0) + 1;
    loginAttempts.current[id] = attempt;
    const isCurrent = () => loginAttempts.current[id] === attempt;
    try {
      updateLoadingState(id, "logging-in");
      const result = await beginMcpOAuth(
        id,
        window.location.origin,
        accessCode,
      );
      if (!isCurrent()) return;
      if (popup) {
        if (!result.url) throw new Error("Missing OAuth authorization URL");
        const target = httpUrl(result.url);
        popup.opener = null;
        popup.location.replace(target.href);
      }
    } catch (error) {
      popup?.close();
      if (!isCurrent()) return;
      showToast(
        error instanceof Error &&
          error.message === "OAuth server requires a pre-registered client"
          ? Locale.Mcp.OAuthUnsupported
          : error instanceof Error && error.message === "OAuth login timed out"
          ? Locale.Mcp.OAuthTimeout
          : Locale.Mcp.OAuthFailed,
      );
    } finally {
      if (isCurrent()) updateLoadingState(id, null);
    }
  };

  const cancelSignIn = (id: string) => {
    loginAttempts.current[id] = (loginAttempts.current[id] ?? 0) + 1;
    // Queue cancellation before enabling a new attempt for this server.
    void cancelMcpOAuth(id, accessCode).catch(() => {});
    updateLoadingState(id, null);
  };

  const signOut = async (id: string) => {
    try {
      updateLoadingState(id, "logging-out");
      await logoutMcpOAuth(id, accessCode);
      showToast(Locale.Mcp.OAuthSignedOut);
    } catch {
      showToast(Locale.Mcp.OAuthFailed);
    } finally {
      updateLoadingState(id, null);
    }
  };

  // Restart all clients
  const handleRestartAll = async () => {
    try {
      updateLoadingState("all", "restarting");
      const newConfig = await restartAllClients(accessCode);
      setConfig(newConfig);
      showToast(Locale.Mcp.RestartStarted);
    } catch (error) {
      showToast(localizedMcpError(error, Locale.Mcp.RestartFailed));
      console.error(error);
    } finally {
      updateLoadingState("all", null);
    }
  };

  // Render configuration form
  const renderConfigForm = () => {
    const preset = presetServers.find((s) => s.id === editingServerId);
    if (!preset?.configSchema) return null;

    return Object.entries(preset.configSchema.properties).map(
      ([key, prop]: [string, ConfigProperty]) => {
        if (prop.type === "array") {
          const currentValue = userConfig[key as keyof typeof userConfig] || [];
          const itemLabel = (prop as any).itemLabel || key;
          const addButtonText = Locale.Mcp.AddItem(itemLabel);

          return (
            <ListItem
              key={key}
              title={key}
              subTitle={prop.description}
              vertical
            >
              <div className={styles["path-list"]}>
                {(currentValue as string[]).map(
                  (value: string, index: number) => (
                    <div key={index} className={styles["path-item"]}>
                      <input
                        type="text"
                        value={value}
                        placeholder={`${itemLabel} ${index + 1}`}
                        onChange={(e) => {
                          const newValue = [...currentValue] as string[];
                          newValue[index] = e.target.value;
                          setUserConfig({ ...userConfig, [key]: newValue });
                        }}
                      />
                      <IconButton
                        icon={<DeleteIcon />}
                        className={styles["delete-button"]}
                        onClick={() => {
                          const newValue = [...currentValue] as string[];
                          newValue.splice(index, 1);
                          setUserConfig({ ...userConfig, [key]: newValue });
                        }}
                      />
                    </div>
                  ),
                )}
                <IconButton
                  icon={<AddIcon />}
                  text={addButtonText}
                  className={styles["add-button"]}
                  bordered
                  onClick={() => {
                    const newValue = [...currentValue, ""] as string[];
                    setUserConfig({ ...userConfig, [key]: newValue });
                  }}
                />
              </div>
            </ListItem>
          );
        } else if (prop.type === "string") {
          const currentValue = userConfig[key as keyof typeof userConfig] || "";
          return (
            <ListItem key={key} title={key} subTitle={prop.description}>
              <input
                aria-label={key}
                type="text"
                value={currentValue}
                placeholder={Locale.Mcp.EnterItem(key)}
                onChange={(e) => {
                  setUserConfig({ ...userConfig, [key]: e.target.value });
                }}
              />
            </ListItem>
          );
        }
        return null;
      },
    );
  };

  const checkServerStatus = (clientId: string) => {
    return clientStatuses[clientId] || { status: "undefined", errorMsg: null };
  };

  const getServerStatusDisplay = (clientId: string) => {
    const status = checkServerStatus(clientId);

    const statusMap = {
      undefined: null, // 未配置/未找到不显示
      // 添加初始化状态
      initializing: (
        <span className={clsx(styles["server-status"], styles["initializing"])}>
          {Locale.Mcp.Initializing}
        </span>
      ),
      paused: (
        <span className={clsx(styles["server-status"], styles["stopped"])}>
          {Locale.Mcp.Stopped}
        </span>
      ),
      active: (
        <span className={styles["server-status"]}>{Locale.Mcp.Running}</span>
      ),
      "login-required": (
        <span className={clsx(styles["server-status"], styles["initializing"])}>
          {Locale.Mcp.LoginRequired}
        </span>
      ),
      "oauth-unsupported": (
        <span
          className={clsx(styles["server-status"], styles["error"])}
          title={Locale.Mcp.OAuthUnsupported}
        >
          {Locale.Mcp.OAuthUnsupportedShort}
        </span>
      ),
      error: (
        <span className={clsx(styles["server-status"], styles["error"])}>
          {Locale.Mcp.Error}
          <span className={styles["error-message"]}>
            {Locale.Mcp.ErrorSeparator}
            {localizedMcpError(status.errorMsg)}
          </span>
        </span>
      ),
    };

    return statusMap[status.status];
  };

  // Get the type of operation status
  const getOperationStatusType = (operation: Operation) => {
    if (operation === "stopping") return "stopping";
    if (operation === "starting") return "starting";
    return "default";
  };
  const operationText: Record<Operation, string> = {
    updating: Locale.Mcp.Updating,
    creating: Locale.Mcp.Creating,
    removing: Locale.Mcp.Removing,
    stopping: Locale.Mcp.Stopping,
    starting: Locale.Mcp.Starting,
    restarting: Locale.Mcp.Restarting,
    "logging-in": Locale.Mcp.LoggingIn,
    "logging-out": Locale.Mcp.LoggingOut,
  };

  // 渲染服务器列表
  const renderServerList = () => {
    if (loadingPresets && allServers.length === 0) {
      return (
        <div className={styles["loading-container"]}>
          <div className={styles["loading-text"]}>
            {Locale.Mcp.LoadingPresets}
          </div>
        </div>
      );
    }

    if (allServers.length === 0) {
      return (
        <div className={styles["empty-container"]}>
          <div className={styles["empty-text"]}>{Locale.Mcp.NoServers}</div>
        </div>
      );
    }

    return allServers
      .filter((server) => {
        if (searchText.length === 0) return true;
        const searchLower = searchText.toLowerCase();
        return (
          server.name.toLowerCase().includes(searchLower) ||
          server.description.toLowerCase().includes(searchLower) ||
          server.tags.some((tag) => tag.toLowerCase().includes(searchLower))
        );
      })
      .sort((a, b) => {
        const aStatus = checkServerStatus(a.id).status;
        const bStatus = checkServerStatus(b.id).status;
        const aLoading = loadingStates[a.id];
        const bLoading = loadingStates[b.id];

        // 定义状态优先级
        const statusPriority: Record<string, number> = {
          error: 0, // Highest priority for error status
          active: 1, // Second for active
          initializing: 2, // Initializing
          starting: 3, // Starting
          stopping: 4, // Stopping
          paused: 5, // Paused
          undefined: 6, // Lowest priority for undefined
        };

        // Get actual status (including loading status)
        const getEffectiveStatus = (status: string, loading?: Operation) => {
          if (loading) {
            const operationType = getOperationStatusType(loading);
            return operationType === "default" ? status : operationType;
          }

          if (status === "initializing" && !loading) {
            return "active";
          }

          return status;
        };

        const aEffectiveStatus = getEffectiveStatus(aStatus, aLoading);
        const bEffectiveStatus = getEffectiveStatus(bStatus, bLoading);

        // 首先按状态排序
        if (aEffectiveStatus !== bEffectiveStatus) {
          return (
            (statusPriority[aEffectiveStatus] ?? 6) -
            (statusPriority[bEffectiveStatus] ?? 6)
          );
        }

        // Sort by name when statuses are the same
        return a.name.localeCompare(b.name);
      })
      .map((server) => (
        <div
          className={clsx(styles["mcp-market-item"], {
            [styles["loading"]]: loadingStates[server.id],
          })}
          key={server.id}
        >
          <div className={styles["mcp-market-header"]}>
            <div className={styles["mcp-market-title"]}>
              <div className={styles["mcp-market-name"]}>
                {server.name}
                {loadingStates[server.id] && (
                  <span
                    className={styles["operation-status"]}
                    data-status={getOperationStatusType(
                      loadingStates[server.id],
                    )}
                  >
                    {operationText[loadingStates[server.id]]}
                  </span>
                )}
                {!loadingStates[server.id] && getServerStatusDisplay(server.id)}
                {server.repo && (
                  <a
                    href={server.repo}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles["repo-link"]}
                    title={Locale.Mcp.OpenRepository}
                  >
                    <GithubIcon />
                  </a>
                )}
              </div>
              <div className={styles["tags-container"]}>
                {server.tags.map((tag, index) => (
                  <span key={index} className={styles["tag"]}>
                    {tag}
                  </span>
                ))}
              </div>
              <div
                className={clsx(styles["mcp-market-info"], "one-line")}
                title={server.description}
              >
                {config?.mcpServers[server.id] &&
                isRemoteServer(config.mcpServers[server.id])
                  ? config.mcpServers[server.id].url
                  : server.description}
              </div>
            </div>
            <div className={styles["mcp-market-actions"]}>
              {isServerAdded(server.id) ? (
                <>
                  {server.configurable &&
                    !isRemoteServer(config!.mcpServers[server.id]) && (
                      <IconButton
                        icon={<EditIcon />}
                        text={Locale.Mcp.Configure}
                        onClick={() => setEditingServerId(server.id)}
                        disabled={isLoading}
                      />
                    )}
                  {(!server.configurable ||
                    isRemoteServer(config!.mcpServers[server.id])) && (
                    <IconButton
                      icon={<EditIcon />}
                      text={Locale.Mcp.Configure}
                      disabled={isLoading}
                      onClick={() => {
                        const saved = config!.mcpServers[server.id];
                        setCustomServer({
                          id: server.id,
                          originalId: server.id,
                          type: isRemoteServer(saved) ? "remote" : "local",
                          command: saved.command ?? "",
                          args: JSON.stringify(saved.args ?? []),
                          env: JSON.stringify(saved.env ?? {}),
                          url: saved.url ?? "",
                          headers: JSON.stringify(saved.headers ?? {}),
                        });
                      }}
                    />
                  )}
                  {isTauri() && loadingStates[server.id] === "logging-in" ? (
                    <IconButton
                      className={styles["oauth-cancel"]}
                      text={Locale.UI.Cancel}
                      onClick={() => cancelSignIn(server.id)}
                    />
                  ) : (
                    checkServerStatus(server.id).status ===
                      "login-required" && (
                      <IconButton
                        text={Locale.Mcp.Login}
                        onClick={() => signIn(server.id)}
                        disabled={isLoading}
                      />
                    )
                  )}
                  {checkServerStatus(server.id).oauthAuthenticated && (
                    <IconButton
                      text={Locale.Mcp.Logout}
                      onClick={() => signOut(server.id)}
                      disabled={isLoading}
                    />
                  )}
                  {checkServerStatus(server.id).status === "paused" ? (
                    <>
                      <IconButton
                        icon={<PlayIcon />}
                        text={Locale.Mcp.Start}
                        onClick={() => restartServer(server.id)}
                        disabled={isLoading}
                      />
                      <IconButton
                        icon={<DeleteIcon />}
                        text={Locale.Mcp.Remove}
                        onClick={() => removeServer(server.id)}
                        disabled={isLoading}
                      />
                    </>
                  ) : (
                    <>
                      <IconButton
                        icon={<EyeIcon />}
                        text={Locale.Mcp.Tools}
                        onClick={async () => {
                          setViewingServerId(server.id);
                          await loadTools(server.id);
                        }}
                        disabled={
                          isLoading ||
                          checkServerStatus(server.id).status !== "active"
                        }
                      />
                      <IconButton
                        icon={<StopIcon />}
                        text={Locale.Mcp.Stop}
                        onClick={() => pauseServer(server.id)}
                        disabled={isLoading}
                      />
                    </>
                  )}
                </>
              ) : (
                <IconButton
                  icon={<AddIcon />}
                  text={Locale.Mcp.Add}
                  onClick={() => addServer(server)}
                  disabled={isLoading}
                />
              )}
            </div>
          </div>
        </div>
      ));
  };

  return (
    <ErrorBoundary>
      <div className={styles["mcp-market-page"]}>
        <div className="window-header">
          <div className="window-header-title">
            <div className="window-header-main-title">
              {Locale.Mcp.Market}
              {loadingStates["all"] && (
                <span className={styles["loading-indicator"]}>
                  {operationText[loadingStates["all"]]}
                </span>
              )}
            </div>
            <div className="window-header-sub-title">
              {Locale.Mcp.Configured(
                Object.keys(config?.mcpServers ?? {}).length,
              )}
            </div>
          </div>

          <div className="window-actions">
            <div className="window-action-button">
              <IconButton
                icon={<AddIcon />}
                text={Locale.Mcp.AddServer}
                bordered
                disabled={isLoading}
                onClick={() =>
                  setCustomServer({
                    id: "",
                    type: "local",
                    command: "",
                    args: "[]",
                    env: "{}",
                    url: "",
                    headers: "{}",
                  })
                }
              />
            </div>
            <div className="window-action-button">
              <IconButton
                icon={<AddIcon />}
                text={Locale.Mcp.PasteJson}
                bordered
                disabled={isLoading}
                onClick={() => setPastedConfig("")}
              />
            </div>
            <div className="window-action-button">
              <IconButton
                icon={<RestartIcon />}
                bordered
                onClick={handleRestartAll}
                text={Locale.Mcp.RestartAll}
                disabled={isLoading}
              />
            </div>
            <div className="window-action-button">
              <IconButton
                icon={<CloseIcon />}
                bordered
                onClick={() => navigate(-1)}
                disabled={isLoading}
              />
            </div>
          </div>
        </div>

        <div className={styles["mcp-market-page-body"]}>
          <div className={styles["mcp-market-filter"]}>
            <input
              type="text"
              className={styles["search-bar"]}
              placeholder={Locale.Mcp.Search}
              autoFocus
              onInput={(e) => setSearchText(e.currentTarget.value)}
            />
          </div>

          <div className={styles["server-list"]}>{renderServerList()}</div>
        </div>

        {customServer && (
          <div className="modal-mask">
            <Modal
              title={Locale.Mcp.ConfigureServer}
              onClose={() => !isLoading && setCustomServer(undefined)}
              actions={[
                <IconButton
                  key="cancel"
                  text={Locale.UI.Cancel}
                  bordered
                  disabled={isLoading}
                  onClick={() => setCustomServer(undefined)}
                />,
                <IconButton
                  key="save"
                  text={Locale.Mcp.Save}
                  bordered
                  disabled={isLoading}
                  onClick={saveCustomServer}
                />,
              ]}
            >
              <List>
                <ListItem title={Locale.Mcp.Transport}>
                  <select
                    aria-label={Locale.Mcp.Transport}
                    value={customServer.type}
                    disabled={isLoading}
                    onChange={(event) =>
                      setCustomServer({
                        ...customServer,
                        type: event.target.value as "local" | "remote",
                      })
                    }
                  >
                    <option value="local">{Locale.Mcp.Local}</option>
                    <option value="remote">{Locale.Mcp.Remote}</option>
                  </select>
                </ListItem>
                {(customServer.type === "local"
                  ? ([
                      ["id", Locale.Mcp.ServerId],
                      ["command", Locale.Mcp.Command],
                      ["args", Locale.Mcp.Arguments],
                      ["env", Locale.Mcp.Environment],
                    ] as const)
                  : ([
                      ["id", Locale.Mcp.ServerId],
                      ["url", Locale.Mcp.Url],
                      ["headers", Locale.Mcp.Headers],
                    ] as const)
                ).map(([key, title]) => (
                  <ListItem key={key} title={title} vertical>
                    <input
                      className={styles["config-input"]}
                      aria-label={title}
                      value={customServer[key]}
                      disabled={
                        isLoading || (key === "id" && !!customServer.originalId)
                      }
                      onChange={(event) =>
                        setCustomServer({
                          ...customServer,
                          [key]: event.target.value,
                        })
                      }
                    />
                  </ListItem>
                ))}
              </List>
            </Modal>
          </div>
        )}

        {pastedConfig !== undefined && (
          <div className="modal-mask">
            <Modal
              title={Locale.Mcp.PasteJson}
              onClose={() => !isLoading && setPastedConfig(undefined)}
              actions={[
                <IconButton
                  key="cancel"
                  text={Locale.UI.Cancel}
                  bordered
                  onClick={() => setPastedConfig(undefined)}
                  disabled={isLoading}
                />,
                <IconButton
                  key="save"
                  text={Locale.UI.Confirm}
                  bordered
                  onClick={savePastedConfig}
                  disabled={isLoading}
                />,
              ]}
            >
              <List>
                <ListItem title={Locale.Mcp.PasteHelp} vertical>
                  <textarea
                    className={styles["config-input"]}
                    aria-label={Locale.Mcp.PasteJson}
                    rows={10}
                    value={pastedConfig}
                    onChange={(e) => setPastedConfig(e.target.value)}
                  />
                </ListItem>
              </List>
            </Modal>
          </div>
        )}

        {/*编辑服务器配置*/}
        {editingServerId && (
          <div className="modal-mask">
            <Modal
              title={Locale.Mcp.ConfigureTitle(editingServerId)}
              onClose={() => !isLoading && setEditingServerId(undefined)}
              actions={[
                <IconButton
                  key="cancel"
                  text={Locale.UI.Cancel}
                  onClick={() => setEditingServerId(undefined)}
                  bordered
                  disabled={isLoading}
                />,
                <IconButton
                  key="confirm"
                  text={Locale.Mcp.Save}
                  type="primary"
                  onClick={saveServerConfig}
                  bordered
                  disabled={isLoading}
                />,
              ]}
            >
              <List>{renderConfigForm()}</List>
            </Modal>
          </div>
        )}

        {viewingServerId && (
          <div className="modal-mask">
            <Modal
              title={Locale.Mcp.ServerDetails(viewingServerId)}
              onClose={() => setViewingServerId(undefined)}
              actions={[
                <IconButton
                  key="close"
                  text={Locale.UI.Close}
                  onClick={() => setViewingServerId(undefined)}
                  bordered
                />,
              ]}
            >
              {config?.mcpServers[viewingServerId] &&
                isRemoteServer(config.mcpServers[viewingServerId]) && (
                  <List>
                    <ListItem
                      title={Locale.Mcp.Url}
                      subTitle={config.mcpServers[viewingServerId].url}
                    />
                    <ListItem
                      title={Locale.Mcp.HeaderNames}
                      subTitle={Object.keys(
                        config.mcpServers[viewingServerId].headers ?? {},
                      ).join(", ")}
                    />
                  </List>
                )}
              <div className={styles["tools-list"]}>
                {isLoading ? (
                  <div>{Locale.Mcp.LoadingTools}</div>
                ) : tools?.tools ? (
                  tools.tools.map(
                    (tool: ListToolsResponse["tools"], index: number) => (
                      <div key={index} className={styles["tool-item"]}>
                        <div className={styles["tool-name"]}>{tool.name}</div>
                        <div className={styles["tool-description"]}>
                          {tool.description}
                        </div>
                      </div>
                    ),
                  )
                ) : (
                  <div>{Locale.Mcp.NoTools}</div>
                )}
              </div>
            </Modal>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}
