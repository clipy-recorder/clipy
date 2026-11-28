//! What a desktop client reports about itself and about a take: the source
//! platform, OS version and bitrate it names on uploads and funnel events,
//! the capture health the pump stashes for the recording diagnostics, and the
//! upload health the recording health sampler reads.
//!
//! Moved out of `upload.rs` unchanged so that code which does not upload
//! (telemetry, the health sampler, the capture pumps) does not depend on the
//! upload module.

use parking_lot::Mutex as SyncMutex;

/// What the health sampler reports about the upload during a take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadHealth {
    /// Bytes the server has acknowledged (contiguous or not).
    pub bytes_uploaded: u64,
    /// The tailer has a part it cannot hand over: every worker and the job
    /// queue are full, so new bytes are piling up on disk. Always false once
    /// the upload has failed, which `failed` reports instead.
    pub backpressure: bool,
    /// The upload hit a terminal error; the take keeps recording to disk and
    /// nothing more will be acknowledged.
    pub failed: bool,
}

pub(crate) fn video_bitrate_for_height(max_height: Option<u32>) -> usize {
    match max_height {
        Some(height) if height <= 720 => 2_700_000,
        Some(height) if height <= 1080 => 3_500_000,
        Some(height) if height <= 1440 => 4_700_000,
        _ => 8_000_000,
    }
}

pub(crate) fn quality_tier_for_height(max_height: Option<u32>) -> &'static str {
    match max_height {
        Some(height) if height > 1440 => "pro_4k",
        Some(height) if height > 1080 => "pro_1440",
        None => "pro_4k",
        _ => "standard",
    }
}

/// The one place a desktop client names itself. `/complete` stamps this onto
/// the `videos` row and the funnel events carry the same value, so a recording
/// and the events about it can never disagree on which client made it.
pub(crate) fn upload_source_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "mac"
    }
}

pub(crate) fn reported_os_version() -> Option<String> {
    operating_system_version()
}

pub(crate) fn operating_system_version() -> Option<String> {
    // Cached: this is only used to decorate the upload user-agent, but it was
    // being re-probed on every upload — i.e. at the start AND end of every
    // recording.
    static CACHED: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHED.get_or_init(probe_operating_system_version).clone()
}

fn probe_operating_system_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    let output = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    #[cfg(target_os = "windows")]
    let output = {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW. Without it `cmd /C ver` allocates a console, so a
        // black window flashed on screen every time a recording started or
        // stopped — and on a slower machine it lingered long enough to be
        // captured into the recording itself.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "ver"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let output = std::process::Command::new("uname")
        .arg("-r")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // Lossy: piped `ver` output is in the OEM code page ("versão", "Версия"),
    // which is not UTF-8. The digits survive either way.
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // `ver` prints "Microsoft Windows [Version 10.0.19045.4651]". The analytics
    // relay only keeps a bare dotted version, so the full line was dropped and
    // no Windows event ever carried its build: the one fact that tells
    // Windows 10 from 11.
    #[cfg(target_os = "windows")]
    let version = ping_os_version(&version)?;
    (!version.is_empty()).then_some(version)
}

/// The server takes `^[0-9A-Za-z.+_-]{1,32}$`. macOS and Linux already report a
/// bare version; Windows `cmd /C ver` reports `Microsoft Windows [Version
/// 10.0.26100.6584]`, so take the last token that looks like a version. The
/// upload user-agent and funnel events use it too (`reported_os_version`).
pub(crate) fn ping_os_version(raw: &str) -> Option<String> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '_' | '-');
    raw.split(|c: char| !allowed(c))
        .filter(|token| !token.is_empty() && token.len() <= 32)
        .filter(|token| token.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .last()
        .map(str::to_string)
}

