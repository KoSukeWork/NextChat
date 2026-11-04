import { useEffect } from "react";
import ConfirmIcon from "../icons/confirm.svg";
import Locale from "../locales";
import { useShortcutKey } from "../store/shortcut-key";
import { IconButton } from "./button";
import { Modal } from "./ui-lib";
import styles from "./chat.module.scss";

export function ShortcutKeyModal() {
  const { open, setOpen } = useShortcutKey();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        useShortcutKey.getState().setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!open) return null;

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const shortcuts = [
    {
      title: Locale.Chat.ShortcutKey.newChat,
      keys: isMac ? ["⌘", "Shift", "O"] : ["Ctrl", "Shift", "O"],
    },
    { title: Locale.Chat.ShortcutKey.focusInput, keys: ["Shift", "Esc"] },
    {
      title: Locale.Chat.ShortcutKey.copyLastCode,
      keys: isMac ? ["⌘", "Shift", ";"] : ["Ctrl", "Shift", ";"],
    },
    {
      title: Locale.Chat.ShortcutKey.copyLastMessage,
      keys: isMac ? ["⌘", "Shift", "C"] : ["Ctrl", "Shift", "C"],
    },
    {
      title: Locale.Chat.ShortcutKey.showShortcutKey,
      keys: isMac ? ["⌘", "/"] : ["Ctrl", "/"],
    },
    {
      title: Locale.Chat.ShortcutKey.search,
      keys: isMac ? ["⌘", "K"] : ["Ctrl", "K"],
    },
    {
      title: Locale.Chat.ShortcutKey.clearContext,
      keys: isMac
        ? ["⌘", "Shift", "backspace"]
        : ["Ctrl", "Shift", "backspace"],
    },
  ];
  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.ShortcutKey.Title}
        onClose={() => setOpen(false)}
        actions={[
          <IconButton
            type="primary"
            text={Locale.UI.Confirm}
            icon={<ConfirmIcon />}
            key="ok"
            onClick={() => setOpen(false)}
          />,
        ]}
      >
        <div className={styles["shortcut-key-container"]}>
          <div className={styles["shortcut-key-grid"]}>
            {shortcuts.map((shortcut, index) => (
              <div key={index} className={styles["shortcut-key-item"]}>
                <div className={styles["shortcut-key-title"]}>
                  {shortcut.title}
                </div>
                <div className={styles["shortcut-key-keys"]}>
                  {shortcut.keys.map((key, i) => (
                    <div key={i} className={styles["shortcut-key"]}>
                      <span>{key}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
