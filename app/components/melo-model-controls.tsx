import { useCallback, useEffect, useState } from "react";
import Locale from "../locales";
import { meloClient, MeloModelStatus } from "../utils/melo-client";
import { IconButton } from "./button";
import { ListItem, showToast } from "./ui-lib";
import { meloErrorMessage } from "./tts-feedback";

export function MeloModelControls({ onStop }: { onStop: () => void }) {
  const text = Locale.Settings.TTS.Melo;
  const [status, setStatus] = useState<MeloModelStatus>();
  const [pending, setPending] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const accept = useCallback((next: MeloModelStatus) => {
    setStatus((current) =>
      current && current.revision > next.revision ? current : next,
    );
  }, []);
  useEffect(() => {
    let closed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await meloClient.subscribe((next) => {
        if (!closed) accept(next);
      });
      if (closed) {
        unlisten();
        return;
      }
      const next = await meloClient.status();
      if (!closed) accept(next);
    })().catch((error) => {
      if (!closed) setConnectionError(meloErrorMessage(error));
    });
    return () => {
      closed = true;
      unlisten?.();
    };
  }, [accept]);
  const run = async (action: () => Promise<MeloModelStatus | null | void>) => {
    setPending(true);
    try {
      const next = await action();
      if (next) accept(next);
    } catch (error) {
      showToast(meloErrorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const busy = status?.operationId != null;
  const percent = status
    ? Math.min(100, Math.floor((status.downloaded / status.total) * 100))
    : 0;
  const label =
    connectionError ??
    (!status
      ? text.Checking
      : status.phase === "ready"
      ? text.Ready((status.size / 1024 / 1024).toFixed(1))
      : status.phase === "downloading"
      ? text.Downloading(percent)
      : status.phase === "verifying"
      ? text.Verifying
      : status.phase === "deleting"
      ? text.Deleting
      : status.phase === "error"
      ? meloErrorMessage(status.error)
      : text.Missing);
  return (
    <>
      <ListItem title={text.Model} subTitle={text.Description}>
        <div aria-live="polite">
          <div role="status">{label}</div>
          {status?.phase === "downloading" && (
            <progress
              aria-label={text.Progress}
              value={status.downloaded}
              max={status.total}
            />
          )}
        </div>
      </ListItem>
      <ListItem title={text.Manage}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <IconButton
            text={text.Download}
            aria={text.Download}
            disabled={pending || busy || status?.phase === "ready"}
            onClick={() => void run(meloClient.download)}
            bordered
          />
          <IconButton
            text={text.Import}
            aria={text.Import}
            disabled={pending || busy || status?.phase === "ready"}
            onClick={() => void run(meloClient.importModel)}
            bordered
          />
          {busy && status.phase !== "deleting" && (
            <IconButton
              text={text.Cancel}
              aria={text.Cancel}
              disabled={pending}
              onClick={() =>
                void run(() => meloClient.cancelInstall(status.operationId!))
              }
              bordered
            />
          )}
          {!busy &&
            (status?.phase === "ready" || status?.phase === "error") && (
              <IconButton
                text={text.Delete}
                aria={text.Delete}
                disabled={pending}
                onClick={() => {
                  onStop();
                  void run(meloClient.deleteModel);
                }}
                bordered
              />
            )}
        </div>
      </ListItem>
    </>
  );
}
