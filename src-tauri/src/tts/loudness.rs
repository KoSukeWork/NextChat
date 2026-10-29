// Median active-frame RMS in the two pinned evaluation passages: -28.71 dBFS.
// Round to -29 dBFS to preserve the typical Melo volume.
const TARGET_RMS: f64 = 0.03548133892335755;
const SILENCE_RMS: f64 = 0.005623413251903491; // -45 dBFS
const PEAK_LIMIT: f32 = 0.8912509; // -1 dBFS

fn active_rms(samples: &[f32], rate: u32) -> Option<f64> {
    active_rms_at_gain(samples, rate, 1.0)
}

fn active_rms_at_gain(samples: &[f32], rate: u32, gain: f64) -> Option<f64> {
    let frame = ((rate as usize * 20) / 1000).max(1);
    let mut energy = 0.0;
    let mut count = 0;
    for block in samples.chunks(frame) {
        let sum: f64 = block.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() * gain * gain;
        if sum / block.len() as f64 >= SILENCE_RMS * SILENCE_RMS {
            energy += sum;
            count += block.len();
        }
    }
    (count > 0).then(|| (energy / count as f64).sqrt())
}

// Historical task-K reference, for paired real-model measurement only.
#[cfg(test)]
pub(super) fn normalize_chunk_baseline(samples: &[f32], rate: u32) -> Vec<f32> {
    normalize(samples, rate, false)
}

fn normalize(samples: &[f32], rate: u32, refine_gate: bool) -> Vec<f32> {
    let mut output = samples.to_vec();
    let peak = samples.iter().fold(0.0_f32, |peak, s| peak.max(s.abs()));
    let gain = match active_rms(samples, rate) {
        Some(rms) => {
            // Prefer a constant gain over clipping speech peaks. A final clamp
            // also protects against pathological inputs above full scale.
            let bound = |gain: f64| {
                gain.clamp(0.5, 3.0)
                    .min((PEAK_LIMIT / peak) as f64)
                    .max(0.5)
            };
            let mut gain = bound(TARGET_RMS / rms);
            if refine_gate {
                // Scaling can move quiet frames across the fixed silence gate.
                // Solve that estimate before playback; the applied gain remains
                // one constant per phrase, never a time-varying compressor.
                for _ in 0..3 {
                    if let Some(rms) = active_rms_at_gain(samples, rate, gain) {
                        gain = bound(gain * TARGET_RMS / rms);
                    }
                }
            }
            gain as f32
        }
        None => 1.0, // Never amplify silence or the near-silent noise floor.
    };
    let fade = ((rate as usize * 5) / 1000).max(1).min(samples.len() / 2);
    let length = output.len();
    for (index, sample) in output.iter_mut().enumerate() {
        let edge = index.min(length - 1 - index);
        let envelope = if edge < fade {
            edge as f32 / fade as f32
        } else {
            1.0
        };
        *sample = (*sample * gain).clamp(-PEAK_LIMIT, PEAK_LIMIT) * envelope;
    }
    output
}

// A callback boundary may have little trailing silence but ample leading
// silence in the next sentence. Move the boundary inside that same quiet gap
// so the 5 ms fades and the change of gain never cut through voiced samples.
fn quiet_midpoint(samples: &[f32], offset: usize, rate: u32) -> Option<usize> {
    let mut left = offset;
    let mut right = offset;
    while left > 0 && samples[left - 1].abs() as f64 <= SILENCE_RMS {
        left -= 1;
    }
    while right < samples.len() && samples[right].abs() as f64 <= SILENCE_RMS {
        right += 1;
    }
    let minimum = ((rate as usize * 10) / 1000).max(2);
    (right - left >= minimum && left < offset && right > offset).then_some((left + right) / 2)
}

fn pause_boundaries(samples: &[f32], rate: u32) -> Vec<usize> {
    let frame = ((rate as usize * 20) / 1000).max(1);
    let mut boundaries = vec![0];
    let mut silence_start = None;
    for (index, block) in samples.chunks(frame).enumerate() {
        let start = index * frame;
        let energy: f64 = block.iter().map(|&s| (s as f64).powi(2)).sum();
        if energy / (block.len() as f64) < SILENCE_RMS * SILENCE_RMS {
            silence_start.get_or_insert(start);
        } else if let Some(begin) = silence_start.take() {
            if begin > 0 && start - begin >= frame * 8 {
                if let Some(midpoint) = quiet_midpoint(samples, (begin + start) / 2, rate) {
                    boundaries.push(midpoint);
                }
            }
        }
    }
    boundaries.push(samples.len());
    boundaries
}

