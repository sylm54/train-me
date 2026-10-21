//! WAV file I/O for rendered tracks.
//!
//! Everything else that used to live here (the Supertone/supertonic-3 ONNX
//! pipeline) was retired when the speech engine moved to Kyutai pocket-tts
//! (`crate::pocket_tts`).

use anyhow::Result;
use hound::{SampleFormat, WavSpec, WavWriter};
use std::path::Path;

// ============================================================================
// WAV File I/O
// ============================================================================

pub fn write_wav_file<P: AsRef<Path>>(
    filename: P,
    audio_data: &[f32],
    sample_rate: i32,
) -> Result<()> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: sample_rate as u32,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut writer = WavWriter::create(filename, spec)?;

    for &sample in audio_data {
        let clamped = sample.max(-1.0).min(1.0);
        let val = (clamped * 32767.0) as i16;
        writer.write_sample(val)?;
    }

    writer.finalize()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_write_wav_file() {
        let dir = std::env::temp_dir().join(format!(
            "tm-helper-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.wav");

        write_wav_file(&path, &[0.0, 0.5, -0.5, 1.0], 24000).unwrap();

        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().sample_rate, 24000);
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().bits_per_sample, 16);
        let samples: Vec<i16> = reader
            .into_samples::<i16>()
            .map(|s| s.unwrap())
            .collect();
        assert_eq!(samples, vec![0, 16383, -16383, 32767]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
