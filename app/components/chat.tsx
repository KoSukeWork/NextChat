import { getUnauthorizedMessage } from "@/app/utils/auth-message";
import { useScrollToBottom } from "../utils/use-scroll-to-bottom";
import { useDebouncedCallback } from "use-debounce";
import React, {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import BrainIcon from "../icons/brain.svg";
import RenameIcon from "../icons/rename.svg";
import EditIcon from "../icons/rename.svg";
import ExportIcon from "../icons/share.svg";
import ReturnIcon from "../icons/return.svg";
import ArchiveIcon from "../icons/archive.svg";
import CopyIcon from "../icons/copy.svg";
import SpeakIcon from "../icons/speak.svg";
import SpeakStopIcon from "../icons/speak-stop.svg";
import LoadingIcon from "../icons/three-dots.svg";
import LoadingButtonIcon from "../icons/loading.svg";
import MaxIcon from "../icons/max.svg";
import MinIcon from "../icons/min.svg";
import ResetIcon from "../icons/reload.svg";
import ReloadIcon from "../icons/reload.svg";
import BreakIcon from "../icons/break.svg";
import DeleteIcon from "../icons/clear.svg";
import PinIcon from "../icons/pin.svg";
import SessionPinIcon from "../icons/pin-upright.svg";
import ConfirmIcon from "../icons/confirm.svg";
import CancelIcon from "../icons/cancel.svg";

import BottomIcon from "../icons/bottom.svg";
import StopIcon from "../icons/pause.svg";
import RobotIcon from "../icons/robot.svg";
import PluginIcon from "../icons/plugin.svg";
import {
  BOT_HELLO,
  ChatMessage,
  createMessage,
  DEFAULT_TOPIC,
  SubmitKey,
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
} from "../store";

import {
  autoGrowTextArea,
  copyToClipboard,
  getMessageImages,
  getMessageTextContent,
  getMessageTextContentForContext,
  safeLocalStorage,
  useMobileScreen,
  selectOrCopy,
} from "../utils";

import { uploadImage as uploadImageRemote } from "@/app/utils/chat";

import dynamic from "next/dynamic";

import { ChatControllerPool } from "../client/controller";
import { Prompt, usePromptStore } from "../store/prompt";
import Locale from "../locales";

import { IconButton } from "./button";
import { ChatInputControls } from "./chat-input-controls";
import styles from "./chat.module.scss";

import {
  List,
  ListItem,
  Modal,
  Selector,
  showConfirm,
  showPrompt,
  showToast,
} from "./ui-lib";
import { useNavigate } from "react-router-dom";
import { useSearchJump } from "../store/search-jump";
import {
  CHAT_PAGE_SIZE,
  Path,
  REQUEST_TIMEOUT_MS,
  UNFINISHED_INPUT,
} from "../constant";
import { Avatar } from "./emoji";
import { ContextPrompts, MaskAvatar, MaskConfig } from "./mask";
import { useMaskStore } from "../store/mask";
import { ChatCommandPrefix, useChatCommand, useCommand } from "../command";
import { prettyObject } from "../utils/format";
import { ExportMessageModal } from "./exporter";
import { getClientConfig } from "../config/client";
import { useAllModels } from "../utils/hooks";
import { MultimodalContent } from "../client/api";
import { speak, stop } from "../utils/local-tts";
import { useLocalTTS } from "../utils/use-local-tts";
import { showSpeechFallback } from "./tts-feedback";
import { ToolCard } from "./tool-card";
import { ThinkingBlock } from "./thinking";
import { parseLegacyMcpResponse, splitLegacyMcpCalls } from "../mcp/utils";
import { parseThinking } from "../utils/thinking";

import clsx from "clsx";

const localStorage = safeLocalStorage();

const Markdown = dynamic(async () => (await import("./markdown")).Markdown, {
  loading: () => <LoadingIcon />,
});

export function SessionConfigModel(props: { onClose: () => void }) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const maskStore = useMaskStore();
  const navigate = useNavigate();

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Context.Edit}
        onClose={() => props.onClose()}
        actions={[
          <IconButton
            key="reset"
            icon={<ResetIcon />}
            bordered
            text={Locale.Chat.Config.Reset}
            onClick={async () => {
              if (await showConfirm(Locale.Memory.ResetConfirm)) {
                chatStore.updateTargetSession(
                  session,
                  (session) => (session.memoryPrompt = ""),
                );
              }
            }}
          />,
          <IconButton
            key="copy"
            icon={<CopyIcon />}
            bordered
            text={Locale.Chat.Config.SaveAs}
            onClick={() => {
              navigate(Path.Masks);
              setTimeout(() => {
                maskStore.create(session.mask);
              }, 500);
            }}
          />,
        ]}
      >
        <MaskConfig
          mask={session.mask}
          updateMask={(updater) => {
            const mask = { ...session.mask };
            updater(mask);
            chatStore.updateTargetSession(
              session,
              (session) => (session.mask = mask),
            );
          }}
          shouldSyncFromGlobal
          extraListItems={
            session.mask.modelConfig.sendMemory ? (
              <ListItem
                className="copyable"
                title={`${Locale.Memory.Title} (${session.lastSummarizeIndex} of ${session.messages.length})`}
                subTitle={session.memoryPrompt || Locale.Memory.EmptyContent}
              ></ListItem>
            ) : (
              <></>
            )
          }
        ></MaskConfig>
      </Modal>
    </div>
  );
}

function PromptToast(props: {
  showToast?: boolean;
  showModal?: boolean;
  setShowModal: (_: boolean) => void;
}) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const context = session.mask.context;

  return (
    <div className={styles["prompt-toast"]} key="prompt-toast">
      {props.showToast && context.length > 0 && (
        <div
          className={clsx(styles["prompt-toast-inner"], "clickable")}
          role="button"
          onClick={() => props.setShowModal(true)}
        >
          <BrainIcon />
          <span className={styles["prompt-toast-content"]}>
            {Locale.Context.Toast(context.length)}
          </span>
        </div>
      )}
      {props.showModal && (
        <SessionConfigModel onClose={() => props.setShowModal(false)} />
      )}
    </div>
  );
}

function useSubmitHandler() {
  const config = useAppConfig();
  const submitKey = config.submitKey;
  const isComposing = useRef(false);

  useEffect(() => {
    const onCompositionStart = () => {
      isComposing.current = true;
    };
    const onCompositionEnd = () => {
      isComposing.current = false;
    };

    window.addEventListener("compositionstart", onCompositionStart);
    window.addEventListener("compositionend", onCompositionEnd);

    return () => {
      window.removeEventListener("compositionstart", onCompositionStart);
      window.removeEventListener("compositionend", onCompositionEnd);
    };
  }, []);

  const shouldSubmit = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Fix Chinese input method "Enter" on Safari
    if (e.keyCode == 229) return false;
    if (e.key !== "Enter") return false;
    if (e.key === "Enter" && (e.nativeEvent.isComposing || isComposing.current))
      return false;
    return (
      (config.submitKey === SubmitKey.AltEnter && e.altKey) ||
      (config.submitKey === SubmitKey.CtrlEnter && e.ctrlKey) ||
      (config.submitKey === SubmitKey.ShiftEnter && e.shiftKey) ||
      (config.submitKey === SubmitKey.MetaEnter && e.metaKey) ||
      (config.submitKey === SubmitKey.Enter &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey)
    );
  };

  return {
    submitKey,
    shouldSubmit,
  };
}

