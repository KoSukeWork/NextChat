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
import { ListItem, Select } from "./ui-lib";
import styles from "./request-plugins.module.scss";
import { managedServices } from "../request-plugins/managed-services";
import type { ServiceLease } from "../request-plugins/service-lifecycle";
import { saveServiceExecutable } from "../request-plugins/local-services";

export function LocalServiceControl(props: {
  service: string;
  title: string;
  managed: boolean;
  onModeChange: (mode: "managed" | "external") => void;
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
  const editorLease = useRef<ServiceLease>();
  const onConnect = useRef(props.onConnect);
  onConnect.current = props.onConnect;
  useEffect(() => {
    active.current = true;
    generation.current++;
    let disposed = false;
    const refresh = async () => {
      if (pending.current || !props.managed) return;
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
      void editorLease.current?.release().catch(() => {});
      editorLease.current = undefined;
      clearInterval(interval);
    };
  }, [props.service, props.managed]);

  const run = async (action: "start" | "stop") => {
    if (pending.current) return;
    pending.current = true;
    const revision = ++generation.current;
    setBusy(true);
    setError("");
    try {
      let state: LocalServiceStatus;
      if (action === "start") {
        const lease = await managedServices.acquire(
          props.service,
          undefined,
          path,
        );
        if (!active.current || revision !== generation.current) {
          void lease.release().catch(() => {});
          return;
        }
        void editorLease.current?.release().catch(() => {});
        editorLease.current = lease;
        state = await localServiceAction("status", props.service);
      } else {
        await editorLease.current?.release();
        editorLease.current = undefined;
        state = await managedServices.stop(props.service);
      }
      if (!active.current || revision !== generation.current) return;
      setStatus(state);
      editingPath.current = false;
      setPath(state.executablePath);
      if (action === "start" && state.connection)
        onConnect.current(state.connection);
    } catch (error) {
      if (active.current && revision === generation.current)
        setError(
          error instanceof Error &&
            error.message === "Local service has active requests"
            ? labels.InUse
            : String(error),
        );
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  const savePath = async (value: string) => {
    try {
      await saveServiceExecutable(props.service, value);
      if (active.current) setError("");
    } catch (error) {
      if (active.current) setError(String(error));
    }
  };
  return (
    <>
      <ListItem
        className={styles.field}
        title={labels.Mode}
        subTitle={
          props.managed
            ? labels.AutomaticDescription
            : labels.ExternalDescription
        }
      >
        <Select
          aria-label={labels.Mode}
          value={props.managed ? "managed" : "external"}
          onChange={(event) =>
            props.onModeChange(
              event.currentTarget.value as "managed" | "external",
            )
          }
        >
          <option value="managed">{labels.Automatic}</option>
          <option value="external">{labels.External}</option>
        </Select>
      </ListItem>
      {props.managed && (
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
                  onBlur={() => {
                    if (editingPath.current) void savePath(path);
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
                        await savePath(selected);
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
      )}
    </>
  );
}
