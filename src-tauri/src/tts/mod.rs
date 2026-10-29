mod loudness;
mod model;
#[cfg(test)]
mod phrase_probe;

use base64::{engine::general_purpose::STANDARD, Engine};
use model::Result;
use serde::Serialize;
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig,
    OfflineTtsVitsModelConfig,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, State};
use tokio_util::sync::CancellationToken;

const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
type EventSink = Arc<dyn Fn(ModelStatus) + Send + Sync>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub size: u64,
    pub error: Option<String>,
    pub operation_id: Option<u64>,
    pub revision: u64,
}

struct ModelState {
    status: ModelStatus,
    operation: Option<(u64, CancellationToken)>,
}
struct EngineSlot {
    model: Option<OfflineTts>,
    last_used: Instant,
}

pub struct TtsState {
    root: PathBuf,
    model_state: Mutex<ModelState>,
    next_operation: AtomicU64,
    generation: Arc<AtomicU64>,
    engine: Mutex<EngineSlot>,
    closed: AtomicBool,
    sink: Mutex<Option<EventSink>>,
}

impl TtsState {
    pub fn new(root: PathBuf, sink: EventSink) -> Result<Arc<Self>> {
        // A broken/unwritable model store must not prevent system speech or app startup.
        let readiness = (|| {
            fs::create_dir_all(&root).map_err(|e| format!("MODEL_IO: {e}"))?;
            model::reject_link(&root)?;
            model::ready_size(&root.join(model::NAME))
        })();
        let (size, error) = match readiness {
            Ok(value) => (value, None),
            Err(error) => (None, Some(error)),
        };
        let state = Arc::new(Self {
            root,
            model_state: Mutex::new(ModelState {
                status: ModelStatus {
                    phase: if size.is_some() {
                        "ready"
                    } else if error.is_some() {
                        "error"
                    } else {
                        "missing"
                    }
                    .into(),
                    downloaded: 0,
                    total: model::DOWNLOAD_BYTES,
                    size: size.unwrap_or(0),
                    error,
                    operation_id: None,
                    revision: 0,
                },
                operation: None,
            }),
            next_operation: AtomicU64::new(1),
            generation: Arc::new(AtomicU64::new(1)),
            engine: Mutex::new(EngineSlot {
                model: None,
                last_used: Instant::now(),
            }),
            closed: AtomicBool::new(false),
            sink: Mutex::new(Some(sink)),
        });
        let weak = Arc::downgrade(&state);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(15));
            let Some(state) = weak.upgrade() else {
                break;
            };
            if state.closed.load(Ordering::Acquire) {
                break;
            }
            state.unload_idle(Instant::now());
        });
        Ok(state)
    }

    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(state) = self.model_state.lock() {
            if let Some((_, token)) = &state.operation {
                token.cancel();
            }
        }
        if let Ok(mut sink) = self.sink.lock() {
            sink.take();
        }
    }

    fn emit(&self, status: ModelStatus) {
        let sink = self.sink.lock().ok().and_then(|sink| sink.clone());
        if let Some(sink) = sink {
            sink(status);
        }
    }

    pub fn status(&self) -> Result<ModelStatus> {
        Ok(self
            .model_state
            .lock()
            .map_err(|_| "MODEL_STATE_FAILED")?
            .status
            .clone())
    }

    fn begin_operation(&self, phase: &str) -> Result<(u64, CancellationToken, ModelStatus)> {
        let mut state = self.model_state.lock().map_err(|_| "MODEL_STATE_FAILED")?;
        if state.operation.is_some() {
            return Err("MODEL_BUSY".into());
        }
        if phase != "deleting" && self.root.join(model::NAME).exists() {
            return Err("MODEL_ALREADY_EXISTS".into());
        }
        let id = self.next_operation.fetch_add(1, Ordering::Relaxed);
        let token = CancellationToken::new();
        state.operation = Some((id, token.clone()));
        state.status.phase = phase.into();
        state.status.error = None;
        state.status.downloaded = 0;
        state.status.operation_id = Some(id);
        state.status.revision += 1;
        let status = state.status.clone();
        drop(state);
        self.emit(status.clone());
        Ok((id, token, status))
    }

    fn progress(&self, id: u64, phase: &str, downloaded: u64) {
        let Ok(mut state) = self.model_state.lock() else {
            return;
        };
        if state.status.operation_id != Some(id) {
            return;
        }
        state.status.phase = phase.into();
        state.status.downloaded = downloaded;
        state.status.revision += 1;
        let status = state.status.clone();
        drop(state);
        self.emit(status);
    }

    fn finish(&self, id: u64, result: Result<u64>) {
        let Ok(mut state) = self.model_state.lock() else {
            return;
        };
        if state.status.operation_id != Some(id) {
            return;
        }
        state.operation = None;
        state.status.operation_id = None;
        match result {
            Ok(size) => {
                state.status.size = size;
                state.status.phase = if size > 0 { "ready" } else { "missing" }.into();
                state.status.error = None;
            }
            Err(error) => {
                state.status.phase = if error == "CANCELLED" {
                    "missing"
                } else {
                    "error"
                }
                .into();
                state.status.error = if error == "CANCELLED" {
                    None
                } else {
                    Some(error)
                };
            }
        }
        state.status.revision += 1;
        let status = state.status.clone();
        drop(state);
        self.emit(status);
    }

    fn cancel_install(&self, id: u64) -> Result<()> {
        let state = self.model_state.lock().map_err(|_| "MODEL_STATE_FAILED")?;
        if let Some((active, token)) = &state.operation {
            if *active == id {
                token.cancel();
            }
        }
        Ok(())
    }

    fn stage(&self) -> Result<tempfile::TempDir> {
        model::reject_link(&self.root)?;
        tempfile::Builder::new()
            .prefix(".melo-install-")
            .tempdir_in(&self.root)
            .map_err(|e| format!("MODEL_IO: {e}"))
    }

    async fn download(self: Arc<Self>, id: u64, token: CancellationToken) -> Result<u64> {
        let stage = self.stage()?;
        let archive = stage.path().join("model.tar.bz2");
        model::download(
            model::URL,
            &archive,
            model::DOWNLOAD_BYTES,
            &token,
            |bytes| self.progress(id, "downloading", bytes),
        )
        .await?;
        self.progress(id, "verifying", model::DOWNLOAD_BYTES);
        let destination = self.root.join(model::NAME);
        tauri::async_runtime::spawn_blocking(move || {
            let result = model::publish(&archive, stage.path(), &destination, &token);
            // Drop the private archive and all unpublished extraction files on every path.
            drop(stage);
            result
        })
        .await
        .map_err(|e| format!("MODEL_IO: {e}"))?
    }

    fn import(self: Arc<Self>, source: PathBuf, token: CancellationToken) -> Result<u64> {
        let stage = self.stage()?;
        let archive = stage.path().join("model.tar.bz2");
        model::copy_import(&source, &archive, &token)?;
        model::publish(&archive, stage.path(), &self.root.join(model::NAME), &token)
    }

    fn delete(&self) -> Result<u64> {
        self.generation.fetch_add(1, Ordering::AcqRel);
        let mut engine = self.engine.lock().map_err(|_| "MODEL_STATE_FAILED")?;
        engine.model.take();
        let path = self.root.join(model::NAME);
        if path.exists() {
            model::directory_size(&path)?; // Refuse reparse points anywhere in the owned tree.
            fs::remove_dir_all(path).map_err(|e| format!("MODEL_IO: {e}"))?;
        }
        Ok(0)
    }

    fn begin_speech(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::AcqRel) + 1
    }
    fn cancel_speech(&self, session: u64) {
        let _ = self.generation.compare_exchange(
            session,
            session + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
    fn check_session(&self, session: u64) -> Result<()> {
        if self.closed.load(Ordering::Acquire) || self.generation.load(Ordering::Acquire) != session
        {
            Err("CANCELLED".into())
        } else {
            Ok(())
        }
    }

    fn unload_idle(&self, now: Instant) {
        if let Ok(mut engine) = self.engine.try_lock() {
            if now.saturating_duration_since(engine.last_used) >= IDLE_TIMEOUT {
                engine.model.take();
            }
        }
    }

    fn synthesize(&self, session: u64, text: String, speed: f32) -> Result<String> {
        self.check_session(session)?;
        if text.trim().is_empty()
            || text.contains('\0')
            || text.chars().count() > 512
            || !speed.is_finite()
            || !(0.5..=2.0).contains(&speed)
        {
            return Err("INVALID_SPEECH_INPUT".into());
        }
        let mut engine = self.engine.lock().map_err(|_| "MODEL_STATE_FAILED")?;
        // Requests queued behind an old inference must not load a model or run.
        self.check_session(session)?;
        if engine.model.is_none() {
            let directory = self.root.join(model::NAME);
            if model::ready_size(&directory)?.is_none() {
                return Err("MODEL_NOT_READY".into());
            }
            engine.model = Some(create_engine(&directory)?);
        }
        self.check_session(session)?;
        let generation = self.generation.clone();
        let result = generate(engine.model.as_ref().unwrap(), &text, speed, move || {
            generation.load(Ordering::Acquire) == session
        });
        engine.last_used = Instant::now();
        // The C API may finish its current sentence before invoking the callback.
        // Always discard that result after cancellation as well.
        self.check_session(session)?;
        result.map(|wav| STANDARD.encode(wav))
    }
}

fn create_engine(directory: &Path) -> Result<OfflineTts> {
    let path = |name: &str| Some(directory.join(name).to_string_lossy().into_owned());
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            vits: OfflineTtsVitsModelConfig {
                model: path("model.onnx"),
                tokens: path("tokens.txt"),
                lexicon: path("lexicon.txt"),
                ..Default::default()
            },
            num_threads: num_cpus::get_physical().clamp(1, 4) as i32,
            provider: Some("cpu".into()),
            ..Default::default()
        },
        rule_fsts: Some(
            ["phone.fst", "date.fst", "number.fst"]
                .map(|name| path(name).unwrap())
                .join(","),
        ),
        max_num_sentences: 1,
        silence_scale: 0.2,
        ..Default::default()
    };
    OfflineTts::create(&config).ok_or_else(|| "MODEL_LOAD_FAILED".into())
}

