import Locale from "../locales";
import { meloErrorCode } from "../utils/melo-client";
import { MeloSpeechError } from "../utils/melo-tts";
import { showToast } from "./ui-lib";

export function meloErrorMessage(error: unknown) {
  const errors: Record<string, string> = Locale.Settings.TTS.Melo.Errors;
  return errors[meloErrorCode(error)] ?? Locale.Settings.TTS.Melo.UnknownError;
}

export function showSpeechFallback(error: unknown) {
  const message = meloErrorMessage(error);
  showToast(
    error instanceof MeloSpeechError && error.playbackStarted
      ? Locale.Settings.TTS.Melo.Stopped(message)
      : Locale.Settings.TTS.Melo.Fallback(message),
  );
}
