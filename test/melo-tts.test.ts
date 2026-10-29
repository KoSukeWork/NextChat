import { jest } from "@jest/globals";
import { isSpeaking, speak, stop } from "../app/utils/local-tts";
import { preprocessMelo, splitMelo } from "../app/utils/melo-tts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let n = 0; n < 15; n++) await Promise.resolve();
};
const audio = btoa("test WAV decoded by the fake Web Audio implementation");
const originals = [
  "__TAURI__",
  "AudioContext",
  "speechSynthesis",
  "SpeechSynthesisUtterance",
].map((name) => [name, Object.getOwnPropertyDescriptor(window, name)] as const);
const localVoice = {
  name: "Local",
  voiceURI: "local",
  lang: "en-US",
  localService: true,
  default: true,
} as SpeechSynthesisVoice;
class Utterance {
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}
class Source {
  buffer?: AudioBuffer;
  onended: (() => void) | null = null;
  connect = jest.fn();
  disconnect = jest.fn();
  start = jest.fn();
  stop = jest.fn();
}
class Context {
  static instances: Context[] = [];
  state = "running";
  destination = {};
  sources: Source[] = [];
  resume = jest.fn(async () => {});
  close = jest.fn(async () => {
    this.state = "closed";
  });
  decodeAudioData = jest.fn(
    async (_buffer: ArrayBuffer) => ({ length: 100 }) as AudioBuffer,
  );
  createBufferSource = () => {
    const source = new Source();
    this.sources.push(source);
    return source;
  };
  constructor() {
    Context.instances.push(this);
  }
}
let requests: {
  text: string;
  session: number;
  job: ReturnType<typeof deferred<string>>;
}[];
let spoken: Utterance[];
let invoke: ReturnType<
  typeof jest.fn<
    (command: string, args?: Record<string, unknown>) => Promise<unknown>
  >
>;

beforeEach(() => {
  requests = [];
  spoken = [];
  Context.instances = [];
  let session = 0;
  invoke = jest.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "melo_begin_speech") return ++session;
    if (command === "melo_synthesize") {
      const job = deferred<string>();
      requests.push({
        text: args!.text as string,
        session: args!.session as number,
        job,
      });
      return job.promise;
    }
    return undefined;
  });
  const synthesis = Object.assign(new EventTarget(), {
    getVoices: () => [localVoice],
    cancel: jest.fn(),
    speak: jest.fn((utterance: Utterance) => {
      spoken.push(utterance);
    }),
  });
  for (const [name, value] of Object.entries({
    __TAURI__: { invoke },
    AudioContext: Context,
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: Utterance,
  }))
    Object.defineProperty(window, name, { configurable: true, value });
});
afterEach(async () => {
  stop();
  for (const request of requests) request.job.resolve(audio);
  await flush();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(window, name, descriptor);
    else Reflect.deleteProperty(window, name);
  }
});

test("normalizes percentage by sentence language and keeps versions and Unicode intact", () => {
  expect(preprocessMelo("当前完成85%；继续。Progress is 85.5%.")).toBe(
    "当前完成百分之85,继续。Progress is 85.5 percent.",
  );
  expect(preprocessMelo("中文. Completed 12%. 下一句完成20％。")).toBe(
    "中文. Completed 12 percent. 下一句完成百分之20。",
  );
  expect(splitMelo("使用 v2.16.1，进度85%。Open example.com. Next!")).toEqual([
    "使用 v2.16.1，",
    "进度百分之85。",
    "Open example.com.",
    "Next!",
  ]);
  expect(splitMelo("😊".repeat(401))).toEqual([]);
  expect(splitMelo("你好😊世界。🎉\n**\n---\n•\n...\n👩‍💻👍🏽🇨🇳")).toEqual([
    "你好世界。",
  ]);
  expect(splitMelo("Hello 👩‍💻world! 123 1️⃣.")).toEqual([
    "Hello world!",
    "123 1.",
  ]);
  expect(
    splitMelo("汉".repeat(401)).map((part) => Array.from(part).length),
  ).toEqual([150, 150, 101]);
});

test("only the first sufficiently readable comma ends an early chunk", () => {
  expect(
    splitMelo(
      "你好，先检查本地环境，再确认 API 地址，最后启动服务。下一句，保持完整。",
    ),
  ).toEqual([
    "你好，先检查本地环境，",
    "再确认 API 地址，最后启动服务。",
    "下一句，保持完整。",
  ]);
  expect(splitMelo("一二三四五，六七。下一句，继续。")).toEqual([
    "一二三四五，六七。",
    "下一句，继续。",
  ]);
  expect(splitMelo("，，😊，一二三四五六，七八，九十。")).toEqual([
    "，，，一二三四五六，",
    "七八，九十。",
  ]);
});