/// What the capture pump saw during a take, sent on the recording
/// diagnostics at `/complete` (`health.source_video_frames`,
/// `health.last_source_frame_ms`, `health.audio`). The Mac app used to send
/// no frame count, which is how macOS 12 takes with no video went unnoticed,
/// and the Windows app sent no audio state, so a silent take could not be told
/// apart from audio that was turned off.
#[derive(Clone, Debug, Default)]
pub(crate) struct CaptureHealthReport {
    /// Screen (or camera) frames that reached the encoder; repeated frames
    /// the pump writes to fill a static screen are not counted.
    pub source_video_frames: Option<u64>,
    /// When the last of them arrived, in ms since the pump started.
    pub last_source_frame_ms: Option<u64>,
    pub audio: Option<AudioStateReport>,
    /// What ScreenCaptureKit sent (`health.screen_capture`). Mac screen
    /// takes only.
    pub screen_capture: Option<crate::capture::stream_health::ScreenCaptureReport>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AudioStateReport {
    pub include_mic: bool,
    pub include_system_audio: bool,
    pub mic_started: bool,
    /// Short slug, never the device name or the OS error text.
    pub mic_error: Option<&'static str>,
    pub mic_chunks: u64,
    /// System audio chunks: WASAPI loopback on Windows, ScreenCaptureKit
    /// audio on macOS.
    pub loopback_chunks: u64,
    /// Windows live mic-silence check; `None` where it does not run or the
    /// mic never started.
    pub mic_silence: Option<crate::capture::mic_silence::MicSilenceSummary>,
    /// Windows mic stream rebuilds during the take (`capture::mic_reopen`);
    /// `None` where no supervisor ran.
    pub mic_reopen: Option<crate::capture::mic_reopen::MicReopenStats>,
}

/// Bounded like `recording_intent`: only the in-flight take and a few recent
/// ones are ever read, and Local AI takes never reach `/complete`.
const MAX_TRACKED_CAPTURE_HEALTH: usize = 8;
static CAPTURE_HEALTH: SyncMutex<Option<std::collections::HashMap<String, CaptureHealthReport>>> =
    SyncMutex::new(None);

/// Stashed by the capture pump when it finishes, before `/complete` runs.
pub(crate) fn remember_capture_health(recording_id: &str, report: CaptureHealthReport) {
    let mut guard = CAPTURE_HEALTH.lock();
    let map = guard.get_or_insert_with(std::collections::HashMap::new);
    if map.len() >= MAX_TRACKED_CAPTURE_HEALTH && !map.contains_key(recording_id) {
        map.clear();
    }
    map.insert(recording_id.to_string(), report);
}

pub(crate) fn capture_health_for(recording_id: &str) -> Option<CaptureHealthReport> {
    CAPTURE_HEALTH.lock().as_ref()?.get(recording_id).cloned()
}

pub(crate) fn apply_capture_health(diagnostics: &mut serde_json::Value, report: &CaptureHealthReport) {
    let health = &mut diagnostics["health"];
    if let Some(frames) = report.source_video_frames {
        health["source_video_frames"] = serde_json::json!(frames);
    }
    if let Some(ms) = report.last_source_frame_ms {
        health["last_source_frame_ms"] = serde_json::json!(ms);
    }
    if let Some(audio) = &report.audio {
        health["audio"] = serde_json::json!({
            "include_mic": audio.include_mic,
            "include_system_audio": audio.include_system_audio,
            "mic_started": audio.mic_started,
            "mic_error": audio.mic_error,
            "mic_chunks": audio.mic_chunks,
            "loopback_chunks": audio.loopback_chunks,
        });
        if let Some(silence) = audio.mic_silence {
            health["audio"]["mic_silence_warned"] = serde_json::json!(silence.warned);
            health["audio"]["mic_silence_reason"] =
                serde_json::json!(silence.reason.map(|r| r.as_str()));
            health["audio"]["mic_silent_ms"] = serde_json::json!(silence.silent_ms);
            health["audio"]["mic_signal_seen"] = serde_json::json!(silence.signal_seen);
        }
        if let Some(reopen) = &audio.mic_reopen {
            health["audio"]["mic_reopens"] = serde_json::json!(reopen.reopens);
            if let Some(reasons) = reopen.reasons_slug() {
                health["audio"]["mic_reopen_reasons"] = serde_json::json!(reasons);
            }
        }
    }
    if let Some(screen) = &report.screen_capture {
        health["screen_capture"] = screen.to_json();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::mic_reopen::MicReopenStats;
    use crate::capture::mic_silence::{MicSilenceReason, MicSilenceSummary};
    use crate::capture::stream_health::ScreenCaptureReport;

    #[test]
    fn ping_os_version_parses_supported_inputs_and_rejects_invalid_ones() {
        assert_eq!(
            ping_os_version("Microsoft Windows [Version 10.0.26100.6584]"),
            Some("10.0.26100.6584".to_string())
        );
        assert_eq!(
            ping_os_version("Microsoft Windows [Versão 10.0.19045.4651]"),
            Some("10.0.19045.4651".to_string())
        );
        assert_eq!(ping_os_version("15.3.1"), Some("15.3.1".to_string()));
        assert_eq!(ping_os_version(""), None);
        assert_eq!(ping_os_version(&"1".repeat(33)), None);
    }

    #[test]
    fn video_bitrate_for_height_matches_bucket_edges() {
        assert_eq!(video_bitrate_for_height(Some(720)), 2_700_000);
        assert_eq!(video_bitrate_for_height(Some(721)), 3_500_000);
        assert_eq!(video_bitrate_for_height(Some(1080)), 3_500_000);
        assert_eq!(video_bitrate_for_height(Some(1440)), 4_700_000);
        assert_eq!(video_bitrate_for_height(Some(1441)), 8_000_000);
        assert_eq!(video_bitrate_for_height(None), 8_000_000);
    }

    #[test]
    fn quality_tier_for_height_maps_tiers_and_none() {
        assert_eq!(quality_tier_for_height(Some(1080)), "standard");
        assert_eq!(quality_tier_for_height(Some(1081)), "pro_1440");
        assert_eq!(quality_tier_for_height(Some(1440)), "pro_1440");
        assert_eq!(quality_tier_for_height(Some(1441)), "pro_4k");
        assert_eq!(quality_tier_for_height(None), "pro_4k");
    }

    #[test]
    fn apply_capture_health_writes_present_fields_into_diagnostics() {
        let mut diagnostics = serde_json::json!({ "health": {} });
        let report = CaptureHealthReport {
            source_video_frames: Some(120),
            last_source_frame_ms: Some(4_000),
            audio: Some(AudioStateReport {
                include_mic: true,
                include_system_audio: false,
                mic_started: true,
                mic_error: Some("none"),
                mic_chunks: 42,
                loopback_chunks: 0,
                mic_silence: Some(MicSilenceSummary {
                    warned: true,
                    reason: Some(MicSilenceReason::DigitalSilence),
                    silent_ms: 5_000,
                    signal_seen: false,
                }),
                mic_reopen: Some(MicReopenStats {
                    reopens: 2,
                    reasons: vec!["stream_error", "digital_silence"],
                }),
            }),
            screen_capture: Some(ScreenCaptureReport {
                pixel_format: Some("bgra"),
                screen_buffers: 10,
                frames_without_image: 1,
                frame_status: [9, 1, 0, 0, 0, 0],
                frame_status_other: 0,
                stop_error_code: None,
                stop_error_domain: None,
                rejected_frames: 0,
                rescaled_frames: 0,
            }),
        };

        apply_capture_health(&mut diagnostics, &report);

        assert_eq!(diagnostics["health"]["source_video_frames"], 120);
        assert_eq!(diagnostics["health"]["last_source_frame_ms"], 4_000);
        assert_eq!(diagnostics["health"]["audio"]["include_mic"], true);
        assert_eq!(diagnostics["health"]["audio"]["include_system_audio"], false);
        assert_eq!(diagnostics["health"]["audio"]["mic_started"], true);
        assert_eq!(diagnostics["health"]["audio"]["mic_error"], "none");
        assert_eq!(diagnostics["health"]["audio"]["mic_chunks"], 42);
        assert_eq!(diagnostics["health"]["audio"]["loopback_chunks"], 0);
        assert_eq!(diagnostics["health"]["audio"]["mic_silence_warned"], true);
        assert_eq!(
            diagnostics["health"]["audio"]["mic_silence_reason"],
            "digital_silence"
        );
        assert_eq!(diagnostics["health"]["audio"]["mic_silent_ms"], 5_000);
        assert_eq!(diagnostics["health"]["audio"]["mic_signal_seen"], false);
        assert_eq!(diagnostics["health"]["audio"]["mic_reopens"], 2);
        assert_eq!(
            diagnostics["health"]["audio"]["mic_reopen_reasons"],
            "stream_error-digital_silence"
        );
        assert_eq!(
            diagnostics["health"]["screen_capture"]["pixel_format"],
            "bgra"
        );
        assert_eq!(
            diagnostics["health"]["screen_capture"]["screen_buffers"],
            10
        );
    }

    #[test]
    fn apply_capture_health_skips_absent_fields() {
        let mut diagnostics = serde_json::json!({ "health": {} });
        apply_capture_health(&mut diagnostics, &CaptureHealthReport::default());
        assert_eq!(diagnostics, serde_json::json!({ "health": {} }));
    }
}