export type RenderPrompt = Pick<Prompt, "title" | "content">;

export function PromptHints(props: {
  prompts: RenderPrompt[];
  onPromptSelect: (prompt: RenderPrompt) => void;
}) {
  const noPrompts = props.prompts.length === 0;
  const [selectIndex, setSelectIndex] = useState(0);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectIndex(0);
  }, [props.prompts.length]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (noPrompts || e.metaKey || e.altKey || e.ctrlKey) {
        return;
      }
      // arrow up / down to select prompt
      const changeIndex = (delta: number) => {
        e.stopPropagation();
        e.preventDefault();
        const nextIndex = Math.max(
          0,
          Math.min(props.prompts.length - 1, selectIndex + delta),
        );
        setSelectIndex(nextIndex);
        selectedRef.current?.scrollIntoView({
          block: "center",
        });
      };

      if (e.key === "ArrowUp") {
        changeIndex(1);
      } else if (e.key === "ArrowDown") {
        changeIndex(-1);
      } else if (e.key === "Enter") {
        const selectedPrompt = props.prompts.at(selectIndex);
        if (selectedPrompt) {
          props.onPromptSelect(selectedPrompt);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.prompts.length, selectIndex]);

  if (noPrompts) return null;
  return (
    <div className={styles["prompt-hints"]}>
      {props.prompts.map((prompt, i) => (
        <div
          ref={i === selectIndex ? selectedRef : null}
          className={clsx(styles["prompt-hint"], {
            [styles["prompt-hint-selected"]]: i === selectIndex,
          })}
          key={prompt.title + i.toString()}
          onClick={() => props.onPromptSelect(prompt)}
          onMouseEnter={() => setSelectIndex(i)}
        >
          <div className={styles["hint-title"]}>{prompt.title}</div>
          <div className={styles["hint-content"]}>{prompt.content}</div>
        </div>
      ))}
    </div>
  );
}

function ClearContextDivider() {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();

  return (
    <div
      className={styles["clear-context"]}
      onClick={() =>
        chatStore.updateTargetSession(
          session,
          (session) => (session.clearContextIndex = undefined),
        )
      }
    >
      <div className={styles["clear-context-tips"]}>{Locale.Context.Clear}</div>
      <div className={styles["clear-context-revert-btn"]}>
        {Locale.Context.Revert}
      </div>
    </div>
  );
}

export function ChatAction(props: {
  text: string;
  icon: JSX.Element;
  onClick: () => void;
}) {
  const iconRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState({
    full: 16,
    icon: 16,
  });

  function updateWidth() {
    if (!iconRef.current || !textRef.current) return;
    const getWidth = (dom: HTMLDivElement) => dom.getBoundingClientRect().width;
    const textWidth = getWidth(textRef.current);
    const iconWidth = getWidth(iconRef.current);
    setWidth({
      full: textWidth + iconWidth,
      icon: iconWidth,
    });
  }

  return (
    <div
      className={clsx(styles["chat-message-action"], "clickable")}
      onClick={() => {
        props.onClick();
        setTimeout(updateWidth, 1);
      }}
      onMouseEnter={updateWidth}
      onTouchStart={updateWidth}
      style={
        {
          "--icon-width": `${width.icon}px`,
          "--full-width": `${width.full}px`,
        } as React.CSSProperties
      }
    >
      <div ref={iconRef} className={styles["icon"]}>
        {props.icon}
      </div>
      <div className={styles["text"]} ref={textRef}>
        {props.text}
      </div>
    </div>
  );
}

function ChatInputOptions() {
  const navigate = useNavigate();
  const chatStore = useChatStore();
  const session = chatStore.currentSession();

  // switch model
  const currentModel = session.mask.modelConfig.model;
  const currentEndpointId = session.mask.modelConfig.endpointId ?? "";
  const models = useAllModels();
  const currentModelName = useMemo(() => {
    const model = models.find(
      (item) =>
        item.name === currentModel && item.endpointId === currentEndpointId,
    );
    return model?.displayName ?? Locale.ModelDiscovery.Unconfigured;
  }, [models, currentModel, currentEndpointId]);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const clearTitle =
    session.clearContextIndex === session.messages.length
      ? Locale.Context.Revert
      : Locale.Chat.InputActions.Clear;
  const modelTitle = `${Locale.Exporter.Model}: ${currentModelName}`;
  return (
    <>
      <div className={styles["chat-input-options"]}>
        <IconButton
          onClick={() =>
            models.length
              ? setShowModelSelector(true)
              : showToast(Locale.ModelDiscovery.ConfigureFirst, {
                  text: Locale.EndpointConfig.OpenSettings,
                  onClick: () => navigate(Path.Settings),
                })
          }
          icon={<RobotIcon />}
          title={modelTitle}
          aria={modelTitle}
          bordered
          className={styles["chat-model-select"]}
        />
        <IconButton
          title={clearTitle}
          aria={clearTitle}
          icon={<BreakIcon />}
          bordered
          className={styles["chat-clear-context"]}
          onClick={() => {
            chatStore.updateTargetSession(session, (target) => {
              if (target.clearContextIndex === target.messages.length) {
                target.clearContextIndex = undefined;
              } else {
                target.clearContextIndex = target.messages.length;
                target.memoryPrompt = ""; // will clear memory
              }
            });
          }}
        />
      </div>

      {showModelSelector && (
        <Selector
          layout="model"
          searchPlaceholder={Locale.ModelDiscovery.Search}
          defaultSelectedValue={JSON.stringify([
            currentEndpointId,
            currentModel,
          ])}
          items={models.map((model) => ({
            title: model.displayName,
            subTitle: model.endpointName,
            searchText: `${model.displayName} (${model.endpointName})  ${model.name}`,
            value: JSON.stringify([model.endpointId, model.name]),
          }))}
          onClose={() => setShowModelSelector(false)}
          onSelection={(selected) => {
            if (!selected.length) return;
            const [endpointId, model] = JSON.parse(selected[0]);
            chatStore.updateTargetSession(session, (target) => {
              target.mask.modelConfig.model = model;
              target.mask.modelConfig.endpointId = endpointId;
              target.mask.syncGlobalConfig = false;
            });
            showToast(model);
          }}
        />
      )}
    </>
  );
}

