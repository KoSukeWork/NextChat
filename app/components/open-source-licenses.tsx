import { useState } from "react";
import { getClientConfig } from "../config/client";
import Locale from "../locales";
import { IconButton } from "./button";
import { ListItem, Modal, showToast } from "./ui-lib";
import styles from "./settings.module.scss";

export function OpenSourceLicenses() {
  const [content, setContent] = useState<string>();
  const [loading, setLoading] = useState(false);
  if (!getClientConfig()?.isApp) return null;
  const title = Locale.Settings.OpenSourceLicenses;
  return (
    <>
      <ListItem title={title}>
        <IconButton
          text={Locale.Settings.ViewLicenses}
          bordered
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              const text = await window.__TAURI__!.invoke("bundled_licenses");
              setContent(text);
            } catch (error) {
              showToast(String(error));
            } finally {
              setLoading(false);
            }
          }}
        />
      </ListItem>
      {content !== undefined && (
        <div className="modal-mask">
          <Modal title={title} onClose={() => setContent(undefined)}>
            <pre className={styles["license-notices"]}>{content}</pre>
          </Modal>
        </div>
      )}
    </>
  );
}
