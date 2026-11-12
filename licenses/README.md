# Bundled notices

The NextChat notice is kept in the repository root `LICENSE`.

`Bun-1.4.4.md` is the unchanged license notice for the pinned Windows x64 runtime:

- Source: https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/LICENSE.md
- SHA-256: `362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd`
- Preserve LF line endings; the Windows packager verifies the original file hash.

`src-tauri/src/bundled_plugins.rs` embeds both notices into `NextChat.exe`.
They can be read offline under Settings → Open-source licenses. These files are
not copied into the installer resource tree or portable directory.

Source and rebuild instructions for the runtime and plugin remain in
`scripts/build-wire-relay.mjs`, `scripts/wire-relay/`, `scripts/client-bridge/`,
`plugins/`, and `docs/wire-relay.md`.
