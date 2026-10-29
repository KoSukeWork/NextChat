import { meloClient, meloErrorCode } from "./melo-client";
import { speechValue } from "./system-tts";

export function preprocessMelo(text: string): string {
  const percentages = text.replace(
    /(-?\d+(?:\.\d+)?)\s*[%％]/gu,
    (match, number, offset: number) => {
      const before =
        text
          .slice(0, offset)
          .split(/[。！？!?;；\n]|\.(?=\s|$)/u)
          .at(-1) ?? "";
      const after = text
        .slice(offset + match.length)
        .split(/[。！？!?;；\n]|\.(?=\s|$)/u)[0];
      const chinese = /[\u3400-\u9fff]/u.test(before + after);
      return chinese ? `百分之${number}` : `${number} percent`;
    },
  );
  return (
    percentages
      .replace(/[；;]/gu, ",")
      // Include flags, skin tones, keycaps and emoji sequence control characters.
      // Do not use Emoji: that Unicode property also includes ordinary digits.
      .replace(
        /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0e\ufe0f\u20e3\u{e0020}-\u{e007f}\0]/gu,
        "",
      )
  );
}

export function splitMelo(text: string, maxLength = 150): string[] {
  const characters = Array.from(preprocessMelo(text).trim());
  const chunks: string[] = [];
  const limit = Math.max(1, Math.floor(maxLength));
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + limit, characters.length);
    let comma = -1;
    let readable = 0;
    for (let index = start; index < end; index++) {
      const character = characters[index];
      if (/[\p{L}\p{N}]/u.test(character)) readable++;
      // Preserve decimal numbers, versions and domains inside a sentence.
      const period =
        character === "." &&
        !(
          /[\p{L}\p{N}]/u.test(characters[index - 1] ?? "") &&
          /[\p{L}\p{N}]/u.test(characters[index + 1] ?? "")
        );
      const isComma = /[，,]/u.test(character);
      if (isComma && readable >= 6) comma = index + 1;
      if (
        /[。！？!?\n]/u.test(character) ||
        period ||
        (chunks.length === 0 && isComma && readable >= 6)
      ) {
        end = index + 1;
        comma = -1;
        break;
      }
    }
    // At the length limit prefer the last comma; otherwise keep the sentence.
    if (end < characters.length && end === start + limit && comma > start)
      end = comma;
    const chunk = characters.slice(start, end).join("").trim();
    if (/[\p{L}\p{N}]/u.test(chunk)) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

export class MeloSpeechError extends Error {
  constructor(
    error: unknown,
    public readonly playbackStarted: boolean,
  ) {
    super(error instanceof Error ? error.message : String(error));
  }
}

const sentenceErrors = new Set([
  "EMPTY_SPEECH",
  "INVALID_SPEECH_INPUT",
  "SYNTHESIS_FAILED",
  "AUDIO_DECODE_FAILED",
]);

type Job = {
  cancelled: boolean;
  playbackStarted: boolean;
  session?: number;
  context?: AudioContext;
  source?: AudioBufferSourceNode;
  finishAudio?: () => void;
  stopped: Promise<void>;
  finish: () => void;
};

let active: Job | undefined;

function close(job: Job) {
  job.source?.disconnect();
  if (job.context && job.context.state !== "closed")
    void job.context.close().catch(() => {});
}

export function stopMelo() {
  const job = active;
  active = undefined;
  if (!job) return;
  job.cancelled = true;
  if (job.session !== undefined)
    void meloClient.cancel(job.session).catch(() => {});
  if (job.source) {
    job.source.onended = null;
    try {
      job.source.stop();
    } catch {
      /* It may already have ended. */
    }
  }
  job.finishAudio?.();
  job.finish();
  close(job);
}

export const isMeloSpeaking = () => !!active;

async function play(job: Job, encoded: string) {
  if (job.cancelled) return;
  const context = job.context!;
  let buffer: AudioBuffer;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    buffer = await context.decodeAudioData(bytes.buffer);
  } catch {
    throw new Error("AUDIO_DECODE_FAILED");
  }
  if (job.cancelled) return;
  if (!buffer.length) throw new Error("EMPTY_SPEECH");
  await new Promise<void>((resolve, reject) => {
    const source = context.createBufferSource();
    job.source = source;
    job.finishAudio = resolve;
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      source.disconnect();
      job.source = undefined;
      job.finishAudio = undefined;
      resolve();
    };
    try {
      source.start();
      job.playbackStarted = true;
    } catch {
      reject(new Error("AUDIO_UNAVAILABLE"));
    }
  });
}

export function speakMelo(text: string, rate?: number): Promise<void> {
  stopMelo();
  const chunks = splitMelo(text);
  if (!chunks.length) return Promise.resolve();
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const job: Job = {
    cancelled: false,
    playbackStarted: false,
    stopped,
    finish,
  };
  active = job;
  const run = async () => {
    if (typeof window.AudioContext !== "function")
      throw new Error("AUDIO_UNAVAILABLE");
    // Create/resume in the user's click turn, before awaiting native inference.
    try {
      job.context = new window.AudioContext();
      await job.context.resume();
    } catch {
      throw new Error("AUDIO_UNAVAILABLE");
    }
    if (job.cancelled) return;
    job.session = await meloClient.begin();
    if (job.cancelled) {
      await meloClient.cancel(job.session).catch(() => {});
      return;
    }
    const synthesize = (index: number) =>
      meloClient
        .synthesize(job.session!, chunks[index], speechValue(rate))
        .then(
          (audio) => ({ audio, error: undefined }),
          (error: unknown) => ({ audio: undefined, error }),
        );
    let next = synthesize(0);
    let lastSentenceError: unknown;
    for (let index = 0; index < chunks.length; index++) {
      const result = await next;
      if (job.cancelled) return;
      if (
        result.error !== undefined &&
        !sentenceErrors.has(meloErrorCode(result.error))
      )
        throw result.error;
      // At most one sentence ahead; attach rejection handlers immediately.
      if (index + 1 < chunks.length) next = synthesize(index + 1);
      try {
        if (result.error !== undefined) throw result.error;
        await play(job, result.audio!);
      } catch (error) {
        if (job.cancelled) return;
        if (!sentenceErrors.has(meloErrorCode(error))) throw error;
        lastSentenceError = error;
        console.debug("MeloTTS skipped a sentence:", meloErrorCode(error));
      }
      if (job.cancelled) return;
    }
    if (!job.playbackStarted)
      throw lastSentenceError ?? new Error("EMPTY_SPEECH");
  };
  const completed = run()
    .catch((error) => {
      if (job.cancelled || meloErrorCode(error) === "CANCELLED") return;
      throw new MeloSpeechError(error, job.playbackStarted);
    })
    .finally(() => {
      if (job.session !== undefined)
        void meloClient.cancel(job.session).catch(() => {});
      if (active === job) active = undefined;
      close(job);
    });
  // Stopping resolves the UI immediately, even if a native sentence is in flight.
  return Promise.race([completed, stopped]);
}