fn generate(
    tts: &OfflineTts,
    text: &str,
    speed: f32,
    active: impl Fn() -> bool + 'static,
) -> Result<Vec<u8>> {
    // The pinned VITS callback supplies each completed internal sentence, not
    // cumulative audio. Keep lengths only; the returned audio owns the samples.
    let boundaries = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let captured = boundaries.clone();
    let audio = tts
        .generate_with_config(
            text,
            &GenerationConfig {
                speed,
                ..Default::default()
            },
            Some(move |samples: &[f32], _: f32| {
                if !active() {
                    return false;
                }
                captured.borrow_mut().push(samples.len());
                true
            }),
        )
        // The C API returns null for token-conversion failure as well as other
        // generation failures. Preserve that ambiguity; only a returned audio
        // object with zero samples can be classified as EMPTY_SPEECH.
        .ok_or("SYNTHESIS_FAILED")?;
    let lengths = boundaries.borrow();
    encode_wav_with_boundaries(audio.samples(), audio.sample_rate(), &lengths)
}

#[cfg(test)]
fn encode_wav(samples: &[f32], rate: i32) -> Result<Vec<u8>> {
    encode_wav_with_boundaries(samples, rate, &[])
}

fn encode_wav_with_boundaries(samples: &[f32], rate: i32, lengths: &[usize]) -> Result<Vec<u8>> {
    if samples.is_empty() {
        return Err("EMPTY_SPEECH".into());
    }
    if rate <= 0 || samples.len() > rate as usize * 180 || samples.iter().any(|s| !s.is_finite()) {
        return Err("SYNTHESIS_FAILED".into());
    }
    let samples = loudness::normalize_phrases(samples, rate as u32, lengths);
    Ok(encode_pcm(&samples, rate))
}

