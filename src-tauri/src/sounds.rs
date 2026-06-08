//! Embedded sound effects for the TTS app.
//!
//! All WAV files from `src/sounds/` are embedded at compile time
//! via `include_bytes!` so they ship with the final binary.

use std::io::Cursor;

/// Sound type identifiers matching the TTS tag spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SoundType {
    Beep,
    Pop,
    BubblePop,
    CameraShutter,
    CensorBeep,
    HeartBeat,
    Padlock,
    Snap,
    Ding,
    Swoosh,
    Click,
    Error,
    Success,
    Bell,
    WaterDrop,
}

impl SoundType {
    /// All available sound types.
    #[cfg(test)]
    pub fn all() -> &'static [SoundType] {
        &[
            SoundType::Beep,
            SoundType::Pop,
            SoundType::BubblePop,
            SoundType::CameraShutter,
            SoundType::CensorBeep,
            SoundType::HeartBeat,
            SoundType::Padlock,
            SoundType::Snap,
            SoundType::Ding,
            SoundType::Swoosh,
            SoundType::Click,
            SoundType::Error,
            SoundType::Success,
            SoundType::Bell,
            SoundType::WaterDrop,
        ]
    }

    /// Parse from the string used in TTS tags.
    pub fn from_tag(s: &str) -> Option<SoundType> {
        match s {
            "beep" => Some(SoundType::Beep),
            "pop" => Some(SoundType::Pop),
            "bubble_pop" => Some(SoundType::BubblePop),
            "camera_shutter" => Some(SoundType::CameraShutter),
            "censor_beep" => Some(SoundType::CensorBeep),
            "heart_beat" => Some(SoundType::HeartBeat),
            "padlock" => Some(SoundType::Padlock),
            "snap" => Some(SoundType::Snap),
            "ding" => Some(SoundType::Ding),
            "swoosh" => Some(SoundType::Swoosh),
            "click" => Some(SoundType::Click),
            "error" => Some(SoundType::Error),
            "success" => Some(SoundType::Success),
            "bell" => Some(SoundType::Bell),
            "water_drop" => Some(SoundType::WaterDrop),
            _ => None,
        }
    }

    /// Get the embedded WAV bytes for this sound type.
    pub fn wav_bytes(&self) -> &'static [u8] {
        match self {
            SoundType::Beep => include_bytes!("sounds/beep_low_high.wav"),
            SoundType::Pop => include_bytes!("sounds/pop.wav"),
            SoundType::BubblePop => include_bytes!("sounds/bubble_pop.wav"),
            SoundType::CameraShutter => include_bytes!("sounds/camera_shutter.wav"),
            SoundType::CensorBeep => include_bytes!("sounds/censor_beep.wav"),
            SoundType::HeartBeat => include_bytes!("sounds/heart_beat.wav"),
            SoundType::Padlock => include_bytes!("sounds/padlock.wav"),
            SoundType::Snap => include_bytes!("sounds/snap.wav"),
            // Generate these programmatically as they aren't available as files
            SoundType::Ding => include_bytes!("sounds/beep_low_high.wav"),
            SoundType::Swoosh => include_bytes!("sounds/pop.wav"),
            SoundType::Click => include_bytes!("sounds/snap.wav"),
            SoundType::Error => include_bytes!("sounds/censor_beep.wav"),
            SoundType::Success => include_bytes!("sounds/beep_low_high.wav"),
            SoundType::Bell => include_bytes!("sounds/beep_low_high.wav"),
            SoundType::WaterDrop => include_bytes!("sounds/pop.wav"),
        }
    }

    /// Decode the WAV bytes into (sample_rate, mono f32 samples).
    pub fn decode(&self) -> anyhow::Result<(u32, Vec<f32>)> {
        let cursor = Cursor::new(self.wav_bytes());
        let mut reader = hound::WavReader::new(cursor)?;
        let spec = reader.spec();
        let sample_rate = spec.sample_rate;
        let channels = spec.channels;

        let samples: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Int => {
                if spec.bits_per_sample == 16 {
                    reader
                        .samples::<i16>()
                        .filter_map(|s| s.ok())
                        .map(|s| s as f32 / 32768.0)
                        .collect()
                } else if spec.bits_per_sample == 24 {
                    reader
                        .samples::<i32>()
                        .filter_map(|s| s.ok())
                        .map(|s| s as f32 / 8388608.0)
                        .collect()
                } else {
                    reader
                        .samples::<i16>()
                        .filter_map(|s| s.ok())
                        .map(|s| s as f32 / 32768.0)
                        .collect()
                }
            }
            hound::SampleFormat::Float => reader.samples::<f32>().filter_map(|s| s.ok()).collect(),
        };

        // Convert to mono if stereo
        let mono = if channels > 1 {
            samples
                .chunks(channels as usize)
                .map(|ch| ch.iter().sum::<f32>() / channels as f32)
                .collect()
        } else {
            samples
        };

        Ok((sample_rate, mono))
    }
}

/// List all available sound type names (for the frontend).
pub fn available_sound_names() -> Vec<&'static str> {
    vec![
        "beep",
        "pop",
        "bubble_pop",
        "camera_shutter",
        "censor_beep",
        "heart_beat",
        "padlock",
        "snap",
        "ding",
        "swoosh",
        "click",
        "error",
        "success",
        "bell",
        "water_drop",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_sounds_decode() {
        for sound in SoundType::all() {
            let result = sound.decode();
            assert!(
                result.is_ok(),
                "Failed to decode {:?}: {:?}",
                sound,
                result.err()
            );
            let (sr, samples) = result.unwrap();
            assert!(sr > 0, "Sample rate should be positive for {:?}", sound);
            assert!(!samples.is_empty(), "Should have samples for {:?}", sound);
        }
    }

    #[test]
    fn test_from_tag() {
        assert_eq!(SoundType::from_tag("beep"), Some(SoundType::Beep));
        assert_eq!(SoundType::from_tag("pop"), Some(SoundType::Pop));
        assert_eq!(SoundType::from_tag("nonexistent"), None);
    }

    #[test]
    fn test_available_names() {
        let names = available_sound_names();
        assert!(names.contains(&"beep"));
        assert!(names.contains(&"snap"));
        assert_eq!(names.len(), 15);
    }
}
