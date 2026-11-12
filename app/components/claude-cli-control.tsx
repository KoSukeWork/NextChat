import { useEffect, useRef, useState } from "react";
import Locale from "../locales";
import { chooseServiceExecutable } from "../request-plugins/local-services";
import { IconButton } from "./button";
import { ListItem } from "./ui-lib";
import styles from "./request-plugins.module.scss";

type Status = {
  executablePath: string;
  cliVersion?: string;
  allowedTools: string;
  requestTimeoutMs: number;
  error?: string;
};

export function ClaudeCliControl() {
  const labels = Locale.RequestPlugins.Service;
  const [path, setPath] = useState("");
  const [version, setVersion] = useState("");
  const [tools, setTools] = useState("Read,Glob,Grep");
  const [timeout, setTimeoutValue] = useState("0");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const revisions = useRef({ path: 0, tools: 0, timeout: 0 });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);
  const apply = (
    status: Status,
    snapshot: typeof revisions.current,
    sequence: number,
  ) => {
    if (!mounted.current) return;
    if (revisions.current.path === snapshot.path) {
      setPath(status.executablePath);
      setVersion(status.cliVersion ?? "");
    }
    if (revisions.current.tools === snapshot.tools)
      setTools(status.allowedTools);
    if (revisions.current.timeout === snapshot.timeout)
      setTimeoutValue(String(status.requestTimeoutMs / 60000));
    if (latest.current === sequence) setError(status.error ?? "");
  };
  const invoke = (command: string, args?: Record<string, unknown>) => {
    const snapshot = { ...revisions.current };
    const sequence = ++latest.current;
    queue.current = queue.current.then(async () => {
      try {
        apply(
          await window.__TAURI__!.invoke(command, args),
          snapshot,
          sequence,
        );
      } catch (error) {
        if (mounted.current && latest.current === sequence)
          setError(String(error));
      }
    });
    return queue.current;
  };
  useEffect(() => {
    mounted.current = true;
    void invoke("claude_cli_status");
    return () => {
      mounted.current = false;
    };
  }, []);
  const saveOptions = () => {
    const minutes = Number(timeout);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      setError(labels.InvalidTimeout);
      return;
    }
    void invoke("claude_cli_options", {
      allowedTools: tools,
      requestTimeoutMs: Math.round(minutes * 60000),
    });
  };
  return (
    <>
      <ListItem
        className={styles.field}
        title={labels.Executable}
        subTitle={labels.ExecutableHint}
      >
        <div className={styles.executable}>
          <input
            aria-label={labels.Executable}
            value={path}
            placeholder={labels.AutoDetect}
            onChange={(event) => {
              revisions.current.path++;
              setPath(event.currentTarget.value);
            }}
            onBlur={() =>
              void invoke("claude_cli_configure", { executablePath: path })
            }
          />
          <IconButton
            text={labels.Browse}
            bordered
            onClick={async () => {
              const selected = await chooseServiceExecutable();
              if (selected) {
                revisions.current.path++;
                setPath(selected);
                await invoke("claude_cli_configure", {
                  executablePath: selected,
                });
              }
            }}
          />
        </div>
      </ListItem>
      <ListItem title={labels.Version} subTitle={version || "—"} />
      <ListItem
        className={styles.field}
        title={labels.AllowedTools}
        subTitle={labels.AllowedToolsHint}
      >
        <input
          aria-label={labels.AllowedTools}
          value={tools}
          onChange={(event) => {
            revisions.current.tools++;
            setTools(event.currentTarget.value);
          }}
          onBlur={saveOptions}
        />
      </ListItem>
      <ListItem
        className={styles.field}
        title={labels.Timeout}
        subTitle={labels.TimeoutHint}
      >
        <input
          type="number"
          min={0}
          max={1440}
          aria-label={labels.Timeout}
          value={timeout}
          onChange={(event) => {
            revisions.current.timeout++;
            setTimeoutValue(event.currentTarget.value);
          }}
          onBlur={saveOptions}
        />
      </ListItem>
      {error && (
        <ListItem
          title={labels.Error}
          subTitle={
            <span role="alert" className={styles.detail}>
              {error}
            </span>
          }
        />
      )}
    </>
  );
}