test("long sentences prefer the latest comma within 150 Unicode characters", () => {
  const prefix = "首句结束。";
  const body =
    "甲".repeat(80) + "，" + "乙".repeat(50) + "," + "丙".repeat(40) + "。";
  expect(splitMelo(prefix + body)).toEqual([
    prefix,
    "甲".repeat(80) + "，" + "乙".repeat(50) + ",",
    "丙".repeat(40) + "。",
  ]);
  expect(
    splitMelo(prefix + "𠀀".repeat(301)).map(
      (chunk) => Array.from(chunk).length,
    ),
  ).toEqual([5, 150, 150, 1]);
  expect(
    splitMelo("First sentence. Use v2.16.1, example.com and 3.14. Done!"),
  ).toEqual(["First sentence.", "Use v2.16.1, example.com and 3.14.", "Done!"]);
});

test("trailing emoji and symbol blocks finish without inference or fallback", async () => {
  const onFallback = jest.fn();
  const done = speak("Finished. 😊\n**\n---\n•", {
    engine: "melo",
    onFallback,
  });
  await flush();
  expect(requests.map((r) => r.text)).toEqual(["Finished."]);
  requests[0].job.resolve(audio);
  await flush();
  Context.instances[0].sources[0].onended?.();
  await done;
  expect(requests).toHaveLength(1);
  expect(onFallback).not.toHaveBeenCalled();
  expect(spoken).toHaveLength(0);
});

test("symbol-only input is a silent no-op", async () => {
  const onFallback = jest.fn();
  await speak("😊 ** --- •", { engine: "melo", onFallback });
  expect(requests).toHaveLength(0);
  expect(Context.instances).toHaveLength(0);
  expect(onFallback).not.toHaveBeenCalled();
  expect(spoken).toHaveLength(0);
});

test.each(["EMPTY_SPEECH", "INVALID_SPEECH_INPUT", "SYNTHESIS_FAILED"])(
  "skips a middle sentence with %s and continues without notification",
  async (reason) => {
    const onFallback = jest.fn();
    const done = speak("First. Bad. Last.", { engine: "melo", onFallback });
    await flush();
    requests[0].job.resolve(audio);
    await flush();
    requests[1].job.reject(reason);
    Context.instances[0].sources[0].onended?.();
    await flush();
    expect(requests.map((r) => r.text)).toEqual(["First.", "Bad.", "Last."]);
    requests[2].job.resolve(audio);
    await flush();
    Context.instances[0].sources[1].onended?.();
    await done;
    expect(onFallback).not.toHaveBeenCalled();
    expect(spoken).toHaveLength(0);
  },
);

test("decode failure skips the first sentence and permits later playback", async () => {
  const onFallback = jest.fn();
  const done = speak("Bad. Last.", { engine: "melo", onFallback });
  await flush();
  const context = Context.instances[0];
  context.decodeAudioData.mockRejectedValueOnce(new Error("Invalid WAV"));
  requests[0].job.resolve(audio);
  await flush();
  requests[1].job.resolve(audio);
  await flush();
  expect(context.sources).toHaveLength(1);
  context.sources[0].onended?.();
  await done;
  expect(onFallback).not.toHaveBeenCalled();
  expect(spoken).toHaveLength(0);
});

test("all sentences failing triggers one fallback only after trying the last", async () => {
  const onFallback = jest.fn();
  const done = speak("Bad. Also bad.", { engine: "melo", onFallback });
  await flush();
  requests[0].job.reject("EMPTY_SPEECH");
  await flush();
  expect(onFallback).not.toHaveBeenCalled();
  expect(spoken).toHaveLength(0);
  requests[1].job.reject("SYNTHESIS_FAILED");
  await flush();
  expect(onFallback).toHaveBeenCalledTimes(1);
  expect(Context.instances[0].sources).toHaveLength(0);
  expect(spoken[0].text).toBe("Bad.");
  spoken[0].onend?.();
  await flush();
  expect(spoken[1].text).toBe("Also bad.");
  spoken[1].onend?.();
  await done;
});

test.each([
  "MODEL_NOT_READY",
  "MODEL_LOAD_FAILED",
  "MODEL_STATE_FAILED",
  "AUDIO_UNAVAILABLE",
])(
  "fatal %s after playback stops and notifies without repeating",
  async (reason) => {
    const onFallback = jest.fn();
    const done = speak("First. Last.", { engine: "melo", onFallback });
    await flush();
    requests[0].job.resolve(audio);
    await flush();
    requests[1].job.reject(reason);
    Context.instances[0].sources[0].onended?.();
    await done;
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ message: reason, playbackStarted: true }),
    );
    expect(spoken).toHaveLength(0);
    expect(isSpeaking()).toBe(false);
  },
);

test("native cancellation is silent even without a frontend stop", async () => {
  const onFallback = jest.fn();
  const done = speak("Cancelled.", { engine: "melo", onFallback });
  await flush();
  requests[0].job.reject("CANCELLED");
  await done;
  expect(onFallback).not.toHaveBeenCalled();
  expect(spoken).toHaveLength(0);
});

