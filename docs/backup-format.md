# Local backup format

Local exports are encrypted JSON files. The password is not saved; a forgotten
password cannot be recovered. Older plaintext JSON exports can still be imported.
Cloud synchronization is separate and retains its existing scope and format.

Version 1 uses AES-256-GCM with a fresh 16-byte salt and 12-byte IV for every
export. PBKDF2-HMAC-SHA256 derives a 32-byte key from the password's UTF-8 bytes
using 600,000 iterations. The `ciphertext` field is base64-encoded ciphertext
followed by the 16-byte GCM tag. Salt and IV are also base64 encoded.

```json
{
  "format": "nextchat-encrypted-backup",
  "version": 1,
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "..." },
  "cipher": "AES-256-GCM",
  "iv": "...",
  "ciphertext": "..."
}
```

The GCM additional authenticated data is the UTF-8 encoding of the compact
`JSON.stringify` representation of the header above, in the displayed key
order, without `ciphertext`. The decrypted plaintext is a UTF-8 JSON backup.
Version 1 requires the parameters shown above. Export and decryption run in a
worker, using the pinned `@noble/ciphers` and `@noble/hashes` dependencies, so
they work in ordinary HTTP contexts without `crypto.subtle`.