function ChatPluginAction() {
  const navigate = useNavigate();
  const chatStore = useChatStore();
  const pluginStore = usePluginStore();
  const session = chatStore.currentSession();
  const [showPluginSelector, setShowPluginSelector] = useState(false);
  return (
    <>
      <div className="window-action-button">
        <IconButton
          onClick={() => {
            if (pluginStore.getAll().length === 0) {
              navigate(Path.Plugins);
            } else {
              setShowPluginSelector(true);
            }
          }}
          title={Locale.Plugin.Name}
          aria={Locale.Plugin.Name}
          icon={<PluginIcon />}
          bordered
        />
      </div>
      {showPluginSelector && (
        <Selector
          multiple
          defaultSelectedValue={session.mask?.plugin}
          items={pluginStore.getAll().map((item) => ({
            title: `${item?.title}@${item?.version}`,
            value: item?.id,
          }))}
          onClose={() => setShowPluginSelector(false)}
          onSelection={(selected) => {
            chatStore.updateTargetSession(session, (target) => {
              target.mask.plugin = selected as string[];
            });
          }}
        />
      )}
    </>
  );
}

export function EditMessageModal(props: { onClose: () => void }) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const [messages, setMessages] = useState(session.messages.slice());

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.EditMessage.Title}
        onClose={props.onClose}
        actions={[
          <IconButton
            text={Locale.UI.Cancel}
            icon={<CancelIcon />}
            key="cancel"
            onClick={() => {
              props.onClose();
            }}
          />,
          <IconButton
            type="primary"
            text={Locale.UI.Confirm}
            icon={<ConfirmIcon />}
            key="ok"
            onClick={() => {
              chatStore.updateTargetSession(
                session,
                (session) => (session.messages = messages),
              );
              props.onClose();
            }}
          />,
        ]}
      >
        <List>
          <ListItem
            title={Locale.Chat.EditMessage.Topic.Title}
            subTitle={Locale.Chat.EditMessage.Topic.SubTitle}
          >
            <input
              type="text"
              value={session.topic}
              onInput={(e) =>
                chatStore.updateTargetSession(
                  session,
                  (session) => (session.topic = e.currentTarget.value),
                )
              }
            ></input>
          </ListItem>
        </List>
        <ContextPrompts
          context={messages}
          updateContext={(updater) => {
            const newMessages = messages.slice();
            updater(newMessages);
            setMessages(newMessages);
          }}
        />
      </Modal>
    </div>
  );
}

export function DeleteImageButton(props: { deleteImage: () => void }) {
  return (
    <div className={styles["delete-image"]} onClick={props.deleteImage}>
      <DeleteIcon />
    </div>
  );
}