test("a failed last sentence after successful playback ends silently", async () => {
  const onFallback = jest.fn();
  const done = speak("Finished. Unsupported.", { engine: "melo", onFallback });
  await flush();
  requests[0].job.resolve(audio);
  await flush();
  requests[1].job.reject("EMPTY_SPEECH");
  Context.instances[0].sources[0].onended?.();
  await done;
  expect(onFallback).not.toHaveBeenCalled();
  expect(spoken).toHaveLength(0);
});

test("an empty decoded buffer falls back when nothing could play", async () => {
  const onFallback = jest.fn();
  const done = speak("Empty audio.", { engine: "melo", onFallback });
  await flush();
  Context.instances[0].decodeAudioData.mockResolvedValueOnce({
    length: 0,
  } as AudioBuffer);
  requests[0].job.resolve(audio);
  await flush();
  expect(onFallback).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "EMPTY_SPEECH",
      playbackStarted: false,
    }),
  );
  expect(Context.instances[0].sources).toHaveLength(0);
  spoken[0].onend?.();
  await done;
});

test("cancellation during a failed decode never falls back", async () => {
  const onFallback = jest.fn();
  const decoding = deferred<AudioBuffer>();
  const done = speak("Pending decode.", { engine: "melo", onFallback });
  await flush();
  Context.instances[0].decodeAudioData.mockReturnValueOnce(decoding.promise);
  requests[0].job.resolve(audio);
  await flush();
  stop();
  await done;
  decoding.reject(new Error("Invalid WAV"));
  await flush();
  expect(onFallback).not.toHaveBeenCalled();
  expect(spoken).toHaveLength(0);
});

test("pipelines one sentence ahead and stop drops prefetched and in-flight audio", async () => {
  const done = speak("First. Second. Third.", { engine: "melo" });
  await flush();
  expect(requests.map((r) => r.text)).toEqual(["First."]);
  requests[0].job.resolve(audio);
  await flush();
  expect(requests.map((r) => r.text)).toEqual(["First.", "Second."]);
  const context = Context.instances[0];
  expect(context.sources).toHaveLength(1);
  expect(context.sources[0].start).toHaveBeenCalled();
  requests[1].job.resolve(audio);
  await flush();
  expect(context.sources).toHaveLength(1);
  context.sources[0].onended?.();
  await flush();
  expect(requests).toHaveLength(3);
  expect(context.sources).toHaveLength(2);
  stop();
  await done;
  expect(isSpeaking()).toBe(false);
  expect(context.sources[1].stop).toHaveBeenCalled();
  requests[2].job.resolve(audio);
  await flush();
  expect(context.sources).toHaveLength(2);
  expect(spoken).toHaveLength(0);
  expect(invoke).toHaveBeenCalledWith("melo_cancel_speech", {
    session: requests[0].session,
  });
});

test("switching to system speech resolves old Melo immediately and cannot replay stale audio", async () => {
  const old = speak("Old neural text.", { engine: "melo" });
  await flush();
  const current = speak("New system text.", { engine: "system" });
  await flush();
  await old;
  expect(spoken.map((item) => item.text)).toEqual(["New system text."]);
  requests[0].job.resolve(audio);
  await flush();
  expect(Context.instances[0].sources).toHaveLength(0);
  spoken[0].onend?.();
  await current;
});

test.each(["MODEL_NOT_READY", "MODEL_LOAD_FAILED", "SYNTHESIS_FAILED"])(
  "falls back locally with a reason for %s",
  async (reason) => {
    const onFallback = jest.fn();
    const done = speak("Read this message.", { engine: "melo", onFallback });
    await flush();
    requests[0].job.reject(new Error(reason));
    await flush();
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ message: reason }),
    );
    expect(spoken[0].text).toBe("Read this message.");
    spoken[0].onend?.();
    await done;
  },
);

test("a late inference failure after stop never triggers fallback", async () => {
  const onFallback = jest.fn();
  const done = speak("Old message.", { engine: "melo", onFallback });
  await flush();
  stop();
  await done;
  requests[0].job.reject(new Error("SYNTHESIS_FAILED"));
  await flush();
  expect(onFallback).not.toHaveBeenCalled();
  expect(spoken).toHaveLength(0);
});

test("stopping while a native session starts cancels the returned session without inference", async () => {
  const beginning = deferred<number>();
  invoke.mockImplementation(async (command) =>
    command === "melo_begin_speech" ? beginning.promise : undefined,
  );
  const done = speak("Pending start.", { engine: "melo" });
  await flush();
  stop();
  await done;
  beginning.resolve(42);
  await flush();
  expect(invoke).toHaveBeenCalledWith("melo_cancel_speech", { session: 42 });
  expect(
    invoke.mock.calls.some(([command]) => command === "melo_synthesize"),
  ).toBe(false);
});

test("Web uses system speech even when imported settings selected Melo", async () => {
  Reflect.deleteProperty(window, "__TAURI__");
  const done = speak("Browser message.", { engine: "melo" });
  await flush();
  expect(invoke).not.toHaveBeenCalled();
  expect(spoken[0].text).toBe("Browser message.");
  spoken[0].onend?.();
  await done;
});
