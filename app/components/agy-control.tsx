import { useEffect, useRef, useState } from "react";
import Locale from "../locales";
import { chooseServiceExecutable } from "../request-plugins/local-services";
import { IconButton } from "./button";
import { ListItem } from "./ui-lib";
import styles from "./request-plugins.module.scss";

type Status = {
  executablePath: string;
  cliVersion?: string;
  requestTimeoutMs: number;
  error?: string;
};

export function AgyControl() {
  const labels = Locale.RequestPlugins.AgyService;
  const [path, setPath] = useState("");
  const [version, setVersion] = useState("");
  const [timeout, setTimeoutValue] = useState("0");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const revisions = useRef({ path: 0, timeout: 0 });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);
  const invoke = (command: string, args?: Record<string, unknown>) => {
    const snapshot = { ...revisions.current };
    const sequence = ++latest.current;
    queue.current = queue.current.then(async () => {
      try {
        const result: Status = await window.__TAURI__!.invoke(command, args);
        if (!mounted.current) return;
        if (revisions.current.path === snapshot.path) {
          setPath(result.executablePath);
          setVersion(result.cliVersion ?? "");
        }
        if (revisions.current.timeout === snapshot.timeout)
          setTimeoutValue(String(result.requestTimeoutMs / 60000));
        if (latest.current === sequence) setError(result.error ?? "");
      } catch (error) {
        if (mounted.current && latest.current === sequence)
          setError(String(error));
      }
    });
    return queue.current;
  };
  useEffect(() => {
    mounted.current = true;
    void invoke("agy_acp_status");
    return () => {
      mounted.current = false;
    };
  }, []);
  const saveTimeout = () => {
    const minutes = Number(timeout);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      setError(labels.InvalidTimeout);
      return;
    }
    void invoke("agy_acp_options", {
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
              void invoke("agy_acp_configure", { executablePath: path })
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
                await invoke("agy_acp_configure", { executablePath: selected });
              }
            }}
          />
        </div>
      </ListItem>
      <ListItem title={labels.Version} subTitle={version || "—"} />
      <ListItem title={labels.Login} subTitle={labels.LoginHint} />
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
          onBlur={saveTimeout}
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
