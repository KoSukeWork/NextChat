import { useState } from "react";
import { createRoot } from "react-dom/client";
import Locale from "../locales";
import { validateBackupPassword } from "../utils/backup-password";
import { IconButton } from "./button";
import { Modal } from "./ui-lib";
import styles from "./backup-dialog.module.scss";

function PasswordDialog(props: {
  mode: "export" | "import";
  retry: boolean;
  finish: (password: string | null) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState(
    props.retry ? Locale.Settings.Sync.BadPassword : "",
  );
  const submit = () => {
    const issue = validateBackupPassword(
      password,
      props.mode === "export" ? confirmation : undefined,
    );
    if (issue) {
      setError(
        issue === "empty"
          ? Locale.Settings.Sync.PasswordEmpty
          : Locale.Settings.Sync.PasswordMismatch,
      );
      return;
    }
    props.finish(password);
  };
  return (
    <Modal
      title={
        props.mode === "export"
          ? Locale.Settings.Sync.SetBackupPassword
          : Locale.Settings.Sync.EnterBackupPassword
      }
      onClose={() => props.finish(null)}
      actions={[
        <IconButton
          key="cancel"
          text={Locale.UI.Cancel}
          bordered
          onClick={() => props.finish(null)}
        />,
        <IconButton
          key="confirm"
          text={Locale.UI.Confirm}
          type="primary"
          bordered
          onClick={submit}
        />,
      ]}
    >
      {props.mode === "export" && <p>{Locale.Settings.Sync.PasswordWarning}</p>}
      <div
        className={styles.fields}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      >
        <label className={styles.field}>
          {Locale.Settings.Sync.Password}
          <input
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            aria-label={Locale.Settings.Sync.Password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
        </label>
        {props.mode === "export" && (
          <label className={styles.field}>
            {Locale.Settings.Sync.ConfirmPassword}
            <input
              type="password"
              autoComplete="new-password"
              value={confirmation}
              aria-label={Locale.Settings.Sync.ConfirmPassword}
              onChange={(event) => setConfirmation(event.currentTarget.value)}
            />
          </label>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </Modal>
  );
}

export function showBackupPassword(mode: "export" | "import", retry = false) {
  const container = document.createElement("div");
  container.className = "modal-mask";
  document.body.appendChild(container);
  const root = createRoot(container);
  return new Promise<string | null>((resolve) => {
    const finish = (password: string | null) => {
      root.unmount();
      container.remove();
      resolve(password);
    };
    root.render(<PasswordDialog mode={mode} retry={retry} finish={finish} />);
  });
}

/** Indeterminate status stays visible while the worker processes large backups. */
export function showBackupProgress(message: string) {
  const container = document.createElement("div");
  container.className = "modal-mask";
  container.setAttribute("role", "status");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    <Modal title={Locale.Settings.Sync.BackupWorking}>{message}</Modal>,
  );
  return () => {
    root.unmount();
    container.remove();
  };
}
