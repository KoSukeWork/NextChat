import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/** Stable across reloads and different for each endpoint/conversation pair. */
export function pluginSessionId(endpointId: string, conversationId: string) {
  const hex = bytesToHex(
    sha256(utf8ToBytes(JSON.stringify([endpointId, conversationId]))),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(
    13,
    16,
  )}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
