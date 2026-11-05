import { gcm } from "@noble/ciphers/aes";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha256";

export const BACKUP_FORMAT = "nextchat-encrypted-backup";
export const BACKUP_ITERATIONS = 600_000;

type BackupHeader = {
  format: typeof BACKUP_FORMAT;
  version: 1;
  kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
  cipher: "AES-256-GCM";
  iv: string;
};
export type EncryptedBackup = BackupHeader & { ciphertext: string };

// Chunk sizes are multiples of three so concatenated base64 remains valid.
function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 24_576) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 24_576))));
  }
  return chunks.join("");
}

function fromBase64(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(value) ||
    (value.includes("=") && !/^[^=]+={1,2}$/.test(value))
  )
    throw new Error("INVALID_BACKUP");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const result = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < value.length; i += 32_768) {
    const part = atob(value.slice(i, i + 32_768));
    for (let j = 0; j < part.length; j++) result[offset++] = part.charCodeAt(j);
  }
  return result;
}

function headerOf(value: EncryptedBackup): BackupHeader {
  return {
    format: value.format,
    version: value.version,
    kdf: {
      name: value.kdf.name,
      iterations: value.kdf.iterations,
      salt: value.kdf.salt,
    },
    cipher: value.cipher,
    iv: value.iv,
  };
}

export function looksEncrypted(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.format === BACKUP_FORMAT ||
    ("ciphertext" in record && ("kdf" in record || "iv" in record))
  );
}

export function encryptBackup(value: unknown, password: string): string {
  if (!password) throw new Error("EMPTY_PASSWORD");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: 1,
    kdf: {
      name: "PBKDF2-SHA256",
      iterations: BACKUP_ITERATIONS,
      salt: toBase64(salt),
    },
    cipher: "AES-256-GCM",
    iv: toBase64(iv),
  };
  const key = pbkdf2(sha256, password, salt, {
    c: BACKUP_ITERATIONS,
    dkLen: 32,
  });
  try {
    const encoder = new TextEncoder();
    const encrypted = gcm(
      key,
      iv,
      encoder.encode(JSON.stringify(header)),
    ).encrypt(encoder.encode(JSON.stringify(value)));
    return JSON.stringify({ ...header, ciphertext: toBase64(encrypted) });
  } finally {
    key.fill(0);
  }
}

export function decryptBackup(value: unknown, password: string): unknown {
  if (!password) throw new Error("EMPTY_PASSWORD");
  const data = value as EncryptedBackup;
  if (
    !data ||
    typeof data !== "object" ||
    data.format !== BACKUP_FORMAT ||
    data.version !== 1 ||
    data.cipher !== "AES-256-GCM" ||
    !data.kdf ||
    data.kdf.name !== "PBKDF2-SHA256" ||
    data.kdf.iterations !== BACKUP_ITERATIONS
  )
    throw new Error("INVALID_BACKUP");
  const salt = fromBase64(data.kdf.salt);
  const iv = fromBase64(data.iv);
  const encrypted = fromBase64(data.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || encrypted.length < 16)
    throw new Error("INVALID_BACKUP");
  const key = pbkdf2(sha256, password, salt, {
    c: BACKUP_ITERATIONS,
    dkLen: 32,
  });
  let plaintext: Uint8Array;
  try {
    plaintext = gcm(
      key,
      iv,
      new TextEncoder().encode(JSON.stringify(headerOf(data))),
    ).decrypt(encrypted);
  } catch {
    throw new Error("AUTH_FAILED");
  } finally {
    key.fill(0);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
  } catch {
    throw new Error("INVALID_BACKUP");
  } finally {
    plaintext.fill(0);
  }
}