fn encode_pcm(samples: &[f32], rate: i32) -> Vec<u8> {
    let bytes = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(bytes as usize + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(bytes + 36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&(rate as u32).to_le_bytes());
    wav.extend_from_slice(&(rate as u32 * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&bytes.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    wav
}

pub fn setup(app: &tauri::App) -> std::result::Result<Arc<TtsState>, Box<dyn std::error::Error>> {
    let root = app
        .path_resolver()
        .app_local_data_dir()
        .ok_or("Missing local application data directory")?
        .join("tts");
    app.fs_scope().forbid_directory(&root, true)?;
    let handle = app.handle();
    TtsState::new(
        root,
        Arc::new(move |status| {
            let _ = handle.emit_all("melo-model-status", status);
        }),
    )
    .map_err(Into::into)
}

#[tauri::command]
pub fn melo_status(state: State<'_, Arc<TtsState>>) -> Result<ModelStatus> {
    state.status()
}

#[tauri::command]
pub fn melo_download(state: State<'_, Arc<TtsState>>) -> Result<ModelStatus> {
    let (id, token, status) = state.begin_operation("downloading")?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = state.clone().download(id, token).await;
        state.finish(id, result);
    });
    Ok(status)
}

#[tauri::command]
pub async fn melo_import(state: State<'_, Arc<TtsState>>) -> Result<Option<ModelStatus>> {
    // The chosen path never crosses the webview boundary or expands its fs scope.
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tauri::api::dialog::FileDialogBuilder::new()
        .add_filter("MeloTTS model", &["bz2"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(source) = receiver.await.map_err(|_| "MODEL_IO")? else {
        return Ok(None);
    };
    let (id, token, status) = state.begin_operation("verifying")?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = state.clone().import(source, token);
        state.finish(id, result);
    });
    Ok(Some(status))
}

#[tauri::command]
pub fn melo_cancel_install(state: State<'_, Arc<TtsState>>, operation_id: u64) -> Result<()> {
    state.cancel_install(operation_id)
}

#[tauri::command]
pub fn melo_delete(state: State<'_, Arc<TtsState>>) -> Result<ModelStatus> {
    let (id, _, status) = state.begin_operation("deleting")?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = state.delete();
        state.finish(id, result);
    });
    Ok(status)
}

