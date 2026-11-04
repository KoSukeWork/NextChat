import { useSyncExternalStore } from "react";
import { ChatControllerPool } from "../client/controller";
import SendIcon from "../icons/send-white.svg";
import StopIcon from "../icons/pause.svg";
import Locale from "../locales";
import { IconButton } from "./button";
import styles from "./chat.module.scss";

export function ChatInputControls(props: {
  sessionId: string;
  input: string;
  hasImages: boolean;
  uploading: boolean;
  onSend: () => void;
}) {
  useSyncExternalStore(
    ChatControllerPool.subscribe,
    ChatControllerPool.getSnapshot,
    ChatControllerPool.getSnapshot,
  );
  const showStop =
    ChatControllerPool.hasPending(props.sessionId) &&
    !props.input.trim() &&
    !props.hasImages &&
    !props.uploading;
  const action = showStop ? Locale.Chat.InputActions.Stop : Locale.Chat.Send;

  return (
    <IconButton
      aria={action}
      title={action}
      icon={showStop ? <StopIcon /> : <SendIcon />}
      text={action}
      className={`${styles["chat-input-send"]} ${
        showStop ? styles["chat-input-stop"] : ""
      }`}
      type="primary"
      disabled={props.uploading}
      onClick={
        showStop
          ? () => ChatControllerPool.stopSession(props.sessionId)
          : props.onSend
      }
    />
  );
}
