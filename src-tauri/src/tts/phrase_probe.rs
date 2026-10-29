//! Opt-in audit of the pinned native TTS callback contract and phrase loudness.
use super::*;
use std::{cell::RefCell, rc::Rc};

#[test]
#[ignore = "Requires NEXTCHAT_MELO_PHRASE_FIXTURES and NEXTCHAT_MELO_TEST_MODEL"]
fn callback_phrase_audit() {
    let fixtures = PathBuf::from(std::env::var("NEXTCHAT_MELO_PHRASE_FIXTURES").unwrap());
    let root = PathBuf::from(std::env::var("NEXTCHAT_MELO_TEST_MODEL").unwrap());
    let output = fixtures.parent().unwrap().join("audio");
    fs::create_dir_all(&output).unwrap();
    let tts = create_engine(&root).unwrap();
    let mut rows: Vec<serde_json::Value> =
        serde_json::from_slice(&fs::read(&fixtures).unwrap()).unwrap();
    for (index, row) in rows.iter_mut().enumerate() {
        let raw = output.join(format!("{index}.f32"));
        let boundary_path = output.join(format!("{index}.boundaries.json"));
        let (samples, boundaries): (Vec<f32>, Vec<usize>) =
            if raw.exists() && boundary_path.exists() {
                let bytes = fs::read(&raw).unwrap();
                (
                    bytes
                        .chunks_exact(4)
                        .map(|s| f32::from_le_bytes(s.try_into().unwrap()))
                        .collect(),
                    serde_json::from_slice(&fs::read(&boundary_path).unwrap()).unwrap(),
                )
            } else {
                let callbacks = Rc::new(RefCell::new(Vec::<Vec<f32>>::new()));
                let captured = callbacks.clone();
                let audio = tts
                    .generate_with_config(
                        row["text"].as_str().unwrap(),
                        &GenerationConfig::default(),
                        Some(move |samples: &[f32], _: f32| {
                            captured.borrow_mut().push(samples.to_vec());
                            true
                        }),
                    )
                    .unwrap();
                assert_eq!(audio.sample_rate(), 44100);
                let callbacks = callbacks.borrow();
                let joined: Vec<f32> = callbacks.iter().flatten().copied().collect();
                assert_eq!(
                    joined,
                    audio.samples(),
                    "Callback concatenation differs from final audio: {}",
                    row["text"]
                );
                let boundaries: Vec<usize> = callbacks.iter().map(Vec::len).collect();
                let bytes: Vec<u8> = joined.iter().flat_map(|s| s.to_le_bytes()).collect();
                fs::write(&raw, bytes).unwrap();
                fs::write(&boundary_path, serde_json::to_vec(&boundaries).unwrap()).unwrap();
                (joined, boundaries)
            };
        row["raw"] = raw.to_string_lossy().into_owned().into();
        row["rate"] = 44100.into();
        row["callbackLengths"] = serde_json::json!(boundaries);
        row["finalLength"] = samples.len().into();
        row["callbackConcatenationEqualsFinal"] = true.into();
        let baseline = output.join(format!("{index}.before.wav"));
        if !baseline.exists() {
            // Reproduce task K's whole-chunk scalar gain on the SAME float audio.
            fs::write(
                &baseline,
                encode_pcm(&loudness::normalize_chunk_baseline(&samples, 44100), 44100),
            )
            .unwrap();
        }
        row["before"] = baseline.to_string_lossy().into_owned().into();
        let after = output.join(format!("{index}.after.wav"));
        fs::write(
            &after,
            encode_wav_with_boundaries(&samples, 44100, &boundaries).unwrap(),
        )
        .unwrap();
        row["after"] = after.to_string_lossy().into_owned().into();
    }
    fs::write(
        fixtures.with_file_name("phrase-results.json"),
        serde_json::to_vec_pretty(&rows).unwrap(),
    )
    .unwrap();
}