#[tauri::command]
pub fn melo_begin_speech(state: State<'_, Arc<TtsState>>) -> u64 {
    state.begin_speech()
}

#[tauri::command]
pub fn melo_cancel_speech(state: State<'_, Arc<TtsState>>, session: u64) {
    state.cancel_speech(session);
}

#[tauri::command]
pub async fn melo_synthesize(
    state: State<'_, Arc<TtsState>>,
    session: u64,
    text: String,
    speed: f32,
) -> Result<String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.synthesize(session, text, speed))
        .await
        .map_err(|e| format!("SYNTHESIS_FAILED: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Requires NEXTCHAT_MELO_LOUDNESS_FIXTURES and NEXTCHAT_MELO_TEST_MODEL"]
    fn melo_loudness_probe() {
        use sha2::{Digest, Sha256};
        let fixtures = PathBuf::from(std::env::var("NEXTCHAT_MELO_LOUDNESS_FIXTURES").unwrap());
        let root = PathBuf::from(std::env::var("NEXTCHAT_MELO_TEST_MODEL").unwrap());
        let output = fixtures.parent().unwrap().join("loudness-audio");
        fs::create_dir_all(&output).unwrap();
        let tts = create_engine(&root).unwrap();
        let mut rows: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(&fixtures).unwrap()).unwrap();
        for row in &mut rows {
            let text = row["text"].as_str().unwrap();
            let key = format!("{:x}", Sha256::digest(text.as_bytes()));
            let raw = output.join(format!("{key}.f32"));
            if !raw.exists() {
                let audio = tts
                    .generate_with_config(
                        text,
                        &GenerationConfig::default(),
                        None::<fn(&[f32], f32) -> bool>,
                    )
                    .unwrap();
                assert_eq!(audio.sample_rate(), 44100);
                let bytes: Vec<u8> = audio
                    .samples()
                    .iter()
                    .flat_map(|s| s.to_le_bytes())
                    .collect();
                fs::write(&raw, bytes).unwrap();
            }
            row["raw"] = raw.to_string_lossy().into_owned().into();
            row["rate"] = 44100.into();
            let bytes = fs::read(&raw).unwrap();
            let samples: Vec<f32> = bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            let normalized = output.join(format!("{key}.wav"));
            fs::write(&normalized, encode_wav(&samples, 44100).unwrap()).unwrap();
            row["normalized"] = normalized.to_string_lossy().into_owned().into();
        }
        fs::write(
            fixtures.with_file_name("loudness-results.json"),
            serde_json::to_vec_pretty(&rows).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn empty_speech_is_distinct_from_invalid_audio() {
        assert_eq!(encode_wav(&[], 44100).unwrap_err(), "EMPTY_SPEECH");
        assert_eq!(encode_wav(&[0.0], 0).unwrap_err(), "SYNTHESIS_FAILED");
        assert_eq!(
            encode_wav(&[f32::NAN], 44100).unwrap_err(),
            "SYNTHESIS_FAILED"
        );
        assert_eq!(
            encode_wav(&[f32::INFINITY], 44100).unwrap_err(),
            "SYNTHESIS_FAILED"
        );
        assert!(encode_wav(&[0.0], 44100).unwrap().len() > 44);
    }

    #[test]
    #[ignore = "Requires NEXTCHAT_MELO_TEST_MODEL pointing at the verified evaluation model"]
    fn melo_trailing_content_probe() {
        let root =
            PathBuf::from(std::env::var("NEXTCHAT_MELO_TEST_MODEL").expect("Set model path"));
        let tts = create_engine(&root).unwrap();
        for text in [
            "😊",
            "🎉",
            "👍🏽",
            "👩‍💻",
            "🇨🇳",
            "**",
            "---",
            "•",
            "...",
            "！",
            "qzxvplm",
            "florbnaxquux",
            "结束。",
            "你好😊世界。",
            "Hello world.",
        ] {
            let audio = tts.generate_with_config(
                text,
                &GenerationConfig::default(),
                None::<fn(&[f32], f32) -> bool>,
            );
            println!(
                "TRAILING_PROBE {:?}: {:?}",
                text,
                audio.as_ref().map(|a| (a.samples().len(), a.sample_rate()))
            );
            let unsupported = ["😊", "🎉", "👍🏽", "👩‍💻", "🇨🇳", "**", "•"].contains(&text);
            assert_eq!(
                audio.is_none(),
                unsupported,
                "Unexpected result for {text:?}"
            );
        }
        assert_eq!(
            generate(&tts, "😊", 1.0, || true).unwrap_err(),
            "SYNTHESIS_FAILED"
        );
        assert!(generate(&tts, "继续朗读。", 1.0, || true).is_ok());
    }

    #[test]
    fn cancelled_and_stale_sessions_never_load_or_generate() {
        let temp = tempfile::tempdir().unwrap();
        let state = TtsState::new(temp.path().join("tts"), Arc::new(|_| {})).unwrap();
        let old = state.begin_speech();
        let current = state.begin_speech();
        state.cancel_speech(old);
        assert!(state.check_session(current).is_ok());
        assert_eq!(
            state.synthesize(old, "你好".into(), 1.0).unwrap_err(),
            "CANCELLED"
        );
        state.cancel_speech(current);
        assert_eq!(
            state.synthesize(current, "你好".into(), 1.0).unwrap_err(),
            "CANCELLED"
        );
        assert!(state.engine.lock().unwrap().model.is_none());
        state.shutdown();
    }

    #[test]
    fn unusable_model_store_does_not_prevent_app_startup() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("not-a-directory");
        fs::write(&root, b"file").unwrap();
        let state = TtsState::new(root, Arc::new(|_| {})).unwrap();
        assert_eq!(state.status().unwrap().phase, "error");
        state.shutdown();
    }

    #[tokio::test]
    #[ignore = "Requires NEXTCHAT_MELO_TEST_ARCHIVE pointing at the pinned official archive"]
    async fn full_model_local_http_install_and_delete() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let source =
            PathBuf::from(std::env::var("NEXTCHAT_MELO_TEST_ARCHIVE").expect("Set archive path"));
        assert_eq!(fs::metadata(&source).unwrap().len(), model::DOWNLOAD_BYTES);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut buffer = [0; 4096];
            let _ = socket.read(&mut buffer);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                model::DOWNLOAD_BYTES
            )
            .unwrap();
            std::io::copy(&mut fs::File::open(source).unwrap(), &mut socket).unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let state = TtsState::new(temp.path().join("tts"), Arc::new(|_| {})).unwrap();
        let stage = state.stage().unwrap();
        let archive = stage.path().join("model.tar.bz2");
        let token = CancellationToken::new();
        model::download(
            &format!("http://{address}"),
            &archive,
            model::DOWNLOAD_BYTES,
            &token,
            |_| {},
        )
        .await
        .unwrap();
        server.join().unwrap();
        let destination = state.root.join(model::NAME);
        let bytes = model::publish(&archive, stage.path(), &destination, &token).unwrap();
        assert!(bytes > 170_000_000);
        assert_eq!(model::ready_size(&destination).unwrap(), Some(bytes));
        drop(stage);
        assert_eq!(fs::read_dir(&state.root).unwrap().count(), 1);
        // Exercise the same session/PCM/base64 path used by the webview.
        let session = state.begin_speech();
        let wav = STANDARD
            .decode(
                state
                    .synthesize(session, "你好，这是安装后的本地语音。".into(), 1.0)
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert!(wav.len() > 44);
        assert_eq!(state.delete().unwrap(), 0);
        assert!(state.engine.lock().unwrap().model.is_none());
        assert!(!destination.exists());
        state.shutdown();
        println!("Verified complete HTTP download, SHA256, safe extraction, atomic install, synthesis, and deletion: {bytes} bytes");
    }

    #[test]
    #[ignore = "Requires NEXTCHAT_MELO_TEST_MODEL pointing at the verified evaluation model"]
    fn melo_real_model_integration() {
        let root =
            PathBuf::from(std::env::var("NEXTCHAT_MELO_TEST_MODEL").expect("Set model path"));
        let start = Instant::now();
        let tts = create_engine(&root).unwrap();
        println!("Melo load: {:.3}s", start.elapsed().as_secs_f64());
        for text in ["好的，我来帮你看一下这个问题。","建议先用 Python 创建虚拟环境，再通过 API 获取数据。请从 GitHub 下载 v2.16.1，并用 Docker 启动服务。"] {
            let start=Instant::now(); let wav=generate(&tts,text,1.0,||true).unwrap(); let elapsed=start.elapsed().as_secs_f64();
            assert_eq!(&wav[..4],b"RIFF"); assert_eq!(&wav[8..12],b"WAVE");
            let rate=u32::from_le_bytes(wav[24..28].try_into().unwrap());
            let duration=(wav.len()-44) as f64/(rate*2) as f64;
            println!("Melo synthesis: {elapsed:.3}s, audio: {duration:.3}s, RTF: {:.3}",elapsed/duration);
            assert!(duration>1.0);
        }
        let temp = tempfile::tempdir().unwrap();
        let state = TtsState::new(temp.path().join("tts"), Arc::new(|_| {})).unwrap();
        state.engine.lock().unwrap().model = Some(tts);
        state.unload_idle(Instant::now() + IDLE_TIMEOUT + Duration::from_secs(1));
        assert!(state.engine.lock().unwrap().model.is_none());
        state.shutdown();
    }
}
