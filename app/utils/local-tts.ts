import * as system from "./system-tts";
import { isMeloDesktop } from "./melo-client";
import {
  isMeloSpeaking,
  MeloSpeechError,
  speakMelo,
  stopMelo,
} from "./melo-tts";

export {
  detectLanguage,
  getVoices,
  selectVoice,
  splitSpeech,
  speechValue,
  subscribeVoices,
} from "./system-tts";
export type SpeechEngine = "system" | "melo";
export type LocalSpeechOptions = system.LocalSpeechOptions & {
  engine?: SpeechEngine;
  onFallback?: (error: unknown) => void;
};
export interface LocalSpeechEngine {
  speak(text: string, options: LocalSpeechOptions): Promise<void>;
  stop(): void;
  isSpeaking(): boolean;
}
const engines: Record<SpeechEngine, LocalSpeechEngine> = {
  system,
  melo: {
    speak: (text, options) => speakMelo(text, options.rate),
    stop: stopMelo,
    isSpeaking: isMeloSpeaking,
  },
};

export const DEFAULT_LOCAL_TTS = {
  ...system.DEFAULT_LOCAL_TTS,
  engine: "system" as SpeechEngine,
};
export function migrateTTSConfig(value: any) {
  return {
    ...system.migrateTTSConfig(value),
    engine: (value?.engine === "melo" ? "melo" : "system") as SpeechEngine,
  };
}
export const isSupported = () => system.isSupported() || isMeloDesktop();
export const isSpeaking = () =>
  engines.system.isSpeaking() || engines.melo.isSpeaking();
let generation = 0;

export function stop() {
  generation++;
  engines.melo.stop();
  engines.system.stop();
}

export function speak(
  text: string,
  options: LocalSpeechOptions = {},
): Promise<void> {
  const ticket = ++generation;
  if (options.engine !== "melo" || !isMeloDesktop()) {
    engines.melo.stop();
    return engines.system.speak(text, options);
  }
  engines.system.stop();
  return engines.melo.speak(text, options).catch((error) => {
    if (ticket !== generation) return;
    // Notify for both fallback and stopping after playback has already begun.
    try {
      options.onFallback?.(error);
    } catch {
      /* Notification failure must not change the playback decision. */
    }
    if (!(error instanceof MeloSpeechError && error.playbackStarted))
      return engines.system.speak(text, options);
  });
}
