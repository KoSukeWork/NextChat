import { TextEncoder, TextDecoder } from "util";
import {
  encryptBackup,
  decryptBackup,
  looksEncrypted,
  BACKUP_FORMAT,
  BACKUP_ITERATIONS,
} from "../app/utils/backup-crypto";
import { validateBackupPassword } from "../app/utils/backup-password";

Object.assign(global, { TextEncoder, TextDecoder });

test("encrypted backup round trips Chinese and special characters without WebCrypto subtle", () => {
  const password = "密码🔐\n!@#$%^&*'\"\\";
  const backup = { key: "sample-secret", chat: "你好，世界", plugins: [1, 2] };
  const first = encryptBackup(backup, password);
  const second = encryptBackup(backup, password);
  const envelope = JSON.parse(first);
  expect(envelope.format).toBe(BACKUP_FORMAT);
  expect(envelope.kdf.iterations).toBe(BACKUP_ITERATIONS);
  expect(first).not.toContain("sample-secret");
  expect(first).not.toContain("你好，世界");
  expect(envelope.kdf.salt).not.toBe(JSON.parse(second).kdf.salt);
  expect(envelope.iv).not.toBe(JSON.parse(second).iv);
  expect(looksEncrypted(envelope)).toBe(true);
  expect(decryptBackup(envelope, password)).toEqual(backup);
}, 30000);

test("wrong password and tampering fail authentication without touching the input", () => {
  const envelope = JSON.parse(encryptBackup({ data: "secret" }, "correct"));
  const before = JSON.stringify(envelope);
  expect(() => decryptBackup(envelope, "wrong")).toThrow("AUTH_FAILED");
  expect(JSON.stringify(envelope)).toBe(before);
  const altered = {
    ...envelope,
    ciphertext:
      (envelope.ciphertext[0] === "A" ? "B" : "A") +
      envelope.ciphertext.slice(1),
  };
  expect(() => decryptBackup(altered, "correct")).toThrow("AUTH_FAILED");
  const alteredSalt = {
    ...envelope,
    kdf: {
      ...envelope.kdf,
      salt:
        (envelope.kdf.salt[0] === "A" ? "B" : "A") + envelope.kdf.salt.slice(1),
    },
  };
  expect(() => decryptBackup(alteredSalt, "correct")).toThrow("AUTH_FAILED");
  const alteredVersion = { ...envelope, version: 2 };
  expect(() => decryptBackup(alteredVersion, "correct")).toThrow(
    "INVALID_BACKUP",
  );
}, 30000);

test("legacy plaintext backups remain distinguishable and empty or mismatched passwords fail", () => {
  expect(looksEncrypted({ "chat-next-web-store": { sessions: [] } })).toBe(
    false,
  );
  expect(validateBackupPassword("", "")).toBe("empty");
  expect(validateBackupPassword("one", "two")).toBe("mismatch");
  expect(validateBackupPassword("中文!", "中文!")).toBeUndefined();
  expect(() => encryptBackup({}, "")).toThrow("EMPTY_PASSWORD");
});