function _Chat() {
  type RenderMessage = ChatMessage & { preview?: boolean };

  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const config = useAppConfig();
  const jumpRequest = useSearchJump((state) => state.request);
  const jumpToMessageId =
    jumpRequest?.sessionId === session.id ? jumpRequest.messageId : undefined;
  const [scrollTargetId, setScrollTargetId] = useState<string>();
  const [highlightMessageId, setHighlightMessageId] = useState<string>();
  const fontSize = config.fontSize;
  const fontFamily = config.fontFamily;

  const [showExport, setShowExport] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingImageUploads = useRef(0);
  const [userInput, setUserInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { submitKey, shouldSubmit } = useSubmitHandler();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isScrolledToBottom = scrollRef?.current
    ? Math.abs(
        scrollRef.current.scrollHeight -
          (scrollRef.current.scrollTop + scrollRef.current.clientHeight),
      ) <= 1
    : false;
  const isAttachWithTop = useMemo(() => {
    const lastMessage = scrollRef.current?.lastElementChild as HTMLElement;
    // if scrolllRef is not ready or no message, return false
    if (!scrollRef?.current || !lastMessage) return false;
    const topDistance =
      lastMessage!.getBoundingClientRect().top -
      scrollRef.current.getBoundingClientRect().top;
    // leave some space for user question
    return topDistance < 100;
  }, [scrollRef?.current?.scrollHeight]);

  const isTyping = userInput !== "";

  // if user is typing, should auto scroll to bottom
  // if user is not typing, should auto scroll to bottom only if already at bottom
  const { setAutoScroll, scrollDomToBottom, cancelPendingScroll } =
    useScrollToBottom(
      scrollRef,
      (isScrolledToBottom || isAttachWithTop) && !isTyping,
      session.messages,
      !!jumpToMessageId || !!scrollTargetId,
    );
  const [hitBottom, setHitBottom] = useState(true);
  useEffect(() => setHitBottom(true), [session.id]);
  const isMobileScreen = useMobileScreen();
  const navigate = useNavigate();
  const [attachImages, setAttachImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  // prompt hints
  const promptStore = usePromptStore();
  const [promptHints, setPromptHints] = useState<RenderPrompt[]>([]);
  const onSearch = useDebouncedCallback(
    (text: string) => {
      const matchedPrompts = promptStore.search(text);
      setPromptHints(matchedPrompts);
    },
    100,
    { leading: true, trailing: true },
  );

  // auto grow input
  const [inputRows, setInputRows] = useState(2);
  const measure = useDebouncedCallback(
    () => {
      const rows = inputRef.current ? autoGrowTextArea(inputRef.current) : 1;
      const inputRows = Math.min(
        20,
        Math.max(2 + Number(!isMobileScreen), rows),
      );
      setInputRows(inputRows);
    },
    100,
    {
      leading: true,
      trailing: true,
    },
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(measure, [userInput]);

  // chat commands shortcuts
  const chatCommands = useChatCommand({
    new: () => chatStore.newSession(),
    newm: () => navigate(Path.NewChat),
    prev: () => chatStore.nextSession(-1),
    next: () => chatStore.nextSession(1),
    clear: () =>
      chatStore.updateTargetSession(
        session,
        (session) => (session.clearContextIndex = session.messages.length),
      ),
    fork: () => chatStore.forkSession(),
    del: () => chatStore.deleteSession(chatStore.currentSessionIndex),
  });

  // only search prompts when user input is short
  const SEARCH_TEXT_LIMIT = 30;
  const onInput = (text: string) => {
    setUserInput(text);
    const n = text.trim().length;

    // clear search results
    if (n === 0) {
      setPromptHints([]);
    } else if (text.match(ChatCommandPrefix)) {
      setPromptHints(chatCommands.search(text));
    } else if (!config.disablePromptHint && n < SEARCH_TEXT_LIMIT) {
      // check if need to trigger auto completion
      if (text.startsWith("/")) {
        let searchText = text.slice(1);
        onSearch(searchText);
      }
    }
  };

  const doSubmit = (userInput: string) => {
    if (pendingImageUploads.current > 0) return;
    if (userInput.trim() === "" && attachImages.length === 0) return;
    const matchCommand = chatCommands.match(userInput);
    if (matchCommand.matched) {
      setUserInput("");
      setPromptHints([]);
      matchCommand.invoke();
      return;
    }
    if (!chatStore.ensureSessionModel()) return;
    setIsLoading(true);
    chatStore
      .onUserInput(userInput, attachImages)
      .then(() => setIsLoading(false));
    setAttachImages([]);
    chatStore.setLastInput(userInput);
    setUserInput("");
    setPromptHints([]);
    if (!isMobileScreen) inputRef.current?.focus();
    setAutoScroll(true);
  };

  const onPromptSelect = (prompt: RenderPrompt) => {
    setTimeout(() => {
      setPromptHints([]);

      const matchedChatCommand = chatCommands.match(prompt.content);
      if (matchedChatCommand.matched) {
        // if user is selecting a chat command, just trigger it
        matchedChatCommand.invoke();
        setUserInput("");
      } else {
        // or fill the prompt
        setUserInput(prompt.content);
      }
      inputRef.current?.focus();
    }, 30);
  };

  // stop response
  const onUserStop = (messageId: string) => {
    ChatControllerPool.stop(session.id, messageId);
  };

  useEffect(() => {
    chatStore.updateTargetSession(session, (session) => {
      const stopTiming = Date.now() - REQUEST_TIMEOUT_MS;
      session.messages.forEach((m) => {
        // check if should stop all stale messages
        if (m.isError || new Date(m.date).getTime() < stopTiming) {
          if (m.streaming) {
            m.streaming = false;
          }

          if (m.content.length === 0) {
            m.isError = true;
            m.content = prettyObject({
              error: true,
              message: "empty response",
            });
          }
        }
      });

      // auto sync mask config from global config
      if (session.mask.syncGlobalConfig) {
        console.log("[Mask] syncing from global, name = ", session.mask.name);
        session.mask.modelConfig = { ...config.modelConfig };
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // check if should send message
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // if ArrowUp and no userInput, fill with last input
    if (
      e.key === "ArrowUp" &&
      userInput.length <= 0 &&
      !(e.metaKey || e.altKey || e.ctrlKey)
    ) {
      setUserInput(chatStore.lastInput ?? "");
      e.preventDefault();
      return;
    }
    if (shouldSubmit(e) && promptHints.length === 0) {
      doSubmit(userInput);
      e.preventDefault();
    }
  };
  const onRightClick = (e: any, message: ChatMessage) => {
    // copy to clipboard
    if (
      selectOrCopy(e.currentTarget, getMessageTextContentForContext(message))
    ) {
      if (userInput.length === 0) {
        setUserInput(getMessageTextContentForContext(message));
      }

      e.preventDefault();
    }
  };

  const deleteMessage = (msgId?: string) => {
    chatStore.updateTargetSession(
      session,
      (session) =>
        (session.messages = session.messages.filter((m) => m.id !== msgId)),
    );
  };

  const onDelete = (msgId: string) => {
    deleteMessage(msgId);
  };

  const onResend = (message: ChatMessage) => {
    // when it is resending a message
    // 1. for a user's message, find the next bot response
    // 2. for a bot's message, find the last user's input
    // 3. delete original user input and bot's message
    // 4. resend the user's input

    const resendingIndex = session.messages.findIndex(
      (m) => m.id === message.id,
    );

    if (resendingIndex < 0 || resendingIndex >= session.messages.length) {
      console.error("[Chat] failed to find resending message", message);
      return;
    }

    let userMessage: ChatMessage | undefined;
    let botMessage: ChatMessage | undefined;

    if (message.role === "assistant") {
      // if it is resending a bot's message, find the user input for it
      botMessage = message;
      for (let i = resendingIndex; i >= 0; i -= 1) {
        if (session.messages[i].role === "user") {
          userMessage = session.messages[i];
          break;
        }
      }
    } else if (message.role === "user") {
      // if it is resending a user's input, find the bot's response
      userMessage = message;
      for (let i = resendingIndex; i < session.messages.length; i += 1) {
        if (session.messages[i].role === "assistant") {
          botMessage = session.messages[i];
          break;
        }
      }
    }

    if (userMessage === undefined) {
      console.error("[Chat] failed to resend", message);
      return;
    }

    // delete the original messages
    if (!chatStore.ensureSessionModel()) return;
    deleteMessage(userMessage.id);
    deleteMessage(botMessage?.id);

    // resend the message
    setIsLoading(true);
    const textContent = getMessageTextContent(userMessage);
    const images = getMessageImages(userMessage);
    chatStore.onUserInput(textContent, images).then(() => setIsLoading(false));
    inputRef.current?.focus();
  };

  const onPinMessage = (message: ChatMessage) => {
    chatStore.updateTargetSession(session, (session) =>
      session.mask.context.push(message),
    );

    showToast(Locale.Chat.Actions.PinToastContent, {
      text: Locale.Chat.Actions.PinToastAction,
      onClick: () => {
        setShowPromptModal(true);
      },
    });
  };

  const accessStore = useAccessStore();
  const { supported: speechSupported } = useLocalTTS();
  const [speechMessageId, setSpeechMessageId] = useState<string>();
  const speechRequest = useRef(0);
  const currentSpeechId = useRef<string>();
  const speakMessage = useCallback(async (message: ChatMessage) => {
    const ticket = ++speechRequest.current;
    if (currentSpeechId.current === message.id) {
      stop();
      currentSpeechId.current = undefined;
      setSpeechMessageId(undefined);
      return;
    }
    currentSpeechId.current = message.id;
    setSpeechMessageId(message.id);
    const { markdownToTxt } = require("markdown-to-txt");
    const text = markdownToTxt(getMessageTextContentForContext(message));
    try {
      await speak(text, {
        ...useAppConfig.getState().ttsConfig,
        onFallback: showSpeechFallback,
      });
    } catch (error) {
      if (ticket === speechRequest.current)
        showToast(
          error instanceof Error && error.message === "NO_LOCAL_VOICES"
            ? Locale.Settings.TTS.NoVoices
            : Locale.Settings.TTS.Failed,
        );
    } finally {
      if (ticket === speechRequest.current) {
        currentSpeechId.current = undefined;
        setSpeechMessageId(undefined);
      }
    }
  }, []);

  useEffect(() => {
    setSpeechMessageId(undefined);
    return () => {
      speechRequest.current++;
      currentSpeechId.current = undefined;
      stop();
    };
  }, [session.id]);
  useEffect(() => {
    if (!config.ttsConfig.enable) {
      speechRequest.current++;
      currentSpeechId.current = undefined;
      stop();
      setSpeechMessageId(undefined);
    }
  }, [config.ttsConfig.enable]);
  useEffect(
    () => () => {
      speechRequest.current++;
      currentSpeechId.current = undefined;
      stop();
      setSpeechMessageId(undefined);
    },
    [config.ttsConfig.engine],
  );
  const previousSpeechMessages = useRef<{
    sessionId: string;
    streaming: Set<string>;
  }>();
  useEffect(() => {
    const previous = previousSpeechMessages.current;
    previousSpeechMessages.current = {
      sessionId: session.id,
      streaming: new Set(
        session.messages
          .filter((message) => message.streaming)
          .map((message) => message.id),
      ),
    };
    const message = session.messages.at(-1);
    if (
      speechSupported &&
      config.ttsConfig.enable &&
      config.ttsConfig.autoplay &&
      previous?.sessionId === session.id &&
      message?.role === "assistant" &&
      previous.streaming.has(message.id) &&
      !message.streaming &&
      !message.isError
    ) {
      void speakMessage(message);
    }
  }, [
    session.id,
    session.messages,
    speechSupported,
    config.ttsConfig.enable,
    config.ttsConfig.autoplay,
    speakMessage,
  ]);

  const context: RenderMessage[] = useMemo(() => {
    return session.mask.hideContext ? [] : session.mask.context.slice();
  }, [session.mask.context, session.mask.hideContext]);

  if (
    context.length === 0 &&
    session.messages.at(0)?.content !== BOT_HELLO.content
  ) {
    const copiedHello = Object.assign({}, BOT_HELLO);
    if (!accessStore.isAuthorized()) {
      copiedHello.content = getUnauthorizedMessage();
    }
    context.push(copiedHello);
  }

  // preview messages
  const renderMessages = useMemo(() => {
    return context
      .concat(session.messages as RenderMessage[])
      .concat(
        isLoading
          ? [
              {
                ...createMessage({
                  role: "assistant",
                  content: "……",
                }),
                preview: true,
              },
            ]
          : [],
      )
      .concat(
        userInput.length > 0 && config.sendPreviewBubble
          ? [
              {
                ...createMessage({
                  role: "user",
                  content: userInput,
                }),
                preview: true,
              },
            ]
          : [],
      );
  }, [
    config.sendPreviewBubble,
    context,
    isLoading,
    session.messages,
    userInput,
  ]);

  const [msgRenderIndex, _setMsgRenderIndex] = useState(
    Math.max(0, renderMessages.length - CHAT_PAGE_SIZE),
  );

  function setMsgRenderIndex(newIndex: number) {
    newIndex = Math.min(renderMessages.length - CHAT_PAGE_SIZE, newIndex);
    newIndex = Math.max(0, newIndex);
    _setMsgRenderIndex(newIndex);
  }

  const messages = useMemo(() => {
    const endRenderIndex = Math.min(
      msgRenderIndex + 3 * CHAT_PAGE_SIZE,
      renderMessages.length,
    );
    return renderMessages.slice(msgRenderIndex, endRenderIndex);
  }, [msgRenderIndex, renderMessages]);

  // Jump to a message opened from the global search.
  useEffect(() => {
    if (!jumpToMessageId) return;
    cancelPendingScroll();
    // Consume the request so going back or reloading does not jump again.
    useSearchJump.getState().consume(jumpRequest!);
    const index = session.messages.findIndex((m) => m.id === jumpToMessageId);
    if (index < 0) return;
    setAutoScroll(false);
    // Only part of the chat is rendered: put the message mid-window.
    setMsgRenderIndex(context.length + index - CHAT_PAGE_SIZE);
    setScrollTargetId(jumpToMessageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest, session.id]);

  useEffect(() => {
    if (!scrollTargetId) return;
    const element = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ??
        [],
    ).find((item) => item.dataset.messageId === scrollTargetId);
    if (!element) return;
    element.scrollIntoView({ block: "center" });
    setScrollTargetId(undefined);
    setHighlightMessageId(scrollTargetId);
  }, [scrollTargetId, messages]);

  useEffect(() => {
    if (!highlightMessageId) return;
    const timer = setTimeout(() => setHighlightMessageId(undefined), 2000);
    return () => clearTimeout(timer);
  }, [highlightMessageId]);

  const onChatBodyScroll = (e: HTMLElement) => {
    const bottomHeight = e.scrollTop + e.clientHeight;
    const edgeThreshold = e.clientHeight;

    const isTouchTopEdge = e.scrollTop <= edgeThreshold;
    const isTouchBottomEdge = bottomHeight >= e.scrollHeight - edgeThreshold;
    const isHitBottom =
      bottomHeight >= e.scrollHeight - (isMobileScreen ? 4 : 10);

    const prevPageMsgIndex = msgRenderIndex - CHAT_PAGE_SIZE;
    const nextPageMsgIndex = msgRenderIndex + CHAT_PAGE_SIZE;

    if (isTouchTopEdge && !isTouchBottomEdge) {
      setMsgRenderIndex(prevPageMsgIndex);
    } else if (isTouchBottomEdge) {
      setMsgRenderIndex(nextPageMsgIndex);
    }

    setHitBottom(isHitBottom);
    setAutoScroll(isHitBottom);
  };

  function scrollToBottom() {
    if (jumpToMessageId || scrollTargetId) return;
    setMsgRenderIndex(renderMessages.length - CHAT_PAGE_SIZE);
    scrollDomToBottom();
  }

  // clear context index = context length + index in messages
  const clearContextIndex =
    (session.clearContextIndex ?? -1) >= 0
      ? session.clearContextIndex! + context.length - msgRenderIndex
      : -1;

  const [showPromptModal, setShowPromptModal] = useState(false);

  const clientConfig = useMemo(() => getClientConfig(), []);

  const autoFocus = !isMobileScreen; // wont auto focus on mobile screen
  const showMaxIcon = !isMobileScreen && !clientConfig?.isApp;

  useCommand({
    fill: setUserInput,
    submit: (text) => {
      doSubmit(text);
    },
    code: (text) => {
      console.log("[Command] got code from url: ", text);
      showConfirm(Locale.URLCommand.Code + `code = ${text}`).then((res) => {
        if (res) {
          accessStore.update((access) => (access.accessCode = text));
        }
      });
    },
  });

  // edit / insert message modal
  const [isEditingMessage, setIsEditingMessage] = useState(false);

  // remember unfinished input
  useEffect(() => {
    // try to load from local storage
    const key = UNFINISHED_INPUT(session.id);
    const mayBeUnfinishedInput = localStorage.getItem(key);
    if (mayBeUnfinishedInput && userInput.length === 0) {
      setUserInput(mayBeUnfinishedInput);
      localStorage.removeItem(key);
    }

    const dom = inputRef.current;
    return () => {
      localStorage.setItem(key, dom?.value ?? "");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addImageFiles = useCallback(async (files: File[]) => {
    const images = files
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, 3);
    if (files.some((file) => !file.type.startsWith("image/"))) {
      showToast(Locale.Chat.ImageOnly);
    }
    if (!images.length) return;
    pendingImageUploads.current += 1;
    setUploading(true);
    try {
      const urls = await Promise.all(
        images.map((file) => uploadImageRemote(file)),
      );
      setAttachImages((previous) => previous.concat(urls).slice(0, 3));
    } catch (error) {
      console.error("[Chat] image upload failed", error);
      showToast(Locale.Store.Error);
    } finally {
      pendingImageUploads.current -= 1;
      setUploading(pendingImageUploads.current > 0);
    }
  }, []);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file);
      if (files.length) {
        if (files.some((file) => file.type.startsWith("image/"))) {
          event.preventDefault();
        }
        void addImageFiles(files);
      }
    },
    [addImageFiles],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      void addImageFiles(Array.from(event.dataTransfer.files));
    },
    [addImageFiles],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 打开新聊天 command + shift + o
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        setTimeout(() => {
          chatStore.newSession();
          navigate(Path.Chat);
        }, 10);
      }
      // 聚焦聊天输入 shift + esc
      else if (event.shiftKey && event.key.toLowerCase() === "escape") {
        event.preventDefault();
        inputRef.current?.focus();
      }
      // 复制最后一个代码块 command + shift + ;
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.code === "Semicolon"
      ) {
        event.preventDefault();
        const copyCodeButton =
          document.querySelectorAll<HTMLElement>(".copy-code-button");
        if (copyCodeButton.length > 0) {
          copyCodeButton[copyCodeButton.length - 1].click();
        }
      }
      // 复制最后一个回复 command + shift + c
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "c"
      ) {
        event.preventDefault();
        const lastNonUserMessage = messages
          .filter((message) => message.role !== "user")
          .pop();
        if (lastNonUserMessage) {
          const lastMessageContent =
            getMessageTextContentForContext(lastNonUserMessage);
          copyToClipboard(lastMessageContent);
        }
      }
      // 清除上下文 command + shift + backspace
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "backspace"
      ) {
        event.preventDefault();
        chatStore.updateTargetSession(session, (session) => {
          if (session.clearContextIndex === session.messages.length) {
            session.clearContextIndex = undefined;
          } else {
            session.clearContextIndex = session.messages.length;
            session.memoryPrompt = ""; // will clear memory
          }
        });
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [messages, chatStore, navigate, session]);

  return (
    <>
      <div className={styles.chat} key={session.id}>
        <div
          className={clsx("window-header", styles["chat-header"])}
          data-tauri-drag-region
        >
          {isMobileScreen && (
            <div className="window-actions">
              <div className={"window-action-button"}>
                <IconButton
                  icon={<ReturnIcon />}
                  bordered
                  title={Locale.Chat.Actions.ChatList}
                  onClick={() => navigate(Path.Home)}
                />
              </div>
            </div>
          )}

          <div
            className={clsx("window-header-title", styles["chat-body-title"])}
          >
            <button
              type="button"
              className={clsx(
                "window-header-main-title",
                styles["chat-body-main-title"],
              )}
              title={Locale.Chat.InputActions.Settings}
              aria-label={`${!session.topic ? DEFAULT_TOPIC : session.topic}: ${
                Locale.Chat.InputActions.Settings
              }`}
              onClick={() => setShowPromptModal(true)}
            >
              {!session.topic ? DEFAULT_TOPIC : session.topic}
            </button>
            <div className="window-header-sub-title">
              {Locale.Chat.SubTitle(session.messages.length)}
            </div>
          </div>
          <div className="window-actions">
            <div className="window-action-button">
              <IconButton
                icon={<ReloadIcon />}
                bordered
                title={Locale.Chat.Actions.RefreshTitle}
                aria={Locale.Chat.Actions.RefreshTitle}
                onClick={() => {
                  showToast(Locale.Chat.Actions.RefreshToast);
                  chatStore.summarizeSession(true, session);
                }}
              />
            </div>
            <div className="window-action-button">
              <IconButton
                icon={<RenameIcon />}
                bordered
                title={Locale.Chat.EditMessage.Title}
                aria={Locale.Chat.EditMessage.Title}
                onClick={() => setIsEditingMessage(true)}
              />
            </div>
            <ChatPluginAction />
            <div className="window-action-button">
              <IconButton
                icon={<ExportIcon />}
                bordered
                title={Locale.Chat.Actions.Export}
                aria={Locale.Chat.Actions.Export}
                onClick={() => {
                  setShowExport(true);
                }}
              />
            </div>
            {(session.messages.length > 0 || session.pinned) &&
              !session.archived && (
                <div className="window-action-button">
                  <IconButton
                    icon={<SessionPinIcon />}
                    bordered
                    type={session.pinned ? "primary" : undefined}
                    className={clsx(styles["chat-session-pin"], {
                      [styles["chat-session-pin-active"]]: session.pinned,
                    })}
                    title={session.pinned ? Locale.Pin.Undo : Locale.Pin.Action}
                    aria={session.pinned ? Locale.Pin.Undo : Locale.Pin.Action}
                    onClick={() => chatStore.togglePinSession(session.id)}
                  />
                </div>
              )}
            {session.messages.length > 0 && !session.archived && (
              <div className="window-action-button">
                <IconButton
                  icon={<ArchiveIcon />}
                  bordered
                  title={Locale.Archive.Action}
                  aria={Locale.Archive.Action}
                  onClick={() => chatStore.archiveSession(session.id)}
                />
              </div>
            )}
            {showMaxIcon && (
              <div className="window-action-button">
                <IconButton
                  icon={config.tightBorder ? <MinIcon /> : <MaxIcon />}
                  bordered
                  title={Locale.Chat.Actions.FullScreen}
                  aria={Locale.Chat.Actions.FullScreen}
                  onClick={() => {
                    config.update(
                      (config) => (config.tightBorder = !config.tightBorder),
                    );
                  }}
                />
              </div>
            )}
          </div>

          <PromptToast
            showToast={!hitBottom}
            showModal={showPromptModal}
            setShowModal={setShowPromptModal}
          />
        </div>
        {session.archived && (
          <div className={styles["chat-archived-banner"]}>
            <span>{Locale.Archive.Banner}</span>
            <IconButton
              icon={<ReturnIcon />}
              text={Locale.Archive.Restore}
              bordered
              onClick={() => chatStore.unarchiveSession(session.id)}
            />
          </div>
        )}
        <div
          className={styles["chat-main"]}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
            }
          }}
          onDrop={handleDrop}
        >
          <div className={styles["chat-body-container"]}>
            <div className={styles["chat-body-viewport"]}>
              <div
                className={styles["chat-body"]}
                ref={scrollRef}
                onScroll={(e) => onChatBodyScroll(e.currentTarget)}
                onMouseDown={() => inputRef.current?.blur()}
                onTouchStart={() => {
                  inputRef.current?.blur();
                  setAutoScroll(false);
                }}
              >
                {messages
                  // Render historical tool messages without changing stored data.
                  .map((message, i) => {
                    const isToolResponse = !!message.isMcpResponse;
                    const isUser = message.role === "user" && !isToolResponse;
                    const isContext = i + msgRenderIndex < context.length;
                    const showActions =
                      i > 0 &&
                      !isToolResponse &&
                      !(
                        message.preview ||
                        (message.content.length === 0 &&
                          !message.streaming &&
                          !message.tools?.length)
                      ) &&
                      !isContext;
                    const showTyping = message.preview || message.streaming;
                    const text = getMessageTextContent(message);
                    const separated =
                      message.role === "assistant"
                        ? parseThinking(text, message.streaming)
                        : [];
                    const thoughtParts = separated.filter(
                      (part) => part.type === "thinking",
                    );
                    const showThoughts =
                      thoughtParts.some((part) => part.content.trim()) ||
                      (!!message.streaming &&
                        !!message.thinkingActive &&
                        !!thoughtParts.length);
                    const visibleText = separated.length
                      ? separated
                          .filter((part) => part.type === "text")
                          .map((part) => part.content)
                          .join("")
                      : text;
                    const legacyResponse = isToolResponse
                      ? parseLegacyMcpResponse(text)
                      : null;
                    const contentParts =
                      message.role === "assistant" &&
                      message.toolMode !== "native"
                        ? splitLegacyMcpCalls(visibleText)
                        : [{ type: "text" as const, content: visibleText }];
                    const hasLegacyCalls = contentParts.some(
                      (part) => part.type === "call",
                    );
                    const visibleParts = hasLegacyCalls
                      ? contentParts.filter(
                          (part) =>
                            part.type === "call" || !!part.content.trim(),
                        )
                      : contentParts;
                    const showTypingStatus =
                      !message.tools?.length && showTyping;
                    const showBlocks =
                      showTypingStatus ||
                      showThoughts ||
                      !!message.tools?.length ||
                      !!legacyResponse;

                    const shouldShowClearContextDivider =
                      i === clearContextIndex - 1;

                    return (
                      <Fragment key={message.id}>
                        <div
                          data-message-id={message.id}
                          className={clsx(
                            isUser
                              ? styles["chat-message-user"]
                              : styles["chat-message"],
                            {
                              [styles["chat-message-jump"]]:
                                message.id === highlightMessageId,
                            },
                          )}
                        >
                          <div className={styles["chat-message-container"]}>
                            <div className={styles["chat-message-header"]}>
                              <div className={styles["chat-message-avatar"]}>
                                <div className={styles["chat-message-edit"]}>
                                  <IconButton
                                    icon={<EditIcon />}
                                    aria={Locale.Chat.Actions.Edit}
                                    onClick={async () => {
                                      const newMessage = await showPrompt(
                                        Locale.Chat.Actions.Edit,
                                        getMessageTextContent(message),
                                        10,
                                      );
                                      let newContent:
                                        | string
                                        | MultimodalContent[] = newMessage;
                                      const images = getMessageImages(message);
                                      if (images.length > 0) {
                                        newContent = [
                                          { type: "text", text: newMessage },
                                        ];
                                        for (
                                          let i = 0;
                                          i < images.length;
                                          i++
                                        ) {
                                          newContent.push({
                                            type: "image_url",
                                            image_url: {
                                              url: images[i],
                                            },
                                          });
                                        }
                                      }
                                      chatStore.updateTargetSession(
                                        session,
                                        (session) => {
                                          const m = session.mask.context
                                            .concat(session.messages)
                                            .find((m) => m.id === message.id);
                                          if (m) {
                                            m.content = newContent;
                                          }
                                        },
                                      );
                                    }}
                                  ></IconButton>
                                </div>
                                {isUser ? (
                                  <Avatar avatar={config.avatar} />
                                ) : (
                                  <>
                                    {["system"].includes(message.role) ? (
                                      <Avatar avatar="2699-fe0f" />
                                    ) : (
                                      <MaskAvatar
                                        avatar={session.mask.avatar}
                                        model={
                                          message.model ||
                                          session.mask.modelConfig.model
                                        }
                                      />
                                    )}
                                  </>
                                )}
                              </div>
                              {!isUser && (
                                <div className={styles["chat-model-name"]}>
                                  {message.model}
                                </div>
                              )}

                              {showActions && (
                                <div className={styles["chat-message-actions"]}>
                                  <div
                                    className={
                                      styles["chat-message-action-list"]
                                    }
                                  >
                                    {message.streaming ? (
                                      <ChatAction
                                        text={Locale.Chat.Actions.Stop}
                                        icon={<StopIcon />}
                                        onClick={() =>
                                          onUserStop(message.id ?? i)
                                        }
                                      />
                                    ) : (
                                      <>
                                        <ChatAction
                                          text={Locale.Chat.Actions.Retry}
                                          icon={<ResetIcon />}
                                          onClick={() => onResend(message)}
                                        />

                                        <ChatAction
                                          text={Locale.Chat.Actions.Delete}
                                          icon={<DeleteIcon />}
                                          onClick={() =>
                                            onDelete(message.id ?? i)
                                          }
                                        />

                                        <ChatAction
                                          text={Locale.Chat.Actions.Pin}
                                          icon={<PinIcon />}
                                          onClick={() => onPinMessage(message)}
                                        />
                                        <ChatAction
                                          text={Locale.Chat.Actions.Copy}
                                          icon={<CopyIcon />}
                                          onClick={() =>
                                            copyToClipboard(
                                              getMessageTextContentForContext(
                                                message,
                                              ),
                                            )
                                          }
                                        />
                                        {speechSupported &&
                                          config.ttsConfig.enable && (
                                            <ChatAction
                                              text={
                                                speechMessageId === message.id
                                                  ? Locale.Chat.Actions
                                                      .StopSpeech
                                                  : Locale.Chat.Actions.Speech
                                              }
                                              icon={
                                                speechMessageId ===
                                                message.id ? (
                                                  <SpeakStopIcon />
                                                ) : (
                                                  <SpeakIcon />
                                                )
                                              }
                                              onClick={() =>
                                                speakMessage(message)
                                              }
                                            />
                                          )}
                                      </>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                            {showBlocks && (
                              <div
                                className={styles["chat-message-blocks"]}
                                style={{
                                  fontSize: `${fontSize}px`,
                                  fontFamily: fontFamily || "inherit",
                                }}
                              >
                                {showTypingStatus && (
                                  <div
                                    className={styles["chat-message-status"]}
                                  >
                                    {Locale.Chat.Typing}
                                  </div>
                                )}
                                {showThoughts && (
                                  <ThinkingBlock
                                    thinking={
                                      !!message.streaming &&
                                      (message.thinkingActive ||
                                        thoughtParts.some(
                                          (part) => !part.closed,
                                        ))
                                    }
                                  >
                                    <Markdown
                                      content={thoughtParts
                                        .map((part) => part.content)
                                        .join("\n\n")}
                                      parseThoughts={false}
                                      fontSize="inherit"
                                      fontFamily={fontFamily}
                                      parentRef={scrollRef}
                                      defaultShow
                                    />
                                  </ThinkingBlock>
                                )}
                                {message.tools?.map((tool) => (
                                  <ToolCard
                                    key={tool.id}
                                    tool={tool}
                                    active={!!message.streaming}
                                  />
                                ))}
                                {legacyResponse && (
                                  <ToolCard
                                    historical
                                    tool={{
                                      id: message.id,
                                      display: {
                                        source: "mcp",
                                        server: legacyResponse.clientId,
                                        name: Locale.Chat.ToolCard.ToolResult,
                                      },
                                      content: legacyResponse.content,
                                    }}
                                  />
                                )}
                              </div>
                            )}
                            {!isToolResponse &&
                              (!!visibleText.trim() ||
                                getMessageImages(message).length > 0 ||
                                (!message.tools?.length &&
                                  !thoughtParts.length)) && (
                                <div
                                  className={clsx(styles["chat-message-item"], {
                                    [styles["chat-message-item-legacy"]]:
                                      hasLegacyCalls,
                                  })}
                                >
                                  {visibleParts.map((part, partIndex) =>
                                    part.type === "call" ? (
                                      (() => {
                                        let request: any;
                                        try {
                                          request = JSON.parse(part.raw);
                                        } catch {
                                          request = {};
                                        }
                                        const name =
                                          request?.params?.name ??
                                          Locale.Chat.ToolCard.Tool;
                                        return (
                                          <ToolCard
                                            key={partIndex}
                                            historical
                                            tool={{
                                              id: `${message.id}-${partIndex}`,
                                              function: {
                                                name,
                                                arguments: request?.params
                                                  ?.arguments
                                                  ? JSON.stringify(
                                                      request.params.arguments,
                                                    )
                                                  : part.raw,
                                              },
                                              display: {
                                                source: "mcp",
                                                server: part.clientId,
                                                name,
                                              },
                                            }}
                                          />
                                        );
                                      })()
                                    ) : (
                                      <Markdown
                                        key={`${message.id}-${partIndex}`}
                                        content={part.content}
                                        streaming={message.streaming}
                                        thinkingActive={message.thinkingActive}
                                        parseThoughts={false}
                                        loading={
                                          (message.preview ||
                                            message.streaming) &&
                                          message.content.length === 0 &&
                                          !isUser
                                        }
                                        //   onContextMenu={(e) => onRightClick(e, message)} // hard to use
                                        onDoubleClickCapture={() => {
                                          if (!isMobileScreen) return;
                                          setUserInput(
                                            getMessageTextContentForContext(
                                              message,
                                            ),
                                          );
                                        }}
                                        fontSize={fontSize}
                                        fontFamily={fontFamily}
                                        parentRef={scrollRef}
                                        defaultShow={i >= messages.length - 6}
                                      />
                                    ),
                                  )}
                                  {getMessageImages(message).length == 1 && (
                                    <img
                                      className={
                                        styles["chat-message-item-image"]
                                      }
                                      src={getMessageImages(message)[0]}
                                      alt=""
                                    />
                                  )}
                                  {getMessageImages(message).length > 1 && (
                                    <div
                                      className={
                                        styles["chat-message-item-images"]
                                      }
                                      style={
                                        {
                                          "--image-count":
                                            getMessageImages(message).length,
                                        } as React.CSSProperties
                                      }
                                    >
                                      {getMessageImages(message).map(
                                        (image, index) => {
                                          return (
                                            <img
                                              className={
                                                styles[
                                                  "chat-message-item-image-multi"
                                                ]
                                              }
                                              key={index}
                                              src={image}
                                              alt=""
                                            />
                                          );
                                        },
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            {message?.audio_url && (
                              <div className={styles["chat-message-audio"]}>
                                <audio src={message.audio_url} controls />
                              </div>
                            )}

                            <div className={styles["chat-message-action-date"]}>
                              {isContext
                                ? Locale.Chat.IsContext
                                : message.date.toLocaleString()}
                            </div>
                          </div>
                        </div>
                        {shouldShowClearContextDivider && (
                          <ClearContextDivider />
                        )}
                      </Fragment>
                    );
                  })}
              </div>
              {!hitBottom && (
                <button
                  type="button"
                  className={styles["chat-to-bottom"]}
                  title={Locale.Chat.InputActions.ToBottom}
                  aria-label={Locale.Chat.InputActions.ToBottom}
                  onClick={scrollToBottom}
                >
                  <BottomIcon />
                </button>
              )}
            </div>
            <div className={styles["chat-input-panel"]}>
              <PromptHints
                prompts={promptHints}
                onPromptSelect={onPromptSelect}
              />

              <div className={styles["chat-input-panel-inner"]}>
                <div className={styles["chat-input-row"]}>
                  <textarea
                    id="chat-input"
                    ref={inputRef}
                    className={styles["chat-input"]}
                    placeholder={`${Locale.Chat.Input(submitKey)}${
                      Locale.Chat.ImageInputHint
                    }`}
                    onInput={(e) => onInput(e.currentTarget.value)}
                    value={userInput}
                    onKeyDown={onInputKeyDown}
                    onFocus={scrollToBottom}
                    onClick={scrollToBottom}
                    onPaste={handlePaste}
                    rows={inputRows}
                    autoFocus={autoFocus}
                    style={{
                      fontSize: config.fontSize,
                      fontFamily: config.fontFamily,
                    }}
                  />
                  <div className={styles["chat-input-controls"]}>
                    <ChatInputOptions />
                    <ChatInputControls
                      sessionId={session.id}
                      input={userInput}
                      hasImages={attachImages.length > 0}
                      uploading={uploading}
                      onSend={() => doSubmit(userInput)}
                    />
                  </div>
                </div>
                {(attachImages.length > 0 || uploading) && (
                  <div className={styles["attach-images"]}>
                    {attachImages.map((image, index) => {
                      return (
                        <div
                          key={index}
                          className={styles["attach-image"]}
                          style={{ backgroundImage: `url("${image}")` }}
                        >
                          <div className={styles["attach-image-mask"]}>
                            <DeleteImageButton
                              deleteImage={() => {
                                setAttachImages(
                                  attachImages.filter((_, i) => i !== index),
                                );
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                    {uploading && (
                      <div
                        className={styles["attach-image-uploading"]}
                        role="status"
                      >
                        <LoadingButtonIcon /> {Locale.Chat.ImageUploading}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {showExport && (
        <ExportMessageModal onClose={() => setShowExport(false)} />
      )}

      {isEditingMessage && (
        <EditMessageModal
          onClose={() => {
            setIsEditingMessage(false);
          }}
        />
      )}
    </>
  );
}

export function Chat() {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  return <_Chat key={session.id}></_Chat>;
}
