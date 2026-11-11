import { useEffect, useRef, useState } from "react";
import Locale from "../locales";
import type {
  LocalServiceConnection,
  LocalServiceStatus,
} from "../request-plugins/local-services";
import {
  chooseServiceExecutable,
  localServiceAction,
} from "../request-plugins/local-services";
import { IconButton } from "./button";
import { ListItem } from "./ui-lib";
import styles from "./request-plugins.module.scss";

export function LocalServiceControl(props: {
  service: string;
  title: string;
  onConnect: (connection: LocalServiceConnection) => void;
}) {
  const labels = Locale.RequestPlugins.Service;
  const [status, setStatus] = useState<LocalServiceStatus>();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const editingPath = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const onConnect = useRef(props.onConnect);
  onConnect.current = props.onConnect;
  useEffect(() => {
    active.current = true;
    let disposed = false;
    const refresh = async () => {
      if (pending.current) return;
      const revision = ++generation.current;
      try {
        const state = await localServiceAction("status", props.service);
        if (disposed || revision !== generation.current || pending.current)
          return;
        setStatus(state);
        if (!editingPath.current) setPath(state.executablePath);
      } catch (error) {
        if (!disposed && revision === generation.current)
          setError(String(error));
      }
    };
    void refresh();
    const interval = setInterval(refresh, 3000);
    return () => {
      active.current = false;
      disposed = true;
      clearInterval(interval);
    };
  }, [props.service]);

  const run = async (action: "start" | "stop") => {
    if (pending.current) return;
    pending.current = true;
    generation.current++;
    setBusy(true);
    setError("");
    try {
      const state = await localServiceAction(action, props.service, path);
      if (!active.current) return;
      setStatus(state);
      editingPath.current = false;
      setPath(state.executablePath);
      if (action === "start" && state.connection)
        onConnect.current(state.connection);
    } catch (error) {
      if (active.current) setError(String(error));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <>
      <ListItem
        className={styles.row}
        title={props.title}
        subTitle={labels.Description}
      >
        <div className={styles.actions}>
          <span role="status" className={styles.status}>
            {status
              ? status.running
                ? labels.Running
                : status.available
                ? labels.Stopped
                : labels.Stopped
              : labels.Checking}
          </span>
          <IconButton
            text={status?.running ? labels.Connect : labels.Start}
            bordered
            disabled={busy || !status?.available}
            onClick={() => void run("start")}
          />
          {status?.running && (
            <IconButton
              text={labels.Stop}
              bordered
              disabled={busy}
              onClick={() => void run("stop")}
            />
          )}
        </div>
      </ListItem>
      {status?.canSelectExecutable && (
        <ListItem
          className={styles.field}
          title={labels.Executable}
          subTitle={labels.ExecutableHint}
        >
          <div className={styles.executable}>
            <input
              type="text"
              aria-label={labels.Executable}
              value={path}
              placeholder={labels.AutoDetect}
              disabled={busy || status.running}
              onChange={(event) => {
                editingPath.current = true;
                setPath(event.currentTarget.value);
              }}
            />
            <IconButton
              text={labels.Browse}
              bordered
              disabled={busy || status.running}
              onClick={async () => {
                try {
                  const selected = await chooseServiceExecutable();
                  if (selected && active.current) {
                    editingPath.current = true;
                    setPath(selected);
                  }
                } catch (error) {
                  if (active.current) setError(String(error));
                }
              }}
            />
          </div>
        </ListItem>
      )}
      {status?.connection?.url && (
        <ListItem
          title={labels.Connection}
          subTitle={
            <span className={styles.detail}>
              {status.connection.url}
              {status.connection.cliVersion
                ? ` · Claude Code ${status.connection.cliVersion}`
                : ""}
            </span>
          }
        />
      )}
      {(error || status?.error || (status && !status.available)) && (
        <ListItem
          title={labels.Error}
          subTitle={
            <span role="alert" className={styles.detail}>
              {error || status?.error || labels.Missing}
            </span>
          }
        />
      )}
    </>
  );
}
