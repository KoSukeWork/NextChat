import { useEffect, useState } from "react";
import { isSupported, subscribeVoices } from "./local-tts";

export function useLocalTTS() {
  const [supported, setSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    setSupported(isSupported());
    return subscribeVoices(setVoices);
  }, []);
  return { supported, voices };
}
