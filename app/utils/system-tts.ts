// System speech implementation. Keep browser voice selection and queuing local.
export type LocalSpeechOptions = {
  voiceURI?: string;
  rate?: number;
  pitch?: number;
};

export const DEFAULT_LOCAL_TTS = {
  enable: false,
  autoplay: false,
  voiceURI: "",
  rate: 1,
  pitch: 1,
};

export function speechValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(2, Math.max(0.5, value))
    : 1;
}

export function migrateTTSConfig(value: any) {
  return {
    enable: value?.enable === true,
    autoplay: value?.autoplay === true,
    voiceURI: typeof value?.voiceURI === "string" ? value.voiceURI : "",
    rate: speechValue(value?.rate ?? value?.speed),
    pitch: speechValue(value?.pitch),
  };
}

export function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.speechSynthesis &&
    typeof window.SpeechSynthesisUtterance === "function"
  );
}

export function getVoices(): SpeechSynthesisVoice[] {
  return isSupported()
    ? window.speechSynthesis
        .getVoices()
        .filter((voice) => voice.localService === true)
    : [];
}

export function subscribeVoices(
  listener: (voices: SpeechSynthesisVoice[]) => void,
) {
  const update = () => listener(getVoices());
  update();
  if (!isSupported()) return () => {};
  const synthesis = window.speechSynthesis;
  synthesis.addEventListener("voiceschanged", update);
  // The list can become ready between the first read and listener registration.
  update();
  return () => synthesis.removeEventListener("voiceschanged", update);
}

export function detectLanguage(text: string): string {
  const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0;
  const han = count(/[\u3400-\u9fff]/gu);
  const kana = count(/[\u3040-\u30ff\uff66-\uff9f]/gu);
  const hangul = count(/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu);
  const english = count(/[a-z]/gi);
  const scores: [string, number][] = [
    ["ja", kana ? kana + han : 0],
    ["ko", hangul],
    ["zh", kana ? 0 : han],
    ["en", english],
  ];
  return scores.sort((a, b) => b[1] - a[1])[0][1] ? scores[0][0] : "en";
}

export function selectVoice(
  text: string,
  voices: SpeechSynthesisVoice[],
  voiceURI = "",
) {
  const local = voices.filter((voice) => voice.localService === true);
  const language = detectLanguage(text);
  return (
    local.find((voice) => voice.voiceURI === voiceURI) ??
    local.find(
      (voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === language,
    ) ??
    local.find((voice) => voice.default) ??
    local[0]
  );
}

export function splitSpeech(text: string, maxLength = 180): string[] {
  const chunks: string[] = [];
  let buffer = "";
  let length = 0;
  for (const character of text.trim()) {
    buffer += character;
    length++;
    if (/[。！？.!?；;\n，,]/u.test(character) || length >= maxLength) {
      if (buffer.trim()) chunks.push(buffer.trim());
      buffer = "";
      length = 0;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

let generation = 0;
let speaking = false;
let finishCurrent: (() => void) | undefined;
let cancelVoiceWait: (() => void) | undefined;
// Retain the current utterance until completion (Chromium can otherwise collect it).
let utterance: SpeechSynthesisUtterance | undefined;

export function isSpeaking() {
  return speaking;
}

export function stop() {
  generation++;
  speaking = false;
  cancelVoiceWait?.();
  cancelVoiceWait = undefined;
  if (utterance) {
    utterance.onend = null;
    utterance.onerror = null;
  }
  utterance = undefined;
  if (isSupported()) window.speechSynthesis.cancel();
  finishCurrent?.();
  finishCurrent = undefined;
}

function waitForVoices(): Promise<SpeechSynthesisVoice[]> {
  const current = getVoices();
  if (current.length) return Promise.resolve(current);
  return new Promise((resolve) => {
    const synthesis = window.speechSynthesis;
    const finish = () => {
      clearTimeout(timeout);
      synthesis.removeEventListener("voiceschanged", changed);
      cancelVoiceWait = undefined;
      resolve(getVoices());
    };
    const changed = () => {
      if (getVoices().length) finish();
    };
    const timeout = setTimeout(finish, 3000);
    cancelVoiceWait = finish;
    synthesis.addEventListener("voiceschanged", changed);
    changed();
  });
}

export async function speak(
  text: string,
  options: LocalSpeechOptions = {},
): Promise<void> {
  stop();
  if (!isSupported()) throw new Error("UNSUPPORTED");
  const chunks = splitSpeech(text);
  if (!chunks.length) return;
  const ticket = generation;
  speaking = true;
  const voices = await waitForVoices();
  if (ticket !== generation) return;
  const voice = selectVoice(text, voices, options.voiceURI);
  // Never leave utterance.voice unset: the browser default could be a cloud voice.
  if (!voice) {
    speaking = false;
    throw new Error("NO_LOCAL_VOICES");
  }
  return new Promise((resolve, reject) => {
    let index = 0;
    const finish = (error?: string) => {
      if (ticket !== generation) return;
      generation++;
      speaking = false;
      if (utterance) {
        utterance.onend = null;
        utterance.onerror = null;
      }
      utterance = undefined;
      finishCurrent = undefined;
      error ? reject(new Error(error)) : resolve();
    };
    finishCurrent = resolve;
    const next = () => {
      if (ticket !== generation) return;
      if (index >= chunks.length) return finish();
      const current = new window.SpeechSynthesisUtterance(chunks[index++]);
      utterance = current;
      current.voice = voice;
      current.lang = voice.lang;
      current.rate = speechValue(options.rate);
      current.pitch = speechValue(options.pitch);
      current.onend = () => {
        current.onend = null;
        current.onerror = null;
        next();
      };
      current.onerror = (event) => finish(event.error);
      try {
        window.speechSynthesis.speak(current);
      } catch {
        finish("SPEECH_FAILED");
      }
    };
    next();
  });
}
