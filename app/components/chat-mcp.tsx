import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Path } from "../constant";
import Locale from "../locales";
import {
  getClientsStatus,
  getMcpConfigFromFile,
  isMcpEnabled,
} from "../mcp/actions";
import { localizedMcpError } from "../mcp/error-message";
import type { ServerStatusResponse } from "../mcp/types";
import { useAccessStore, useChatStore } from "../store";
import type { ChatSession } from "../store/chat";
import { Selector, showToast } from "./ui-lib";

type ServerItem = {
  id: string;
  paused: boolean;
  status?: ServerStatusResponse;
};

function statusText(item: ServerItem) {
  if (item.paused) return Locale.Mcp.StoppedForAllChats;
  switch (item.status?.status) {
    case "active":
      return Locale.Mcp.Running;
    case "initializing":
      return Locale.Mcp.Initializing;
    case "login-required":
      return Locale.Mcp.LoginRequired;
    case "oauth-unsupported":
      return Locale.Mcp.OAuthUnsupportedShort;
    case "error":
      return item.status.errorMsg
        ? `${Locale.Mcp.Error}${Locale.Mcp.ErrorSeparator}${localizedMcpError(
            item.status.errorMsg,
          )}`
        : Locale.Mcp.Error;
    default:
      return Locale.Mcp.StatusUnknown;
  }
}

/** A selector belongs to the conversation that opened it, even across awaits. */
export function useChatMcpSelector() {
  const navigate = useNavigate();
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const [enabled, setEnabled] = useState(false);
  const [dialog, setDialog] = useState<{
    session: ChatSession;
    items: ServerItem[];
    selected: string[];
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    void isMcpEnabled()
      .then((value) => {
        if (mounted) setEnabled(value);
      })
      .catch(() => {
        if (mounted) setEnabled(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => setDialog(null), [session.id]);

  const open = async () => {
    const target = session;
    const accessCode = useAccessStore.getState().accessCode;
    try {
      const [config, statuses] = await Promise.all([
        getMcpConfigFromFile(accessCode),
        getClientsStatus(accessCode),
      ]);
      const store = useChatStore.getState();
      if (store.currentSession().id !== target.id) return;
      const current = store.sessions.find((item) => item.id === target.id);
      if (!current) return;
      const items = Object.entries(config.mcpServers).map(([id, server]) => ({
        id,
        paused: server.status === "paused" || statuses[id]?.status === "paused",
        status: statuses[id],
      }));
      if (!items.length) {
        navigate(Path.McpMarket);
        return;
      }
      const disabled = new Set(current.mask.mcpDisabled ?? []);
      setDialog({
        session: current,
        items,
        selected: items
          .filter((item) => !item.paused && !disabled.has(item.id))
          .map((item) => item.id),
      });
    } catch (error) {
      showToast(localizedMcpError(error, Locale.Mcp.LoadStateFailed));
    }
  };

  const selector = dialog && (
    <Selector
      multiple
      defaultSelectedValue={dialog.selected}
      items={dialog.items.map((item) => ({
        title: item.id,
        value: item.id,
        subTitle: statusText(item),
        disable: item.paused,
      }))}
      onClose={() => setDialog(null)}
      onSelection={(selected) => {
        const editable = dialog.items
          .filter((item) => !item.paused)
          .map((item) => item.id);
        const editableIds = new Set(editable);
        const selectedIds = new Set(selected);
        chatStore.updateTargetSession(dialog.session, (target) => {
          target.mask.mcpDisabled = [
            ...(target.mask.mcpDisabled ?? []).filter(
              (id) => !editableIds.has(id),
            ),
            ...editable.filter((id) => !selectedIds.has(id)),
          ];
        });
      }}
    />
  );
  return { enabled, open, selector };
}
