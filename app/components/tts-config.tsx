import { useEffect, useRef, useState } from "react";
import { TTSConfig, TTSConfigValidator } from "../store";
import Locale from "../locales";
import { List, ListItem, Select, showToast } from "./ui-lib";
import { IconButton } from "./button";
import { InputRange } from "./input-range";
import { speak, stop } from "../utils/local-tts";
import { useLocalTTS } from "../utils/use-local-tts";
import { isMeloDesktop } from "../utils/melo-client";
import { MeloModelControls } from "./melo-model-controls";
import { showSpeechFallback } from "./tts-feedback";

export function TTSConfigList(props: {
  ttsConfig: TTSConfig;
  updateConfig: (updater: (config: TTSConfig) => void) => void;
}) {
  const { supported, voices } = useLocalTTS();
  const [previewing, setPreviewing] = useState(false);
  const preview = useRef(0);
  const desktop = isMeloDesktop();
  const engine = desktop ? props.ttsConfig.engine : "system";
  const stopPreview = () => {
    preview.current++;
    stop();
    setPreviewing(false);
  };
  useEffect(
    () => () => {
      preview.current++;
      stop();
    },
    [],
  );
  if (!supported) return null;
  const text = Locale.Settings.TTS;
  const selected = voices.some(
    (voice) => voice.voiceURI === props.ttsConfig.voiceURI,
  )
    ? props.ttsConfig.voiceURI
    : "";
  const audition = async () => {
    if (previewing) {
      preview.current++;
      stop();
      setPreviewing(false);
      return;
    }
    const ticket = ++preview.current;
    setPreviewing(true);
    try {
      await speak(engine === "melo" ? text.Melo.Sample : text.Sample, {
        ...props.ttsConfig,
        onFallback: showSpeechFallback,
      });
    } catch (error) {
      if (ticket === preview.current)
        showToast(
          error instanceof Error && error.message === "NO_LOCAL_VOICES"
            ? text.NoVoices
            : text.Failed,
        );
    } finally {
      if (ticket === preview.current) setPreviewing(false);
    }
  };
  return (
    <List>
      {desktop && (
        <ListItem title={text.Engine}>
          <Select
            aria-label={text.Engine}
            value={engine}
            onChange={(event) => {
              const value =
                event.currentTarget.value === "melo" ? "melo" : "system";
              stopPreview();
              props.updateConfig((config) => {
                config.engine = value;
              });
            }}
          >
            <option value="system">{text.SystemEngine}</option>
            <option value="melo">{text.Melo.Engine}</option>
          </Select>
        </ListItem>
      )}
      <ListItem title={text.Enable.Title} subTitle={text.LocalDescription}>
        <input
          aria-label={text.Enable.Title}
          type="checkbox"
          checked={props.ttsConfig.enable}
          onChange={(e) => {
            const value = e.currentTarget.checked;
            props.updateConfig((config) => {
              config.enable = value;
            });
          }}
        />
      </ListItem>
      <ListItem title={text.Autoplay.Title} subTitle={text.Autoplay.SubTitle}>
        <input
          aria-label={text.Autoplay.Title}
          type="checkbox"
          checked={props.ttsConfig.autoplay}
          disabled={!props.ttsConfig.enable}
          onChange={(e) => {
            const value = e.currentTarget.checked;
            props.updateConfig((config) => {
              config.autoplay = value;
            });
          }}
        />
      </ListItem>
      {engine === "melo" && <MeloModelControls onStop={stopPreview} />}
      {engine !== "melo" && (
        <ListItem
          title={text.LocalVoice}
          subTitle={voices.length ? text.LocalDescription : text.NoVoices}
        >
          <Select
            aria-label={text.LocalVoice}
            value={selected}
            onChange={(e) => {
              const value = e.currentTarget.value;
              props.updateConfig((config) => {
                config.voiceURI = value;
              });
            }}
          >
            <option value="">{text.Automatic}</option>
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name}（{voice.lang}）
              </option>
            ))}
          </Select>
        </ListItem>
      )}
      <ListItem title={text.Rate}>
        <InputRange
          aria={text.Rate}
          value={props.ttsConfig.rate.toFixed(1)}
          min="0.5"
          max="2"
          step="0.1"
          onChange={(e) => {
            const value = TTSConfigValidator.rate(
              e.currentTarget.valueAsNumber,
            );
            props.updateConfig((config) => {
              config.rate = value;
            });
          }}
        />
      </ListItem>
      {engine !== "melo" && (
        <ListItem title={text.Pitch}>
          <InputRange
            aria={text.Pitch}
            value={props.ttsConfig.pitch.toFixed(1)}
            min="0.5"
            max="2"
            step="0.1"
            onChange={(e) => {
              const value = TTSConfigValidator.pitch(
                e.currentTarget.valueAsNumber,
              );
              props.updateConfig((config) => {
                config.pitch = value;
              });
            }}
          />
        </ListItem>
      )}
      <ListItem title={text.Preview}>
        <IconButton
          aria={previewing ? Locale.Chat.Actions.StopSpeech : text.Preview}
          text={previewing ? Locale.Chat.Actions.StopSpeech : text.Preview}
          onClick={audition}
          disabled={engine !== "melo" && !voices.length}
          bordered
        />
      </ListItem>
    </List>
  );
}
