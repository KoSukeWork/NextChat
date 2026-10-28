import { jest } from "@jest/globals";
import {
  detectLanguage,
  getVoices,
  isSpeaking,
  isSupported,
  selectVoice,
  speak,
  splitSpeech,
  stop,
  subscribeVoices,
} from "../app/utils/local-tts";

const voice = (
  name: string,
  lang: string,
  localService = true,
  systemDefault = false,
) =>
  ({
    name,
    voiceURI: name,
    lang,
    localService,
    default: systemDefault,
  }) as SpeechSynthesisVoice;
const voices = [
  voice("Online Natural", "zh-CN", false, true),
  voice("Huihui", "zh-CN"),
  voice("David", "en-US", true, true),
  voice("Japanese", "ja-JP"),
  voice("Korean", "ko-KR"),
];
class Utterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = "";
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}
class Synthesis extends EventTarget {
  voices = voices;
  spoken: Utterance[] = [];
  speak = jest.fn((utterance: Utterance) => {
    this.spoken.push(utterance);
  });
  cancel = jest.fn();
  getVoices = () => this.voices;
}
let synthesis: Synthesis;
const originalSynthesis = Object.getOwnPropertyDescriptor(
  window,
  "speechSynthesis",
);
const originalUtterance = Object.getOwnPropertyDescriptor(
  window,
  "SpeechSynthesisUtterance",
);
beforeEach(() => {
  synthesis = new Synthesis();
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: synthesis,
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: Utterance,
  });
});
afterEach(() => {
  stop();
  jest.useRealTimers();
  if (originalSynthesis)
    Object.defineProperty(window, "speechSynthesis", originalSynthesis);
  else Reflect.deleteProperty(window, "speechSynthesis");
  if (originalUtterance)
    Object.defineProperty(
      window,
      "SpeechSynthesisUtterance",
      originalUtterance,
    );
  else Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
});

test("voice discovery excludes cloud voices and subscribes to delayed local voices", () => {
  expect(isSupported()).toBe(true);
  expect(getVoices()).toEqual(voices.slice(1));
  synthesis.voices = [];
  const changed = jest.fn();
  const dispose = subscribeVoices(changed);
  expect(changed).toHaveBeenLastCalledWith([]);
  synthesis.voices = voices;
  synthesis.dispatchEvent(new Event("voiceschanged"));
  expect(changed).toHaveBeenLastCalledWith(voices.slice(1));
  dispose();
  changed.mockClear();
  synthesis.dispatchEvent(new Event("voiceschanged"));
  expect(changed).not.toHaveBeenCalled();
});

test.each([
  ["你好，这是中文。", "zh"],
  ["日本語でこんにちは。", "ja"],
  ["안녕하세요", "ko"],
  ["Hello world.", "en"],
])("automatic voice follows text language: %s", (text, lang) => {
  expect(detectLanguage(text)).toBe(lang);
  expect(selectVoice(text, voices)?.lang).toMatch(new RegExp(`^${lang}`));
});

test("explicit voices and local system fallback never pick online default", () => {
  expect(selectVoice("Hello", voices, "Huihui")?.name).toBe("Huihui");
  expect(selectVoice("こんにちは", voices.slice(0, 3))?.name).toBe("David");
  expect(selectVoice("你好", voices, "Online Natural")?.name).toBe("Huihui");
  expect(selectVoice("Hello", [voices[0]])).toBeUndefined();
});

test("splits sentences and bounds long text without splitting Unicode characters", () => {
  expect(splitSpeech("你好。Hello! 下一句；done?")).toEqual([
    "你好。",
    "Hello!",
    "下一句；",
    "done?",
  ]);
  const long = "😊".repeat(401);
  const parts = splitSpeech(long);
  expect(parts.map((part) => Array.from(part).length)).toEqual([180, 180, 41]);
  expect(parts.join("")).toBe(long);
  expect(splitSpeech("  ")).toEqual([]);
});

test("queues one utterance at a time with explicit local voice and options", async () => {
  const done = speak("你好。第二句。", { rate: 1.5, pitch: 0.8 });
  await Promise.resolve();
  expect(isSpeaking()).toBe(true);
  expect(synthesis.spoken).toHaveLength(1);
  expect(synthesis.spoken[0]).toMatchObject({
    text: "你好。",
    voice: voices[1],
    lang: "zh-CN",
    rate: 1.5,
    pitch: 0.8,
  });
  synthesis.spoken[0].onend?.();
  expect(synthesis.spoken).toHaveLength(2);
  synthesis.spoken[1].onend?.();
  await done;
  expect(isSpeaking()).toBe(false);
});

test("stop and switching messages cancel the queue; stale end events cannot resume it", async () => {
  const first = speak("First. Second.");
  await Promise.resolve();
  const staleEnd = synthesis.spoken[0].onend;
  const second = speak("新的消息。");
  await Promise.resolve();
  await first;
  expect(synthesis.cancel).toHaveBeenCalledTimes(2);
  staleEnd?.();
  expect(synthesis.spoken.map((part) => part.text)).toEqual([
    "First.",
    "新的消息。",
  ]);
  stop();
  await second;
  expect(isSpeaking()).toBe(false);
  expect(synthesis.spoken[1].onend).toBeNull();
});

test("waits for voiceschanged and cancelling a pending voice load prevents speech", async () => {
  synthesis.voices = [];
  const first = speak("Hello");
  stop();
  await first;
  synthesis.voices = voices;
  synthesis.dispatchEvent(new Event("voiceschanged"));
  expect(synthesis.spoken).toHaveLength(0);
  synthesis.voices = [];
  const second = speak("你好");
  synthesis.voices = voices;
  synthesis.dispatchEvent(new Event("voiceschanged"));
  await Promise.resolve();
  expect(synthesis.spoken[0].voice).toBe(voices[1]);
  synthesis.spoken[0].onend?.();
  await second;
});

test("no local voices fails closed instead of sending text through the browser default", async () => {
  jest.useFakeTimers();
  synthesis.voices = [voices[0]];
  const result = expect(speak("Private text")).rejects.toThrow(
    "NO_LOCAL_VOICES",
  );
  jest.advanceTimersByTime(3000);
  await result;
  expect(synthesis.speak).not.toHaveBeenCalled();
  expect(isSpeaking()).toBe(false);
});

test("unsupported browser and synthesis errors clear speaking state", async () => {
  const result = expect(speak("Hello")).rejects.toThrow("synthesis-failed");
  await Promise.resolve();
  synthesis.spoken[0].onerror?.({ error: "synthesis-failed" });
  await result;
  expect(isSpeaking()).toBe(false);
  Reflect.deleteProperty(window, "speechSynthesis");
  expect(isSupported()).toBe(false);
  await expect(speak("Hello")).rejects.toThrow("UNSUPPORTED");
});
