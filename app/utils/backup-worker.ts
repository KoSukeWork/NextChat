import { decryptBackup, encryptBackup, looksEncrypted } from "./backup-crypto";

type Request =
  | { id: number; type: "encrypt"; data: unknown; password: string }
  | { id: number; type: "open"; text: string }
  | { id: number; type: "decrypt"; password: string };

const worker = self as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (message: unknown) => void;
};
let encryptedFile: unknown;

worker.onmessage = ({ data: request }) => {
  try {
    let result: unknown;
    if (request.type === "encrypt") {
      result = encryptBackup(request.data, request.password);
    } else if (request.type === "open") {
      const parsed: unknown = JSON.parse(request.text);
      if (looksEncrypted(parsed)) {
        encryptedFile = parsed;
        result = { encrypted: true };
      } else {
        result = { encrypted: false, backup: parsed };
      }
    } else {
      result = decryptBackup(encryptedFile, request.password);
    }
    worker.postMessage({ id: request.id, result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "INVALID_BACKUP";
    worker.postMessage({
      id: request.id,
      error: code === "AUTH_FAILED" ? code : "INVALID_BACKUP",
    });
  }
};