fn phrase_boundaries(samples: &[f32], rate: u32, lengths: &[usize]) -> Vec<usize> {
    if lengths.is_empty()
        || lengths.contains(&0)
        || lengths
            .iter()
            .try_fold(0usize, |sum, &n| sum.checked_add(n))
            != Some(samples.len())
    {
        return pause_boundaries(samples, rate);
    }
    let mut boundaries = vec![0];
    let mut offset = 0;
    for &length in &lengths[..lengths.len() - 1] {
        offset += length;
        let Some(midpoint) = quiet_midpoint(samples, offset, rate) else {
            // Never trust a changed callback contract enough to change gain
            // inside speech. The fallback also requires a genuine quiet gap.
            return pause_boundaries(samples, rate);
        };
        if midpoint > *boundaries.last().unwrap() {
            boundaries.push(midpoint);
        }
    }
    boundaries.push(samples.len());
    boundaries
}

pub(super) fn normalize_phrases(samples: &[f32], rate: u32, lengths: &[usize]) -> Vec<f32> {
    let boundaries = phrase_boundaries(samples, rate, lengths);
    let mut output = Vec::with_capacity(samples.len());
    for interval in boundaries.windows(2) {
        output.extend(normalize(&samples[interval[0]..interval[1]], rate, true));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(amplitude: f32) -> Vec<f32> {
        (0..44100)
            .map(|n| amplitude * (n as f32 * std::f32::consts::TAU * 440.0 / 44100.0).sin())
            .collect()
    }

    fn normalize(samples: &[f32], rate: u32) -> Vec<f32> {
        super::normalize(samples, rate, true)
    }

    #[test]
    fn three_phrases_six_db_apart_only_change_gain_in_silence() {
        let mut samples = Vec::new();
        let mut lengths = Vec::new();
        for amplitude in [0.02, 0.04, 0.08] {
            let start = samples.len();
            samples.extend(vec![0.0; 8820]);
            samples.extend(tone(amplitude));
            samples.extend(vec![0.0; 8820]);
            lengths.push(samples.len() - start);
        }
        for boundaries in [lengths.clone(), vec![], vec![1, 2, 3]] {
            let output = normalize_phrases(&samples, 44100, &boundaries);
            assert_eq!(output.len(), samples.len());
            let mut offset = 0;
            let mut rms = Vec::new();
            for &length in &lengths {
                rms.push(
                    20.0 * active_rms(&output[offset..offset + length], 44100)
                        .unwrap()
                        .log10(),
                );
                let voice_start = offset + 8820;
                let gain = output[voice_start + 1000] / samples[voice_start + 1000];
                for index in voice_start..voice_start + 44100 {
                    assert!(
                        (output[index] - samples[index] * gain).abs() < 1e-6,
                        "Gain changed inside voiced audio at {index}"
                    );
                }
                offset += length;
            }
            let min = rms.iter().copied().fold(f64::INFINITY, f64::min);
            let max = rms.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            assert!(max - min <= 1.0, "{rms:?}");
            assert!(rms.iter().all(|db| (db + 29.0).abs() <= 1.0));
            assert!(samples
                .iter()
                .zip(&output)
                .all(|(a, b)| *a != 0.0 || *b == 0.0));
        }
    }

    #[test]
    fn callback_boundaries_inside_speech_are_not_gain_switches() {
        let input = tone(0.04);
        let output = normalize_phrases(&input, 44100, &[22050, 22050]);
        assert_eq!(output, normalize(&input, 44100));
        assert_eq!(
            phrase_boundaries(&input, 44100, &[usize::MAX, 2]),
            vec![0, input.len()]
        );
    }

    #[test]
    fn voiced_rms_matches_target_without_counting_silence() {
        for amplitude in [0.02, 0.05, 0.09] {
            let mut input = vec![0.0; 8820];
            input.extend(tone(amplitude));
            input.extend(vec![0.0; 8820]);
            let output = normalize(&input, 44100);
            let db_error = 20.0 * (active_rms(&output, 44100).unwrap() / TARGET_RMS).log10();
            assert!(db_error.abs() <= 1.0, "{db_error}");
            assert_eq!(output.len(), input.len());
        }
    }

    #[test]
    fn gain_is_clamped_and_peaks_are_safe() {
        for (amplitude, expected) in [(0.01, 3.0), (0.5, 0.5)] {
            let input = tone(amplitude);
            let output = normalize(&input, 44100);
            assert!((output[1000] / input[1000] - expected).abs() < 1e-5);
        }
        let mut input = tone(0.02);
        input[1000] = 0.9;
        let output = normalize(&input, 44100);
        assert!(output.iter().all(|s| s.abs() <= PEAK_LIMIT));
        assert!(output[1000] >= 0.89);
        assert!(normalize(&[3.0; 1000], 44100)
            .iter()
            .all(|s| s.abs() <= PEAK_LIMIT));
    }

    #[test]
    fn silence_stays_silent_and_edges_fade() {
        assert_eq!(normalize(&[0.0; 1000], 44100), vec![0.0; 1000]);
        let noise = vec![0.00001; 1000];
        let output = normalize(&noise, 44100);
        assert!(output.iter().zip(&noise).all(|(a, b)| a.abs() <= b.abs()));
        assert_eq!(output[0], 0.0);
        assert_eq!(output[999], 0.0);
        assert!(output[100] > output[1]);
        assert_eq!(output[220], noise[220]);
        assert!(normalize(&[], 44100).is_empty());
    }
}
