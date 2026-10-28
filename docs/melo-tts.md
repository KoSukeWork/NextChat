# Desktop MeloTTS

The default remains **System voice**. Desktop settings additionally offer MeloTTS
(one local Chinese/English female voice), model download/import/delete, speech
rate and a preview. Pitch and system-voice selection are only shown for System
voice. Web always uses system speech, including when imported configuration
contains `engine: "melo"`.

## Native runtime and builds

The app uses the official `sherpa-onnx = 2.0.1` Rust wrapper over the matching
official C API, with static sherpa-onnx and ONNX Runtime libraries. This avoids
hand-maintained FFI layouts and the older API used by `sherpa-rs 0.6.8`.

Native archive sources, exact sizes and SHA256 digests are pinned in
`scripts/sherpa-native.json`. `scripts/with-sherpa.mjs` checks the digest **before**
extracting into the ignored Cargo target directory. `.cargo/config.toml` directs
Cargo to this prepared directory, preventing the dependency's default unchecked
download in normal project-root builds. Windows uses the MT archive and static
CRT target feature. The x64 Windows archive is:

- [sherpa-onnx-v2.0.1-win-x64-static-MT-Release-lib.tar.bz2](https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-static-MT-Release-lib.tar.bz2)
- SHA256: `23e7b986b197eda0bbc47ff3d7d5c87afd6ef2b9077214ba26b0f1ec52ef0e66`

From the repository root:

```powershell
corepack yarn app:prepare-native
corepack yarn app:build
```

For an offline build, set `NEXTCHAT_SHERPA_ARCHIVE` to the downloaded archive;
the same size and hash checks apply. `app:dev` also prepares native libraries.
Plain Web `corepack yarn build` does not download or link native dependencies.
The manifest includes Linux/macOS/ARM64 assets, but this change was built and
tested on Windows x64 only.

The Windows portable build measured 30,495,232 bytes versus 11,699,712 bytes
before this change: **+18,795,520 bytes (+18.80 MB)**. This is below the agreed
30 MB increase limit. Its PE imports contain only Windows system libraries;
there is no separate sherpa-onnx/onnxruntime DLL. Existing Tauri/WebView2 system
requirements remain. No separate runtime ZIP is needed for this static route.

## Model installation

Model directory: `{app_local_data_dir}/tts/vits-melo-tts-zh_en/`.

- [Official model archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2)
- Compressed size: **167,006,755 bytes**.
- SHA256: `e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514`.
- Complete extracted model package: **191,246,256 bytes**, excluding the small
  installation marker.

Downloads stream into a private temporary directory and emit bounded progress
events. Cancellation interrupts pending HTTP reads as well as hash/extraction
work. Import uses a native file picker, copies the selected archive into private
staging, and follows the same verification and publication path. IPC accepts no
caller-provided download URL, digest or destination directory.

Extraction rejects absolute/drive/UNC paths, `..`, backslashes, alternate data
streams, Windows device names, symbolic links, hard links and special entries.
It only creates ordinary files/directories under the expected archive root,
limits extracted size/count, checks required files, then renames the complete
model directory atomically. Failed/cancelled operations discard their temporary
directory. A process crash can leave an unpublished temporary directory; it is
never treated as an installed model. The app does not sweep other instances'
temporary directories on startup.

No webview filesystem permission was added. The model directory is explicitly
forbidden to generic webview filesystem IPC, including file-dialog grants. Only
the narrow model-management/synthesis commands operate on it. Model readiness
errors do not prevent app startup or system speech.

## Playback and lifetime

- `local-tts.ts` is the engine facade; `system-tts.ts` retains the existing local
  browser speech behavior and rejects cloud-only browser voices.
- Melo preprocessing expands percentages according to sentence language and
  converts semicolons into commas. Sentence splitting preserves numeric
  decimals, version numbers and Unicode codepoints. Emoji (including flags and
  joined sequences) are removed; chunks without any letter or number are skipped.
- Messages still use the existing Markdown-to-text/context-content path, so
  reasoning content remains excluded.
- Web Audio plays one sentence while the next is synthesized. There is at most
  one sentence of prefetch, and WAV is transferred as 16-bit PCM base64.
- A native generation token is checked before waiting, after acquiring the model
  mutex, in callbacks and after inference. Stop/message/engine switches discard
  queued and in-flight old results; stopping resolves the UI immediately.
- Inference runs on blocking worker threads with `min(4, physical cores)` CPU
  threads. The model is lazy loaded and dropped after five idle minutes (checked
  every 15 seconds), or before model deletion. No model data is embedded in the
  executable.
- Sentence-local synthesis, empty-audio and decoding errors are debug-logged and
  skipped. If every attempted sentence fails before playback, system speech is
  used with a localized notification. Engine failures also fall back only before
  playback starts; after playback they stop with a notification and never repeat
  the message. Cancellation is silent and never restarts speech.
- The pinned native API returns null for unsupported emoji and symbols such as
  `**` and `•`, reported as `SYNTHESIS_FAILED`. It cannot distinguish that null
  result from other inference failures. An audio object with zero samples instead
  returns `EMPTY_SPEECH`; both are handled as sentence-local errors.
- Persisted configuration is version **4.4**; older/unknown engines migrate to
  `system`, while valid `melo` selections are preserved.

## Validation

```powershell
corepack yarn tsc --noEmit
node --no-warnings --experimental-vm-modules node_modules/jest/bin/jest.js --ci --runInBand
cargo test --manifest-path src-tauri/Cargo.toml --release --no-default-features
```

The direct Jest command avoids the existing `$(yarn bin jest)` shell substitution
in `test:ci`, which Windows command shells do not implement.

Real-model tests are opt-in and do not download test fixtures automatically:

```powershell
$env:NEXTCHAT_MELO_TEST_MODEL='absolute path to verified extracted Melo model'
$env:NEXTCHAT_MELO_TEST_ARCHIVE='absolute path to official model tar.bz2'
cargo test --manifest-path src-tauri/Cargo.toml --release --no-default-features -- --include-ignored --nocapture
```

Verified on Windows x64: 47 Jest suites / 300 tests; 16 Rust tests including the
three real-model tests; TypeScript; desktop packaging; normal Web build (initial
integration). The trailing-content fix reran TypeScript, Jest, Rust and desktop
packaging. Tests
cover traversal/links, wrong hashes, stalled-download cancellation, actual
167 MB local HTTP transfer, atomic installation, synthesis, deletion, idle
unload, stale requests, pipeline stop/switch/fallback, settings and migration.
Playback regression tests cover trailing emoji and symbols, a failed middle or
last sentence, all sentences failing, fatal errors after playback, decode errors,
empty decoded audio, and cancellation while inference or decoding is pending.

An isolated four-thread Rust integration run generated the evaluation short
Chinese sentence in **0.477 s**, with **RTF 0.188**, near the Python evaluation's
0.524 s median. A mixed short paragraph measured RTF 0.229 (a shorter text than
the full Python mixed paragraph). Whole-suite concurrent tests can vary.

Actual speaker output, the native file-picker interaction, and downloading from
GitHub inside the final executable still need manual confirmation. The complete
download/install path was tested with the actual official archive served over
local HTTP. The native/model archives used for building and testing were
downloaded from official GitHub releases and SHA256-verified.
