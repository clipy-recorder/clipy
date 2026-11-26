//! Transcript pieces in the app's format: segments are `{startMs, endMs,
//! text}` JSON values, gaps are `"<start> ms: <why>"` lines.
//!
//! A gap that the user can fix in Settings ends with [`RETRY_HINT`]; such a
//! transcript is redone on Retry instead of being kept as finished.

use serde_json::{json, Value};

use crate::settings::LocalModelId;

/// Ends every gap that Settings can fix.
pub const RETRY_HINT: &str = "then Retry.";

pub const NOT_SET_UP_GAP: &str = "0 ms: No transcription is set up, so no transcript was made; the recorded audio is unchanged. Choose a model or add a key in Settings, then Retry.";
pub const NO_AUDIO_GAP: &str = "0 ms: No audio track captured.";
pub const NO_SPEECH_GAP: &str = "0 ms: No speech was detected; the recorded audio is unchanged.";

/// The chosen model is not downloaded. The take still completes.
pub fn model_missing_gap(model: LocalModelId) -> String {
    format!(
        "0 ms: The {} model is not downloaded yet, so no transcript was made; the recorded audio is unchanged. Download it in Settings, then Retry.",
        model.label()
    )
}

/// A keyed provider without a key. `message` comes from
/// `settings::stt_config` and already says to add it in Settings.
pub fn missing_key_gap(message: &str) -> String {
    let message = message.replace(['\r', '\n'], " ");
    let mut message = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if message.ends_with(RETRY_HINT) {
        message.truncate(message.len() - RETRY_HINT.len());
    }
    let message = message.trim_end_matches(|c: char| c == '.' || c == ',' || c.is_whitespace());
    format!(
        "0 ms: {message}. No transcript was made; the recorded audio is unchanged. Fix it in Settings, {RETRY_HINT}"
    )
}

/// A stretch the engine or provider could not transcribe.
pub fn gap_line(start_ms: u64, end_ms: u64, reason: &str) -> String {
    let reason = reason.replace(['\r', '\n'], " ");
    let reason = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    let reason = reason.trim_end_matches('.');
    let end_ms = end_ms.max(start_ms);
    format!("{start_ms} ms: {reason} (until {end_ms} ms).")
}

/// Whether a transcript ended in a gap Settings can fix, so Retry should
/// transcribe again rather than keep it.
pub fn needs_retry(gaps: &[String]) -> bool {
    gaps.iter().any(|g| g.trim_end().ends_with(RETRY_HINT))
}

/// Segments in the app's JSON shape, inside the recording: anything starting
/// at or after `duration_ms` is dropped, ends are clamped to it, and empty
/// text is skipped. A zero duration means unknown and clamps nothing.
pub fn segment_values<I>(segments: I, duration_ms: u64) -> Vec<Value>
where
    I: IntoIterator<Item = (u64, u64, String)>,
{
    segments
        .into_iter()
        .filter_map(|(start, end, text)| {
            let text = text.trim();
            if text.is_empty() || (duration_ms > 0 && start >= duration_ms) {
                return None;
            }
            let end = end.max(start);
            let end = if duration_ms > 0 {
                end.min(duration_ms)
            } else {
                end
            };
            Some(json!({"startMs": start, "endMs": end.max(start), "text": text}))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_gaps_are_recognised() {
        assert!(needs_retry(&[NOT_SET_UP_GAP.to_string()]));
        assert!(needs_retry(&[model_missing_gap(
            LocalModelId::Multilingual
        )]));
        let key = missing_key_gap("Deepgram needs an API key. Add it in Settings, then Retry.");
        assert_eq!(key, "0 ms: Deepgram needs an API key. Add it in Settings. No transcript was made; the recorded audio is unchanged. Fix it in Settings, then Retry.");
        assert!(needs_retry(&[key]));
        assert!(!needs_retry(&[
            NO_SPEECH_GAP.to_string(),
            NO_AUDIO_GAP.to_string()
        ]));
        assert!(!needs_retry(&[gap_line(0, 5, "piece failed")]));
        for line in [
            NOT_SET_UP_GAP.to_string(),
            model_missing_gap(LocalModelId::EnglishFast),
        ] {
            assert!(!line.contains('\u{2014}'));
        }
    }

    #[test]
    fn gap_lines_are_one_line() {
        assert_eq!(
            gap_line(1000, 2500, "Engine failed.\nagain"),
            "1000 ms: Engine failed. again (until 2500 ms)."
        );
        // Issue #16 edge cases: CRLF, multiple whitespaces, inverted end_ms, trailing dots
        assert_eq!(
            gap_line(1000, 2500, "Engine failed.\r\nagain"),
            "1000 ms: Engine failed. again (until 2500 ms)."
        );
        assert_eq!(
            gap_line(3000, 1000, "reversed times..."),
            "3000 ms: reversed times (until 3000 ms)."
        );
        assert_eq!(
            missing_key_gap("Deepgram needs an API key.\r\nAdd it in Settings, then Retry.\r\n"),
            "0 ms: Deepgram needs an API key. Add it in Settings. No transcript was made; the recorded audio is unchanged. Fix it in Settings, then Retry."
        );
        assert!(needs_retry(&[format!("{NOT_SET_UP_GAP}\r\n")]));
        assert!(needs_retry(&[format!("{NOT_SET_UP_GAP}   ")]));
    }

    #[test]
    fn segments_stay_inside_the_recording() {
        let values = segment_values(
            vec![
                (0, 900, " hello ".into()),
                (800, 1500, "tail".into()),
                (1000, 1200, "after".into()),
                (10, 20, "   ".into()),
                (500, 200, "inverted".into()),
            ],
            1000,
        );
        assert_eq!(
            values,
            vec![
                json!({"startMs":0,"endMs":900,"text":"hello"}),
                json!({"startMs":800,"endMs":1000,"text":"tail"}),
                json!({"startMs":500,"endMs":500,"text":"inverted"}),
            ]
        );
        assert_eq!(segment_values(vec![(5, 9, "x".into())], 0).len(), 1);
    }
}
