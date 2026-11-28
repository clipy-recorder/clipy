//! Recording state machine.
//!
//! Owns a `RecordingController` in Tauri managed state. Coordinates
//! ScreenCaptureKit (screen + system audio) and cpal (mic) into an
//! AVAssetWriter-fed fragmented MP4 that `upload.rs` tails and ships to
//! the server concurrently.
//!
//! State:
//!   Idle → Countdown → Recording → Stopping → Uploading → Idle

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::types::{
    new_recording_id, AudioOptionsDto, CaptureSourceDto, CaptureSourceMetadataDto, RecordingId,
    RecordingMetadata, RecordingPhase, RecordingStateDto, RecoverableRecordingDto, ShareLinkDto,
    SourceHighlightRectDto, StudioRecordingDto, VideoOptionsDto, WebcamCaptureDto,
    EVENT_COUNTDOWN_TICK, EVENT_RECORDING_AUDIO_WARNING, EVENT_RECORDING_STATE_CHANGED,
    EVENT_SHARE_LINK_READY, EVENT_STUDIO_RECORDING_UPDATED,
};

// A 1080p H.264 desktop recording at the current 6 Mbps target plus audio
// is roughly 3 GiB/hour. Requiring 5 GiB avoids immediate encoder/uploader
// failures while still allowing short urgent recordings on tight disks.
const MIN_RECORDING_FREE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const LOCAL_RECOVERY_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const SCREEN_CHARM_COMPAT_FRAME_RATE: f64 = 60.0;
const SCREEN_CHARM_ZOOM_DURATION_S: f64 = 0.8;
const SCREEN_CHARM_ZOOM_IN_FREEZE_DURATION_S: f64 = 1.1;
const SCREEN_CHARM_ZOOM_OUT_FREEZE_DURATION_S: f64 = 1.3;
const SCREEN_CHARM_DEFAULT_ZOOM_LEVEL: f64 = 2.0;
const SCREEN_CHARM_DEFAULT_PADDING_X_FRACTION: f64 = 0.10;
const SCREEN_CHARM_DEFAULT_PADDING_Y_FRACTION: f64 = 0.03;
const SCREEN_CHARM_DEFAULT_BACKGROUND_IMAGE: &str = "26-Tahoe-Light-6K-thumb.jpeg";
const SCREEN_CHARM_CURSOR_SVG_WIDTH: f64 = 105.0;
const SCREEN_CHARM_TEXT_CURSOR_SVG_WIDTH: f64 = 87.36;
const SOURCE_CURSOR_BAKED_IN_VIDEO: bool = true;
const SCREEN_CHARM_SCREEN_FILE_NAME: &str = "recording.mp4";
const SCREEN_CHARM_INPUT_EVENTS_FILE_NAME: &str = "recording.input-events.json";
const SCREEN_CHARM_WEBCAM_FILE_NAME: &str = "webcam.mp4";
const SCREEN_CHARM_MICROPHONE_FILE_NAME: &str = "microphone.wav";
const SCREEN_CHARM_MICROPHONE_ENHANCED_FILE_NAME: &str = "microphone_enhanced.wav";
const SCREEN_CHARM_SYSTEM_AUDIO_FILE_NAME: &str = "system_audio.wav";
const MIC_SILENCE_WARNING_MS: u64 = 5_000;
const MIC_CAPTURE_UNAVAILABLE: &str =
    "Microphone unavailable. Turn Microphone off to record without it.";
/// How much limiter gain the mix recovers per drained audio block (80 ms), so a
/// fully-ducked mix returns to unity over roughly 1.6 s.
#[cfg(target_os = "macos")]
const LIMITER_RELEASE_PER_BLOCK: f32 = 0.05;
#[cfg(target_os = "macos")]
const MIC_CHANNEL_SIGNAL_RMS: f32 = 0.003;

fn camera_sidecar_path_for(file_path: &std::path::Path) -> Option<PathBuf> {
    ["webm", "mp4"]
        .iter()
        .map(|ext| file_path.with_extension(format!("camera.{ext}")))
        .find(|path| path.exists())
}

/// Show/hide the region frame from generic-`Runtime` code.
///
/// `commands::show_source_highlight` is a `#[tauri::command]` bound to the
/// concrete `AppHandle`, which recording code (generic over `R: Runtime`)
/// cannot call. Same window, but positioned in PHYSICAL pixels.
///
/// The crop rect comes from WGC, which works in physical pixels. Positioning
/// with `LogicalPosition` made Tauri scale those values by the display's DPI
/// factor, so on a scaled display the frame landed shifted and oversized —
/// its top-left stroke fell INSIDE the crop (and was recorded into the video)
/// while its bottom-right fell outside the region entirely.
///
/// `origin` is the crop's top-left on the VIRTUAL DESKTOP. The crop itself is
/// in its display's local pixel space, so drawing at `crop.x/y` put the frame
/// on the primary display whenever the region was on any other one.
#[cfg(target_os = "windows")]
fn show_region_highlight<R: Runtime>(app: &AppHandle<R>, origin: (i32, i32), crop: WinCropRect) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("source-highlight") else {
        return;
    };

    // The frame renders a 4px stroke inset 4px from the window edge — both in
    // CSS pixels, i.e. LOGICAL units. Expanding the window by 8 logical px on
    // every side puts the stroke's inner edge exactly on the crop boundary:
    // visible on screen, outside the recorded pixels. Converted to physical
    // here because the rect below is physical.
    // The scale of the display the region is on, not the one the window was
    // last shown on.
    let scale = crate::commands::monitor_scale_for_physical_point(
        &window,
        f64::from(origin.0),
        f64::from(origin.1),
    )
    .or_else(|| window.scale_factor().ok())
    .unwrap_or(1.0);
    let inset = (8.0 * scale).round() as i32;

    let x = origin.0 - inset;
    let y = origin.1 - inset;
    let width = crop.width as i32 + inset * 2;
    let height = crop.height as i32 + inset * 2;
    if width < 2 || height < 2 {
        return;
    }

    let _ = crate::commands::place_window_physical(&window, x, y, width as u32, height as u32);
    let _ = window.set_always_on_top(true);
    let _ = crate::cursor_track::set_ignore_cursor_events(&window, true);
    crate::commands::exclude_window_from_capture(&window);
    let _ = app.emit_to(
        "source-highlight",
        crate::commands::EVENT_SOURCE_HIGHLIGHT_STYLE,
        "recording",
    );
    crate::commands::REGION_FRAME_ACTIVE.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = window.show();
}

/// macOS counterpart: the capture viewport is already global LOGICAL, so
/// the same 8 px expansion is applied in logical units, and the window is
/// set to `NSWindowSharingNone` so ScreenCaptureKit never composites it.
#[cfg(target_os = "macos")]
fn show_region_highlight<R: Runtime>(app: &AppHandle<R>, rect: SourceHighlightRectDto) {
    use tauri::{LogicalPosition, LogicalSize, Manager};

    let Some(window) = app.get_webview_window("source-highlight") else {
        return;
    };

    let inset = 8.0;
    let width = rect.width + inset * 2.0;
    let height = rect.height + inset * 2.0;
    if width < 2.0 || height < 2.0 {
        return;
    }

    let _ = app.emit_to(
        "source-highlight",
        crate::commands::EVENT_SOURCE_HIGHLIGHT_STYLE,
        "recording",
    );
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.set_position(LogicalPosition::new(rect.x - inset, rect.y - inset));
    let _ = window.set_always_on_top(true);
    let _ = crate::cursor_track::set_ignore_cursor_events(&window, true);
    let _ = window.set_focusable(false);
    // Reached from the async `start_capture`, i.e. a Tokio worker. AppKit's
    // `setSharingType:` aborts off the main thread, so hop over and wait.
    let sharing_window = window.clone();
    let _ = crate::commands::run_on_main_thread_result(app, "region highlight sharing", move |_| {
        if let Ok(ns_window) = sharing_window.ns_window() {
            // SAFETY: same NSWindow sharing call as the area-select overlay,
            // made on the main thread. The level is set here rather than
            // next to `set_always_on_top` above because both go through the
            // event loop in order, so this runs after it resets the level.
            unsafe {
                crate::commands::set_window_sharing_none(ns_window);
                crate::commands::raise_above_menu_bar(ns_window);
            }
        }
        Ok(())
    });
    crate::commands::REGION_FRAME_ACTIVE.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = window.show();
}

fn hide_region_highlight<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;
    crate::commands::REGION_FRAME_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("source-highlight") {
        let _ = window.hide();
    }
}

fn source_rect_from_capture_viewport(
    capture: crate::cursor_track::CaptureViewport,
) -> SourceHighlightRectDto {
    SourceHighlightRectDto {
        x: capture.x,
        y: capture.y,
        width: capture.width,
        height: capture.height,
    }
}

#[cfg(target_os = "macos")]
use crate::capture::audio::{AudioPcmF32, MicStreamGeneration, MicSupervisor};
// Pure level maths — used by the shared `PauseState`, which is NOT gated, so
// these cannot be imported from the macOS-only `capture::audio`. That module
// re-exports them from here, so macOS call sites are unaffected.
use crate::capture::level::{level_has_input, samples_level};
#[cfg(target_os = "macos")]
use crate::capture::macos::{ScreenCaptureHandles, ScreenCapturer, VideoSample};
#[cfg(target_os = "macos")]
use crate::capture::mic_timeline::MicTimeline;
#[cfg(target_os = "macos")]
use crate::encoder::{
    cm_audio_to_frame, Config as EncoderConfig, Mp4Encoder, AUDIO_CHANNELS, SAMPLE_RATE,
    VIDEO_TIME_BASE,
};
#[cfg(target_os = "macos")]
use crate::upload::UploaderHandle;

// Windows path mirrors the same lifecycle shape: WGC for video, cpal for
// mic, cpal-loopback for system audio, all fed into the cross-platform
// `Mp4Encoder`. `recording.rs::start_capture` has a Windows variant below.
#[cfg(any(target_os = "windows", target_os = "macos"))]
use crate::capture::failure::CaptureFailure;
#[cfg(target_os = "windows")]
use crate::capture::windows::{
    AudioChunk as WinAudioChunk, CropRect as WinCropRect, LoopbackCapturer as WinLoopbackCapturer,
    MicSupervisor as WinMicSupervisor, ScreenCaptureHandles as WinScreenCaptureHandles,
    ScreenCapturer as WinScreenCapturer, VideoFrame as WinVideoFrame,
};
#[cfg(target_os = "windows")]
use crate::encoder::{
    Config as EncoderConfig, Mp4Encoder, AUDIO_CHANNELS, SAMPLE_RATE, VIDEO_TIME_BASE,
};
use crate::upload::StreamingUploader;
#[cfg(target_os = "windows")]
use crate::upload::UploaderHandle;

/// Live counters the capture pump updates and the start path reads: source
/// video frames that reached the encoder, and when the last one did. The
/// Mac first-frame guard waits on the count, and both pumps report it in the
/// recording diagnostics (see `capture_health::CaptureHealthReport`).
#[cfg(any(target_os = "macos", target_os = "windows"))]
struct CaptureCounters {
    started_at: Instant,
    source_video_frames: std::sync::atomic::AtomicU64,
    last_source_frame_ms: std::sync::atomic::AtomicU64,
    /// Source frames that arrived but could not be converted or encoded.
    /// Lets the Mac first-frame guard tell "nothing arrived" apart from
    /// "frames arrived and none could be used".
    rejected_source_frames: std::sync::atomic::AtomicU64,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl CaptureCounters {
    fn new(started_at: Instant) -> Self {
        Self {
            started_at,
            source_video_frames: std::sync::atomic::AtomicU64::new(0),
            last_source_frame_ms: std::sync::atomic::AtomicU64::new(0),
            rejected_source_frames: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// A captured frame arrived but could not be converted or encoded.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn note_rejected_source_frame(&self) {
        self.rejected_source_frames
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn rejected_source_frames(&self) -> u64 {
        self.rejected_source_frames
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// A real captured frame (not a repeat of the last one) reached the encoder.
    fn note_source_frame(&self) {
        use std::sync::atomic::Ordering;
        let ms = u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_source_frame_ms.store(ms, Ordering::Relaxed);
        self.source_video_frames.fetch_add(1, Ordering::Relaxed);
    }

    fn source_video_frames(&self) -> u64 {
        self.source_video_frames
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    fn last_source_frame_ms(&self) -> Option<u64> {
        (self.source_video_frames() > 0).then(|| {
            self.last_source_frame_ms
                .load(std::sync::atomic::Ordering::Relaxed)
        })
    }
}

/// How long the Mac start path waits for the first screen frame to reach the
/// encoder. SCK normally delivers one within a few hundred milliseconds; on
/// macOS 12.7.6 takes ran for minutes with none, so a take that
/// gets nothing in this window is stopped instead of recording into nothing.
#[cfg(target_os = "macos")]
const FIRST_SOURCE_FRAME_TIMEOUT: Duration = Duration::from_secs(3);

#[cfg(target_os = "macos")]
const NO_SCREEN_FRAMES: &str = "Clipy could not capture your screen, so the recording was stopped \
     and nothing was uploaded. Open System Settings > Privacy & Security > Screen Recording, \
     make sure Clipy is turned on, then quit and reopen Clipy and try again.";

/// Window takes: a minimized window, or one on another Space, sends no
/// frames either, so the permission is not the only likely cause.
#[cfg(target_os = "macos")]
const NO_WINDOW_FRAMES: &str = "Clipy could not capture that window, so the recording was stopped \
     and nothing was uploaded. Make sure the window is open and not minimized, and that Clipy is \
     turned on in System Settings > Privacy & Security > Screen Recording, then try again.";

/// Frames arrived but none could be encoded: not a permission problem.
#[cfg(target_os = "macos")]
const UNREADABLE_SCREEN_FRAMES: &str = "Clipy could not record what your screen sent, so the \
     recording was stopped and nothing was uploaded. Try again, or choose another display or \
     window.";

/// Wait until the first source frame reaches the encoder. False on timeout.
#[cfg(target_os = "macos")]
async fn wait_for_first_source_frame(counters: &CaptureCounters, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if counters.source_video_frames() > 0 {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[allow(dead_code)]
/// Shared pause / mic-mute flags between the controller, the capture pump,
/// the elapsed ticker, and the cursor tracker (pause/resume). The pump consumes `pending_shift_us` by shifting its mach
/// anchor forward on resume, which keeps every downstream PTS (video,
/// system audio, mic — all `mach - start_mach` derived) continuous with the
/// paused wall-time excluded from the output. Frames arriving while
/// `paused` are dropped at the pump.
pub struct PauseState {
    paused: std::sync::atomic::AtomicBool,
    mic_muted: std::sync::atomic::AtomicBool,
    mic_level_milli: std::sync::atomic::AtomicU32,
    mic_signal_seen: std::sync::atomic::AtomicBool,
    mic_unmuted_recording_ms: std::sync::atomic::AtomicU64,
    /// Committed paused wall-time (µs), accumulated on each resume.
    paused_total_us: std::sync::atomic::AtomicU64,
    /// Anchor shift the pump has not yet consumed (µs).
    pending_shift_us: std::sync::atomic::AtomicU64,
    paused_since: Mutex<Option<Instant>>,
    /// Every pause as `(start, end)` on the capture clock, `end` open while
    /// paused. The Windows pump stamps each frame and chunk from these, as
    /// Cap's `SharedWallClockPause` does, rather than from an anchor shift
    /// that a sample still queued at the resume would read on the wrong side.
    windows: Mutex<Vec<(Instant, Option<Instant>)>>,
}

impl PauseState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            paused: std::sync::atomic::AtomicBool::new(false),
            mic_muted: std::sync::atomic::AtomicBool::new(false),
            mic_level_milli: std::sync::atomic::AtomicU32::new(0),
            mic_signal_seen: std::sync::atomic::AtomicBool::new(false),
            mic_unmuted_recording_ms: std::sync::atomic::AtomicU64::new(0),
            paused_total_us: std::sync::atomic::AtomicU64::new(0),
            pending_shift_us: std::sync::atomic::AtomicU64::new(0),
            paused_since: Mutex::new(None),
            windows: Mutex::new(Vec::new()),
        })
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn is_mic_muted(&self) -> bool {
        self.mic_muted.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn set_mic_muted(&self, muted: bool) {
        self.mic_muted
            .store(muted, std::sync::atomic::Ordering::Release);
    }

    pub fn observe_mic_samples(&self, samples: &[f32]) {
        let level = samples_level(samples);
        if level_has_input(level) {
            self.mic_signal_seen
                .store(true, std::sync::atomic::Ordering::Release);
        }
        let next = (level * 1_000.0).round() as u32;
        let mut current = self
            .mic_level_milli
            .load(std::sync::atomic::Ordering::Acquire);
        while next > current {
            match self.mic_level_milli.compare_exchange(
                current,
                next,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
    }

    pub fn take_mic_level(&self) -> f32 {
        self.mic_level_milli
            .swap(0, std::sync::atomic::Ordering::AcqRel) as f32
            / 1_000.0
    }

    pub fn had_mic_signal(&self) -> bool {
        self.mic_signal_seen
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn add_unmuted_mic_ms(&self, elapsed_ms: u64) {
        self.mic_unmuted_recording_ms
            .fetch_add(elapsed_ms, std::sync::atomic::Ordering::AcqRel);
    }

    pub fn unmuted_mic_ms(&self) -> u64 {
        self.mic_unmuted_recording_ms
            .load(std::sync::atomic::Ordering::Acquire)
    }

    fn begin_pause(&self) {
        let mut since = self.paused_since.lock();
        if since.is_none() {
            let now = Instant::now();
            *since = Some(now);
            self.windows.lock().push((now, None));
        }
        self.paused
            .store(true, std::sync::atomic::Ordering::Release);
    }

    /// Commit the open pause window (idempotent — safe to call on stop even
    /// when not paused).
    fn end_pause(&self) {
        self.commit_pause(true);
    }

    /// Stop from paused: fold the pause into the totals but leave its window
    /// open, so nothing captured between the Stop click and capture teardown
    /// is kept.
    fn end_pause_for_stop(&self) {
        self.commit_pause(false);
    }

    fn commit_pause(&self, close_window: bool) {
        let mut since = self.paused_since.lock();
        if let Some(started) = since.take() {
            let now = Instant::now();
            if close_window {
                if let Some((_, end)) = self.windows.lock().last_mut() {
                    end.get_or_insert(now);
                }
            }
            let us = now.saturating_duration_since(started).as_micros() as u64;
            self.paused_total_us
                .fetch_add(us, std::sync::atomic::Ordering::AcqRel);
            self.pending_shift_us
                .fetch_add(us, std::sync::atomic::Ordering::AcqRel);
        }
        self.paused
            .store(false, std::sync::atomic::Ordering::Release);
    }

    /// Whether a sample captured at `at` falls inside a pause.
    #[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
    pub fn captured_while_paused(&self, at: Instant) -> bool {
        self.windows
            .lock()
            .iter()
            .any(|&(start, end)| start <= at && end.is_none_or(|end| at < end))
    }

    /// Paused time before `at`, which a sample captured then must subtract
    /// from its position on the output timeline.
    #[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
    pub fn paused_before(&self, at: Instant) -> Duration {
        self.windows
            .lock()
            .iter()
            .map(|&(start, end)| end.unwrap_or(at).min(at).saturating_duration_since(start))
            .sum()
    }

    fn take_pending_shift_us(&self) -> u64 {
        self.pending_shift_us
            .swap(0, std::sync::atomic::Ordering::AcqRel)
    }

    /// Wall elapsed minus all paused time (including a still-open pause).
    pub fn effective_elapsed_us(&self, started_at: &Instant) -> u64 {
        let raw = started_at.elapsed().as_micros() as u64;
        let mut paused = self
            .paused_total_us
            .load(std::sync::atomic::Ordering::Acquire);
        if let Some(since) = *self.paused_since.lock() {
            paused = paused.saturating_add(since.elapsed().as_micros() as u64);
        }
        raw.saturating_sub(paused)
    }
}

struct ActiveRecording {
    recording_id: RecordingId,
    file_path: PathBuf,
    started_at: Instant,
    /// Pause / mic-mute flags shared with the pump + ticker + tracker.
    pause: Arc<PauseState>,
    bearer: String,
    api_base: String,

    /// Cursor + click tracker that runs alongside the encoder. Started
    /// at the same moment as the first frame capture so its `time_ms`
    /// origin lines up with the recording's PTS-zero. Drained on stop
    /// into `<id>.cursor.json` + `<id>.zoom.json` sidecars.
    cursor_tracker: Option<crate::cursor_track::CursorTracker>,
    cursor_capture: Option<crate::cursor_track::CaptureViewport>,
    capture_source: Option<CaptureSourceMetadataDto>,
    /// The take records one window's own pixels (macOS window-only mode).
    /// The camera bubble and Flare are separate windows and cannot be in it.
    window_only: bool,

    /// Instant vs Studio (Cap-style). Both authenticated modes stream
    /// during capture; Studio opens native editing instead of surfacing
    /// the share window.
    mode: crate::types::RecordingMode,
    webcam: Option<WebcamCaptureDto>,
    audio: AudioOptionsDto,

    /// Signals the pump task to flush and exit.
    shutdown_tx: Option<oneshot::Sender<()>>,

    /// Pump task: drains capture channels into the writer, then finalizes
    /// the writer. Resolves to bytes written.
    pump_task: Option<JoinHandle<Result<u64>>>,

    /// Periodic ticker that emits state updates so the UI can render
    /// elapsed time and bytes-written while the recording is in flight.
    /// Aborted on stop/cancel.
    ticker_task: Option<JoinHandle<()>>,

    /// Streaming uploader tailing the file. `finish()`d on stop,
    /// `abort()`d on cancel.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    uploader: Option<UploaderHandle>,

    #[cfg(target_os = "macos")]
    screen: Option<ScreenCapturer>,
    #[cfg(target_os = "macos")]
    mic: Option<MicSupervisor>,

    // Windows lifecycle handles. Same shape as the macOS trio above; the
    // pump task drains the channels these own and the stop/cancel paths
    // halt them in the same order.
    #[cfg(target_os = "windows")]
    win_screen: Option<WinScreenCapturer>,
    #[cfg(target_os = "windows")]
    win_mic: Option<WinMicSupervisor>,
    #[cfg(target_os = "windows")]
    win_loopback: Option<WinLoopbackCapturer>,
}

pub struct RecordingController {
    api_base: String,
    state: Arc<Mutex<RecordingStateDto>>,
    active: Arc<Mutex<Option<ActiveRecording>>>,
    /// Most recent share link, kept so the `share` Tauri window can fetch
    /// it on open even if it missed the broadcast event.
    last_share_link: Arc<Mutex<Option<ShareLinkDto>>>,
    /// Terminal outcome of the most recent Instant upload, keyed by recording
    /// id: `Ok(real share link from /complete)` or `Err(finish error text)`.
    /// Written by `stop()` once the uploader's `finish` handle resolves. The
    /// agent bridge reads this to learn the ACTUAL upload result instead of
    /// inferring success from `last_share_link` mutation — which also holds
    /// the early, pre-completion link the uploader reserves at `/initiate`,
    /// so a changed link there does NOT mean the upload succeeded and would
    /// otherwise let the bridge report a dead link as success.
    last_upload_outcome: Arc<Mutex<Option<(RecordingId, Result<ShareLinkDto, String>)>>>,
    /// Most recent Studio recording, backed by the local MP4 and sidecars.
    /// The native editor window uses this for fast local preview.
    last_studio_recording: Arc<Mutex<Option<StudioRecordingDto>>>,
    /// Escape hatch for the drain/finalize phase: once `stop()` hands the
    /// uploader to `finish()`, `active` is empty, so `cancel()` needs this
    /// to interrupt never-terminal upload retries (dead network after
    /// Stop would otherwise pin "Uploading…" forever).
    upload_cancel: Arc<Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>>,
    /// Makes restart-to-update and recording start mutually exclusive.
    /// `start()` holds it through the Idle→Countdown transition;
    /// `restart_to_apply_update` holds it across its gate checks, the
    /// bundle install, and the relaunch — so a recording can never slip
    /// into countdown while the .app is being swapped, and the swap can
    /// never begin once a start is past its phase check.
    start_restart_gate: Arc<tokio::sync::Mutex<()>>,
}

/// `stop()` called with nothing recording: a double Stop (tray, hotkey and
/// HUD racing each other), not a failure. Typed so callers can tell it
/// apart without matching on the message, which the UI also reads.
#[derive(Debug)]
pub(crate) struct NoRecordingInProgress;

impl std::fmt::Display for NoRecordingInProgress {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("no recording in progress")
    }
}

impl std::error::Error for NoRecordingInProgress {}

/// True when a `stop()` error is something the user did (a second Stop, or
/// cancelling the upload) rather than a fault worth reporting. Genuine
/// upload failures are already reported where they happen inside `stop()`.
pub(crate) fn is_benign_stop_error(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<NoRecordingInProgress>().is_some())
        || crate::upload::is_upload_cancelled(error)
}

impl RecordingController {
    pub fn new(api_base: String) -> Self {
        Self {
            api_base,
            state: Arc::new(Mutex::new(RecordingStateDto::idle())),
            active: Arc::new(Mutex::new(None)),
            last_share_link: Arc::new(Mutex::new(None)),
            last_upload_outcome: Arc::new(Mutex::new(None)),
            last_studio_recording: Arc::new(Mutex::new(None)),
            upload_cancel: Arc::new(Mutex::new(None)),
            start_restart_gate: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn start_restart_gate(&self) -> &tokio::sync::Mutex<()> {
        &self.start_restart_gate
    }

    pub fn dto(&self) -> RecordingStateDto {
        self.state.lock().clone()
    }

    /// True while an upload is still running — including Studio's detached
    /// background upload, which keeps going after the phase returns to
    /// Idle. Restart-to-update gates on this, not just the phase.
    pub fn upload_in_flight(&self) -> bool {
        self.upload_cancel.lock().is_some()
    }

    pub fn last_share_link(&self) -> Option<ShareLinkDto> {
        self.last_share_link.lock().clone()
    }

    /// The recording id currently held in `active`, if any. The agent bridge's
    /// max-duration watchdog re-checks this against its session's id before
    /// auto-stopping, so a session left stale by an app-side Stop can never
    /// stop a newer, unrelated recording.
    pub fn active_recording_id(&self) -> Option<RecordingId> {
        self.active.lock().as_ref().map(|a| a.recording_id.clone())
    }

    /// Take the terminal upload outcome recorded by the most recent `stop()`
    /// IF it belongs to `recording_id`. Consumed on read so a later recording
    /// can never observe a stale outcome, and gated on the id so a different
    /// recording's result is never mistaken for this one. `None` means either
    /// no outcome was recorded yet (upload still in flight, or no uploader) or
    /// the recorded outcome is for a different recording. The agent bridge
    /// uses this as the authoritative success/failure signal for `stop`.
    pub fn take_upload_outcome(&self, recording_id: &str) -> Option<Result<ShareLinkDto, String>> {
        let mut guard = self.last_upload_outcome.lock();
        match guard.as_ref() {
            Some((rid, _)) if rid.as_str() == recording_id => {
                guard.take().map(|(_, outcome)| outcome)
            }
            _ => None,
        }
    }

    /// True while the live recording captures a window by itself. The
    /// camera bubble and Flare are their own windows, so ScreenCaptureKit
    /// never puts them in those pixels; the HUD hides or disables both
    /// rather than offer controls that cannot change the video.
    pub fn active_capture_is_window_only(&self) -> bool {
        self.active.lock().as_ref().is_some_and(|a| a.window_only)
    }

    /// Webcam config + mode of the live recording — the HUD camera toggle
    /// needs the saved device/layout to re-show the bubble mid-recording.
    pub fn active_webcam_context(
        &self,
    ) -> Option<(
        Option<WebcamCaptureDto>,
        crate::types::RecordingMode,
        Option<SourceHighlightRectDto>,
    )> {
        let guard = self.active.lock();
        guard.as_ref().map(|a| {
            (
                a.webcam.clone(),
                a.mode,
                a.cursor_capture.map(source_rect_from_capture_viewport),
            )
        })
    }

    pub fn update_active_webcam_appearance(
        &self,
        shape: crate::types::WebcamShapeDto,
        size: crate::types::WebcamSizeDto,
    ) {
        if let Some(active) = self.active.lock().as_mut() {
            let webcam = active.webcam.get_or_insert_with(WebcamCaptureDto::default);
            webcam.shape = shape;
            webcam.size = size;
        }
    }

    pub fn studio_recording(&self, public_id: Option<&str>) -> Option<StudioRecordingDto> {
        let mut recording = self.last_studio_recording.lock().clone()?;
        refresh_studio_recording_json(&mut recording);
        match public_id {
            Some(id) if id != recording.public_id => None,
            _ => Some(recording),
        }
    }

    pub fn studio_recording_from_dir(
        &self,
        public_id: Option<&str>,
        dir: &std::path::Path,
    ) -> Option<StudioRecordingDto> {
        let path = match public_id {
            Some(id) if id.starts_with("local-") => {
                let recording_id = id.trim_start_matches("local-");
                dir.join(format!("{recording_id}.studio.json"))
            }
            Some(_) => return None,
            None => latest_studio_metadata_path(dir)?,
        };
        let mut recording = read_studio_metadata(&path)?;
        refresh_studio_recording_json(&mut recording);
        *self.last_studio_recording.lock() = Some(recording.clone());
        Some(recording)
    }

    pub fn note_camera_sidecar(
        &self,
        recording_id: &str,
        camera_path: PathBuf,
    ) -> Option<StudioRecordingDto> {
        let updated = {
            let mut guard = self.last_studio_recording.lock();
            let recording = guard.as_mut()?;
            if recording.recording_id != recording_id {
                return None;
            }
            recording.camera_path = Some(camera_path);
            refresh_screen_charm_media_metadata(recording);
            let cloned = recording.clone();
            persist_studio_metadata(&cloned);
            cloned
        };
        Some(updated)
    }

    fn set_phase<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        phase: RecordingPhase,
        recording_id: Option<RecordingId>,
    ) {
        let mut guard = self.state.lock();
        guard.phase = phase;
        if recording_id.is_some() {
            guard.recording_id = recording_id;
        }
        if guard.phase == RecordingPhase::Idle {
            guard.recording_id = None;
            guard.elapsed_ms = None;
            guard.bytes_written = None;
            guard.mic_level = None;
            guard.mic_muted = false;
            guard.mic_active = false;
            guard.mic_silence_warning = None;
        }
        let dto = guard.clone();
        drop(guard);
        if phase == RecordingPhase::Idle {
            crate::commands::teardown_webcam_bubble(app);
            crate::commands::teardown_cursor_trail_overlay(app);
            hide_region_highlight(app);
        }
        let _ = app.emit(EVENT_RECORDING_STATE_CHANGED, dto);
    }

    pub async fn start<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        bearer: String,
        source: Option<CaptureSourceDto>,
        audio: Option<AudioOptionsDto>,
        video: Option<VideoOptionsDto>,
        webcam: Option<WebcamCaptureDto>,
        capture_source: Option<CaptureSourceMetadataDto>,
        mode: crate::types::RecordingMode,
        countdown_seconds: u32,
    ) -> Result<RecordingId> {
        // Mutual exclusion with restart-to-update: hold the gate through
        // the Idle→Countdown transition so an update install can never
        // begin once we're past the phase check (and vice-versa).
        let start_gate = self.start_restart_gate.lock().await;

        if self.state.lock().phase != RecordingPhase::Idle {
            return Err(anyhow!("a recording is already in progress"));
        }

        let mut audio = audio.unwrap_or_default();
        let camera_only = matches!(source, Some(CaptureSourceDto::Camera { .. }));
        if camera_only {
            audio.include_system_audio = false;
        }
        let webcam = if camera_only { None } else { webcam };
        // Resolution above 1080p is Pro-gated (server stores desktop MP4s
        // as-uploaded since the remux path — resolution bounds storage).
        // The picker enforces this in the UI; this clamp is the backstop
        // for hotkey starts and stale persisted settings. Uses the cached
        // flag so starting never blocks on the network.
        let video = if mode == crate::types::RecordingMode::Local {
            video.unwrap_or_default()
        } else {
            crate::entitlement::clamp_video_options(
                video.unwrap_or_default(),
                app.state::<crate::entitlement::EntitlementState>()
                    .is_pro_cached(&bearer),
            )
        };
        // A window recorded by itself cannot contain the camera bubble: it
        // is a different window. Starting it anyway would light the camera
        // for a video it never appears in, so the camera stays off. The
        // picker already says so; this covers hotkey and stale settings.
        let window_only = crate::types::is_window_only_capture(source.as_ref(), &video);
        let webcam = if window_only { None } else { webcam };
        if window_only {
            // Dropping the camera only stops a new bubble from opening. A
            // preview that is already up (an agent or hotkey start while the
            // picker showed it) would keep the camera light on for a take it
            // is not in, so close it too.
            crate::commands::teardown_webcam_bubble(app);
        }
        let capture_source = stamp_window_capture(capture_source, source.as_ref(), window_only);

        #[cfg(target_os = "windows")]
        if let Err(err) = crate::capture::windows::check_source_available(source.as_ref()) {
            if mode != crate::types::RecordingMode::Local {
                let (event, reason) = crate::telemetry::classify(&err, "capture_unavailable");
                let error_name = crate::capture::failure::of(&err)
                    .and_then(|failure| failure.error_name.clone())
                    .or_else(|| {
                        crate::api_error::refusal_of(&err)
                            .is_none()
                            .then(|| crate::capture::failure::untyped_error_name_of(&err))
                    });
                crate::telemetry::send(
                    app,
                    crate::telemetry::Event::new(event)
                        .stage("setup")
                        .reason(reason)
                        .maybe_error_name(error_name.as_deref()),
                );
            }
            return Err(err);
        }

        let recording_id = new_recording_id();

        let mut dir = app.path().app_data_dir().context("resolve app data dir")?;
        dir.push("recordings");
        if mode == crate::types::RecordingMode::Local {
            dir = crate::local::directory(app, &recording_id)?;
        }
        std::fs::create_dir_all(&dir).context("create recordings dir")?;
        #[cfg(target_os = "macos")]
        if mode == crate::types::RecordingMode::Local {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        ensure_recording_disk_space(&dir)?;
        let file_path = if mode == crate::types::RecordingMode::Local {
            crate::local::start(app, dir.clone())?;
            dir.join("recording.mp4")
        } else {
            dir.join(format!("{recording_id}.mp4"))
        };

        self.set_phase(app, RecordingPhase::Countdown, Some(recording_id.clone()));
        // Phase is now non-idle, which restart_to_apply_update checks under
        // this same gate — safe to release before the long countdown/capture.
        drop(start_gate);
        run_countdown(app, countdown_seconds).await;

        let cancelled = {
            let state = self.state.lock();
            state.recording_id.as_deref() != Some(recording_id.as_str()) || state.phase != RecordingPhase::Countdown
        };
        if cancelled {
            if mode == crate::types::RecordingMode::Local {
                crate::local::discard(app, dir).await?;
            } else {
                crate::telemetry::send(
                    app,
                    crate::telemetry::Event::new(crate::telemetry::RECORDING_CANCELLED)
                        .recording(&recording_id)
                        .stage("countdown")
                        .reason("user_cancelled"),
                );
            }
            bail!("Recording countdown cancelled");
        }

        let capture_result = start_capture(
            app,
            &self.api_base,
            &bearer,
            &recording_id,
            &file_path,
            &self.active,
            source.as_ref(),
            &audio,
            &video,
            webcam.clone(),
            capture_source.map(CaptureSourceMetadataDto::normalized),
            &self.state,
            mode,
        )
        .await;

        if let Err(err) = capture_result {
            if mode == crate::types::RecordingMode::Local {
                crate::local::cancel(app);
            } else {
                // The take never started, so nothing on disk is worth
                // keeping. On Windows the encoder writes the MP4 header
                // before `/initiate` runs, and a refused or offline initiate
                // used to leave that 1.2 KB file behind to be offered for
                // "recovery" (beta 1.1.81). The encoder and capture are
                // dropped by now, so the file is closed. Every start error
                // path ends here, so none of them can leak a file.
                if let Err(cleanup_err) =
                    crate::recording_files::remove_local_recording_artifacts(&file_path).await
                {
                    tracing::warn!(
                        "failed start left a local file that could not be removed: {cleanup_err:#}"
                    );
                }
            }
            // Recover to Idle so the UI's Start Recording button reappears
            // instead of staying stuck on the countdown.
            self.set_phase(app, RecordingPhase::Idle, None);

            // A start refused by the gate is the product working, not a
            // failure, so it is classified off the error chain rather than
            // counted against the desktop failure rate.
            if mode != crate::types::RecordingMode::Local {
                let (event, reason) = crate::telemetry::classify(&err, "capture_unavailable");
                let failure = crate::capture::failure::of(&err);
                // Never empty: an error nobody named yet is still described
                // by a fixed-vocabulary slug (never its text).
                // A server refusal already names itself in reason_code; the
                // fallback would only describe the step it came through.
                let error_name = failure
                    .and_then(|failure| failure.error_name.clone())
                    .or_else(|| {
                        crate::api_error::refusal_of(&err)
                            .is_none()
                            .then(|| crate::capture::failure::untyped_error_name_of(&err))
                    });
                let mut event = crate::telemetry::Event::new(event)
                    .recording(&recording_id)
                    .stage("setup")
                    .reason(reason)
                    .maybe_error_name(error_name.as_deref());
                for (key, value) in failure.map(|f| f.measures()).unwrap_or_default() {
                    event = event.measure(*key, Some(value.clone()));
                }
                crate::telemetry::send(app, event);
            }

            return Err(err);
        }

        self.set_phase(app, RecordingPhase::Recording, Some(recording_id.clone()));
        {
            let mut s = self.state.lock();
            s.elapsed_ms = Some(0);
            s.bytes_written = Some(0);
        }

        Ok(recording_id)
    }

    pub async fn stop<R: Runtime + 'static>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<RecordingMetadata> {
        {
            let guard = self.state.lock();
            if guard.phase != RecordingPhase::Recording && guard.phase != RecordingPhase::Paused {
                return Err(NoRecordingInProgress.into());
            }
        }
        // Fold any open pause into the totals so the pump's shutdown fill
        // targets the correct (pause-excluded) timeline position.
        if let Some(active) = self.active.lock().as_ref() {
            active.pause.end_pause_for_stop();
        }
        self.set_phase(app, RecordingPhase::Stopping, None);

        let mut active = self
            .active
            .lock()
            .take()
            .ok_or_else(|| anyhow!("internal: no active recording"))?;

        let started_at = active.started_at;
        let stopped_at = Instant::now();
        #[cfg(target_os = "macos")]
        let mic_capture_started = active.mic.is_some();
        #[cfg(target_os = "windows")]
        let mic_capture_started = active.win_mic.is_some();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mic_capture_started = false;
        // Pause-excluded elapsed for the duration fallback (probing the
        // finalized MP4 is preferred; this is the no-probe path).
        let effective_elapsed_ms = active.pause.effective_elapsed_us(&started_at) / 1_000;
        let recording_id = active.recording_id.clone();
        let file_path = active.file_path.clone();

        // If an agent session is driving this recording, ending it from the app
        // (human Stop) must clear the bridge session so the max-duration
        // watchdog and any later `clipy session stop` can't act on a stale
        // session. No-op on the agent's own stop path (it already took SESSION)
        // and on plain human/web recordings (no session to match).
        crate::agent_bridge::clear_session_for(&recording_id);

        // Stop the cursor tracker FIRST so we capture as much of the
        // user's final interaction as possible. We harvest the events
        // here but defer the sidecar write until after the encoder
        // pump drains — that way we know the recording's actual
        // duration and can clamp zoom segments to it.
        let cursor_track = active.cursor_tracker.take().map(|t| t.stop());

        if let Some(t) = active.ticker_task.take() {
            t.abort();
        }

        #[cfg(target_os = "macos")]
        {
            crate::commands::teardown_webcam_bubble(app);
            // Tell the encoder to stop before awaiting ScreenCaptureKit
            // teardown. SCK stop can occasionally lag; the user's
            // recording should end when they pressed Stop, not when the
            // OS finishes shutting the stream down.
            if let Some(shutdown_tx) = active.shutdown_tx.take() {
                let _ = shutdown_tx.send(());
            }
            // Close the microphone before awaiting ScreenCaptureKit. SCK
            // teardown can lag, but the macOS microphone indicator must clear
            // as soon as the user presses Stop instead of waiting behind it.
            if let Some(mic) = active.mic.take() {
                if let Err(e) = mic.stop() {
                    tracing::warn!("mic.stop failed: {e:#}");
                }
            }
            if let Some(screen) = active.screen.take() {
                if let Err(e) = screen.stop().await {
                    tracing::warn!("screen.stop failed: {e:#}");
                }
            }
            crate::commands::teardown_cursor_trail_overlay(app);
            // Custom size frame: clear it whatever the stop reason, before
            // SCK teardown, so it never outlives the recording on screen.
            hide_region_highlight(app);
        }
        #[cfg(target_os = "windows")]
        {
            // Stop screen first so the pump's video loop drains the
            // remaining frames in the channel before being shut down.
            // Audio is drained in the pump task on `shutdown_tx`.
            if let Some(screen) = active.win_screen.take() {
                if let Err(e) = screen.stop().await {
                    tracing::warn!("win screen.stop failed: {e:#}");
                }
            }
            if let Some(mic) = active.win_mic.take() {
                // Waits up to 2 s for the supervisor thread; keep that off
                // the async runtime.
                match tokio::task::spawn_blocking(move || mic.stop()).await {
                    Ok(Err(e)) => tracing::warn!("win mic.stop failed: {e:#}"),
                    Err(e) => tracing::warn!("win mic.stop task failed: {e}"),
                    Ok(Ok(())) => {}
                }
            }
            // Region recordings draw their own frame (Windows' indicator is
            // suppressed there); clear it whatever the stop reason, so it can
            // never outlive the recording.
            hide_region_highlight(app);
            if let Some(loopback) = active.win_loopback.take() {
                if let Err(e) = loopback.stop() {
                    tracing::warn!("win loopback.stop failed: {e:#}");
                }
            }
        }

        if let Some(shutdown_tx) = active.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        let mut pump_failure: Option<&'static str> = None;
        let bytes_written = if let Some(task) = active.pump_task.take() {
            match task.await {
                Ok(Ok(n)) => n,
                Ok(Err(e)) => {
                    tracing::error!("encoder pump errored: {e:#}");
                    pump_failure = Some("encoder_pump_failed");
                    0
                }
                Err(e) => {
                    tracing::error!("encoder pump join failed: {e:#}");
                    pump_failure = Some("encoder_pump_join_failed");
                    0
                }
            }
        } else {
            0
        };

        // Zero bytes is the silent empty recording: capture opened without error, the UI showed a normal take,
        // and nothing came out. It produced no error and no event anywhere.
        let capture_failure = match (pump_failure, bytes_written) {
            (Some(reason), _) => Some(("media", reason)),
            (None, 0) => Some(("capture", "capture_produced_no_bytes")),
            _ => None,
        };
        if let Some((stage, reason)) = capture_failure {
            if active.mode != crate::types::RecordingMode::Local {
                crate::telemetry::send(
                    app,
                    crate::telemetry::Event::new(crate::telemetry::RECORDING_FAILED)
                        .recording(&recording_id)
                        .stage(stage)
                        .reason(reason),
                );
            }
        }

        if bytes_written > 0 { crate::recorder_actions::play_stop_sound(); }

        let wall_duration_ms = stopped_at.duration_since(started_at).as_millis() as u64;
        let duration_ms = probe_mp4_duration_ms(&file_path).unwrap_or(effective_elapsed_ms);
        if duration_ms.abs_diff(wall_duration_ms) > 250 {
            tracing::info!(
                wall_duration_ms,
                media_duration_ms = duration_ms,
                "using finalized MP4 duration for recording metadata"
            );
        }
        let mic_input_missing = active.audio.include_mic
            && (!mic_capture_started
                || (active.pause.unmuted_mic_ms() >= MIC_SILENCE_WARNING_MS
                    && !active.pause.had_mic_signal()));
        if mic_input_missing {
            let message = crate::i18n::t(if mic_capture_started {
                "notifications.micSilent"
            } else if cfg!(target_os = "windows") {
                "notifications.micNotStartedWindows"
            } else {
                "notifications.micNotStartedMac"
            });
            tracing::warn!(recording_id = %recording_id, "recording finished without microphone input");
            let _ = app.emit(
                EVENT_RECORDING_AUDIO_WARNING,
                serde_json::json!({ "message": message }),
            );
            use tauri_plugin_notification::NotificationExt;
            let _ = app
                .notification()
                .builder()
                .title(crate::edition::APP_NAME)
                .body(message)
                .show();
        }
        {
            let mut s = self.state.lock();
            s.elapsed_ms = Some(duration_ms);
            s.bytes_written = Some(bytes_written);
        }

        // Write the cursor + zoom sidecars BEFORE flipping to Uploading.
        // The sidecars sit next to <id>.mp4 in the recordings dir; if the
        // server later wants them, an explicit endpoint can pull them, but
        // they are not in the current raw-upload contract — keeping the
        // upload path single-purpose for now (see follow-ups below).
        if let Some(track) = cursor_track {
            write_cursor_sidecars(
                &file_path,
                &track,
                duration_ms,
                active.cursor_capture,
                active.capture_source.as_ref(),
                Some(&active.audio),
                active.webcam.as_ref(),
                None,
                // Instant = raw video, no auto-zoom animation. The zoom
                // sidecar is Studio's animation recipe; cursor/keystroke
                // data still uploads for key moments + agent context.
                active.mode == crate::types::RecordingMode::Studio,
            );
        }

        if active.mode == crate::types::RecordingMode::Local {
            let metadata = RecordingMetadata {
                recording_id,
                file_path,
                bytes: bytes_written,
                duration_ms,
            };
            let dir = metadata.file_path.parent().context("local directory")?;
            let result = crate::local::finish(dir, &metadata);
            if let Err(handoff_error) = &result {
                if let Err(error) = crate::local::record_handoff_failure(dir, handoff_error) {
                    tracing::warn!("local handoff diagnostic could not be saved: {error:#}");
                }
                crate::local::cancel(app);
            }
            self.set_phase(app, RecordingPhase::Idle, None);
            result?;
            // An agent's take goes back to the agent through `stop`, and a
            // talk-key take is pasted by `talk.rs`.
            if !crate::local::is_handed_off(dir) {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                let arec = metadata.file_path.with_file_name("recording.arec");
                if let Err(err) = app.clipboard().write_text(arec.to_string_lossy().into_owned()) {
                    tracing::warn!("local AREC clipboard write failed: {err:#}");
                }
            }
            return Ok(metadata);
        }

        self.set_phase(app, RecordingPhase::Uploading, Some(recording_id.clone()));

        // Finish the streaming upload: the tail task has been shipping
        // bytes throughout. `finish()` drains anything left, runs the
        // server-side /finalize + /complete, and resolves to the share link.
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let mut instant_upload_error = None;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let mut instant_upload_cancelled = false;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let mode = active.mode;
            match mode {
                crate::types::RecordingMode::Local => {
                    unreachable!("local completion returns before upload")
                }
                crate::types::RecordingMode::Instant => {
                    if let Some(uploader) = active.uploader.take() {
                        *self.upload_cancel.lock() = Some(uploader.cancel.clone());
                        let handle = (uploader.finish)();
                        // Record the ACTUAL terminal outcome (not the early
                        // link) so the agent bridge can report real
                        // success/failure to the CLI. Keyed by recording id.
                        match handle.await {
                            Ok(Ok(share)) => {
                                tracing::info!(url = %share.url, mode = ?mode, "share link ready");
                                *self.last_share_link.lock() = Some(share.clone());
                                surface_share_link(app, &share);
                                *self.last_upload_outcome.lock() =
                                    Some((recording_id.clone(), Ok(share)));
                            }
                            Ok(Err(err)) => {
                                let message = format!("{err:#}");
                                if crate::upload::is_upload_cancelled(&err) {
                                    tracing::info!("uploader finish cancelled");
                                    instant_upload_cancelled = true;
                                } else {
                                    tracing::error!("uploader finish failed: {message}");
                                }
                                *self.last_upload_outcome.lock() =
                                    Some((recording_id.clone(), Err(message.clone())));
                                instant_upload_error = Some(message);
                            }
                            Err(err) => {
                                let message = format!("{err:#}");
                                tracing::error!("uploader finish join failed: {message}");
                                *self.last_upload_outcome.lock() =
                                    Some((recording_id.clone(), Err(message.clone())));
                                // The uploader reports its own terminal
                                // failures with the stage they happened in; a
                                // dead task never reaches that code.
                                crate::telemetry::send(
                                    app,
                                    crate::telemetry::Event::new(
                                        crate::telemetry::RECORDING_FAILED,
                                    )
                                    .recording(&recording_id)
                                    .stage("upload")
                                    .reason("upload_task_died"),
                                );
                                instant_upload_error = Some(message);
                            }
                        }
                        *self.upload_cancel.lock() = None;
                    }
                }
                crate::types::RecordingMode::Studio => {
                    self.remember_studio_recording(
                        &recording_id,
                        &file_path,
                        bytes_written,
                        duration_ms,
                        None,
                        active.webcam.clone(),
                        Some(active.audio.clone()),
                    );
                    let public_id = format!("local-{recording_id}");
                    if let Err(e) = crate::commands::open_editor_window(app, &public_id) {
                        tracing::error!("open editor (studio) failed: {e}");
                    }

                    if let Some(uploader) = active.uploader.take() {
                        *self.upload_cancel.lock() = Some(uploader.cancel.clone());
                        let handle = (uploader.finish)();
                        let app = app.clone();
                        let last_share_link = self.last_share_link.clone();
                        let last_studio_recording = self.last_studio_recording.clone();
                        let upload_cancel = self.upload_cancel.clone();
                        tauri::async_runtime::spawn(async move {
                            match handle.await {
                                Ok(Ok(share)) => {
                                    tracing::info!(url = %share.url, "studio upload ready");
                                    *last_share_link.lock() = Some(share.clone());
                                    let _ = app.emit(EVENT_SHARE_LINK_READY, &share);
                                    let updated = {
                                        let mut guard = last_studio_recording.lock();
                                        if let Some(recording) = guard.as_mut() {
                                            recording.remote_public_id =
                                                Some(share.public_id.clone());
                                            recording.video_id = Some(share.video_id.clone());
                                            recording.share_url = Some(share.url.clone());
                                            Some(recording.clone())
                                        } else {
                                            None
                                        }
                                    };
                                    if let Some(recording) = updated {
                                        persist_studio_metadata(&recording);
                                        let _ = app.emit(EVENT_STUDIO_RECORDING_UPDATED, recording);
                                    }
                                }
                                Ok(Err(err)) => {
                                    tracing::error!("studio uploader finish failed: {err:#}");
                                }
                                Err(err) => {
                                    tracing::error!("studio uploader finish join failed: {err:#}");
                                }
                            }
                            *upload_cancel.lock() = None;
                        });
                    }
                }
            }
        }

        self.set_phase(app, RecordingPhase::Idle, None);

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(error) = instant_upload_error {
            // Keep the cancellation typed so callers can tell a user's own
            // cancel from a failure (the message text is unchanged).
            if instant_upload_cancelled {
                return Err(anyhow::Error::new(crate::upload::UploadCancelled)
                    .context("recording saved locally but upload did not complete"));
            }
            bail!("recording saved locally but upload did not complete: {error}");
        }

        Ok(RecordingMetadata {
            recording_id,
            file_path,
            bytes: bytes_written,
            duration_ms,
        })
    }

    fn remember_studio_recording(
        &self,
        recording_id: &RecordingId,
        file_path: &std::path::Path,
        bytes: u64,
        duration_ms: u64,
        share: Option<&ShareLinkDto>,
        webcam: Option<WebcamCaptureDto>,
        audio: Option<AudioOptionsDto>,
    ) {
        let cursor_path = file_path.with_extension("cursor.json");
        let zoom_path = file_path.with_extension("zoom.json");
        let camera_path = camera_sidecar_path_for(file_path);
        let project_path = file_path.with_extension("project.json");
        let screen_charm_path = file_path.with_extension("screencharm.json");
        let cursor_json = read_json_if_exists(&cursor_path);
        let zoom_json = read_json_if_exists(&zoom_path);
        let project_json = read_json_if_exists(&project_path);
        let screen_charm_json = read_json_if_exists(&screen_charm_path);
        let public_id = format!("local-{recording_id}");
        let dto = StudioRecordingDto {
            recording_id: recording_id.clone(),
            public_id,
            remote_public_id: share.map(|s| s.public_id.clone()),
            video_id: share.map(|s| s.video_id.clone()),
            share_url: share.map(|s| s.url.clone()),
            local_file_path: file_path.to_path_buf(),
            cursor_path: cursor_path.exists().then_some(cursor_path),
            zoom_path: zoom_path.exists().then_some(zoom_path),
            camera_path,
            project_path: Some(project_path),
            screen_charm_path: screen_charm_path.exists().then_some(screen_charm_path),
            cursor_json,
            zoom_json,
            project_json,
            screen_charm_json,
            webcam,
            audio,
            bytes,
            duration_ms,
        };
        persist_studio_metadata(&dto);
        *self.last_studio_recording.lock() = Some(dto);
    }

    /// Pause capture: frames are dropped at the pump and the paused
    /// wall-time is excluded from the output video's timeline. The SCK
    /// stream and uploader stay alive (the file simply stops growing).
    pub fn pause<R: Runtime>(&self, app: &AppHandle<R>) -> Result<()> {
        {
            let guard = self.state.lock();
            if guard.phase != RecordingPhase::Recording {
                return Err(anyhow!("not recording"));
            }
        }
        let pause = self
            .active
            .lock()
            .as_ref()
            .map(|a| a.pause.clone())
            .ok_or_else(|| anyhow!("internal: no active recording"))?;
        pause.begin_pause();
        self.set_phase(app, RecordingPhase::Paused, None);
        tracing::info!("recording paused");
        Ok(())
    }

    pub fn resume<R: Runtime>(&self, app: &AppHandle<R>) -> Result<()> {
        {
            let guard = self.state.lock();
            if guard.phase != RecordingPhase::Paused {
                return Err(anyhow!("not paused"));
            }
        }
        let pause = self
            .active
            .lock()
            .as_ref()
            .map(|a| a.pause.clone())
            .ok_or_else(|| anyhow!("internal: no active recording"))?;
        pause.end_pause();
        self.set_phase(app, RecordingPhase::Recording, None);
        tracing::info!("recording resumed");
        Ok(())
    }

    /// Live mic mute: the pump zeroes mic PCM while set (frames keep
    /// flowing so the audio mixer's source pacing is undisturbed).
    pub fn set_mic_muted(&self, muted: bool) -> Result<()> {
        let pause = self
            .active
            .lock()
            .as_ref()
            .map(|a| a.pause.clone())
            .ok_or_else(|| anyhow!("no active recording"))?;
        pause.set_mic_muted(muted);
        // tracing::info!(muted, "mic mute toggled");
        tracing::info!(
            requested = muted,
            actual = pause.is_mic_muted(),
            "mic mute toggled"
        );
        Ok(())
    }

    pub async fn retry_local_upload<R: Runtime + 'static>(
        &self,
        app: &AppHandle<R>,
        bearer: String,
        file_path: PathBuf,
    ) -> Result<ShareLinkDto> {
        let _start_gate = self.start_restart_gate.lock().await;
        if self.state.lock().phase != RecordingPhase::Idle || self.active.lock().is_some() {
            bail!("finish the current recording before recovering another one");
        }
        if self.upload_in_flight() {
            bail!("another upload is already in progress");
        }

        let metadata = tokio::fs::symlink_metadata(&file_path)
            .await
            .with_context(|| format!("read recoverable recording {}", file_path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!("recoverable recording must be a regular file");
        }
        let bytes = metadata.len();
        // The file is `<recordingId>.mp4`: the take this upload stands in
        // for. Reported as `recovered_from` so a recovered upload can be
        // tied back to the attempt it replaces; otherwise a recovery looks
        // like an abandoned take because nothing links the ids.
        let recovered_from = recovered_recording_id(&file_path);
        let upload_id = new_recording_id();
        let upload_id_for_report = upload_id.clone();
        self.set_phase(app, RecordingPhase::Uploading, Some(upload_id.clone()));
        self.state.lock().bytes_written = Some(bytes);

        let result = async {
            let uploader = StreamingUploader::start(
                app,
                self.api_base.clone(),
                bearer,
                upload_id,
                file_path,
                None,
                None,
                true,
            )
            .await
            .map_err(|err| {
                // Offline: say so plainly and keep the file, so Recover works
                // once the connection is back. Anything else keeps its chain.
                if crate::api_error::is_offline(&err) {
                    anyhow::Error::new(crate::capture::failure::CaptureFailure::new(
                        "offline",
                        crate::capture::failure::OFFLINE_RECOVER,
                    ))
                } else {
                    err.context("start recovery upload")
                }
            })?;
            *self.upload_cancel.lock() = Some(uploader.cancel.clone());
            let handle = (uploader.finish)();
            match handle.await {
                Ok(result) => result.context("finish recovery upload"),
                Err(err) => Err(anyhow!("recovery upload task failed: {err:#}")),
            }
        }
        .await;

        *self.upload_cancel.lock() = None;
        match &result {
            Ok(share) => {
                *self.last_share_link.lock() = Some(share.clone());
                surface_share_link(app, share);
                crate::telemetry::send(
                    app,
                    crate::telemetry::Event::new(crate::telemetry::RECORDING_RECOVERED)
                        .recording(&upload_id_for_report)
                        .stage("recovery")
                        .measure("recovered_from", recovered_from.clone()),
                );
            }
            Err(err) => {
                let (_, reason) = crate::telemetry::classify(err, "recovery_upload_failed");
                crate::telemetry::send(
                    app,
                    crate::telemetry::Event::new(crate::telemetry::RECORDING_RECOVERY_FAILED)
                        .recording(&upload_id_for_report)
                        .stage("recovery")
                        .reason(reason)
                        .measure("recovered_from", recovered_from.clone()),
                );
            }
        }
        self.set_phase(app, RecordingPhase::Idle, None);
        result
    }

    pub async fn discard_local_recording(&self, file_path: &std::path::Path) -> Result<()> {
        let _start_gate = self
            .start_restart_gate
            .try_lock()
            .map_err(|_| anyhow!("wait for the current recording or upload to finish"))?;
        if self.state.lock().phase != RecordingPhase::Idle
            || self.active.lock().is_some()
            || self.upload_in_flight()
        {
            bail!("wait for the current recording or upload to finish");
        }
        crate::recording_files::remove_local_recording_artifacts(file_path).await?;
        Ok(())
    }

    pub async fn cancel<R: Runtime>(&self, app: &AppHandle<R>) -> Result<()> {
        // Read before anything is torn down: the phase says which stage the
        // user walked away from, and `active` is about to be emptied.
        let cancelled_at = self.state.lock().clone();

        // Post-Stop cancel: the uploader is inside `finish()` and `active`
        // is already empty. Flip its abort flag so never-terminal retries
        // stop pinning the Uploading phase; the in-flight finish errors
        // out and the stop flow returns to idle.
        let mut cancelled_something = false;
        if let Some(cancel_upload) = self.upload_cancel.lock().take() {
            cancel_upload();
            cancelled_something = true;
        }
        let maybe_active = self.active.lock().take();
        cancelled_something |= maybe_active.is_some();

        // Desktop emitted no cancellation event at all, which is why an
        // unfinished desktop recording was indistinguishable from a lost one.
        // A cancel that found nothing to cancel is not a user giving up.
        let local_mode = maybe_active
            .as_ref()
            .is_some_and(|active| active.mode == crate::types::RecordingMode::Local);
        if cancelled_something && !local_mode {
            let stage = match cancelled_at.phase {
                RecordingPhase::Countdown => "countdown",
                RecordingPhase::Recording | RecordingPhase::Paused => "recording",
                _ => "upload",
            };
            let event = crate::telemetry::Event::new(crate::telemetry::RECORDING_CANCELLED)
                .maybe_recording(cancelled_at.recording_id.as_deref())
                .stage(stage)
                .reason("user_discarded");
            crate::telemetry::send(
                app,
                match cancelled_at.elapsed_ms {
                    Some(ms) => event.elapsed_ms(ms),
                    None => event,
                },
            );
        }
        if let Some(mut active) = maybe_active {
            if active.mode == crate::types::RecordingMode::Local {
                crate::local::cancel(app);
            }
            // Same as stop(): clear any agent session bound to this recording so
            // a human Cancel can't leave a stale session for the watchdog.
            crate::agent_bridge::clear_session_for(&active.recording_id);
            // Stop the cursor tracker first so its thread joins cleanly;
            // we discard the events because a cancelled recording has no
            // sidecar consumer.
            if let Some(tracker) = active.cursor_tracker.take() {
                let _ = tracker.stop();
            }
            if let Some(t) = active.ticker_task.take() {
                t.abort();
            }
            #[cfg(target_os = "macos")]
            {
                if let Some(mic) = active.mic.take() {
                    let _ = mic.stop();
                }
                if let Some(screen) = active.screen.take() {
                    let _ = screen.stop().await;
                }
            }
            #[cfg(target_os = "windows")]
            {
                if let Some(screen) = active.win_screen.take() {
                    let _ = screen.stop().await;
                }
                if let Some(mic) = active.win_mic.take() {
                    let _ = tokio::task::spawn_blocking(move || mic.stop()).await;
                }
                if let Some(loopback) = active.win_loopback.take() {
                    let _ = loopback.stop();
                }
            }
            if let Some(tx) = active.shutdown_tx.take() {
                let _ = tx.send(());
            }
            if let Some(task) = active.pump_task.take() {
                let _ = task.await;
            }
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if let Some(uploader) = active.uploader.take() {
                let handle = (uploader.abort)();
                let _ = handle.await;
            }
            if active.mode == crate::types::RecordingMode::Local {
                let result = crate::local::discard(
                    app,
                    active
                        .file_path
                        .parent()
                        .context("local directory")?
                        .to_path_buf(),
                )
                .await;
                self.set_phase(app, RecordingPhase::Idle, None);
                result?;
                return Ok(());
            }
            if active.file_path.exists() {
                if let Err(e) = std::fs::remove_file(&active.file_path) {
                    tracing::warn!(
                        "failed to delete cancelled recording {}: {e:#}",
                        active.file_path.display()
                    );
                }
            }
        }
        self.set_phase(app, RecordingPhase::Idle, None);
        Ok(())
    }
}

/// Give the notification permission prompt and the tray a moment before
/// interrupting someone who just launched the app.
const LAUNCH_RECOVERY_NOTICE_DELAY: Duration = Duration::from_secs(4);

/// How long a header-only MP4 (see `mp4_boxes`) must have gone unmodified
/// before the recovery scan deletes it. The take being recorded is excluded
/// by id as well; this covers the moment between a start creating its file
/// and the take becoming active, when the file is only its header.
const HEADER_ONLY_PURGE_AGE: Duration = Duration::from_secs(10 * 60);

/// `active` is the take in progress, if any: its file is never judged or
/// deleted here, because a take that has just started (or was paused right
/// away) is a header-only MP4 too.
pub(crate) async fn list_recoverable_recordings_in_dir(
    dir: &std::path::Path,
    now: SystemTime,
    active: Option<&str>,
) -> Result<Vec<RecoverableRecordingDto>> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err).context("read desktop recordings directory"),
    };
    let mut recoverable = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(recording_id) = file_name.split('.').next() else {
            continue;
        };
        if uuid::Uuid::parse_str(recording_id).is_err() {
            continue;
        }
        if tokio::fs::try_exists(dir.join(format!("{recording_id}.studio.json"))).await? {
            continue;
        }
        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err).context("read local recording file type"),
        };
        if !file_type.is_file() {
            continue;
        }
        let metadata = match entry.metadata().await {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err).context("read local recording metadata"),
        };
        let updated_at = metadata.modified().unwrap_or(now);
        let age = now.duration_since(updated_at).unwrap_or_default();
        let primary_mp4 = dir.join(format!("{recording_id}.mp4"));
        if path != primary_mp4 {
            if age >= LOCAL_RECOVERY_RETENTION && !tokio::fs::try_exists(&primary_mp4).await? {
                if let Err(err) =
                    crate::recording_files::remove_local_recording_artifacts(&primary_mp4).await
                {
                    tracing::warn!(
                        recording_id,
                        "failed to purge expired local recording artifacts: {err:#}"
                    );
                }
            }
            continue;
        }
        if age >= LOCAL_RECOVERY_RETENTION {
            if let Err(err) = crate::recording_files::remove_local_recording_artifacts(&path).await {
                tracing::warn!(
                    recording_id,
                    "failed to purge expired local recording: {err:#}"
                );
            }
            continue;
        }
        if metadata.len() == 0 {
            continue;
        }
        if active == Some(recording_id) {
            continue;
        }
        // A file with no media (a start that failed after the encoder wrote
        // its header, beta 1.1.81 offline) is never offered: Recover would
        // upload a file the server cannot play. Only a clean walk that found
        // no fragment counts; anything unreadable stays listed.
        let scan_path = path.clone();
        let media = tokio::task::spawn_blocking(move || crate::mp4_boxes::scan_file(&scan_path))
            .await
            .unwrap_or(crate::mp4_boxes::Mp4Media::Unknown);
        if media == crate::mp4_boxes::Mp4Media::HeaderOnly {
            if age >= HEADER_ONLY_PURGE_AGE {
                match crate::recording_files::remove_local_recording_artifacts(&path).await {
                    Ok(()) => tracing::debug!(
                        recording_id,
                        bytes = metadata.len(),
                        "removed header-only local recording (no media data)"
                    ),
                    Err(err) => tracing::warn!(
                        recording_id,
                        "header-only local recording could not be removed: {err:#}"
                    ),
                }
            }
            continue;
        }
        let updated_at_ms = updated_at
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        recoverable.push(RecoverableRecordingDto {
            recording_id: recording_id.to_string(),
            bytes: metadata.len(),
            updated_at_ms,
            expires_at_ms: updated_at_ms + LOCAL_RECOVERY_RETENTION.as_millis() as u64,
        });
    }
    recoverable.sort_by_key(|recording| std::cmp::Reverse(recording.updated_at_ms));
    Ok(recoverable)
}

/// Records on the capture metadata whether a window take is the window alone
/// or the screen area under it. Agent and hotkey starts pass no picker
/// metadata, so a window take gets a minimal record of its own: without it
/// the sidecar could not say which kind of footage it describes.
fn stamp_window_capture(
    capture_source: Option<CaptureSourceMetadataDto>,
    source: Option<&CaptureSourceDto>,
    window_only: bool,
) -> Option<CaptureSourceMetadataDto> {
    let window_capture =
        matches!(source, Some(CaptureSourceDto::Window { .. })).then_some(if window_only {
            crate::types::WindowCaptureModeDto::Window
        } else {
            crate::types::WindowCaptureModeDto::Area
        });
    match capture_source {
        Some(metadata) => Some(CaptureSourceMetadataDto {
            window_capture,
            ..metadata
        }),
        None => window_capture.map(|mode| CaptureSourceMetadataDto {
            source_tab: crate::types::RecordingSourceTab::Window,
            source: source.cloned(),
            window_app_name: None,
            window_title: None,
            controlled_evidence: None,
            window_capture: Some(mode),
        }),
    }
}

fn read_json_if_exists(path: &std::path::Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn studio_metadata_path_for_recording(recording: &StudioRecordingDto) -> std::path::PathBuf {
    recording.local_file_path.with_extension("studio.json")
}

fn persist_studio_metadata(recording: &StudioRecordingDto) {
    let path = studio_metadata_path_for_recording(recording);
    match serde_json::to_vec_pretty(recording) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                tracing::warn!("studio metadata write failed {}: {e:#}", path.display());
            }
        }
        Err(e) => {
            tracing::warn!("studio metadata serialize failed: {e:#}");
        }
    }
}

fn read_studio_metadata(path: &std::path::Path) -> Option<StudioRecordingDto> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn refresh_studio_recording_json(recording: &mut StudioRecordingDto) {
    recording.camera_path = camera_sidecar_path_for(&recording.local_file_path);
    if let Some(path) = &recording.cursor_path {
        recording.cursor_json = read_json_if_exists(path);
    }
    if let Some(path) = &recording.zoom_path {
        recording.zoom_json = read_json_if_exists(path);
    }
    if let Some(path) = &recording.project_path {
        recording.project_json = read_json_if_exists(path);
    }
    if let Some(path) = &recording.screen_charm_path {
        recording.screen_charm_json = read_json_if_exists(path);
    }
    refresh_screen_charm_media_metadata(recording);
}

fn refresh_screen_charm_media_metadata(recording: &mut StudioRecordingDto) {
    let Some(path) = recording.screen_charm_path.clone() else {
        return;
    };
    let Some(mut project) = read_json_if_exists(&path) else {
        return;
    };
    apply_screen_charm_media_metadata(
        &mut project,
        recording.audio.as_ref(),
        recording.webcam.as_ref(),
        recording.camera_path.as_deref(),
    );
    let (project_json_path, record_info_path, player_props_path) =
        screen_charm_companion_paths(&recording.local_file_path);
    persist_screen_charm_companion_files(
        &mut project,
        &project_json_path,
        &record_info_path,
        &player_props_path,
    );
    match serde_json::to_vec_pretty(&project) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                tracing::warn!(
                    "Screen Charm media metadata refresh failed {}: {e:#}",
                    path.display()
                );
                return;
            }
            recording.screen_charm_json = Some(project);
        }
        Err(e) => {
            tracing::warn!("Screen Charm media metadata serialize failed: {e:#}");
        }
    }
}

fn latest_studio_metadata_path(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json")
                || !path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|name| name.ends_with(".studio.json"))
            {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

/// Serialize the captured cursor track + auto-generated zoom segments
/// to JSON sidecars next to `<id>.mp4`. Best-effort: failures are logged
/// but do not block the upload path. Native Studio reads these when it
/// opens a recording.
///
/// Files written:
/// - `<id>.cursor.json` — raw event stream + sample_hz + coord_space
/// - `<id>.zoom.json`   — auto-generated `ZoomSegment[]` from the clicks.
///   **Studio recordings only** (`include_zoom`): the zoom sidecar is the
///   auto-zoom *animation recipe*, and Instant recordings are raw by
///   design: no zoom in/out baked server-side. The
///   cursor/keystroke DATA keeps flowing for every mode; key moments and
///   agent context depend on it.
/// - `<id>.input-events.json` — Screen Charm-style raw input event stream
/// - `<id>.screencharm-project.json` — Screen Charm-style `project.json` projection
/// - `<id>.record-info.json` — Screen Charm-style `record-info.json` projection
/// - `<id>.player-props.json` — renderer-ready Screen Charm `playerProps`
/// - `<id>.screencharm.json` — aggregate compatibility view
pub(crate) fn write_cursor_sidecars(
    mp4_path: &std::path::Path,
    track: &crate::cursor_track::CursorTrack,
    duration_ms: u64,
    capture: Option<crate::cursor_track::CaptureViewport>,
    capture_source: Option<&CaptureSourceMetadataDto>,
    audio: Option<&AudioOptionsDto>,
    webcam: Option<&WebcamCaptureDto>,
    camera_path: Option<&std::path::Path>,
    include_zoom: bool,
) {
    let dir = match mp4_path.parent() {
        Some(d) => d,
        None => return,
    };
    let stem = match mp4_path.file_stem().and_then(|s| s.to_str()) {
        Some(s) => s,
        None => return,
    };
    let cursor_path = dir.join(format!("{stem}.cursor.json"));
    let zoom_path = dir.join(format!("{stem}.zoom.json"));
    let input_events_path = dir.join(format!("{stem}.input-events.json"));
    let project_json_path = dir.join(format!("{stem}.screencharm-project.json"));
    let record_info_path = dir.join(format!("{stem}.record-info.json"));
    let player_props_path = dir.join(format!("{stem}.player-props.json"));
    let screen_charm_path = dir.join(format!("{stem}.screencharm.json"));
    let mut track = track.clone();
    track.capture = capture;
    track.capture_source = capture_source
        .cloned()
        .map(CaptureSourceMetadataDto::normalized);
    enrich_cursor_click_render_anchors(&mut track, duration_ms);

    match serde_json::to_vec_pretty(&track) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&cursor_path, &bytes) {
                tracing::warn!(
                    "cursor sidecar write failed: {e:#} ({} bytes -> {})",
                    bytes.len(),
                    cursor_path.display()
                );
            } else {
                tracing::info!(
                    "wrote cursor sidecar ({} events, {} bytes) -> {}",
                    track.events.len(),
                    bytes.len(),
                    cursor_path.display()
                );
            }
        }
        Err(e) => {
            tracing::warn!("cursor sidecar serialize failed: {e:#}");
        }
    }

    // Segments are still computed for every mode — the Screen Charm
    // projections below embed them as data. Only the `<id>.zoom.json`
    // recipe (what the server bake consumes) is Studio-gated.
    let segments = crate::zoom_segments::generate_zoom_segments(
        &track,
        duration_ms as f64 / 1000.0,
        crate::zoom_segments::ZoomConfig::screen_charm(),
    );
    if include_zoom {
        match serde_json::to_vec_pretty(&segments) {
            Ok(bytes) => {
                if let Err(e) = std::fs::write(&zoom_path, &bytes) {
                    tracing::warn!(
                        "zoom sidecar write failed: {e:#} ({} bytes -> {})",
                        bytes.len(),
                        zoom_path.display()
                    );
                } else {
                    tracing::info!(
                        "wrote zoom sidecar ({} segments, {} bytes) -> {}",
                        segments.len(),
                        bytes.len(),
                        zoom_path.display()
                    );
                }
            }
            Err(e) => {
                tracing::warn!("zoom sidecar serialize failed: {e:#}");
            }
        }
    } else {
        // A stale recipe from an older build must not resurrect the bake
        // for this recording id.
        let _ = std::fs::remove_file(&zoom_path);
    }

    let raw_input_events = screen_charm_raw_input_events(&track);
    match serde_json::to_vec_pretty(&raw_input_events) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&input_events_path, &bytes) {
                tracing::warn!(
                    "Screen Charm raw input-events sidecar write failed: {e:#} ({} bytes -> {})",
                    bytes.len(),
                    input_events_path.display()
                );
            } else {
                tracing::info!(
                    "wrote Screen Charm raw input-events sidecar ({} events, {} bytes) -> {}",
                    raw_input_events.len(),
                    bytes.len(),
                    input_events_path.display()
                );
            }
        }
        Err(e) => {
            tracing::warn!("Screen Charm raw input-events sidecar serialize failed: {e:#}");
        }
    }

    write_screen_charm_compat_sidecar(
        mp4_path,
        &cursor_path,
        &zoom_path,
        &input_events_path,
        &project_json_path,
        &record_info_path,
        &player_props_path,
        &screen_charm_path,
        &track,
        &segments,
        duration_ms,
        capture_source,
        audio,
        webcam,
        camera_path,
    );
}

fn enrich_cursor_click_render_anchors(
    track: &mut crate::cursor_track::CursorTrack,
    duration_ms: u64,
) {
    let frame_count = screen_charm_frame_count(duration_ms);
    if frame_count == 0 {
        return;
    }
    let capture = track.capture;
    let capture_timeline = &track.capture_timeline;
    let mut moves: Vec<(f64, f64, f64)> = track
        .events
        .iter()
        .filter_map(|event| match event {
            crate::cursor_track::CursorEvent::Move { time_ms, x, y, .. } => {
                let (x, y) = screen_charm_event_xy_at(
                    capture,
                    capture_timeline,
                    *time_ms,
                    *x as f64,
                    *y as f64,
                );
                Some((*time_ms, x, y))
            }
            _ => None,
        })
        .collect();
    moves.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let max_frame = frame_count.saturating_sub(1);
    for event in track.events.iter_mut() {
        let crate::cursor_track::CursorEvent::Down {
            time_ms,
            x,
            y,
            render_x,
            render_y,
            ..
        } = event
        else {
            continue;
        };
        if render_x.is_some() && render_y.is_some() {
            continue;
        }
        let frame = screen_charm_frame_for_ms(*time_ms, max_frame);
        let frame_ms = frame as f64 * 1000.0 / SCREEN_CHARM_COMPAT_FRAME_RATE;
        let fallback =
            screen_charm_event_xy_at(capture, capture_timeline, *time_ms, *x as f64, *y as f64);
        let anchor = moves
            .iter()
            .take_while(|(move_ms, _, _)| *move_ms <= frame_ms)
            .last()
            .map(|(_, move_x, move_y)| (*move_x, *move_y))
            .unwrap_or(fallback);
        *render_x = Some(round3(anchor.0));
        *render_y = Some(round3(anchor.1));
    }
}

fn write_screen_charm_compat_sidecar(
    mp4_path: &std::path::Path,
    cursor_path: &std::path::Path,
    zoom_path: &std::path::Path,
    input_events_path: &std::path::Path,
    project_json_path: &std::path::Path,
    record_info_path: &std::path::Path,
    player_props_path: &std::path::Path,
    screen_charm_path: &std::path::Path,
    track: &crate::cursor_track::CursorTrack,
    segments: &[crate::zoom_segments::ZoomSegment],
    duration_ms: u64,
    capture_source: Option<&CaptureSourceMetadataDto>,
    audio: Option<&AudioOptionsDto>,
    webcam: Option<&WebcamCaptureDto>,
    camera_path: Option<&std::path::Path>,
) {
    let stem = mp4_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    let file_name = mp4_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("recording.mp4");
    let dir = mp4_path
        .parent()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let duration_s = duration_ms as f64 / 1000.0;
    let frame_count = screen_charm_frame_count(duration_ms);
    let input_events = screen_charm_input_events(track, duration_ms);
    let capture = track.capture;
    let display_scale = capture
        .map(|c| {
            if c.width > 0.0 {
                c.output_width as f64 / c.width
            } else {
                1.0
            }
        })
        .unwrap_or(1.0);
    let recording_width = capture
        .map(|c| c.output_width)
        .unwrap_or_else(|| inferred_track_width(track).unwrap_or_default());
    let recording_height = capture
        .map(|c| c.output_height)
        .unwrap_or_else(|| inferred_track_height(track).unwrap_or_default());
    let x_offset = capture.map(|c| round3(c.x * display_scale)).unwrap_or(0.0);
    let y_offset = capture.map(|c| round3(c.y * display_scale)).unwrap_or(0.0);
    let recording_area_width = capture
        .map(|c| round3(c.width * display_scale))
        .unwrap_or(recording_width as f64);
    let recording_area_height = capture
        .map(|c| round3(c.height * display_scale))
        .unwrap_or(recording_height as f64);
    let screen_width = capture
        .and_then(|c| c.screen_width)
        .map(|width| round3(width * display_scale))
        .unwrap_or(recording_width as f64);
    let screen_height = capture
        .and_then(|c| c.screen_height)
        .map(|height| round3(height * display_scale))
        .unwrap_or(recording_height as f64);
    let camera = screen_charm_camera_metadata(webcam, camera_path);
    let audio = screen_charm_audio_metadata(audio);
    let capture_source = capture_source
        .cloned()
        .or_else(|| track.capture_source.clone())
        .map(CaptureSourceMetadataDto::normalized);
    let capture_source_json = capture_source
        .as_ref()
        .map(|metadata| serde_json::to_value(metadata).unwrap_or(serde_json::Value::Null))
        .unwrap_or(serde_json::Value::Null);
    let has_webcam = webcam.map(|w| w.enabled).unwrap_or(false) || camera_path.is_some();
    let has_system_audio = audio
        .get("includeSystemAudio")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let has_microphone = audio
        .get("includeMic")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let player_props = screen_charm_player_props(
        mp4_path,
        track,
        segments,
        duration_ms,
        frame_count,
        recording_width,
        recording_height,
        recording_area_width,
        recording_area_height,
        x_offset,
        y_offset,
        display_scale,
        &audio,
        webcam,
        camera_path,
    );
    let mut record_info_files = vec![
        serde_json::json!({
            "filename": file_name,
            "recordingScale": round3(display_scale),
            "recordingSize": {
                "width": capture.map(|c| round3(c.width)).unwrap_or(recording_width as f64),
                "height": capture.map(|c| round3(c.height)).unwrap_or(recording_height as f64)
            },
            "type": "screen",
            "videoDimensions": {
                "width": recording_width,
                "height": recording_height
            }
        }),
        serde_json::json!({
            "filename": input_events_path.file_name().and_then(|s| s.to_str()).unwrap_or("input-events.json"),
            "type": "mouse"
        }),
    ];
    if let Some(path) = camera_path {
        record_info_files.push(screen_charm_camera_record_info_file(path));
    }
    let now_ms = system_time_ms(SystemTime::now());
    let recording_start_ms = now_ms.saturating_sub(duration_ms);

    let mut project = serde_json::json!({
        "schema": "clipy.screencharm-compat.v1",
        "source": "clipy-desktop",
        "captureSource": capture_source_json.clone(),
        "screenCharmReference": {
            "appVersion": "1.9.1",
            "sampledAt": "2026-06-05",
            "cursorTrackVersion": 2,
            "projectShape": ["projectInfo", "recording", "files", "projectSettings"],
            "companionFiles": {
                "projectJson": project_json_path.file_name().and_then(|s| s.to_str()),
                "recordInfoJson": record_info_path.file_name().and_then(|s| s.to_str()),
                "playerPropsJson": player_props_path.file_name().and_then(|s| s.to_str())
            },
            "audioSidecars": {
                "electronWritesExtractedWavSidecars": true,
                "screenAudioExtractedFromRecordingMp4": true,
                "microphoneExtractedFromWebcamMp4": true,
                "microphone": SCREEN_CHARM_MICROPHONE_FILE_NAME,
                "microphoneEnhanced": SCREEN_CHARM_MICROPHONE_ENHANCED_FILE_NAME,
                "systemAudio": SCREEN_CHARM_SYSTEM_AUDIO_FILE_NAME
            }
        },
        "projectInfo": {
            "name": stem,
            "createdEpochMs": now_ms,
            "version": "1.0.0",
            "type": "screencharm-project",
            "directoryPath": dir,
            "recordingFolderName": stem
        },
        "recording": {
            "duration": round3(duration_s),
            "frameRate": SCREEN_CHARM_COMPAT_FRAME_RATE,
            "frameCount": frame_count,
            "outputPath": mp4_path.display().to_string(),
            "sourceCursorBakedInVideo": SOURCE_CURSOR_BAKED_IN_VIDEO,
            "recordingStartTime": recording_start_ms,
            "countdownFinishedTime": recording_start_ms,
            "recordingFolderName": stem,
            "xOffset": x_offset,
            "yOffset": y_offset,
            "recordingAreaWidth": recording_area_width,
            "recordingAreaHeight": recording_area_height,
            "width": recording_area_width,
            "height": recording_area_height,
            "displayScaleFactor": round3(display_scale),
            "fileName": file_name,
            "cursorTrackVersion": 2,
            "totalDurationMs": duration_ms,
            "screenWidth": screen_width,
            "screenHeight": screen_height,
            "hasMicrophone": has_microphone,
            "hasSystemAudio": has_system_audio,
            "hasWebcam": has_webcam,
            "recordSystemAudio": has_system_audio,
            "audioSidecarsWritten": false,
            "clipyAudioTrackMode": "mixed-into-main",
            "microphoneFileName": serde_json::Value::Null,
            "microphoneEnhancedFileName": serde_json::Value::Null,
            "micExtractedFromWebcam": false,
            "systemAudioFileName": serde_json::Value::Null,
            "webcamFileName": camera_path
                .and_then(|path| path.file_name())
                .and_then(|s| s.to_str()),
            "coordSpace": track.coord_space,
            "clipyCapture": capture,
            "clipyCaptureTimeline": track.capture_timeline,
            "clipyCaptureSource": capture_source_json.clone(),
            "camera": camera.clone(),
            "audio": audio.clone(),
            "inputEvents": input_events,
            "zoomSegments": segments
        },
        "recordInfo": {
            "duration": round3(duration_s),
            "sourceCursorBakedInVideo": SOURCE_CURSOR_BAKED_IN_VIDEO,
            "files": record_info_files,
            "clipyCaptureSource": capture_source_json.clone(),
            "audio": audio.clone()
        },
        "projectSettings": {
            "editorSettings": {
                "borderRadius": 35,
                "finalWidth": player_props["finalWidth"].clone(),
                "finalHeight": player_props["finalHeight"].clone(),
                "aspectRatio": "auto",
                "backgroundImage": SCREEN_CHARM_DEFAULT_BACKGROUND_IMAGE,
                "showIntro": false,
                "showOutro": false,
                "zoomInEffect": !segments.is_empty(),
                // Screen Charm keeps this recording-time project setting false even
                // when renderer playerProps.showClickEffect is enabled.
                "clickEffects": false,
                "camera": camera,
                "audio": audio
            }
        },
        "playerProps": player_props,
        "files": {
            "mainVideo": sidecar_file_info(mp4_path),
            "cursorSidecar": sidecar_file_info(cursor_path),
            "zoomSidecar": sidecar_file_info(zoom_path),
            "inputEvents": sidecar_file_info(input_events_path),
            "rawInputEvents": sidecar_file_info(input_events_path),
            "webcamVideo": camera_path
                .map(sidecar_file_info)
                .unwrap_or(serde_json::Value::Null),
            "microphoneAudio": serde_json::Value::Null,
            "cameraSidecar": camera_path
                .map(sidecar_file_info)
                .unwrap_or(serde_json::Value::Null),
            "screenCharmAudioSidecars": {
                "microphoneAudio": {
                    "filename": SCREEN_CHARM_MICROPHONE_FILE_NAME,
                    "present": false,
                    "reason": "Clipy mixes microphone audio into the main recording MP4"
                },
                "microphoneEnhancedAudio": {
                    "filename": SCREEN_CHARM_MICROPHONE_ENHANCED_FILE_NAME,
                    "present": false,
                    "reason": "Clipy does not currently generate an enhanced microphone WAV sidecar"
                },
                "systemAudio": {
                    "filename": SCREEN_CHARM_SYSTEM_AUDIO_FILE_NAME,
                    "present": false,
                    "reason": "Clipy mixes system audio into the main recording MP4"
                }
            }
        }
    });

    persist_screen_charm_companion_files(
        &mut project,
        project_json_path,
        record_info_path,
        player_props_path,
    );

    write_json_sidecar(
        screen_charm_path,
        "Screen Charm compatibility sidecar",
        &project,
    );
}

fn screen_charm_companion_paths(
    mp4_path: &std::path::Path,
) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let dir = mp4_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new(""));
    let stem = mp4_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    (
        dir.join(format!("{stem}.screencharm-project.json")),
        dir.join(format!("{stem}.record-info.json")),
        dir.join(format!("{stem}.player-props.json")),
    )
}

fn persist_screen_charm_companion_files(
    project: &mut serde_json::Value,
    project_json_path: &std::path::Path,
    record_info_path: &std::path::Path,
    player_props_path: &std::path::Path,
) {
    write_json_sidecar(
        record_info_path,
        "Screen Charm record-info projection",
        &project["recordInfo"],
    );
    write_json_sidecar(
        player_props_path,
        "Screen Charm playerProps projection",
        &project["playerProps"],
    );

    project["files"]["recordInfoFile"] = sidecar_file_info(record_info_path);
    project["files"]["playerPropsSidecar"] = sidecar_file_info(player_props_path);
    project["files"]["additionalFiles"] = serde_json::json!([sidecar_file_info(record_info_path)]);

    let project_json = screen_charm_project_json_projection(project);
    write_json_sidecar(
        project_json_path,
        "Screen Charm project.json projection",
        &project_json,
    );
    project["files"]["screenCharmProject"] = sidecar_file_info(project_json_path);
}

fn write_json_sidecar(path: &std::path::Path, label: &str, value: &serde_json::Value) {
    match serde_json::to_vec_pretty(value) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(path, &bytes) {
                tracing::warn!(
                    "{label} write failed: {e:#} ({} bytes -> {})",
                    bytes.len(),
                    path.display()
                );
            } else {
                tracing::info!(
                    "wrote {label} ({} bytes) -> {}",
                    bytes.len(),
                    path.display()
                );
            }
        }
        Err(e) => tracing::warn!("{label} serialize failed: {e:#}"),
    }
}

fn screen_charm_project_json_projection(project: &serde_json::Value) -> serde_json::Value {
    let recording = &project["recording"];
    let project_settings = &project["projectSettings"]["editorSettings"];
    let files = &project["files"];

    let mut project_files = serde_json::Map::new();
    project_files.insert("mainVideo".into(), files["mainVideo"].clone());
    if !files["webcamVideo"].is_null() {
        project_files.insert("webcamVideo".into(), files["webcamVideo"].clone());
    }
    if !files["microphoneAudio"].is_null() {
        project_files.insert("microphoneAudio".into(), files["microphoneAudio"].clone());
    }
    project_files.insert("inputEvents".into(), files["inputEvents"].clone());
    project_files.insert(
        "additionalFiles".into(),
        serde_json::Value::Array(vec![files["recordInfoFile"].clone()]),
    );

    serde_json::json!({
        "projectInfo": project["projectInfo"].clone(),
        "recording": {
            "duration": recording["duration"].clone(),
            "frameRate": recording["frameRate"].clone(),
            "frameCount": recording["frameCount"].clone(),
            "recordSystemAudio": recording["recordSystemAudio"].clone(),
            "outputPath": recording["outputPath"].clone(),
            "recordingFolderName": recording["recordingFolderName"].clone(),
            "xOffset": recording["xOffset"].clone(),
            "yOffset": recording["yOffset"].clone(),
            "recordingAreaWidth": recording["recordingAreaWidth"].clone(),
            "recordingAreaHeight": recording["recordingAreaHeight"].clone(),
            "width": recording["width"].clone(),
            "height": recording["height"].clone(),
            "displayScaleFactor": recording["displayScaleFactor"].clone(),
            "countdownFinishedTime": recording["countdownFinishedTime"].clone(),
            "fileName": recording["fileName"].clone(),
            "recordingStartTime": recording["recordingStartTime"].clone(),
            "screenWidth": recording["screenWidth"].clone(),
            "screenHeight": recording["screenHeight"].clone(),
            "webcamFileName": recording["webcamFileName"].clone(),
            "microphoneFileName": recording["microphoneFileName"].clone(),
            "microphoneEnhancedFileName": recording["microphoneEnhancedFileName"].clone(),
            "micExtractedFromWebcam": recording["micExtractedFromWebcam"].clone(),
            "systemAudioFileName": recording["systemAudioFileName"].clone(),
            "cursorTrackVersion": recording["cursorTrackVersion"].clone(),
            "inputEvents": recording["inputEvents"].clone(),
            "totalDurationMs": recording["totalDurationMs"].clone(),
            "hasWebcam": recording["hasWebcam"].clone(),
            "hasMicrophone": recording["hasMicrophone"].clone(),
            "hasSystemAudio": recording["hasSystemAudio"].clone()
        },
        "files": serde_json::Value::Object(project_files),
        "projectSettings": {
            "lastModifiedEpochMs": recording["recordingStartTime"].clone(),
            "editorSettings": {
                "backgroundImage": project_settings["backgroundImage"].clone(),
                "borderRadius": project_settings["borderRadius"].clone(),
                "finalWidth": project_settings["finalWidth"].clone(),
                "finalHeight": project_settings["finalHeight"].clone(),
                "aspectRatio": project_settings["aspectRatio"].clone(),
                "showIntro": project_settings["showIntro"].clone(),
                "showOutro": project_settings["showOutro"].clone(),
                "zoomInEffect": project_settings["zoomInEffect"].clone(),
                "clickEffects": project_settings["clickEffects"].clone()
            }
        }
    })
}

fn apply_screen_charm_media_metadata(
    project: &mut serde_json::Value,
    audio: Option<&AudioOptionsDto>,
    webcam: Option<&WebcamCaptureDto>,
    camera_path: Option<&std::path::Path>,
) {
    let camera = screen_charm_camera_metadata(webcam, camera_path);
    let audio = screen_charm_audio_metadata(audio);
    let has_system_audio = audio
        .get("includeSystemAudio")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let has_microphone = audio
        .get("includeMic")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let has_webcam = webcam.map(|w| w.enabled).unwrap_or(false) || camera_path.is_some();
    project["recording"]["camera"] = camera.clone();
    project["recording"]["audio"] = audio.clone();
    project["recording"]["hasMicrophone"] = serde_json::Value::Bool(has_microphone);
    project["recording"]["hasSystemAudio"] = serde_json::Value::Bool(has_system_audio);
    project["recording"]["hasWebcam"] = serde_json::Value::Bool(has_webcam);
    project["recording"]["recordSystemAudio"] = serde_json::Value::Bool(has_system_audio);
    project["recording"]["webcamFileName"] = camera_path
        .and_then(|path| path.file_name())
        .and_then(|s| s.to_str())
        .map(|s| serde_json::Value::String(s.to_string()))
        .unwrap_or(serde_json::Value::Null);
    project["recordInfo"]["audio"] = audio.clone();
    project["projectSettings"]["editorSettings"]["camera"] = camera.clone();
    project["projectSettings"]["editorSettings"]["audio"] = audio.clone();
    project["files"]["cameraSidecar"] = camera_path
        .map(sidecar_file_info)
        .unwrap_or(serde_json::Value::Null);
    project["files"]["webcamVideo"] = camera_path
        .map(sidecar_file_info)
        .unwrap_or(serde_json::Value::Null);
    project["files"]["microphoneAudio"] = serde_json::Value::Null;
    apply_screen_charm_player_props_media(project, audio, webcam, camera_path);

    let Some(path) = camera_path else {
        return;
    };
    let Some(files) = project["recordInfo"]["files"].as_array_mut() else {
        return;
    };
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("camera.webm");
    if let Some(existing) = files.iter_mut().find(|file| {
        matches!(
            file.get("type").and_then(|v| v.as_str()),
            Some("camera" | "webcam")
        ) || file.get("filename").and_then(|v| v.as_str()) == Some(filename)
    }) {
        *existing = screen_charm_camera_record_info_file(path);
    } else {
        files.push(screen_charm_camera_record_info_file(path));
    }
}

fn screen_charm_camera_metadata(
    webcam: Option<&WebcamCaptureDto>,
    camera_path: Option<&std::path::Path>,
) -> serde_json::Value {
    let enabled = webcam.map(|w| w.enabled).unwrap_or(false);
    let layout = webcam
        .map(|w| serde_json::to_value(w.layout).unwrap_or_else(|_| serde_json::json!("bubble")))
        .unwrap_or_else(|| serde_json::json!("hidden"));
    let track_mode = if camera_path.is_some() {
        "separate"
    } else if enabled {
        "pending"
    } else {
        "none"
    };
    serde_json::json!({
        "enabled": enabled,
        "layout": layout,
        "trackMode": track_mode,
        "source": "clipy-webcam-sidecar",
        "screenCharmType": "webcam",
        "screenCharmFileName": SCREEN_CHARM_WEBCAM_FILE_NAME,
        "mirrored": true,
        "fileName": camera_path
            .and_then(|path| path.file_name())
            .and_then(|s| s.to_str()),
        "path": camera_path.map(|path| path.display().to_string())
    })
}

fn screen_charm_audio_metadata(audio: Option<&AudioOptionsDto>) -> serde_json::Value {
    let include_system_audio = audio.map(|a| a.include_system_audio).unwrap_or(false);
    let include_mic = audio.map(|a| a.include_mic).unwrap_or(false);
    serde_json::json!({
        "includeSystemAudio": include_system_audio,
        "includeMic": include_mic,
        "micDeviceId": audio.and_then(|a| a.mic_device_id.clone()),
        "embeddedInMainVideo": true,
        "trackMode": if include_system_audio || include_mic { "mixed-into-main" } else { "none" },
        "clipyWritesExtractedWavSidecars": false,
        "screenCharmElectronWritesExtractedWavSidecars": true,
        "screenCharmFileNames": {
            "screen": SCREEN_CHARM_SCREEN_FILE_NAME,
            "rawInputEvents": SCREEN_CHARM_INPUT_EVENTS_FILE_NAME,
            "microphone": SCREEN_CHARM_MICROPHONE_FILE_NAME,
            "microphoneEnhanced": SCREEN_CHARM_MICROPHONE_ENHANCED_FILE_NAME,
            "systemAudio": SCREEN_CHARM_SYSTEM_AUDIO_FILE_NAME,
            "webcam": SCREEN_CHARM_WEBCAM_FILE_NAME
        }
    })
}

fn screen_charm_camera_record_info_file(path: &std::path::Path) -> serde_json::Value {
    serde_json::json!({
        "filename": path.file_name().and_then(|s| s.to_str()).unwrap_or("camera.webm"),
        "type": "webcam",
        "clipyType": "camera",
        "screenCharmFileName": SCREEN_CHARM_WEBCAM_FILE_NAME,
        "trackMode": "separate",
        "path": path.display().to_string()
    })
}

#[allow(clippy::too_many_arguments)]
fn screen_charm_player_props(
    mp4_path: &std::path::Path,
    track: &crate::cursor_track::CursorTrack,
    segments: &[crate::zoom_segments::ZoomSegment],
    duration_ms: u64,
    frame_count: u64,
    recording_width: u32,
    recording_height: u32,
    _recording_area_width: f64,
    _recording_area_height: f64,
    x_offset: f64,
    y_offset: f64,
    display_scale: f64,
    audio: &serde_json::Value,
    webcam: Option<&WebcamCaptureDto>,
    camera_path: Option<&std::path::Path>,
) -> serde_json::Value {
    let padding_x = recording_width as f64 * SCREEN_CHARM_DEFAULT_PADDING_X_FRACTION;
    let padding_y = recording_height as f64 * SCREEN_CHARM_DEFAULT_PADDING_Y_FRACTION;
    let final_width = even_f64(recording_width as f64 + padding_x * 2.0);
    let final_height = even_f64(recording_height as f64 + padding_y * 2.0);
    let camera_enabled = webcam.map(|w| w.enabled).unwrap_or(false);
    let camera_file_name = camera_path
        .and_then(|path| path.file_name())
        .and_then(|s| s.to_str());
    let camera_size = if camera_enabled {
        (final_width * 0.23).round().max(220.0)
    } else {
        0.0
    };
    let camera_margin = (final_width * 0.025).round().max(18.0);
    let include_system_audio = audio
        .get("includeSystemAudio")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_mic = audio
        .get("includeMic")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut props = serde_json::Map::new();
    props.insert(
        "webmUrl".into(),
        serde_json::Value::String(mp4_path.display().to_string()),
    );
    props.insert(
        "webcamFileName".into(),
        camera_path
            .map(|path| serde_json::Value::String(path.display().to_string()))
            .unwrap_or(serde_json::Value::Null),
    );
    props.insert("microphoneFileName".into(), serde_json::Value::Null);
    props.insert("microphoneEnhancedFileName".into(), serde_json::Value::Null);
    props.insert("systemAudioFileName".into(), serde_json::Value::Null);
    props.insert(
        "micExtractedFromWebcam".into(),
        serde_json::Value::Bool(false),
    );
    props.insert(
        "frameRate".into(),
        serde_json::Value::from(SCREEN_CHARM_COMPAT_FRAME_RATE),
    );
    props.insert(
        "fps".into(),
        serde_json::Value::from(SCREEN_CHARM_COMPAT_FRAME_RATE),
    );
    props.insert(
        "outputFrameRate".into(),
        serde_json::Value::from(SCREEN_CHARM_COMPAT_FRAME_RATE),
    );
    props.insert("frameCount".into(), serde_json::Value::from(frame_count));
    props.insert(
        "fullRecordingFramesCount".into(),
        serde_json::Value::from(frame_count),
    );
    props.insert(
        "recordingDurationInFrames".into(),
        serde_json::Value::from(frame_count),
    );
    props.insert(
        "duration".into(),
        serde_json::Value::from(round3(duration_ms as f64 / 1000.0)),
    );
    props.insert("finalWidth".into(), serde_json::Value::from(final_width));
    props.insert("finalHeight".into(), serde_json::Value::from(final_height));
    props.insert(
        "originalVideoWidth".into(),
        serde_json::Value::from(recording_width),
    );
    props.insert(
        "originalVideoHeight".into(),
        serde_json::Value::from(recording_height),
    );
    props.insert(
        "displayScaleFactor".into(),
        serde_json::Value::from(round3(display_scale)),
    );
    props.insert(
        "paddingXInPixels".into(),
        serde_json::Value::from(padding_x),
    );
    props.insert(
        "paddingYInPixels".into(),
        serde_json::Value::from(padding_y),
    );
    props.insert("xOffset".into(), serde_json::Value::from(round3(x_offset)));
    props.insert("yOffset".into(), serde_json::Value::from(round3(y_offset)));
    props.insert("borderRadius".into(), serde_json::Value::from(70));
    props.insert("shadowIntensity".into(), serde_json::Value::from(0.5));
    props.insert("backgroundColor".into(), serde_json::Value::Null);
    props.insert(
        "backgroundImage".into(),
        serde_json::Value::String(SCREEN_CHARM_DEFAULT_BACKGROUND_IMAGE.into()),
    );
    props.insert("backgroundImageBlur".into(), serde_json::Value::from(0));
    props.insert("deviceFrame".into(), serde_json::Value::Null);
    props.insert(
        "sourceCursorBakedInVideo".into(),
        serde_json::Value::Bool(SOURCE_CURSOR_BAKED_IN_VIDEO),
    );
    props.insert(
        "showCursor".into(),
        serde_json::Value::Bool(!SOURCE_CURSOR_BAKED_IN_VIDEO),
    );
    props.insert("useDefaultCursor".into(), serde_json::Value::Bool(false));
    props.insert("showClickEffect".into(), serde_json::Value::Bool(true));
    props.insert(
        "clicks".into(),
        serde_json::Value::Array(screen_charm_player_clicks(track, frame_count)),
    );
    props.insert(
        "zoomInEffect".into(),
        serde_json::Value::Bool(!segments.is_empty()),
    );
    props.insert(
        "defaultZoomInLevel".into(),
        serde_json::Value::from(SCREEN_CHARM_DEFAULT_ZOOM_LEVEL),
    );
    props.insert("defaultPlaybackSpeed".into(), serde_json::Value::from(1));
    props.insert(
        "zoomDurationSec".into(),
        serde_json::Value::from(SCREEN_CHARM_ZOOM_DURATION_S),
    );
    props.insert(
        "zoomInFreezeDurationSec".into(),
        serde_json::Value::from(SCREEN_CHARM_ZOOM_IN_FREEZE_DURATION_S),
    );
    props.insert(
        "zoomOutFreezeDurationSec".into(),
        serde_json::Value::from(SCREEN_CHARM_ZOOM_OUT_FREEZE_DURATION_S),
    );
    props.insert(
        "cursorPositions".into(),
        serde_json::Value::Array(screen_charm_player_cursor_positions(track, frame_count)),
    );
    props.insert(
        "zooms".into(),
        serde_json::Value::Array(screen_charm_player_zooms(
            track,
            segments,
            frame_count,
            recording_width,
            recording_height,
        )),
    );
    props.insert(
        "framesData".into(),
        serde_json::Value::Array(screen_charm_player_frames_data(
            track,
            segments,
            frame_count,
            recording_width,
            recording_height,
            camera_size,
        )),
    );
    props.insert(
        "intervals".into(),
        serde_json::Value::Array(vec![serde_json::json!({
            "start": 0,
            "end": frame_count,
            "playbackSpeed": 1
        })]),
    );
    props.insert(
        "showCamera".into(),
        serde_json::Value::Bool(camera_enabled && camera_file_name.is_some()),
    );
    props.insert("cameraLeft".into(), serde_json::Value::from(camera_margin));
    props.insert("cameraTop".into(), serde_json::Value::Null);
    props.insert("cameraRight".into(), serde_json::Value::Null);
    props.insert(
        "cameraBottom".into(),
        serde_json::Value::from(camera_margin),
    );
    props.insert("cameraWidth".into(), serde_json::Value::from(camera_size));
    props.insert("cameraHeight".into(), serde_json::Value::from(camera_size));
    props.insert("cameraSize".into(), serde_json::Value::from(23));
    props.insert(
        "cameraPosition".into(),
        serde_json::Value::String("left-bottom".into()),
    );
    props.insert(
        "cameraLayout".into(),
        serde_json::Value::String("default".into()),
    );
    props.insert("cameraBorderRadius".into(), serde_json::Value::from(24));
    props.insert("cameraZoomEffect".into(), serde_json::Value::Bool(true));
    props.insert("cameraContentZoom".into(), serde_json::Value::from(1));
    props.insert(
        "systemSoundOn".into(),
        serde_json::Value::Bool(include_system_audio),
    );
    props.insert("muteMic".into(), serde_json::Value::Bool(!include_mic));
    props.insert("enhanceMicAudio".into(), serde_json::Value::Bool(false));
    props.insert("backgroundMusicTrack".into(), serde_json::Value::Null);
    props.insert(
        "backgroundMusicVolume".into(),
        serde_json::Value::from(0.15),
    );
    props.insert(
        "screenCharmCompat".into(),
        serde_json::json!({
            "cameraFileName": camera_file_name,
            "sourceCursorBakedInVideo": SOURCE_CURSOR_BAKED_IN_VIDEO,
            "renderedCursorDisabledByDefault": SOURCE_CURSOR_BAKED_IN_VIDEO,
            "webcamRecordInfoType": "webcam",
            "screenCharmScreenFileName": SCREEN_CHARM_SCREEN_FILE_NAME,
            "screenCharmInputEventsFileName": SCREEN_CHARM_INPUT_EVENTS_FILE_NAME,
            "screenCharmWebcamFileName": SCREEN_CHARM_WEBCAM_FILE_NAME,
            "screenCharmMicrophoneFileName": SCREEN_CHARM_MICROPHONE_FILE_NAME,
            "screenCharmMicrophoneEnhancedFileName": SCREEN_CHARM_MICROPHONE_ENHANCED_FILE_NAME,
            "screenCharmSystemAudioFileName": SCREEN_CHARM_SYSTEM_AUDIO_FILE_NAME,
            "screenCharmMediaFiles": {
                "screen": SCREEN_CHARM_SCREEN_FILE_NAME,
                "rawInputEvents": SCREEN_CHARM_INPUT_EVENTS_FILE_NAME,
                "webcam": SCREEN_CHARM_WEBCAM_FILE_NAME,
                "microphone": SCREEN_CHARM_MICROPHONE_FILE_NAME,
                "microphoneEnhanced": SCREEN_CHARM_MICROPHONE_ENHANCED_FILE_NAME,
                "systemAudio": SCREEN_CHARM_SYSTEM_AUDIO_FILE_NAME
            },
            "audioEmbeddedInMainVideo": true,
            "clipyWritesExtractedWavSidecars": false,
            "screenCharmElectronWritesExtractedWavSidecars": true,
            "screenCharmMicrophoneExtractedFromWebcam": true,
            "screenCharmSystemAudioExtractedFromRecording": true,
            "audioTrackMode": audio.get("trackMode").cloned().unwrap_or(serde_json::Value::Null)
        }),
    );
    serde_json::Value::Object(props)
}

fn apply_screen_charm_player_props_media(
    project: &mut serde_json::Value,
    audio: serde_json::Value,
    webcam: Option<&WebcamCaptureDto>,
    camera_path: Option<&std::path::Path>,
) {
    let Some(player_props) = project["playerProps"].as_object_mut() else {
        return;
    };
    let camera_enabled = webcam.map(|w| w.enabled).unwrap_or(false);
    let include_system_audio = audio
        .get("includeSystemAudio")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_mic = audio
        .get("includeMic")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    player_props.insert(
        "webcamFileName".into(),
        camera_path
            .map(|path| serde_json::Value::String(path.display().to_string()))
            .unwrap_or(serde_json::Value::Null),
    );
    player_props.insert(
        "showCamera".into(),
        serde_json::Value::Bool(camera_enabled && camera_path.is_some()),
    );
    player_props.insert(
        "systemSoundOn".into(),
        serde_json::Value::Bool(include_system_audio),
    );
    player_props.insert("muteMic".into(), serde_json::Value::Bool(!include_mic));
    player_props.insert(
        "micExtractedFromWebcam".into(),
        serde_json::Value::Bool(false),
    );
    if let Some(compat) = player_props
        .get_mut("screenCharmCompat")
        .and_then(|value| value.as_object_mut())
    {
        compat.insert(
            "cameraFileName".into(),
            camera_path
                .and_then(|path| path.file_name())
                .and_then(|s| s.to_str())
                .map(|s| serde_json::Value::String(s.to_string()))
                .unwrap_or(serde_json::Value::Null),
        );
        compat.insert(
            "webcamRecordInfoType".into(),
            serde_json::Value::String("webcam".to_string()),
        );
        compat.insert(
            "screenCharmWebcamFileName".into(),
            serde_json::Value::String(SCREEN_CHARM_WEBCAM_FILE_NAME.to_string()),
        );
        compat.insert(
            "screenCharmMicrophoneFileName".into(),
            serde_json::Value::String(SCREEN_CHARM_MICROPHONE_FILE_NAME.to_string()),
        );
        compat.insert(
            "screenCharmMicrophoneEnhancedFileName".into(),
            serde_json::Value::String(SCREEN_CHARM_MICROPHONE_ENHANCED_FILE_NAME.to_string()),
        );
        compat.insert(
            "screenCharmSystemAudioFileName".into(),
            serde_json::Value::String(SCREEN_CHARM_SYSTEM_AUDIO_FILE_NAME.to_string()),
        );
        compat.insert(
            "screenCharmMediaFiles".into(),
            serde_json::json!({
                "screen": SCREEN_CHARM_SCREEN_FILE_NAME,
                "rawInputEvents": SCREEN_CHARM_INPUT_EVENTS_FILE_NAME,
                "webcam": SCREEN_CHARM_WEBCAM_FILE_NAME,
                "microphone": SCREEN_CHARM_MICROPHONE_FILE_NAME,
                "microphoneEnhanced": SCREEN_CHARM_MICROPHONE_ENHANCED_FILE_NAME,
                "systemAudio": SCREEN_CHARM_SYSTEM_AUDIO_FILE_NAME
            }),
        );
        compat.insert(
            "clipyWritesExtractedWavSidecars".into(),
            serde_json::Value::Bool(false),
        );
        compat.insert(
            "screenCharmElectronWritesExtractedWavSidecars".into(),
            serde_json::Value::Bool(true),
        );
        compat.insert(
            "screenCharmMicrophoneExtractedFromWebcam".into(),
            serde_json::Value::Bool(true),
        );
        compat.insert(
            "screenCharmSystemAudioExtractedFromRecording".into(),
            serde_json::Value::Bool(true),
        );
        compat.insert(
            "audioTrackMode".into(),
            audio
                .get("trackMode")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        );
    }
}

fn screen_charm_player_frames_data(
    track: &crate::cursor_track::CursorTrack,
    segments: &[crate::zoom_segments::ZoomSegment],
    frame_count: u64,
    recording_width: u32,
    recording_height: u32,
    camera_size: f64,
) -> Vec<serde_json::Value> {
    let mut moves: Vec<(f64, f64, f64, String)> = track
        .events
        .iter()
        .filter_map(|event| match event {
            crate::cursor_track::CursorEvent::Move {
                time_ms,
                x,
                y,
                cursor_type,
            } => {
                let (x, y) = screen_charm_track_event_xy(track, *time_ms, *x as f64, *y as f64);
                Some((
                    *time_ms,
                    x,
                    y,
                    cursor_type.clone().unwrap_or_else(|| "cursor".to_string()),
                ))
            }
            _ => None,
        })
        .collect();
    moves.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut move_index = 0usize;
    let mut current_x = moves.first().map(|(_, x, _, _)| *x).unwrap_or(0.0);
    let mut current_y = moves.first().map(|(_, _, y, _)| *y).unwrap_or(0.0);
    let mut current_cursor_type = moves
        .first()
        .map(|(_, _, _, cursor_type)| cursor_type.clone())
        .unwrap_or_else(|| "cursor".to_string());
    let center_x = recording_width as f64 / 2.0;
    let center_y = recording_height as f64 / 2.0;

    (0..frame_count)
        .map(|frame| {
            let frame_ms = frame as f64 * 1000.0 / SCREEN_CHARM_COMPAT_FRAME_RATE;
            while move_index < moves.len() && moves[move_index].0 <= frame_ms {
                current_x = moves[move_index].1;
                current_y = moves[move_index].2;
                current_cursor_type = moves[move_index].3.clone();
                move_index += 1;
            }
            let time_s = frame_ms / 1000.0;
            let scale = screen_charm_player_zoom_scale(segments, time_s);
            let (focal_x, focal_y) = screen_charm_player_active_manual_focal(segments, time_s)
                .unwrap_or((current_x, current_y));
            let target_x = if scale > 1.0 {
                scale * (center_x - focal_x)
            } else {
                0.0
            };
            let target_y = if scale > 1.0 {
                scale * (center_y - focal_y)
            } else {
                0.0
            };
            serde_json::json!([
                round3(target_x),
                round3(target_y),
                round3(scale),
                round3(current_x),
                round3(current_y),
                round3(screen_charm_cursor_svg_width(&current_cursor_type)),
                round3(camera_size),
                round3(camera_size),
                current_cursor_type
            ])
        })
        .collect()
}

fn screen_charm_cursor_svg_width(cursor_type: &str) -> f64 {
    match cursor_type.to_ascii_lowercase().as_str() {
        "textcursor" | "text" => SCREEN_CHARM_TEXT_CURSOR_SVG_WIDTH,
        _ => SCREEN_CHARM_CURSOR_SVG_WIDTH,
    }
}

fn screen_charm_player_zoom_scale(
    segments: &[crate::zoom_segments::ZoomSegment],
    time_s: f64,
) -> f64 {
    segments
        .iter()
        .find(|segment| time_s >= segment.start_s && time_s <= segment.end_s)
        .map(|segment| {
            let ramp_s = segment.ramp_s.unwrap_or(0.25).clamp(0.08, 0.8);
            let from_start = time_s - segment.start_s;
            let to_end = segment.end_s - time_s;
            let ramp = if from_start >= 0.0 && from_start <= ramp_s {
                screen_charm_zoom_ease01(from_start / ramp_s)
            } else if to_end >= 0.0 && to_end <= ramp_s {
                screen_charm_zoom_ease01(to_end / ramp_s)
            } else {
                1.0
            };
            1.0 + (segment.amount - 1.0) * ramp.clamp(0.0, 1.0)
        })
        .unwrap_or(1.0)
}

fn screen_charm_player_active_manual_focal(
    segments: &[crate::zoom_segments::ZoomSegment],
    time_s: f64,
) -> Option<(f64, f64)> {
    segments
        .iter()
        .find(|segment| time_s >= segment.start_s && time_s <= segment.end_s)
        .and_then(|segment| {
            screen_charm_focal_curve_point_at(segment.focal_curve.as_deref(), time_s).or_else(
                || match &segment.mode {
                    crate::zoom_segments::ZoomMode::Manual { x, y } => Some((*x, *y)),
                    crate::zoom_segments::ZoomMode::Auto => None,
                },
            )
        })
}

fn screen_charm_focal_curve_point_at(
    curve: Option<&[crate::zoom_segments::FocalCurvePoint]>,
    time_s: f64,
) -> Option<(f64, f64)> {
    let curve = curve?;
    if curve.is_empty() {
        return None;
    }
    if time_s <= curve[0].time_s {
        return Some((curve[0].x, curve[0].y));
    }
    let last = curve.last()?;
    if time_s >= last.time_s {
        return Some((last.x, last.y));
    }
    let mut lo = 0usize;
    let mut hi = curve.len() - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if curve[mid].time_s <= time_s {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let a = &curve[lo];
    let b = &curve[hi];
    let span = (b.time_s - a.time_s).max(0.000001);
    let t = ((time_s - a.time_s) / span).clamp(0.0, 1.0);
    Some((a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t))
}

fn screen_charm_player_cursor_positions(
    track: &crate::cursor_track::CursorTrack,
    frame_count: u64,
) -> Vec<serde_json::Value> {
    let max_frame = frame_count.saturating_sub(1);
    track
        .events
        .iter()
        .filter_map(|event| match event {
            crate::cursor_track::CursorEvent::Move {
                time_ms,
                x,
                y,
                cursor_type,
            } => {
                let frame = screen_charm_frame_for_ms(*time_ms, max_frame);
                let (x, y) = screen_charm_track_event_xy(track, *time_ms, *x as f64, *y as f64);
                Some(serde_json::json!({
                    "type": "move",
                    "frame": frame,
                    "x": round3(x),
                    "y": round3(y),
                    "cursorType": cursor_type.as_deref().unwrap_or("cursor")
                }))
            }
            _ => None,
        })
        .collect()
}

fn screen_charm_player_zooms(
    track: &crate::cursor_track::CursorTrack,
    segments: &[crate::zoom_segments::ZoomSegment],
    frame_count: u64,
    recording_width: u32,
    recording_height: u32,
) -> Vec<serde_json::Value> {
    let max_frame = frame_count.saturating_sub(1);
    let mut clicks: Vec<(f64, u64, f64, f64)> = track
        .events
        .iter()
        .filter_map(|event| match event {
            crate::cursor_track::CursorEvent::Down { time_ms, x, y, .. } => {
                let (x, y) = screen_charm_track_event_xy(track, *time_ms, *x as f64, *y as f64);
                Some((
                    *time_ms / 1000.0,
                    screen_charm_frame_for_ms(*time_ms, max_frame),
                    x,
                    y,
                ))
            }
            _ => None,
        })
        .collect();
    clicks.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let cursor_samples = screen_charm_cursor_xy_samples(track);

    segments
        .iter()
        .map(|segment| {
            let zoom_in_start_frame =
                screen_charm_frame_for_ms(segment.start_s * 1000.0, max_frame);
            let zoom_out_start_frame = screen_charm_frame_for_ms(segment.end_s * 1000.0, max_frame);
            let nearest_click = nearest_click_for_segment(&clicks, segment.start_s, segment.end_s);
            let mut value = serde_json::json!({
                "zoomInStartFrame": zoom_in_start_frame,
                "zoomOutStartFrame": zoom_out_start_frame,
                "level": round3(segment.amount),
                "followCursor": matches!(segment.mode, crate::zoom_segments::ZoomMode::Auto),
                "scales": screen_charm_player_zoom_scales(segment, zoom_in_start_frame, zoom_out_start_frame, max_frame),
                "positions": screen_charm_player_zoom_positions(
                    segment,
                    nearest_click.map(|(_, frame, _, _)| *frame),
                    &cursor_samples,
                    zoom_in_start_frame,
                    zoom_out_start_frame,
                    max_frame,
                    recording_width,
                    recording_height,
                )
            });
            if let Some((_, click_frame, click_x, click_y)) = nearest_click {
                let (anchor_x, anchor_y) =
                    screen_charm_zoom_anchor(*click_x, *click_y, recording_width, recording_height);
                value["clickFrame"] = serde_json::Value::from(*click_frame);
                value["clickX"] = serde_json::Value::from(round3(*click_x));
                value["clickY"] = serde_json::Value::from(round3(*click_y));
                value["clickAnchorX"] = serde_json::Value::from(round3(anchor_x));
                value["clickAnchorY"] = serde_json::Value::from(round3(anchor_y));
            }
            value
        })
        .collect()
}

fn screen_charm_player_zoom_scales(
    segment: &crate::zoom_segments::ZoomSegment,
    zoom_in_start_frame: u64,
    zoom_out_start_frame: u64,
    max_frame: u64,
) -> serde_json::Value {
    let in_frames = screen_charm_zoom_duration_frames();
    let out_frames = in_frames.max(1);
    let end_frame = zoom_out_start_frame
        .saturating_add(out_frames)
        .min(max_frame);
    let mut values = Vec::new();

    for frame in zoom_in_start_frame..=end_frame {
        let progress = if frame <= zoom_in_start_frame.saturating_add(in_frames) {
            let t = (frame.saturating_sub(zoom_in_start_frame) as f64) / (in_frames.max(1) as f64);
            screen_charm_zoom_ease01(t)
        } else if frame <= zoom_out_start_frame {
            1.0
        } else {
            let t = (frame.saturating_sub(zoom_out_start_frame) as f64) / (out_frames as f64);
            1.0 - screen_charm_zoom_ease01(t)
        }
        .clamp(0.0, 1.0);
        let scale = 1.0 + (segment.amount - 1.0) * progress;
        values.push(serde_json::json!({
            "frame": frame,
            "scale": round3(scale),
            "koeff": round3(segment.amount * progress)
        }));
    }

    serde_json::Value::Array(values)
}

fn screen_charm_player_zoom_positions(
    segment: &crate::zoom_segments::ZoomSegment,
    click_frame: Option<u64>,
    cursor_samples: &[(f64, f64, f64)],
    zoom_in_start_frame: u64,
    zoom_out_start_frame: u64,
    max_frame: u64,
    recording_width: u32,
    recording_height: u32,
) -> serde_json::Value {
    let start_frame = click_frame
        .unwrap_or_else(|| zoom_in_start_frame.saturating_add(screen_charm_zoom_duration_frames()));
    let end_frame = zoom_out_start_frame
        .saturating_add(screen_charm_zoom_hold_frames())
        .min(max_frame);
    if start_frame > end_frame {
        return serde_json::Value::Array(Vec::new());
    }

    let center_x = recording_width as f64 / 2.0;
    let center_y = recording_height as f64 / 2.0;
    let mut values = Vec::new();
    for frame in start_frame..=end_frame {
        let time_s = frame as f64 / SCREEN_CHARM_COMPAT_FRAME_RATE;
        let focal = screen_charm_focal_curve_point_at(segment.focal_curve.as_deref(), time_s)
            .or_else(|| match &segment.mode {
                crate::zoom_segments::ZoomMode::Manual { x, y } => Some((*x, *y)),
                crate::zoom_segments::ZoomMode::Auto => {
                    screen_charm_cursor_xy_at(cursor_samples, time_s * 1000.0)
                }
            })
            .unwrap_or((center_x, center_y));
        values.push(serde_json::json!({
            "frame": frame,
            "actualX": round3(segment.amount * (center_x - focal.0)),
            "actualY": round3(segment.amount * (center_y - focal.1))
        }));
    }

    serde_json::Value::Array(values)
}

fn screen_charm_zoom_duration_frames() -> u64 {
    (SCREEN_CHARM_ZOOM_DURATION_S * SCREEN_CHARM_COMPAT_FRAME_RATE).round() as u64
}

fn screen_charm_zoom_hold_frames() -> u64 {
    (SCREEN_CHARM_ZOOM_IN_FREEZE_DURATION_S * SCREEN_CHARM_COMPAT_FRAME_RATE).round() as u64
}

fn screen_charm_cursor_xy_samples(
    track: &crate::cursor_track::CursorTrack,
) -> Vec<(f64, f64, f64)> {
    let mut samples: Vec<(f64, f64, f64)> = track
        .events
        .iter()
        .filter_map(|event| {
            let time_ms = cursor_event_time_ms(event)?;
            let x = cursor_event_x(event)? as f64;
            let y = cursor_event_y(event)? as f64;
            let (x, y) = screen_charm_track_event_xy(track, time_ms, x, y);
            Some((time_ms, x, y))
        })
        .collect();
    samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    samples
}

fn screen_charm_cursor_xy_at(samples: &[(f64, f64, f64)], time_ms: f64) -> Option<(f64, f64)> {
    if samples.is_empty() {
        return None;
    }
    let mut current = (samples[0].1, samples[0].2);
    for (sample_time_ms, x, y) in samples {
        if *sample_time_ms > time_ms {
            break;
        }
        current = (*x, *y);
    }
    Some(current)
}

fn nearest_click_for_segment<'a>(
    clicks: &'a [(f64, u64, f64, f64)],
    start_s: f64,
    end_s: f64,
) -> Option<&'a (f64, u64, f64, f64)> {
    let expected_click_s = start_s + SCREEN_CHARM_ZOOM_DURATION_S;
    clicks
        .iter()
        .filter(|(time_s, _, _, _)| *time_s >= start_s && *time_s <= end_s)
        .min_by(|a, b| {
            (a.0 - expected_click_s)
                .abs()
                .partial_cmp(&(b.0 - expected_click_s).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn screen_charm_zoom_anchor(
    x: f64,
    y: f64,
    recording_width: u32,
    recording_height: u32,
) -> (f64, f64) {
    let center_x = recording_width as f64 / 2.0;
    let center_y = recording_height as f64 / 2.0;
    (
        SCREEN_CHARM_DEFAULT_ZOOM_LEVEL * (center_x - x),
        SCREEN_CHARM_DEFAULT_ZOOM_LEVEL * (center_y - y),
    )
}

fn screen_charm_frame_for_ms(time_ms: f64, max_frame: u64) -> u64 {
    ((time_ms / 1000.0) * SCREEN_CHARM_COMPAT_FRAME_RATE)
        .round()
        .max(0.0)
        .min(max_frame as f64) as u64
}

fn screen_charm_zoom_ease01(t: f64) -> f64 {
    let x = t.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

fn screen_charm_player_clicks(
    track: &crate::cursor_track::CursorTrack,
    frame_count: u64,
) -> Vec<serde_json::Value> {
    let max_frame = frame_count.saturating_sub(1);
    track
        .events
        .iter()
        .filter_map(|event| match event {
            crate::cursor_track::CursorEvent::Down { time_ms, .. } => {
                let frame = ((*time_ms / 1000.0) * SCREEN_CHARM_COMPAT_FRAME_RATE)
                    .round()
                    .max(0.0)
                    .min(max_frame as f64) as u64;
                Some(serde_json::json!({
                    "frame": frame,
                    "clickEffect": true
                }))
            }
            _ => None,
        })
        .collect()
}

fn screen_charm_raw_input_events(
    track: &crate::cursor_track::CursorTrack,
) -> Vec<serde_json::Value> {
    let (origin_x, origin_y, width, height) = screen_charm_raw_input_event_space(track);
    let mut ordered_events: Vec<&crate::cursor_track::CursorEvent> = track.events.iter().collect();
    ordered_events.sort_by(|a, b| {
        a.time_ms()
            .partial_cmp(&b.time_ms())
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut primary_button_down = false;
    let mut values = Vec::with_capacity(ordered_events.len());
    for event in ordered_events {
        let value = match event {
            crate::cursor_track::CursorEvent::Move {
                time_ms,
                x,
                y,
                cursor_type,
            } => Some(screen_charm_raw_mouse_event(
                if primary_button_down {
                    "dragged"
                } else {
                    "moved"
                },
                *time_ms,
                *x as f64,
                *y as f64,
                cursor_type.as_deref().unwrap_or("cursor"),
                origin_x,
                origin_y,
                width,
                height,
            )),
            crate::cursor_track::CursorEvent::Down {
                time_ms,
                button,
                x,
                y,
                cursor_type,
                ..
            } => {
                let value = screen_charm_raw_mouse_event(
                    "down",
                    *time_ms,
                    *x as f64,
                    *y as f64,
                    cursor_type.as_deref().unwrap_or("cursor"),
                    origin_x,
                    origin_y,
                    width,
                    height,
                );
                if *button == 1 {
                    primary_button_down = true;
                }
                Some(value)
            }
            crate::cursor_track::CursorEvent::Up {
                time_ms,
                button,
                x,
                y,
                cursor_type,
            } => {
                let value = screen_charm_raw_mouse_event(
                    "up",
                    *time_ms,
                    *x as f64,
                    *y as f64,
                    cursor_type.as_deref().unwrap_or("cursor"),
                    origin_x,
                    origin_y,
                    width,
                    height,
                );
                if *button == 1 {
                    primary_button_down = false;
                }
                Some(value)
            }
            crate::cursor_track::CursorEvent::Scroll {
                time_ms,
                x,
                y,
                delta_x,
                delta_y,
                cursor_type,
            } => Some(screen_charm_raw_scroll_event(
                *time_ms,
                *x as f64,
                *y as f64,
                *delta_x,
                *delta_y,
                cursor_type.as_deref().unwrap_or("cursor"),
                origin_x,
                origin_y,
                width,
                height,
            )),
            crate::cursor_track::CursorEvent::KeyDown { time_ms, .. } => {
                Some(screen_charm_raw_keyboard_event("down", *time_ms))
            }
            crate::cursor_track::CursorEvent::KeyUp { time_ms, .. } => {
                Some(screen_charm_raw_keyboard_event("up", *time_ms))
            }
            // Overlay state is Clipy telemetry, not an input event.
            crate::cursor_track::CursorEvent::Annotation { .. } => None,
        };
        if let Some(value) = value {
            values.push(value);
        }
    }
    values
}

fn screen_charm_raw_scroll_event(
    time_ms: f64,
    x: f64,
    y: f64,
    delta_x: i32,
    delta_y: i32,
    cursor_type: &str,
    origin_x: f64,
    origin_y: f64,
    width: f64,
    height: f64,
) -> serde_json::Value {
    let (x, y) = if width > 0.0 && height > 0.0 {
        ((x - origin_x) / width, 1.0 - ((y - origin_y) / height))
    } else {
        (x, y)
    };
    serde_json::json!({
        "type": "mouse",
        "cursorType": cursor_type,
        "mouseEventType": "scroll",
        "x": round3(x),
        "y": round3(y),
        "deltaX": delta_x,
        "deltaY": delta_y,
        "time": {
            "seconds": round3((time_ms / 1000.0).max(0.0))
        }
    })
}

fn screen_charm_raw_mouse_event(
    mouse_event_type: &str,
    time_ms: f64,
    x: f64,
    y: f64,
    cursor_type: &str,
    origin_x: f64,
    origin_y: f64,
    width: f64,
    height: f64,
) -> serde_json::Value {
    let (x, y) = if width > 0.0 && height > 0.0 {
        ((x - origin_x) / width, 1.0 - ((y - origin_y) / height))
    } else {
        (x, y)
    };
    serde_json::json!({
        "type": "mouse",
        "cursorType": cursor_type,
        "mouseEventType": mouse_event_type,
        "x": round3(x),
        "y": round3(y),
        "time": {
            "seconds": round3((time_ms / 1000.0).max(0.0))
        }
    })
}

fn screen_charm_raw_keyboard_event(keyboard_event_type: &str, time_ms: f64) -> serde_json::Value {
    serde_json::json!({
        "type": "keyboard",
        "keyboardEventType": keyboard_event_type,
        "time": {
            "seconds": round3((time_ms / 1000.0).max(0.0))
        }
    })
}

fn screen_charm_raw_input_event_space(
    track: &crate::cursor_track::CursorTrack,
) -> (f64, f64, f64, f64) {
    if let Some(capture) = track.capture {
        return (
            capture.screen_x.unwrap_or(capture.x),
            capture.screen_y.unwrap_or(capture.y),
            capture.screen_width.unwrap_or(capture.width),
            capture.screen_height.unwrap_or(capture.height),
        );
    }
    (
        0.0,
        0.0,
        inferred_track_width(track).unwrap_or_default().max(1) as f64,
        inferred_track_height(track).unwrap_or_default().max(1) as f64,
    )
}

fn screen_charm_input_events(
    track: &crate::cursor_track::CursorTrack,
    duration_ms: u64,
) -> Vec<serde_json::Value> {
    let frame_count = screen_charm_frame_count(duration_ms);
    if frame_count == 0 {
        return Vec::new();
    }

    let mut moves: Vec<(f64, f64, f64, String)> = track
        .events
        .iter()
        .filter_map(|event| match event {
            crate::cursor_track::CursorEvent::Move {
                time_ms,
                x,
                y,
                cursor_type,
            } => {
                let (x, y) = screen_charm_track_event_xy(track, *time_ms, *x as f64, *y as f64);
                Some((
                    *time_ms,
                    x,
                    y,
                    cursor_type.clone().unwrap_or_else(|| "cursor".to_string()),
                ))
            }
            _ => None,
        })
        .collect();
    moves.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut values = Vec::with_capacity(frame_count as usize + track.events.len());
    let mut move_index = 0usize;
    let mut current_xy = moves
        .first()
        .map(|(_, x, y, _)| (*x, *y))
        .unwrap_or((0.0, 0.0));
    let mut current_cursor_type = moves
        .first()
        .map(|(_, _, _, cursor_type)| cursor_type.clone())
        .unwrap_or_else(|| "cursor".to_string());

    for frame in 0..frame_count {
        let frame_ms = frame as f64 * 1000.0 / SCREEN_CHARM_COMPAT_FRAME_RATE;
        while move_index < moves.len() && moves[move_index].0 <= frame_ms {
            current_xy = (moves[move_index].1, moves[move_index].2);
            current_cursor_type = moves[move_index].3.clone();
            move_index += 1;
        }
        values.push(serde_json::json!({
            "eventType": "moved",
            "frame": frame,
            "x": round3(current_xy.0),
            "y": round3(current_xy.1),
            "cursorType": current_cursor_type,
            "cursorEvent": true
        }));
    }

    let max_frame = frame_count.saturating_sub(1);
    values.extend(track.events.iter().filter_map(|event| {
        let (event_type, time_ms, button, xy, cursor_type) = match event {
            crate::cursor_track::CursorEvent::Down {
                time_ms,
                button,
                x,
                y,
                cursor_type,
                ..
            } => (
                "down",
                *time_ms,
                Some(*button),
                Some((*x as f64, *y as f64)),
                cursor_type.as_deref().unwrap_or("cursor"),
            ),
            crate::cursor_track::CursorEvent::Up {
                time_ms,
                button,
                x,
                y,
                cursor_type,
            } => (
                "up",
                *time_ms,
                Some(*button),
                Some((*x as f64, *y as f64)),
                cursor_type.as_deref().unwrap_or("cursor"),
            ),
            crate::cursor_track::CursorEvent::KeyDown { time_ms, .. } => {
                ("down", *time_ms, None, None, "cursor")
            }
            crate::cursor_track::CursorEvent::KeyUp { time_ms, .. } => {
                ("up", *time_ms, None, None, "cursor")
            }
            crate::cursor_track::CursorEvent::Scroll {
                time_ms,
                x,
                y,
                cursor_type,
                ..
            } => (
                "scroll",
                *time_ms,
                None,
                Some((*x as f64, *y as f64)),
                cursor_type.as_deref().unwrap_or("cursor"),
            ),
            _ => return None,
        };
        let time_ms = time_ms.max(0.0).min(duration_ms as f64);
        let frame = ((time_ms / 1000.0) * SCREEN_CHARM_COMPAT_FRAME_RATE)
            .round()
            .max(0.0)
            .min(max_frame as f64) as u64;
        let (x, y) = xy
            .map(|(x, y)| screen_charm_track_event_xy(track, time_ms, x, y))
            .unwrap_or((0.0, 0.0));
        let cursor_event = button.is_some();
        let mut value = serde_json::json!({
            "eventType": event_type,
            "frame": frame,
            "x": round3(x),
            "y": round3(y),
            "cursorEvent": cursor_event
        });
        if cursor_event {
            value["cursorType"] = serde_json::Value::String(cursor_type.into());
        }
        if let Some(button) = button {
            value["button"] = serde_json::Value::from(button);
        }
        match event {
            crate::cursor_track::CursorEvent::Scroll {
                delta_x, delta_y, ..
            } => {
                value["deltaX"] = serde_json::Value::from(*delta_x);
                value["deltaY"] = serde_json::Value::from(*delta_y);
                value["cursorType"] = serde_json::Value::String(cursor_type.into());
                value["inputType"] = serde_json::Value::String("scroll".into());
            }
            crate::cursor_track::CursorEvent::KeyDown { key_code, .. }
            | crate::cursor_track::CursorEvent::KeyUp { key_code, .. } => {
                value["keyCode"] = serde_json::Value::from(*key_code);
                value["inputType"] = serde_json::Value::String("keyboard".into());
            }
            _ => {}
        }
        Some(value)
    }));

    values
}

fn screen_charm_event_xy(
    capture: Option<crate::cursor_track::CaptureViewport>,
    x: f64,
    y: f64,
) -> (f64, f64) {
    let Some(capture) = capture else {
        return (x, y);
    };
    if capture.width <= 0.0 || capture.height <= 0.0 {
        return (x, y);
    }
    (
        ((x - capture.x) / capture.width) * capture.output_width as f64,
        ((y - capture.y) / capture.height) * capture.output_height as f64,
    )
}

fn screen_charm_event_xy_at(
    capture: Option<crate::cursor_track::CaptureViewport>,
    capture_timeline: &[crate::cursor_track::CaptureViewportSample],
    time_ms: f64,
    x: f64,
    y: f64,
) -> (f64, f64) {
    let mut capture = capture;
    for sample in capture_timeline {
        if sample.time_ms <= time_ms {
            capture = Some(sample.viewport);
        } else {
            break;
        }
    }
    screen_charm_event_xy(capture, x, y)
}

fn screen_charm_track_event_xy(
    track: &crate::cursor_track::CursorTrack,
    time_ms: f64,
    x: f64,
    y: f64,
) -> (f64, f64) {
    screen_charm_event_xy(track.capture_at(time_ms), x, y)
}

fn screen_charm_frame_count(duration_ms: u64) -> u64 {
    ((duration_ms as f64 / 1000.0) * SCREEN_CHARM_COMPAT_FRAME_RATE).ceil() as u64
}

fn inferred_track_width(track: &crate::cursor_track::CursorTrack) -> Option<u32> {
    track
        .events
        .iter()
        .filter_map(cursor_event_x)
        .max()
        .map(|x| x as u32)
}

fn inferred_track_height(track: &crate::cursor_track::CursorTrack) -> Option<u32> {
    track
        .events
        .iter()
        .filter_map(cursor_event_y)
        .max()
        .map(|y| y as u32)
}

fn cursor_event_x(event: &crate::cursor_track::CursorEvent) -> Option<i32> {
    match event {
        crate::cursor_track::CursorEvent::Move { x, .. }
        | crate::cursor_track::CursorEvent::Down { x, .. }
        | crate::cursor_track::CursorEvent::Up { x, .. }
        | crate::cursor_track::CursorEvent::Scroll { x, .. } => Some(*x),
        crate::cursor_track::CursorEvent::KeyDown { .. }
        | crate::cursor_track::CursorEvent::KeyUp { .. }
        | crate::cursor_track::CursorEvent::Annotation { .. } => None,
    }
}

fn cursor_event_time_ms(event: &crate::cursor_track::CursorEvent) -> Option<f64> {
    match event {
        crate::cursor_track::CursorEvent::Move { time_ms, .. }
        | crate::cursor_track::CursorEvent::Down { time_ms, .. }
        | crate::cursor_track::CursorEvent::Up { time_ms, .. }
        | crate::cursor_track::CursorEvent::Scroll { time_ms, .. } => Some(*time_ms),
        crate::cursor_track::CursorEvent::KeyDown { .. }
        | crate::cursor_track::CursorEvent::KeyUp { .. }
        | crate::cursor_track::CursorEvent::Annotation { .. } => None,
    }
}

fn cursor_event_y(event: &crate::cursor_track::CursorEvent) -> Option<i32> {
    match event {
        crate::cursor_track::CursorEvent::Move { y, .. }
        | crate::cursor_track::CursorEvent::Down { y, .. }
        | crate::cursor_track::CursorEvent::Up { y, .. }
        | crate::cursor_track::CursorEvent::Scroll { y, .. } => Some(*y),
        crate::cursor_track::CursorEvent::KeyDown { .. }
        | crate::cursor_track::CursorEvent::KeyUp { .. }
        | crate::cursor_track::CursorEvent::Annotation { .. } => None,
    }
}

fn sidecar_file_info(path: &std::path::Path) -> serde_json::Value {
    let metadata = std::fs::metadata(path).ok();
    serde_json::json!({
        "path": path.display().to_string(),
        "filename": path.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
        "size": metadata.as_ref().map(|m| m.len()).unwrap_or_default(),
        "modifiedEpochMs": metadata
            .and_then(|m| m.modified().ok())
            .map(system_time_ms)
    })
}

fn system_time_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn even_f64(value: f64) -> f64 {
    ((value / 2.0).round() * 2.0).max(2.0)
}

fn probe_mp4_duration_ms(path: &std::path::Path) -> Option<u64> {
    // The user-facing Studio timeline must match the finalized MP4, not
    // wall-clock stop latency. FFmpeg reports container duration in
    // AV_TIME_BASE units.
    if let Err(e) = ffmpeg::init() {
        tracing::warn!("ffmpeg init failed while probing recording duration: {e:#}");
        return None;
    }
    let input = match ffmpeg::format::input(path) {
        Ok(input) => input,
        Err(e) => {
            tracing::warn!(
                "recording duration probe failed for {}: {e:#}",
                path.display()
            );
            return None;
        }
    };
    let duration = input.duration();
    if duration <= 0 {
        return None;
    }
    let ms = (duration as f64 * 1000.0 / 1_000_000.0).round();
    if ms.is_finite() && ms > 0.0 {
        Some(ms as u64)
    } else {
        None
    }
}

fn ensure_recording_disk_space(dir: &std::path::Path) -> Result<()> {
    let available = fs2::available_space(dir)
        .with_context(|| format!("check free space in {}", dir.display()))?;
    if available < MIN_RECORDING_FREE_BYTES {
        bail!(
            "Not enough free disk space to start recording. Clipy needs at least {} free in {} for reliable capture, but only {} is available.",
            format_bytes(MIN_RECORDING_FREE_BYTES),
            dir.display(),
            format_bytes(available)
        );
    }
    Ok(())
}

fn format_bytes(bytes: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes as f64 / GIB)
    } else {
        format!("{:.0} MB", bytes as f64 / MIB)
    }
}

async fn run_countdown<R: Runtime>(app: &AppHandle<R>, seconds: u32) {
    let seconds = crate::types::normalize_countdown_seconds(seconds);
    if seconds == 0 {
        return;
    }

    let window = app.get_webview_window("countdown");
    if let Some(w) = &window {
        let _ = w.show();
    }

    for n in (1..=seconds).rev() {
        let _ = app.emit(EVENT_COUNTDOWN_TICK, n);
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    if let Some(w) = &window {
        let _ = w.hide();
        // `hide()` returns before the compositor has actually dropped the
        // window. Capture starts immediately after this function returns, so
        // without a settle beat WGC's first frames still contain the "1"
        // overlay — the countdown ends up recorded, and because those early
        // frames are a stale surface the picture (camera included) appears
        // frozen for the same span.
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn surface_share_link<R: Runtime>(app: &AppHandle<R>, share: &ShareLinkDto) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use tauri_plugin_shell::ShellExt;

    let copied = match app.clipboard().write_text(share.url.clone()) {
        Ok(()) => true,
        Err(err) => {
            tracing::warn!("clipboard write failed: {err:#}");
            false
        }
    };
    notify_share_link(app, copied);

    // The finished video opens in the browser. The share
    // window is only the fallback for a Mac where no browser could launch.
    #[allow(deprecated)]
    let opened = app.shell().open(share.url.as_str(), None);
    if let Err(err) = opened {
        tracing::warn!("share link browser open failed: {err:#}");
        if let Some(window) = app.get_webview_window("share") {
            let _ = window.show();
        }
    }
}

/// The copy itself is silent, so a native notification says the link exists
/// and whether it is on the clipboard. It names the clipboard only when the
/// write landed: claiming a copy that failed would send the user to paste
/// whatever their clipboard held before. Best effort, like the other
/// notifications: macOS may hold them until authorization is granted.
fn notify_share_link<R: Runtime>(app: &AppHandle<R>, copied: bool) {
    use tauri_plugin_notification::NotificationExt;
    let body = crate::i18n::t(if copied {
        "notifications.linkCopied"
    } else {
        "notifications.linkReady"
    });
    if let Err(err) = app
        .notification()
        .builder()
        .title(crate::edition::APP_NAME)
        .body(body)
        .show()
    {
        tracing::warn!("share link notification failed: {err:#}");
    }
}

// ===========================================================================
// Capture + writer + uploader wiring (macOS)
// ===========================================================================

#[cfg(target_os = "macos")]
async fn start_capture<R: Runtime>(
    app: &AppHandle<R>,
    api_base: &str,
    bearer: &str,
    recording_id: &RecordingId,
    file_path: &std::path::Path,
    active_slot: &Arc<Mutex<Option<ActiveRecording>>>,
    source: Option<&CaptureSourceDto>,
    audio: &AudioOptionsDto,
    video: &VideoOptionsDto,
    webcam: Option<WebcamCaptureDto>,
    capture_source: Option<CaptureSourceMetadataDto>,
    state: &Arc<Mutex<RecordingStateDto>>,
    mode: crate::types::RecordingMode,
) -> Result<()> {
    const FPS: u32 = 30;
    let webcam_for_activation = webcam.clone();

    if mode != crate::types::RecordingMode::Studio {
        if let Some(webcam) = webcam_for_activation
            .as_ref()
            .filter(|webcam| webcam.enabled)
        {
            crate::commands::show_recording_webcam_bubble_for_capture_start(app, webcam, true)
                .map_err(|err| {
                    CaptureFailure::tag(
                        "webcam_bubble_failed",
                        anyhow!("webcam bubble activation failed: {err}"),
                    )
                })?;
        }
    }

    // The uploader's /initiate is a network round-trip and SCK stream
    // setup takes ~0.5-1s — run them CONCURRENTLY so the user-perceived
    // "click Record → recording starts" delay is max(initiate, SCK)
    // instead of the sum. Frames SCK delivers while initiate is still in
    // flight are drained below before the pump starts, preserving the old
    // ordering's property that nothing lands in the file from before the
    // user-visible start point. An initiate failure (e.g. 401) still
    // fails the whole start — the capturer is stopped and dropped.
    let uploader_fut = async {
        if mode == crate::types::RecordingMode::Local
            || (crate::edition::is_dev_bypass(bearer) && !is_local_api_base(api_base))
        {
            tracing::info!("dev session: skipping streaming upload (local studio)");
            Ok::<Option<UploaderHandle>, anyhow::Error>(None)
        } else {
            Ok(Some(
                StreamingUploader::start(
                    app,
                    api_base.to_string(),
                    bearer.to_string(),
                    recording_id.clone(),
                    file_path.to_path_buf(),
                    None,
                    video.max_height,
                    mode == crate::types::RecordingMode::Instant,
                )
                .await
                .map_err(crate::capture::failure::initiate_failure)?,
            ))
        }
    };
    let window_only = crate::types::is_window_only_capture(source, video);
    let capture_fut = ScreenCapturer::start(
        app,
        FPS,
        audio.include_system_audio,
        source,
        video.max_height,
        video.window_capture,
    );
    let (uploader_res, capture_res) = tokio::join!(uploader_fut, capture_fut);
    let uploader = match uploader_res {
        Ok(u) => u,
        Err(err) => {
            // Don't leave a live SCK stream (and the purple menu-bar
            // indicator) behind when the upload session couldn't open.
            if let Ok((screen, _)) = capture_res {
                let _ = screen.stop().await;
            }
            return Err(err);
        }
    };
    let (screen, handles) = match capture_res {
        Ok(v) => v,
        Err(err) => {
            // Symmetric to the branch above: /initiate already succeeded
            // (a 'recording' stub row + upload session exist server-side)
            // but capture never started, so no bytes will ever follow.
            // Without this, the uploader handle is silently dropped —
            // `abort` is a plain closure with no Drop impl — leaving an
            // orphaned row the janitor only sweeps after 8 days.
            if let Some(u) = uploader {
                let handle = (u.abort)();
                let _ = handle.await;
            }
            return Err(CaptureFailure::tag(
                "screen_capture_failed",
                err.context("start screen capture"),
            ));
        }
    };

    let ScreenCaptureHandles {
        mut video_rx,
        system_audio_rx,
        width,
        height,
        capture: cursor_capture,
        window_follow,
        stream_stats,
    } = handles;
    let mut system_audio_rx = system_audio_rx;
    let pump_stream_stats = stream_stats.clone();

    // Discard whatever SCK queued while /initiate was still in flight so
    // the first encoded frame is at the user-visible start point (see the
    // concurrency note above).
    //
    // Keep the newest drained screen frame, though. ScreenCaptureKit only
    // sends a new frame when the picture changes, so on a still screen or
    // window that frame can be the only one for a long time. It becomes the
    // first frame of the take (re-timed to the start point) instead of being
    // thrown away, which would leave the first-frame guard below waiting for
    // a change that may never come.
    let mut primed_video: Option<VideoSample> = None;
    while let Ok(sample) = video_rx.try_recv() {
        if matches!(sample, VideoSample::Screen(_)) {
            primed_video = Some(sample);
        }
    }
    // The start point the primed frame is shown at: anything still queued
    // after this was captured later.
    let primed_at_mach = cidre::mach::abs_time();
    if let Some(rx) = system_audio_rx.as_mut() {
        while rx.try_recv().is_ok() {}
    }

    // The popover's level monitor holds the same device; release it before the
    // recording opens its own stream.
    crate::mic_monitor::stop_and_wait().await;

    let (mic, mic_rx) = if audio.include_mic {
        // Supervised: survives unplugging the active mic mid-recording and
        // follows the OS default when no explicit device was picked
        // (AirPods connected mid-take). Swap feedback goes to the recording
        // HUD via EVENT_MIC_SWITCHED — always visible, no OS permission —
        // with a native notification as best-effort backup (macOS may
        // suppress those until authorization is granted).
        let app_for_switch = app.clone();
        let on_switch: crate::capture::audio::MicSupervisorCallback = Box::new(move |event| {
            use tauri_plugin_notification::NotificationExt;
            let device = event.device();
            let paused = event.is_paused();
            let notification = if paused {
                crate::i18n::t_with("notifications.micPaused", &[("device", &device)])
            } else {
                crate::i18n::t_with("notifications.micSwitched", &[("device", &device)])
            };
            // `paused` travels as its own field so the HUD can hold the state
            // for as long as it lasts instead of inferring it from the device
            // string and dismissing it on a timer.
            let _ = app_for_switch.emit(
                crate::types::EVENT_MIC_SWITCHED,
                serde_json::json!({ "device": device, "paused": paused }),
            );
            let _ = app_for_switch
                .notification()
                .builder()
                .title(crate::edition::APP_NAME)
                .body(notification)
                .show();
        });
        match MicSupervisor::start(audio.mic_device_id.clone(), on_switch) {
            Ok((m, rx)) => (Some(m), Some(rx)),
            Err(err) => {
                tracing::warn!("requested mic capture unavailable; refusing silent recording");
                tracing::debug!(error = ?err, "requested mic capture failure details");
                if let Some(u) = uploader {
                    let handle = (u.abort)();
                    let _ = handle.await;
                }
                let _ = screen.stop().await;
                // Deliberately does NOT interpolate `err`: the cpal error text
                // carries the device name, and this string is surfaced in the
                // UI and captured by crash reporting. The detail is already on
                // the debug log above, which stays local.
                return Err(anyhow::Error::new(CaptureFailure::new(
                    "mic_unavailable",
                    MIC_CAPTURE_UNAVAILABLE,
                )));
            }
        }
    } else {
        tracing::info!("mic capture disabled by user");
        (None, None)
    };
    let mut mic_rx = mic_rx;

    let encoder_cfg = EncoderConfig {
        width,
        height,
        fps: FPS,
        video_bitrate_bps: crate::capture_health::video_bitrate_for_height(video.max_height),
    };
    let mut encoder = match Mp4Encoder::open(file_path, encoder_cfg) {
        Ok(e) => e,
        Err(err) => {
            // Same orphan risk as the uploader/capture join above: /initiate
            // already succeeded and SCK + mic capture are already running,
            // but none of the three are stored into ActiveRecording yet, so
            // the normal stop/cancel paths can never reach them. Tear all
            // three down explicitly instead of letting them drop silently
            // (a known failure mode: usually a
            // missing parent dir for file_path).
            if let Some(u) = uploader {
                let handle = (u.abort)();
                let _ = handle.await;
            }
            if let Some(m) = mic {
                let _ = m.stop();
            }
            let _ = screen.stop().await;
            return Err(CaptureFailure::tag(
                "encoder_open_failed",
                err.context("open ffmpeg MP4 encoder"),
            ));
        }
    };

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    // Pause / mic-mute flags shared with the pump, the elapsed ticker, the
    // cursor tracker, and the controller (via ActiveRecording).
    let pause = PauseState::new();
    let pump_pause = pause.clone();

    let pump_file_path = file_path.to_path_buf();
    let pump_started_at = Instant::now();
    let pump_reduce_noise = audio.reduce_noise;
    let capture_counters = Arc::new(CaptureCounters::new(pump_started_at));
    let pump_counters = Arc::clone(&capture_counters);
    let pump_recording_id = recording_id.clone();
    let pump_include_mic = audio.include_mic;
    let pump_include_system_audio = audio.include_system_audio;
    // macOS refuses to start without a requested mic, so a requested mic is
    // always a started one here.
    let pump_mic_started = mic.is_some();
    let pump_task: JoinHandle<Result<u64>> = tokio::spawn(async move {
        // Wall-clock anchor for both video + audio PTS. SCK delivers
        // CMSampleBuffers tagged with absolute mach time; we subtract
        // off the first video frame's mach time and convert to each
        // stream's natural time base (microseconds for video, samples
        // for audio). This shared anchor keeps A/V sync correct without
        // any clock drift.
        let mach_timebase = cidre::mach::TimeBaseInfo::new();
        let mut start_mach: Option<u64> = None;
        let mut last_video_pts: i64 = -1;
        let mut pump_error_reports = crate::repeat_error::RepeatErrorTracker::default();
        let mut last_video_frame: Option<ffmpeg::frame::Video> = None;
        let mut next_synthetic_video_pts: Option<i64> = None;
        let mut last_system_audio_pts: i64 = -1;
        let mut mic_timeline = MicTimeline::default();
        let mut audio_sources = Vec::new();
        if system_audio_rx.is_some() {
            audio_sources.push("system_audio");
        }
        if mic_rx.is_some() {
            audio_sources.push("mic");
        }
        let has_audio_sources = !audio_sources.is_empty();
        if !has_audio_sources {
            // Nothing can ever reach the audio track, so keep it filled with
            // silence instead of finishing with zero packets.
            encoder.enable_silence_prefill();
        }
        let mut audio_mixer =
            LiveAudioMixer::new(audio_sources)?.with_noise_suppression(pump_reduce_noise);

        let mut video_frames: u64 = 0;
        let mut system_audio_chunks: u64 = 0;
        let mut mic_chunks: u64 = 0;
        let mut mixed_audio_frames: u64 = 0;
        let mut system_audio_signal = AudioSignalStats::default();
        let mut mic_audio_signal = AudioSignalStats::default();
        let mut mixed_audio_signal = AudioSignalStats::default();
        let mut mic_channel_selector = MicChannelSelector::default();
        let mut mic_resampler: Option<MicResampler> = None;

        // The newest frame drained at start (see above) opens the take at
        // PTS 0, anchored to now: it is what the screen showed at the start
        // point, and later frames, audio and the cursor all sit after it.
        if let Some(sample) = primed_video.take() {
            match sample.to_frame(0).and_then(|frame| {
                encoder.queue_video(frame.clone())?;
                Ok(frame)
            }) {
                Ok(frame) => {
                    start_mach = Some(primed_at_mach);
                    last_video_pts = 0;
                    pump_counters.note_source_frame();
                    last_video_frame = Some(frame);
                    next_synthetic_video_pts = Some(video_frame_interval_us(FPS));
                    video_frames += 1;
                }
                Err(e) => {
                    pump_counters.note_rejected_source_frame();
                    report_pump_error(&mut pump_error_reports, "queue_video (start frame)", &e);
                }
            }
        }

        // Convert SCK SampleBuf → ffmpeg::frame::Video and queue.
        // Closures aren't quite right because they'd need to borrow
        // `encoder` mutably from the surrounding scope; inlined here.
        loop {
            tokio::select! {
                // Keep this select fair. Mic chunks are timestamped in the
                // cpal callback and can queue faster than the pump drains
                // them. A biased select lets video/system-audio starve the
                // mic branch for seconds, then those old mic frames arrive
                // after the mixer has advanced `buffer_start_pts` and get
                // dropped as "behind buffer_start".
                _ = &mut shutdown_rx => {
                    // A stop-from-paused committed its pause window just
                    // before shutdown — consume it so drained frames and the
                    // fill below land on the pause-excluded timeline.
                    if apply_pending_pause_shift(&pump_pause, &mut start_mach, &mach_timebase) {
                        // Covers a pause during which the pump pulled no mic
                        // chunk, so `note_mic_cut` never ran on a dropped one.
                        audio_mixer.note_mic_cut();
                    }
                    // Drain whatever is still in the channels — SCK can
                    // have a few buffers queued at this point.
                    while let Ok(s) = video_rx.try_recv() {
                        match pump_video(
                            &mut encoder, &s, &mach_timebase,
                            &mut start_mach, &mut last_video_pts,
                        ) {
                            Ok((pts, frame)) => {
                                pump_counters.note_source_frame();
                                last_video_frame = Some(frame);
                                next_synthetic_video_pts =
                                    Some(pts + video_frame_interval_us(FPS));
                            }
                            Err(e) => {
                                pump_counters.note_rejected_source_frame();
                                report_pump_error(
                                    &mut pump_error_reports,
                                    "queue_video (drain)",
                                    &e,
                                );
                            }
                        }
                        video_frames += 1;
                    }
                    if let (Some(frame), Some(next_pts)) =
                        (last_video_frame.as_ref(), next_synthetic_video_pts.as_mut())
                    {
                        let target_pts = pump_pause.effective_elapsed_us(&pump_started_at) as i64;
                        match pump_repeated_video_until(
                            &mut encoder,
                            frame,
                            next_pts,
                            target_pts,
                            video_frame_interval_us(FPS),
                        ) {
                            Ok(emitted) => video_frames += emitted,
                            Err(e) => {
                                report_pump_error(
                                    &mut pump_error_reports,
                                    "queue_video (shutdown fill)",
                                    &e,
                                );
                            }
                        }
                    }
                    if let Some(rx) = system_audio_rx.as_mut() {
                        while let Ok(s) = rx.try_recv() {
                            match system_audio_frame(
                                &s, &mach_timebase, start_mach, &mut last_system_audio_pts,
                            ) {
                                Ok(Some(frame)) => {
                                    if let Err(e) = queue_mixed_audio(
                                        &mut encoder,
                                        &mut audio_mixer,
                                        frame,
                                        &mut system_audio_signal,
                                        &mut mixed_audio_signal,
                                        &mut mixed_audio_frames,
                                        "system_audio",
                                    ) {
                                        report_pump_error(
                                            &mut pump_error_reports,
                                            "queue_system_audio (drain)",
                                            &e,
                                        );
                                    }
                                }
                                Ok(None) => {}
                                Err(e) => {
                                    report_pump_error(
                                        &mut pump_error_reports,
                                        "system_audio_frame (drain)",
                                        &e,
                                    );
                                }
                            }
                            system_audio_chunks += 1;
                        }
                    }
                    if let Some(rx) = mic_rx.as_mut() {
                        while let Ok(mut chunk) = rx.try_recv() {
                            if !audio_mixer.begin_mic_generation(chunk.generation) {
                                continue;
                            }
                            // The mic is still muted while its last chunks
                            // are drained at stop, so they must not reach the
                            // recording either.
                            let mic_muted = apply_live_mic_mute(&pump_pause, &mut chunk.samples);
                            audio_mixer.set_mic_muted(mic_muted);
                            match mic_audio_frame(
                                &chunk,
                                &mach_timebase,
                                start_mach,
                                &mut mic_timeline,
                                &mut mic_channel_selector,
                                &mut mic_resampler,
                            ) {
                                Ok(Some(frame)) => {
                                    if let Err(e) = queue_mixed_audio(
                                        &mut encoder,
                                        &mut audio_mixer,
                                        frame,
                                        &mut mic_audio_signal,
                                        &mut mixed_audio_signal,
                                        &mut mixed_audio_frames,
                                        "mic",
                                    ) {
                                        report_pump_error(
                                            &mut pump_error_reports,
                                            "queue_mic_audio (drain)",
                                            &e,
                                        );
                                    }
                                }
                                Ok(None) => {}
                                Err(e) => {
                                    report_pump_error(
                                        &mut pump_error_reports,
                                        "mic_audio_frame (drain)",
                                        &e,
                                    );
                                }
                            }
                            mic_chunks += 1;
                        }
                    }
                    break;
                }
                maybe_v = video_rx.recv() => {
                    match maybe_v {
                        Some(s) => {
                            // Order matters: drop-while-paused FIRST, then
                            // consume the shift — a stale frame processed
                            // right after resume is bounded to 1-2 clamped
                            // pts (the paused arms keep draining channels,
                            // so no backlog accumulates during pause).
                            if pump_pause.is_paused() {
                                continue;
                            }
                            if apply_pending_pause_shift(&pump_pause, &mut start_mach, &mach_timebase) {
                                // Covers a pause during which the pump pulled no mic
                                // chunk, so `note_mic_cut` never ran on a dropped one.
                                audio_mixer.note_mic_cut();
                            }
                            match next_video_pts(
                                &s,
                                &mach_timebase,
                                &mut start_mach,
                                &mut last_video_pts,
                            )
                            .and_then(|pts| {
                                if let (Some(frame), Some(next_pts)) =
                                    (last_video_frame.as_ref(), next_synthetic_video_pts.as_mut())
                                {
                                    pump_repeated_video_until(
                                        &mut encoder,
                                        frame,
                                        next_pts,
                                        pts,
                                        video_frame_interval_us(FPS),
                                    )?;
                                }
                                let frame = s.to_frame(pts)?;
                                encoder.queue_video(frame.clone())?;
                                Ok((pts, frame))
                            }) {
                                Ok((pts, frame)) => {
                                    pump_counters.note_source_frame();
                                    last_video_frame = Some(frame);
                                    next_synthetic_video_pts =
                                        Some(pts + video_frame_interval_us(FPS));
                                }
                                Err(e) => {
                                    pump_counters.note_rejected_source_frame();
                                    report_pump_error(
                                        &mut pump_error_reports,
                                        "queue_video",
                                        &e,
                                    );
                                }
                            }
                            video_frames += 1;
                        }
                        None => {
                            if let (Some(frame), Some(next_pts)) =
                                (last_video_frame.as_ref(), next_synthetic_video_pts.as_mut())
                            {
                                let target_pts = pump_pause.effective_elapsed_us(&pump_started_at) as i64;
                                match pump_repeated_video_until(
                                    &mut encoder,
                                    frame,
                                    next_pts,
                                    target_pts,
                                    video_frame_interval_us(FPS),
                                ) {
                                    Ok(emitted) => video_frames += emitted,
                                    Err(e) => {
                                        report_pump_error(
                                            &mut pump_error_reports,
                                            "queue_video (close fill)",
                                            &e,
                                        );
                                    }
                                }
                            }
                            break;
                        },
                    }
                }
                maybe_sa = async {
                    match system_audio_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    match maybe_sa {
                        Some(s) => {
                            if pump_pause.is_paused() {
                                continue;
                            }
                            if apply_pending_pause_shift(&pump_pause, &mut start_mach, &mach_timebase) {
                                // Covers a pause during which the pump pulled no mic
                                // chunk, so `note_mic_cut` never ran on a dropped one.
                                audio_mixer.note_mic_cut();
                            }
                            match system_audio_frame(
                                &s, &mach_timebase, start_mach, &mut last_system_audio_pts,
                            ) {
                                Ok(Some(frame)) => {
                                    if let Err(e) = queue_mixed_audio(
                                        &mut encoder,
                                        &mut audio_mixer,
                                        frame,
                                        &mut system_audio_signal,
                                        &mut mixed_audio_signal,
                                        &mut mixed_audio_frames,
                                        "system_audio",
                                    ) {
                                        report_pump_error(
                                            &mut pump_error_reports,
                                            "queue_system_audio",
                                            &e,
                                        );
                                    }
                                }
                                Ok(None) => {}
                                Err(e) => {
                                    report_pump_error(
                                        &mut pump_error_reports,
                                        "system_audio_frame",
                                        &e,
                                    );
                                }
                            }
                            system_audio_chunks += 1;
                        }
                        None => { system_audio_rx = None; }
                    }
                }
                maybe_mic = async {
                    match mic_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    match maybe_mic {
                        Some(mut chunk) => {
                            if pump_pause.is_paused() {
                                audio_mixer.note_mic_cut();
                                continue;
                            }
                            if !audio_mixer.begin_mic_generation(chunk.generation) {
                                continue;
                            }
                            if apply_pending_pause_shift(&pump_pause, &mut start_mach, &mach_timebase) {
                                // Covers a pause during which the pump pulled no mic
                                // chunk, so `note_mic_cut` never ran on a dropped one.
                                audio_mixer.note_mic_cut();
                            }
                            let mic_muted = apply_live_mic_mute(&pump_pause, &mut chunk.samples);
                            audio_mixer.set_mic_muted(mic_muted);
                            pump_pause.observe_mic_samples(&chunk.samples);
                            match mic_audio_frame(
                                &chunk,
                                &mach_timebase,
                                start_mach,
                                &mut mic_timeline,
                                &mut mic_channel_selector,
                                &mut mic_resampler,
                            ) {
                                Ok(Some(frame)) => {
                                    if let Err(e) = queue_mixed_audio(
                                        &mut encoder,
                                        &mut audio_mixer,
                                        frame,
                                        &mut mic_audio_signal,
                                        &mut mixed_audio_signal,
                                        &mut mixed_audio_frames,
                                        "mic",
                                    ) {
                                        report_pump_error(
                                            &mut pump_error_reports,
                                            "queue_mic_audio",
                                            &e,
                                        );
                                    }
                                }
                                Ok(None) => {}
                                Err(e) => {
                                    report_pump_error(
                                        &mut pump_error_reports,
                                        "mic_audio_frame",
                                        &e,
                                    );
                                }
                            }
                            mic_chunks += 1;
                        }
                        None => { mic_rx = None; }
                    }
                }
            }
        }

        for (message, occurrences) in pump_error_reports.repeated() {
            tracing::warn!(
                occurrences,
                error_message = message,
                "repeated recording pump error summary"
            );
        }

        let audio_mixer_peak_buffered_samples = audio_mixer.peak_buffered_samples;
        let audio_mixer_laggard_bypass_calls = audio_mixer.laggard_bypass_calls;
        if has_audio_sources {
            let video_end_us = next_synthetic_video_pts
                .and_then(|pts| u64::try_from(pts).ok())
                .unwrap_or_else(|| pump_pause.effective_elapsed_us(&pump_started_at));
            let target_audio_pts = video_end_us
                .saturating_mul(SAMPLE_RATE as u64)
                .saturating_div(1_000_000)
                .min(i64::MAX as u64) as i64;
            mixed_audio_frames += audio_mixer.flush_through(
                &mut encoder,
                &mut mixed_audio_signal,
                target_audio_pts,
            )?;
        } else {
            mixed_audio_frames += audio_mixer.flush(&mut encoder, &mut mixed_audio_signal)?;
        }
        tracing::info!(
            video_frames,
            system_audio_chunks,
            mic_chunks,
            mixed_audio_frames,
            system_audio_peak_db = system_audio_signal.peak_dbfs(),
            mic_audio_peak_db = mic_audio_signal.peak_dbfs(),
            mixed_audio_peak_db = mixed_audio_signal.peak_dbfs(),
            audio_mixer_peak_buffered_samples,
            audio_mixer_peak_buffered_ms =
                audio_mixer_peak_buffered_samples as u64 * 1_000 / SAMPLE_RATE as u64,
            audio_mixer_laggard_bypass_calls,
            mic_timeline_snaps = mic_timeline.snaps,
            mic_timeline_drift_trims = mic_timeline.drift_trims,
            mic_timeline_drift_pads = mic_timeline.drift_pads,
            mic_timeline_gaps = mic_timeline.gaps,
            mic_timeline_trims = mic_timeline.trims,
            mic_timeline_backward_resyncs = mic_timeline.backward_resyncs,
            mic_timeline_stale_drops = mic_timeline.stale_drops,
            "pump: finalizing encoder"
        );
        if mixed_audio_frames > 0 && mixed_audio_signal.is_effectively_silent() {
            tracing::warn!(
                system_audio_chunks,
                mic_chunks,
                "captured audio stream is effectively silent"
            );
        }
        crate::capture_health::remember_capture_health(
            &pump_recording_id,
            crate::capture_health::CaptureHealthReport {
                source_video_frames: Some(pump_counters.source_video_frames()),
                last_source_frame_ms: pump_counters.last_source_frame_ms(),
                audio: Some(crate::capture_health::AudioStateReport {
                    include_mic: pump_include_mic,
                    include_system_audio: pump_include_system_audio,
                    mic_started: pump_mic_started,
                    mic_error: None,
                    mic_chunks,
                    loopback_chunks: system_audio_chunks,
                    mic_silence: None,
                    mic_reopen: None,
                }),
                screen_capture: pump_stream_stats.as_ref().map(|stats| {
                    stats.report(
                        pump_counters.rejected_source_frames(),
                        encoder.rescaled_video_frames(),
                    )
                }),
            },
        );
        encoder.finish().context("Mp4Encoder::finish")?;

        let bytes = std::fs::metadata(&pump_file_path)
            .map(|m| m.len())
            .unwrap_or(0);
        Ok(bytes)
    });

    // First-frame guard (a recording must never silently produce nothing):
    // capture and the encoder can open without error and still deliver no
    // video at all, as every macOS 12.7.6 take did. Wait for the first real
    // frame to reach the encoder before calling this a recording. Camera-only
    // takes are left out: a camera can take longer than this to warm up.
    let guards_screen_frames = !matches!(source, Some(CaptureSourceDto::Camera { .. }));
    if guards_screen_frames
        && !wait_for_first_source_frame(&capture_counters, FIRST_SOURCE_FRAME_TIMEOUT).await
    {
        tracing::error!(
            timeout_ms = FIRST_SOURCE_FRAME_TIMEOUT.as_millis() as u64,
            rejected_frames = capture_counters.rejected_source_frames(),
            "no screen frame reached the encoder after start; stopping the take"
        );
        // Same teardown order as `stop`: pump first, then the microphone, then
        // ScreenCaptureKit. The upload is aborted so no empty take is created.
        let _ = shutdown_tx.send(());
        if let Some(m) = mic {
            let _ = m.stop();
        }
        let _ = screen.stop().await;
        let _ = pump_task.await;
        if let Some(u) = uploader {
            let handle = (u.abort)();
            let _ = handle.await;
        }
        if mode != crate::types::RecordingMode::Local {
            // Otherwise the empty file would be offered for recovery later.
            if let Err(err) = crate::recording_files::remove_local_recording_artifacts(file_path).await {
                tracing::warn!("empty take could not be removed: {err:#}");
            }
        }
        let (reason, message) = if capture_counters.rejected_source_frames() > 0 {
            ("screen_frames_unreadable", UNREADABLE_SCREEN_FRAMES)
        } else if matches!(source, Some(CaptureSourceDto::Window { .. })) {
            ("no_window_frames", NO_WINDOW_FRAMES)
        } else {
            ("no_screen_frames", NO_SCREEN_FRAMES)
        };
        // Nothing reaches `/complete` for this take, so what ScreenCaptureKit
        // sent rides on the `recording_failed` event instead: whether it sent
        // status-only buffers, stopped with an error, or sent nothing at all.
        // The pump has finished, so its report (with the encoder's counts) is
        // normally there; the live counters are the fallback.
        let screen_report = crate::capture_health::capture_health_for(recording_id)
            .and_then(|report| report.screen_capture)
            .or_else(|| {
                stream_stats
                    .as_ref()
                    .map(|stats| stats.report(capture_counters.rejected_source_frames(), 0))
            });
        let mut failure = crate::capture::failure::CaptureFailure::new(reason, message);
        if let Some(report) = screen_report {
            tracing::error!(
                screen_buffers = report.screen_buffers,
                frames_without_image = report.frames_without_image,
                frame_status = ?report.frame_status,
                stop_error_code = ?report.stop_error_code,
                pixel_format = ?report.pixel_format,
                "screen capture sent no usable frame"
            );
            if let Some(name) = report.stop_error_name() {
                failure = failure.with_error_name(name);
            }
            failure = failure.with_measures(report.telemetry_measures());
        }
        return Err(anyhow::Error::new(failure));
    }

    let started_at = Instant::now();

    // Periodic ticker: while the recording phase is active, emit state
    // updates so the UI can render elapsed time + bytes-written. Without
    // this the React side stays at 0/0 because the phase only flips at
    // start/stop, never during the recording itself.
    let ticker_app = app.clone();
    let ticker_state = state.clone();
    let ticker_path = file_path.to_path_buf();
    let ticker_pause = pause.clone();
    let ticker_has_mic = mic.is_some();
    state.lock().mic_active = ticker_has_mic;
    let ticker_task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut displayed_mic_level = 0.0f32;
        let mut silent_mic_ms = 0u64;
        let mut last_elapsed_ms = 0u64;
        loop {
            tick.tick().await;
            let phase = {
                let s = ticker_state.lock();
                s.phase
            };
            if phase == RecordingPhase::Countdown {
                continue;
            }
            if phase != RecordingPhase::Recording && phase != RecordingPhase::Paused {
                break;
            }
            let elapsed_ms = ticker_pause.effective_elapsed_us(&started_at) / 1_000;
            let elapsed_delta_ms = elapsed_ms.saturating_sub(last_elapsed_ms);
            last_elapsed_ms = elapsed_ms;
            let mic_muted = ticker_pause.is_mic_muted();
            let mut silence_warning = None;
            if ticker_has_mic {
                let level = ticker_pause.take_mic_level();
                displayed_mic_level = if level > displayed_mic_level {
                    level
                } else {
                    displayed_mic_level * 0.65
                };
                if displayed_mic_level < 0.01 {
                    displayed_mic_level = 0.0;
                }
                if !mic_muted && phase == RecordingPhase::Recording {
                    ticker_pause.add_unmuted_mic_ms(elapsed_delta_ms);
                }
                if mic_muted || phase == RecordingPhase::Paused || level_has_input(level) {
                    silent_mic_ms = 0;
                } else {
                    silent_mic_ms = silent_mic_ms.saturating_add(elapsed_delta_ms);
                    if silent_mic_ms >= MIC_SILENCE_WARNING_MS {
                        silence_warning = Some(crate::i18n::t("notifications.micSilent"));
                    }
                }
            }
            let bytes = tokio::fs::metadata(&ticker_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            let dto = {
                let mut s = ticker_state.lock();
                s.elapsed_ms = Some(elapsed_ms);
                s.bytes_written = Some(bytes);
                s.mic_level = ticker_has_mic.then_some(displayed_mic_level);
                s.mic_muted = mic_muted;
                s.mic_active = ticker_has_mic;
                s.mic_silence_warning = silence_warning;
                s.clone()
            };
            let _ = ticker_app.emit(EVENT_RECORDING_STATE_CHANGED, dto);
        }
    });

    // Start the cursor tracker the moment we hand the active recording
    // to the controller. The encoder anchors its timeline on the first
    // video frame; cursor `time_ms` is wall-clock-from-start, so the
    // editor will drop the first ~50–200ms of cursor samples to align
    // when it consumes the sidecar. Cheap to over-capture.
    //
    // A window-only take follows its window, so the viewport is sampled
    // too and lands in the sidecar as `capture_timeline`; every consumer
    // (server key moments, local moments, auto-zoom) already reads it.
    let capture_timeline = match (window_follow, cursor_capture) {
        (Some(follow), Some(initial)) => Some(crate::cursor_track::CaptureTimelineConfig {
            window_id: follow.window_id,
            initial,
            content: follow.content,
        }),
        _ => None,
    };
    let cursor_tracker = cursor_capture.map(|_| {
        crate::cursor_track::CursorTracker::start_paused_aware_with_capture_timeline(
            pause.clone(),
            capture_timeline,
        )
    });

    // Resource samples once a minute, for Instant takes that upload (Local AI
    // and debug dev-session takes send no recording events, and retired Studio gets
    // no new features). Ends by itself when the take leaves Recording/Paused.
    if let (Some(upload), crate::types::RecordingMode::Instant) = (uploader.as_ref(), mode) {
        crate::recording_health::spawn(
            app.clone(),
            recording_id.clone(),
            state.clone(),
            pause.clone(),
            started_at,
            file_path.to_path_buf(),
            Some(upload.health.clone()),
        );
    }
    let active = ActiveRecording {
        recording_id: recording_id.clone(),
        file_path: file_path.to_path_buf(),
        started_at,
        pause,
        bearer: bearer.to_string(),
        api_base: api_base.to_string(),
        cursor_tracker,
        cursor_capture,
        capture_source,
        window_only,
        shutdown_tx: Some(shutdown_tx),
        pump_task: Some(pump_task),
        ticker_task: Some(ticker_task),
        // `Option<UploaderHandle>` — populated for both Instant and Studio
        // (a real authenticated session), `None` only for the debug dev session.
        uploader,
        mode,
        webcam,
        audio: audio.clone(),
        screen: Some(screen),
        // `mic` is already Option<MicCapturer> (None when include_mic=false).
        mic,
    };
    *active_slot.lock() = Some(active);

    let Some(cursor_capture) = cursor_capture else {
        crate::commands::teardown_cursor_trail_overlay(app);
        return Ok(());
    };

    // Custom size keeps its frame up for the whole take so the user can see
    // what is inside the crop. The window is excluded from capture, so the
    // frame never reaches the video. Area only: a display has edges and a
    // window has its own chrome.
    if matches!(source, Some(CaptureSourceDto::Area { .. })) {
        show_region_highlight(app, source_rect_from_capture_viewport(cursor_capture));
    }

    if let Some(webcam) = webcam_for_activation
        .as_ref()
        .filter(|webcam| webcam.enabled)
    {
        if let Err(err) = crate::commands::show_recording_webcam_bubble(
            app,
            webcam,
            Some(source_rect_from_capture_viewport(cursor_capture)),
            mode != crate::types::RecordingMode::Studio,
        ) {
            tracing::error!("webcam bubble activation failed: {err}");
        }
    } else {
        crate::commands::set_webcam_capturable(app, mode != crate::types::RecordingMode::Studio);
    }

    // Flare draws in its own overlay window, which a window-only take never
    // contains. Without a session the HUD hides the Flare button and holding
    // Control draws nothing, rather than drawing a trail the video lacks.
    // The Control presses still reach the sidecar, so key moments keep
    // anchoring on them.
    if mode != crate::types::RecordingMode::Studio && !window_only {
        if let Err(err) = crate::commands::show_cursor_trail_overlay(
            app,
            source_rect_from_capture_viewport(cursor_capture),
            true,
        ) {
            tracing::warn!("cursor trail overlay activation failed: {err}");
        }
    } else {
        crate::commands::teardown_cursor_trail_overlay(app);
    }

    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn is_local_api_base(api_base: &str) -> bool {
    url::Url::parse(api_base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host == "localhost" || host == "127.0.0.1" || host == "::1")
        .unwrap_or(false)
}

/// Convert mach raw delta to nanoseconds via the host timebase.
#[cfg(target_os = "macos")]
fn mach_delta_ns(delta: u64, tb: &cidre::mach::TimeBaseInfo) -> i128 {
    (delta as i128 * tb.numer as i128) / tb.denom as i128
}

/// Inverse of `mach_delta_ns` for microseconds: wall µs → mach ticks.
#[cfg(target_os = "macos")]
fn us_to_mach_delta(us: u64, tb: &cidre::mach::TimeBaseInfo) -> u64 {
    ((us as i128 * 1_000 * tb.denom as i128) / tb.numer as i128) as u64
}

/// Consume any resume-committed pause window by shifting the shared mach
/// anchor forward — every PTS derived from `mach - start_mach` (video,
/// system audio, mic) then continues seamlessly across the pause. Must run
/// before EVERY pts computation in the pump so an audio frame arriving
/// right after resume can't use the unshifted anchor.
///
/// Returns whether a pause window was consumed, i.e. the input streams were
/// just cut and rejoined.
#[cfg(target_os = "macos")]
fn apply_pending_pause_shift(
    pause: &PauseState,
    start_mach: &mut Option<u64>,
    tb: &cidre::mach::TimeBaseInfo,
) -> bool {
    let shift_us = pause.take_pending_shift_us();
    if shift_us > 0 {
        if let Some(anchor) = start_mach.as_mut() {
            *anchor = anchor.saturating_add(us_to_mach_delta(shift_us, tb));
        }
    }
    shift_us > 0
}

/// Live mute: zero the PCM but keep the frame flowing. The mixer paces on
/// its slowest expected source, so dropping mic frames would stall the whole
/// audio pipeline. Returns whether the chunk was muted, so the caller can tell
/// the mixer from the same read of the flag.
#[cfg(target_os = "macos")]
fn apply_live_mic_mute(pause: &PauseState, samples: &mut [f32]) -> bool {
    let muted = pause.is_mic_muted();
    if muted {
        samples.fill(0.0);
    }
    muted
}

#[cfg(target_os = "macos")]
fn report_pump_error(
    tracker: &mut crate::repeat_error::RepeatErrorTracker,
    operation: &str,
    error: &anyhow::Error,
) {
    let message = format!("{operation}: {error:#}");
    match tracker.observe(&message) {
        crate::repeat_error::ErrorReport::First => tracing::error!("{message}"),
        crate::repeat_error::ErrorReport::Repeat(occurrences) => {
            tracing::warn!(
                occurrences,
                error_message = message.as_str(),
                "repeated recording pump error"
            );
        }
        crate::repeat_error::ErrorReport::Suppress => {}
    }
}

#[cfg(target_os = "macos")]
fn video_frame_interval_us(fps: u32) -> i64 {
    (VIDEO_TIME_BASE as i64 / fps.max(1) as i64).max(1)
}

/// Convert + queue one SCK video sample buffer. Anchors `start_mach` on
/// the first call (the first video frame anchors the whole timeline,
/// including audio). Enforces strict monotonicity on the encoder PTS so
/// VideoToolbox doesn't reject reordered frames.
#[cfg(target_os = "macos")]
fn next_video_pts(
    sbuf: &VideoSample,
    tb: &cidre::mach::TimeBaseInfo,
    start_mach: &mut Option<u64>,
    last_pts: &mut i64,
) -> Result<i64> {
    let mach_pts = sbuf.mach_pts();
    let start = *start_mach.get_or_insert(mach_pts);
    let delta = mach_pts.saturating_sub(start);
    let ns = mach_delta_ns(delta, tb);
    let mut pts = (ns / 1000) as i64; // VIDEO_TIME_BASE = 1_000_000
    let _ = VIDEO_TIME_BASE;
    if pts <= *last_pts {
        pts = *last_pts + 1;
    }
    *last_pts = pts;
    Ok(pts)
}

#[cfg(target_os = "macos")]
fn pump_video(
    encoder: &mut Mp4Encoder,
    sbuf: &VideoSample,
    tb: &cidre::mach::TimeBaseInfo,
    start_mach: &mut Option<u64>,
    last_pts: &mut i64,
) -> Result<(i64, ffmpeg::frame::Video)> {
    let pts = next_video_pts(sbuf, tb, start_mach, last_pts)?;
    let frame = sbuf.to_frame(pts)?;
    encoder.queue_video(frame.clone())?;
    Ok((pts, frame))
}

#[cfg(target_os = "macos")]
fn pump_repeated_video_until(
    encoder: &mut Mp4Encoder,
    last_frame: &ffmpeg::frame::Video,
    next_pts: &mut i64,
    target_pts: i64,
    frame_interval_us: i64,
) -> Result<u64> {
    let mut emitted = 0;
    while *next_pts < target_pts {
        let mut frame = last_frame.clone();
        frame.set_pts(Some(*next_pts));
        encoder.queue_video(frame)?;
        *next_pts += frame_interval_us;
        emitted += 1;
    }
    Ok(emitted)
}

// Takes `LiveAudioMixer` / `AudioSignalStats`, both of which are macOS-only,
// and every caller lives in the macOS `start_capture`. The Windows pump has
// its own `WinLiveAudioMixer` + `queue_win_audio` pair.
#[cfg(target_os = "macos")]
fn queue_mixed_audio(
    encoder: &mut Mp4Encoder,
    mixer: &mut LiveAudioMixer,
    frame: ffmpeg::frame::Audio,
    source_stats: &mut AudioSignalStats,
    mixed_stats: &mut AudioSignalStats,
    emitted_frames: &mut u64,
    source_label: &'static str,
) -> Result<()> {
    if source_stats.frames == 0 {
        tracing::info!(
            source = source_label,
            pts = frame.pts(),
            samples = frame.samples(),
            "first audio frame from source"
        );
    }
    source_stats.observe_frame(&frame);
    mixer.push(frame, source_label)?;
    *emitted_frames += mixer.drain_ready(encoder, mixed_stats)?;
    Ok(())
}

/// Convert one SCK system-audio sample buffer. Gated behind the first
/// video frame (`start_mach` must be Some) so the audio PTS shares the
/// same origin as video.
#[cfg(target_os = "macos")]
fn system_audio_frame(
    sbuf: &crate::capture::macos::SampleBuf,
    tb: &cidre::mach::TimeBaseInfo,
    start_mach: Option<u64>,
    last_pts: &mut i64,
) -> Result<Option<ffmpeg::frame::Audio>> {
    use cidre::cm;
    let Some(start) = start_mach else {
        // Drop pre-video audio (≤200 ms typical) — keeps audio anchored
        // to the same wall-clock origin as video.
        return Ok(None);
    };
    let mach_pts = cm::Clock::convert_host_time_to_sys_units(sbuf.0.pts());
    let delta = mach_pts.saturating_sub(start);
    let ns = mach_delta_ns(delta, tb);
    let mut pts = ((ns * SAMPLE_RATE as i128) / 1_000_000_000i128) as i64;
    if pts < 0 {
        pts = 0;
    }
    let num_samples = sbuf.0.num_samples().max(1) as i64;
    if pts <= *last_pts {
        pts = (*last_pts + 1).max(0);
    }
    *last_pts = pts + num_samples - 1;
    let frame = cm_audio_to_frame(&sbuf.0, pts)?;
    Ok(Some(frame))
}

/// Convert one cpal mic chunk into the encoder's canonical planar f32
/// stereo @48 kHz format. `chunk.mach_pts` is the HAL capture time of the
/// chunk's first sample (latency-compensated in `capture::audio`), anchored
/// to the same `start_mach` origin as video and system audio so all three
/// streams land on a shared timeline; `MicTimeline` then places it.
#[cfg(target_os = "macos")]
fn mic_audio_frame(
    chunk: &AudioPcmF32,
    tb: &cidre::mach::TimeBaseInfo,
    start_mach: Option<u64>,
    timeline: &mut MicTimeline,
    channel_selector: &mut MicChannelSelector,
    resampler: &mut Option<MicResampler>,
) -> Result<Option<ffmpeg::frame::Audio>> {
    let Some(start) = start_mach else {
        return Ok(None);
    };
    if chunk.samples.is_empty() || chunk.channels == 0 || chunk.sample_rate == 0 {
        return Ok(None);
    }

    let input_channels = chunk.channels as usize;
    let input_frames = chunk.samples.len() / input_channels;
    if input_frames == 0 {
        return Ok(None);
    }

    let src_channel =
        channel_selector.select_for_generation(&chunk.samples, input_channels, chunk.generation);
    let microphone = chunk
        .samples
        .chunks_exact(input_channels)
        .map(|frame| {
            let sample = frame[src_channel];
            if sample.is_finite() {
                sample
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();

    let microphone = if chunk.sample_rate == SAMPLE_RATE as u32 {
        microphone
    } else {
        let needs_rebuild = resampler
            .as_ref()
            .is_none_or(|current| !current.matches(chunk.sample_rate, chunk.generation));
        if needs_rebuild {
            *resampler = Some(MicResampler::new(chunk.sample_rate, chunk.generation)?);
        }
        resampler
            .as_mut()
            .ok_or_else(|| anyhow!("microphone resampler is unavailable"))?
            .resample(&microphone)?
    };
    let output_samples = microphone.len();
    if output_samples == 0 {
        return Ok(None);
    }

    // Signed: with latency compensation the first chunks can legitimately
    // predate the video anchor, and that part must be cut, not shifted.
    let ns = if chunk.mach_pts >= start {
        mach_delta_ns(chunk.mach_pts - start, tb)
    } else {
        -mach_delta_ns(start - chunk.mach_pts, tb)
    };
    let raw_pts = ((ns * SAMPLE_RATE as i128) / 1_000_000_000i128) as i64;
    let Some(placement) = timeline.place(raw_pts, output_samples, chunk.generation) else {
        return Ok(None);
    };
    let emitted = output_samples - placement.skip;

    let mut frame = ffmpeg::frame::Audio::new(
        ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
        emitted,
        ffmpeg::ChannelLayout::STEREO,
    );
    frame.set_rate(SAMPLE_RATE as u32);

    for out_channel in 0..AUDIO_CHANNELS as usize {
        let dst = frame.plane_mut::<f32>(out_channel);
        dst[..emitted].copy_from_slice(&microphone[placement.skip..]);
    }

    frame.set_pts(Some(placement.pts));
    Ok(Some(frame))
}

#[cfg(target_os = "macos")]
struct MicResampler {
    context: ffmpeg::software::resampling::Context,
    source_rate: u32,
    generation: MicStreamGeneration,
}

#[cfg(target_os = "macos")]
impl MicResampler {
    fn new(source_rate: u32, generation: MicStreamGeneration) -> Result<Self> {
        let context = ffmpeg::software::resampler(
            (
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                ffmpeg::ChannelLayout::MONO,
                source_rate,
            ),
            (
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                ffmpeg::ChannelLayout::MONO,
                SAMPLE_RATE as u32,
            ),
        )
        .map_err(|error| anyhow!("create microphone resampler: {error:?}"))?;
        Ok(Self {
            context,
            source_rate,
            generation,
        })
    }

    fn matches(&self, source_rate: u32, generation: MicStreamGeneration) -> bool {
        self.source_rate == source_rate && self.generation == generation
    }

    fn resample(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        let mut input = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            samples.len(),
            ffmpeg::ChannelLayout::MONO,
        );
        input.set_rate(self.source_rate);
        input.plane_mut::<f32>(0).copy_from_slice(samples);

        let pending_samples = self
            .context
            .delay()
            .map(|delay| delay.output.max(0) as u64)
            .unwrap_or(0);
        let converted_samples = (samples.len() as u64)
            .saturating_mul(SAMPLE_RATE as u64)
            .div_ceil(self.source_rate.max(1) as u64);
        let capacity = pending_samples
            .saturating_add(converted_samples)
            .saturating_add(16)
            .min(i32::MAX as u64) as usize;
        let mut output = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
            capacity,
            ffmpeg::ChannelLayout::MONO,
        );
        output.set_rate(SAMPLE_RATE as u32);
        self.context
            .run(&input, &mut output)
            .map_err(|error| anyhow!("resample microphone audio: {error:?}"))?;
        Ok(output.plane::<f32>(0).to_vec())
    }
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct MicChannelSelector {
    generation: Option<MicStreamGeneration>,
    channels: usize,
    signal_frames: usize,
    energy: Vec<f64>,
    selected: Option<usize>,
    last_chunk_channel: Option<usize>,
}

#[cfg(target_os = "macos")]
impl MicChannelSelector {
    fn select_for_generation(
        &mut self,
        samples: &[f32],
        channels: usize,
        generation: MicStreamGeneration,
    ) -> usize {
        if self.generation != Some(generation) {
            *self = Self {
                generation: Some(generation),
                ..Self::default()
            };
        }
        self.select(samples, channels)
    }

    fn select(&mut self, samples: &[f32], channels: usize) -> usize {
        if self.channels != channels {
            self.channels = channels;
            self.signal_frames = 0;
            self.energy = vec![0.0; channels];
            self.selected = None;
            self.last_chunk_channel = None;
        }
        if let Some(selected) = self.selected {
            return selected;
        }

        let frames = samples.len() / channels;
        let mut chunk_energy = vec![0.0_f64; channels];
        for frame in samples.chunks_exact(channels) {
            for (channel, sample) in frame.iter().enumerate() {
                if sample.is_finite() {
                    chunk_energy[channel] += (*sample as f64).powi(2);
                }
            }
        }
        let strongest = chunk_energy
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .map_or(0, |(channel, _)| channel);
        let selected_energy = self
            .last_chunk_channel
            .and_then(|channel| chunk_energy.get(channel))
            .copied()
            .unwrap_or(0.0);
        let chunk_channel = if chunk_energy[strongest] > selected_energy * 4.0 {
            strongest
        } else {
            self.last_chunk_channel.unwrap_or(strongest)
        };
        self.last_chunk_channel = Some(chunk_channel);
        let strongest_rms = (chunk_energy[strongest] / frames.max(1) as f64).sqrt() as f32;
        if strongest_rms > MIC_CHANNEL_SIGNAL_RMS {
            for (total, current) in self.energy.iter_mut().zip(chunk_energy) {
                *total += current;
            }
            self.signal_frames += frames;
            if self.signal_frames >= (SAMPLE_RATE as usize / 10) {
                self.selected = self
                    .energy
                    .iter()
                    .enumerate()
                    .max_by(|(_, left), (_, right)| left.total_cmp(right))
                    .map(|(channel, _)| channel);
            }
        }
        self.selected.unwrap_or(chunk_channel)
    }
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct AudioSignalStats {
    frames: u64,
    samples: u64,
    peak_abs: f32,
}

#[cfg(target_os = "macos")]
impl AudioSignalStats {
    fn observe_frame(&mut self, frame: &ffmpeg::frame::Audio) {
        self.frames += 1;
        self.samples += frame.samples() as u64;
        for channel in 0..frame.planes() {
            for sample in frame.plane::<f32>(channel).iter().take(frame.samples()) {
                self.peak_abs = self.peak_abs.max(sample.abs());
            }
        }
    }

    fn peak_dbfs(&self) -> f32 {
        if self.peak_abs <= 0.0 {
            -120.0
        } else {
            20.0 * self.peak_abs.log10()
        }
    }

    fn is_effectively_silent(&self) -> bool {
        self.frames > 0 && self.peak_abs < 0.000_1
    }
}

#[cfg(target_os = "macos")]
struct LiveAudioMixer {
    buffer_start_pts: Option<i64>,
    last_emitted_end_pts: i64,
    sources: Vec<AudioSourceProgress>,
    mic_generation: Option<MicStreamGeneration>,
    /// Present only when the user turned "Reduce background noise" on AND a
    /// microphone lane exists. See `crate::denoise`.
    mic_denoiser: Option<crate::denoise::NoiseSuppressor>,
    /// Buffer positions, in order, where the microphone changed generation.
    ///
    /// The filter is reset when `pop_frame` REACHES one of these, not when the
    /// chunk carrying the new generation arrives. Those are five seconds apart:
    /// the mixer holds `LATENCY_SAMPLES` of aligned PCM, so at the moment a new
    /// device's first chunk is received the buffer is still full of the old
    /// device's audio. Resetting there cleared a converged estimate and then
    /// let those very samples retrain it — the estimator's window is 1.4 s, so
    /// five seconds of them retrain it completely — leaving the new microphone
    /// filtered with the old one's noise profile and no reset left to fix it.
    mic_reset_pts: VecDeque<i64>,
    /// Set when the generation advances, consumed by the next microphone
    /// `push`, which is where that boundary's position is known.
    mic_generation_boundary_pending: bool,
    /// Buffer positions where the microphone input was cut because the pump
    /// dropped chunks while paused. The pause shift closes that gap on the
    /// timeline, so the filter would otherwise play its last `LATENCY_SAMPLES`
    /// of pre-pause audio straight after the resume. Placed in the buffer for
    /// the same reason as `mic_reset_pts`.
    mic_cut_pts: VecDeque<i64>,
    /// Set by `note_mic_cut`, consumed by the next microphone `push`.
    mic_cut_pending: bool,
    /// Live mute, as last reported by the pump. Read by `push`.
    mic_muted: bool,
    /// Buffer ranges whose microphone audio was muted. The pump zeroes muted
    /// PCM before it gets here, but the filter still holds `LATENCY_SAMPLES`
    /// of speech from before the mute and would emit it over the first ~21 ms
    /// of the mute, so `pop_frame` zeroes the filtered output again here.
    mic_muted_ranges: VecDeque<std::ops::Range<i64>>,
    limiter_gain: f32,
    dropped_stale_frames: u64,
    peak_buffered_samples: usize,
    laggard_bypass_calls: u64,
}

#[cfg(target_os = "macos")]
struct AudioSourceProgress {
    label: &'static str,
    latest_seen_end_pts: Option<i64>,
    channels: Vec<VecDeque<f32>>,
}

#[cfg(target_os = "macos")]
impl LiveAudioMixer {
    // macOS capture sources do not begin delivering buffers at the same
    // time: ScreenCaptureKit can hand us a short burst of system-audio
    // buffers while cpal is still draining queued mic callbacks. If we
    // emit mixed audio after only ~100 ms, `buffer_start_pts` advances
    // before those valid mic frames arrive and the mixer has to drop
    // them as stale. Five seconds is still a small buffer (~2 MB per
    // stereo f32 channel) and gives startup/back-pressure bursts enough
    // room without affecting the finalized file's A/V timeline.
    const LATENCY_SAMPLES: i64 = SAMPLE_RATE as i64 * 5;
    const STARTUP_GRACE_SAMPLES: i64 = SAMPLE_RATE as i64 * 10;
    const MAX_SOURCE_LAG_SAMPLES: i64 = SAMPLE_RATE as i64 * 10;
    // Keep the existing 80 ms drain cadence and limiter release timing.
    const DRAIN_CHUNK_SAMPLES: usize = 3_840;

    fn new(expected_sources: impl IntoIterator<Item = &'static str>) -> Result<Self> {
        let mut sources = expected_sources
            .into_iter()
            .map(|label| AudioSourceProgress {
                label,
                latest_seen_end_pts: None,
                channels: vec![VecDeque::new(); AUDIO_CHANNELS as usize],
            })
            .collect::<Vec<_>>();
        if sources.is_empty() {
            sources.push(AudioSourceProgress {
                label: "audio",
                latest_seen_end_pts: None,
                channels: vec![VecDeque::new(); AUDIO_CHANNELS as usize],
            });
        }
        Ok(Self {
            buffer_start_pts: None,
            last_emitted_end_pts: 0,
            sources,
            mic_generation: None,
            mic_denoiser: None,
            mic_reset_pts: VecDeque::new(),
            mic_generation_boundary_pending: false,
            mic_cut_pts: VecDeque::new(),
            mic_cut_pending: false,
            mic_muted: false,
            mic_muted_ranges: VecDeque::new(),
            limiter_gain: 1.0,
            dropped_stale_frames: 0,
            peak_buffered_samples: 0,
            laggard_bypass_calls: 0,
        })
    }

    /// Turns the microphone noise filter on for this recording.
    ///
    /// A no-op when there is no microphone lane: system audio is the machine's
    /// own output, not a room, so there is nothing there for a room-noise
    /// estimator to find and no reason to spend a transform per frame looking.
    fn with_noise_suppression(mut self, enabled: bool) -> Self {
        let has_mic = self.sources.iter().any(|source| source.label == "mic");
        self.mic_denoiser = (enabled && has_mic).then(crate::denoise::NoiseSuppressor::new);
        if self.mic_denoiser.is_some() {
            // Logged because it is the one setting that changes what the
            // microphone sounds like, so a recording that comes back odd needs
            // to say whether the filter was in the path and what it cost.
            tracing::info!(
                latency_samples = crate::denoise::LATENCY_SAMPLES,
                "microphone noise reduction enabled for this recording"
            );
        }
        self
    }

    fn begin_mic_generation(&mut self, generation: MicStreamGeneration) -> bool {
        if let Some(current) = self.mic_generation {
            if generation < current {
                return false;
            }
            if generation == current {
                return true;
            }
        }
        // A new generation is a different microphone, or the same one reopened
        // after a disconnect. Either way the room it hears is not the room the
        // estimate was built from, so the filter starts again rather than
        // attenuating the new device at the old device's frequencies — but at
        // the boundary in the buffer, not here. See `mic_reset_pts`.
        if self.mic_generation.is_some() && self.mic_denoiser.is_some() {
            self.mic_generation_boundary_pending = true;
        }
        self.mic_generation = Some(generation);
        true
    }

    /// The pump dropped a microphone chunk because recording is paused.
    fn note_mic_cut(&mut self) {
        if self.mic_denoiser.is_some() {
            self.mic_cut_pending = true;
        }
    }

    /// Whether the microphone frames pushed from now on are muted.
    fn set_mic_muted(&mut self, muted: bool) {
        self.mic_muted = muted;
    }

    fn push(&mut self, frame: ffmpeg::frame::Audio, source_label: &'static str) -> Result<()> {
        if frame.samples() == 0 {
            return Ok(());
        }
        validate_mix_frame(&frame)?;

        let pts = frame
            .pts()
            .ok_or_else(|| anyhow!("mixed audio frame missing pts"))?;
        let frame_end = pts + frame.samples() as i64;
        self.mark_source_seen(source_label, frame_end);

        let start = match self.buffer_start_pts {
            Some(start) => start,
            None => {
                self.buffer_start_pts = Some(pts);
                pts
            }
        };

        if frame_end <= start {
            self.dropped_stale_frames += 1;
            if self.dropped_stale_frames == 1 || self.dropped_stale_frames.is_power_of_two() {
                tracing::debug!(
                    source = source_label,
                    pts,
                    start,
                    frame_end,
                    samples = frame.samples(),
                    dropped_stale_frames = self.dropped_stale_frames,
                    "audio mixer dropped stale frame behind emitted buffer"
                );
            }
            return Ok(());
        }

        let skip = if pts < start {
            usize::try_from(start - pts).map_err(|_| anyhow!("audio mixer overlap is too large"))?
        } else {
            0
        };
        let offset = if pts > start {
            usize::try_from(pts - start).map_err(|_| anyhow!("audio mixer gap is too large"))?
        } else {
            0
        };
        let samples_to_mix = frame.samples() - skip;
        self.ensure_len(offset + samples_to_mix);

        // Record where the new microphone's audio actually begins, now that the
        // frame has survived the stale check and its position is known. A
        // dropped frame leaves the boundary pending so the next one carries it,
        // rather than losing the reset entirely.
        if source_label == "mic" && self.mic_generation_boundary_pending {
            self.mic_generation_boundary_pending = false;
            self.mic_reset_pts.push_back(pts + skip as i64);
        }
        if source_label == "mic" && self.mic_cut_pending {
            self.mic_cut_pending = false;
            self.mic_cut_pts.push_back(pts + skip as i64);
        }
        if source_label == "mic" && self.mic_muted && self.mic_denoiser.is_some() {
            let range = pts + skip as i64..frame_end;
            match self.mic_muted_ranges.back_mut() {
                Some(last) if last.end >= range.start && last.start <= range.start => {
                    last.end = last.end.max(range.end);
                }
                _ => self.mic_muted_ranges.push_back(range),
            }
        }

        let source = self
            .sources
            .iter_mut()
            .find(|source| source.label == source_label)
            .ok_or_else(|| anyhow!("audio mixer lost source buffer for {source_label}"))?;
        for channel in 0..source.channels.len() {
            let plane = frame.plane::<f32>(channel);
            for (sample_idx, sample) in plane[skip..].iter().take(samples_to_mix).enumerate() {
                let dst = &mut source.channels[channel][offset + sample_idx];
                *dst = (*dst + *sample).clamp(-1.0, 1.0);
            }
        }
        Ok(())
    }

    fn mark_source_seen(&mut self, label: &'static str, frame_end: i64) {
        if let Some(source) = self.sources.iter_mut().find(|source| source.label == label) {
            source.latest_seen_end_pts = Some(
                source
                    .latest_seen_end_pts
                    .map_or(frame_end, |end| end.max(frame_end)),
            );
            return;
        }
        self.sources.push(AudioSourceProgress {
            label,
            latest_seen_end_pts: Some(frame_end),
            channels: vec![
                VecDeque::from(vec![0.0; self.buffered_samples()]);
                AUDIO_CHANNELS as usize
            ],
        });
    }

    fn ready_until_pts(&self, start: i64) -> Option<i64> {
        let max_seen = self
            .sources
            .iter()
            .filter_map(|source| source.latest_seen_end_pts)
            .max()?;
        // Two distinct questions, and conflating them regressed startup:
        //  - "has every source delivered anything yet?" gates the grace window
        //  - "is every source still keeping up?" chooses how we pick sync_end
        // A source that has started but fallen far behind must NOT re-open the
        // grace gate; during startup that would hold the buffer instead of
        // draining it, which is the opposite of what this bound is for.
        let all_sources_started = self
            .sources
            .iter()
            .all(|source| source.latest_seen_end_pts.is_some());
        if !all_sources_started && max_seen - start <= Self::STARTUP_GRACE_SAMPLES {
            return None;
        }
        // A source that died mid-recording keeps `latest_seen_end_pts` frozen
        // forever. Taking min() across sources would then pin `sync_end` at
        // that frozen value and the mixed PCM buffer would grow for the rest
        // of the recording, so a source lagging past MAX_SOURCE_LAG_SAMPLES is
        // bypassed instead. An explicitly-selected mic that is unplugged
        // mid-recording is exactly this case: it stops delivering buffers and
        // the healthy lane must keep draining, with the stalled lane read as
        // silence.
        let all_sources_current = self.sources.iter().all(|source| {
            source
                .latest_seen_end_pts
                .is_some_and(|end| max_seen - end <= Self::MAX_SOURCE_LAG_SAMPLES)
        });
        let sync_end = if all_sources_current {
            self.sources
                .iter()
                .filter_map(|source| source.latest_seen_end_pts)
                .min()
                .unwrap_or(max_seen)
        } else {
            max_seen - Self::STARTUP_GRACE_SAMPLES
        };
        Some(sync_end - Self::LATENCY_SAMPLES)
    }

    fn drain_ready(
        &mut self,
        encoder: &mut Mp4Encoder,
        mixed_stats: &mut AudioSignalStats,
    ) -> Result<u64> {
        let Some(start) = self.buffer_start_pts else {
            return Ok(0);
        };
        let lagging_sources = self.lagging_source_count(start);
        if lagging_sources > 0 {
            self.laggard_bypass_calls = self.laggard_bypass_calls.saturating_add(1);
            if self.laggard_bypass_calls == 1 || self.laggard_bypass_calls.is_power_of_two() {
                tracing::warn!(
                    lagging_sources,
                    laggard_bypass_calls = self.laggard_bypass_calls,
                    max_source_lag_samples = Self::MAX_SOURCE_LAG_SAMPLES,
                    "audio mixer bypassed a lagging capture source to keep memory bounded"
                );
            }
        }
        let Some(ready_until) = self.ready_until_pts(start) else {
            return Ok(0);
        };
        if ready_until <= start {
            return Ok(0);
        }
        let ready_samples = usize::try_from(ready_until - start)
            .unwrap_or(usize::MAX)
            .min(self.buffered_samples());

        let mut emitted = 0;
        let mut remaining_ready = ready_samples;
        while remaining_ready >= Self::DRAIN_CHUNK_SAMPLES {
            let frame = self.pop_frame(Self::DRAIN_CHUNK_SAMPLES)?;
            self.emit(encoder, mixed_stats, frame)?;
            emitted += 1;
            remaining_ready -= Self::DRAIN_CHUNK_SAMPLES;
        }
        Ok(emitted)
    }

    fn flush(
        &mut self,
        encoder: &mut Mp4Encoder,
        mixed_stats: &mut AudioSignalStats,
    ) -> Result<u64> {
        let mut emitted = 0;
        while self.buffered_samples() > Self::DRAIN_CHUNK_SAMPLES {
            let frame = self.pop_frame(Self::DRAIN_CHUNK_SAMPLES)?;
            self.emit(encoder, mixed_stats, frame)?;
            emitted += 1;
        }
        if self.buffered_samples() > 0 {
            let samples = self.buffered_samples().min(Self::DRAIN_CHUNK_SAMPLES);
            let frame = self.pop_frame(samples)?;
            self.emit(encoder, mixed_stats, frame)?;
            emitted += 1;
        }
        Ok(emitted)
    }

    fn flush_through(
        &mut self,
        encoder: &mut Mp4Encoder,
        mixed_stats: &mut AudioSignalStats,
        target_end_pts: i64,
    ) -> Result<u64> {
        let mut emitted = self.flush(encoder, mixed_stats)?;
        while self.last_emitted_end_pts < target_end_pts {
            let remaining =
                usize::try_from(target_end_pts - self.last_emitted_end_pts).unwrap_or(usize::MAX);
            let samples = remaining.min(Self::DRAIN_CHUNK_SAMPLES);
            let mut frame = ffmpeg::frame::Audio::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                samples,
                ffmpeg::ChannelLayout::STEREO,
            );
            frame.set_rate(SAMPLE_RATE as u32);
            frame.set_pts(Some(self.last_emitted_end_pts));
            for channel in 0..AUDIO_CHANNELS as usize {
                frame.plane_mut::<f32>(channel).fill(0.0);
            }
            self.emit(encoder, mixed_stats, frame)?;
            self.last_emitted_end_pts += samples as i64;
            emitted += 1;
        }
        Ok(emitted)
    }

    fn ensure_len(&mut self, len: usize) {
        for source in &mut self.sources {
            for channel in &mut source.channels {
                while channel.len() < len {
                    channel.push_back(0.0);
                }
            }
        }
        self.peak_buffered_samples = self.peak_buffered_samples.max(len);
    }

    fn lagging_source_count(&self, start: i64) -> usize {
        let Some(max_seen) = self
            .sources
            .iter()
            .filter_map(|source| source.latest_seen_end_pts)
            .max()
        else {
            return 0;
        };
        if max_seen - start <= Self::STARTUP_GRACE_SAMPLES {
            return 0;
        }
        self.sources
            .iter()
            .filter(|source| {
                source
                    .latest_seen_end_pts
                    .map_or(true, |end| max_seen - end > Self::MAX_SOURCE_LAG_SAMPLES)
            })
            .count()
    }

    fn buffered_samples(&self) -> usize {
        self.sources
            .first()
            .and_then(|source| source.channels.first())
            .map_or(0, VecDeque::len)
    }

    /// Hands one mixed frame to the encoder, and to Local mode's live
    /// transcription when it is running. This is the only place mixed audio
    /// leaves the mixer, so it is the only tap: what Speech hears is exactly
    /// what the MP4 gets — mic plus system audio, after denoise and mute.
    /// Tapping the microphone chunk alone would silently lose every word that
    /// came through system audio on a call or a demo, which is the default
    /// configuration. `push` never blocks the pump.
    fn emit(
        &mut self,
        encoder: &mut Mp4Encoder,
        mixed_stats: &mut AudioSignalStats,
        frame: ffmpeg::frame::Audio,
    ) -> Result<()> {
        if crate::local::live_stt::is_active() {
            if let Some(pts) = frame.pts() {
                let left = frame.plane::<f32>(0);
                let right = frame.plane::<f32>(1);
                let mono: Vec<f32> = left
                    .iter()
                    .zip(right)
                    .map(|(l, r)| (l + r) * 0.5)
                    .collect();
                let recording_ms = pts.max(0) as u64 * 1000 / SAMPLE_RATE as u64;
                crate::local::live_stt::push(&mono, SAMPLE_RATE as u32, 1, recording_ms);
            }
        }
        mixed_stats.observe_frame(&frame);
        encoder.queue_audio(frame)
    }

    fn pop_frame(&mut self, samples: usize) -> Result<ffmpeg::frame::Audio> {
        let pts = self
            .buffer_start_pts
            .ok_or_else(|| anyhow!("audio mixer has no buffer start"))?;
        let mut system = vec![vec![0.0; samples]; AUDIO_CHANNELS as usize];
        let mut microphone = vec![0.0; samples];

        for source in &mut self.sources {
            for sample_idx in 0..samples {
                let left = source.channels[0].pop_front().unwrap_or(0.0);
                let right = source.channels[1].pop_front().unwrap_or(0.0);
                match source.label {
                    "mic" => microphone[sample_idx] += (left + right) * 0.5,
                    _ => {
                        system[0][sample_idx] += left;
                        system[1][sample_idx] += right;
                    }
                }
            }
        }

        // The microphone is filtered here, on its own mono lane, before it
        // meets system audio. Two reasons it has to be at this point and not
        // on the finished mix: the filter learns a steady room, and the
        // machine's own output is neither steady nor a room; and it must never
        // touch what the user's speakers played, which is somebody else's
        // recording. The lane is summed at unity gain immediately below, so
        // this stage can only ever subtract.
        // Generation boundaries and pause cuts are applied at their exact
        // sample, splitting the block there: the filter delays the lane by
        // `LATENCY_SAMPLES`, so waiting for the next block would let the audio
        // from before a cut out after it. Crossing two generation boundaries
        // at once is an unplug and replug inside one buffer, and one reset
        // serves both: what matters is that the estimator is empty when the
        // newest device's audio arrives, not how many times it was emptied.
        let end = pts + samples as i64;
        if let Some(denoiser) = self.mic_denoiser.as_mut() {
            let mut filtered = 0;
            loop {
                let reset = self.mic_reset_pts.front().copied().filter(|at| *at < end);
                let cut = self.mic_cut_pts.front().copied().filter(|at| *at < end);
                let (at, is_reset) = match (reset, cut) {
                    (Some(r), Some(c)) if c < r => (c, false),
                    (Some(r), _) => (r, true),
                    (None, Some(c)) => (c, false),
                    (None, None) => break,
                };
                let split = usize::try_from(at - pts)
                    .unwrap_or(0)
                    .clamp(filtered, samples);
                denoiser.process(&mut microphone[filtered..split]);
                filtered = split;
                if is_reset {
                    self.mic_reset_pts.pop_front();
                    denoiser.reset();
                } else {
                    self.mic_cut_pts.pop_front();
                    // Keeps the learned room: a pause does not change it.
                    denoiser.discard_buffered();
                }
            }
            denoiser.process(&mut microphone[filtered..]);

            // Run on the zeroed input so the filter's history stays
            // continuous, then silence what it emits for the muted span.
            for range in &self.mic_muted_ranges {
                let from = usize::try_from(range.start - pts).unwrap_or(0).min(samples);
                let to = usize::try_from(range.end - pts).unwrap_or(0).min(samples);
                if from < to {
                    microphone[from..to].fill(0.0);
                }
            }
            self.mic_muted_ranges.retain(|range| range.end > end);
        }

        let mut mixed = vec![vec![0.0; samples]; AUDIO_CHANNELS as usize];
        let mut peak = 0.0_f32;
        for channel in 0..AUDIO_CHANNELS as usize {
            for index in 0..samples {
                let sample = system[channel][index] + microphone[index];
                mixed[channel][index] = sample;
                peak = peak.max(sample.abs());
            }
        }
        // Peak limiter. Attack is instantaneous and flat across the block;
        // release is ramped per sample.
        //
        // Attack must not ramp: we have no look-ahead, so easing INTO a
        // reduction would leave the early samples of the block — which is where
        // the transient can be — above the ceiling and relying on the clamp,
        // i.e. clipping. Dropping straight to `required_gain` for the whole
        // block is the safe direction and is what limiters do anyway.
        //
        // Release must ramp: a block is 80 ms, so stepping the gain up at each
        // boundary is what makes recovery audible as pumping/zipper. Every
        // value on the ramp is <= `required_gain`, so ramping up cannot
        // overshoot the ceiling either.
        let required_gain = if peak > 0.98 { 0.98 / peak } else { 1.0 };
        let attacking = required_gain < self.limiter_gain;
        let start_gain = if attacking {
            required_gain
        } else {
            self.limiter_gain
        };
        // +0.05 per 80 ms block ≈ 1.6 s from fully ducked back to unity.
        let target_gain = if attacking {
            required_gain
        } else {
            required_gain.min(self.limiter_gain + LIMITER_RELEASE_PER_BLOCK)
        };

        let mut out = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
            samples,
            ffmpeg::ChannelLayout::STEREO,
        );
        out.set_rate(SAMPLE_RATE as u32);
        out.set_pts(Some(pts));

        let step = if samples > 1 {
            (target_gain - start_gain) / (samples - 1) as f32
        } else {
            0.0
        };
        for channel in 0..AUDIO_CHANNELS as usize {
            let dst = out.plane_mut::<f32>(channel);
            for (index, (sample, mixed_sample)) in dst
                .iter_mut()
                .take(samples)
                .zip(&mixed[channel])
                .enumerate()
            {
                let gain = start_gain + step * index as f32;
                *sample = (*mixed_sample * gain).clamp(-1.0, 1.0);
            }
        }
        self.limiter_gain = target_gain;
        self.last_emitted_end_pts = pts + samples as i64;

        if self.buffered_samples() == 0 {
            self.buffer_start_pts = None;
        } else {
            self.buffer_start_pts = Some(pts + samples as i64);
        }

        Ok(out)
    }
}

#[cfg(target_os = "macos")]
fn validate_mix_frame(frame: &ffmpeg::frame::Audio) -> Result<()> {
    let expected_format = ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar);
    if frame.format() != expected_format {
        bail!(
            "audio mixer frame format mismatch: got {:?}, expected {:?}",
            frame.format(),
            expected_format
        );
    }
    if frame.rate() != SAMPLE_RATE as u32 {
        bail!(
            "audio mixer frame sample rate mismatch: got {}, expected {}",
            frame.rate(),
            SAMPLE_RATE
        );
    }
    if frame.channel_layout() != ffmpeg::ChannelLayout::STEREO
        || frame.channels() != AUDIO_CHANNELS
        || frame.planes() != AUDIO_CHANNELS as usize
    {
        bail!(
            "audio mixer channel layout mismatch: layout={:?} channels={} planes={}",
            frame.channel_layout(),
            frame.channels(),
            frame.planes()
        );
    }
    Ok(())
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
async fn start_capture<R: Runtime>(
    _app: &AppHandle<R>,
    _api_base: &str,
    _bearer: &str,
    _recording_id: &RecordingId,
    _file_path: &std::path::Path,
    _active_slot: &Arc<Mutex<Option<ActiveRecording>>>,
    _source: Option<&CaptureSourceDto>,
    _audio: &AudioOptionsDto,
    _video: &VideoOptionsDto,
    _webcam: Option<WebcamCaptureDto>,
    _capture_source: Option<CaptureSourceMetadataDto>,
    _state: &Arc<Mutex<RecordingStateDto>>,
    _mode: crate::types::RecordingMode,
) -> Result<()> {
    Err(anyhow!(
        "screen capture is only implemented for macOS and Windows"
    ))
}

// ===========================================================================
// Windows recording pump
// ===========================================================================
//
// Direct analog of the macOS `start_capture`: opens the WGC screen
// capture + cpal mic + cpal loopback, opens the Mp4Encoder (libx264 on
// Windows), spins up the streaming uploader, and spawns a tokio task
// that drains the three capture channels into the encoder until the
// shutdown_tx fires.
//
// PTS arithmetic is anchored to `handles.started_at` (the first WGC
// frame's `Instant`). Both video and audio chunks carry their own
// `captured_at: Instant`, which we subtract from the anchor to compute
// the encoder's native PTS:
//   video PTS = (captured_at - anchor).as_micros()           // VIDEO_TIME_BASE
//   audio PTS = (captured_at - anchor).sub_sec_samples_at(48k)

#[cfg(target_os = "windows")]
const WINDOWS_MIC_START_FAILED: &str = "Clipy could not start your microphone, so this \
     recording has no mic audio. Open Settings > Privacy & security > Microphone and allow \
     desktop apps to use it, or choose another microphone.";

/// Live warnings for a mic that opened but records nothing. Same opening as
/// the macOS mic-silence warning (`notifications.micSilent`), with the Windows places to look.
#[cfg(target_os = "windows")]
const WINDOWS_MIC_SILENT: &str = "No microphone input detected. Check that your mic is not \
     muted and is allowed in Settings > Privacy & security > Microphone, or choose another input.";
#[cfg(target_os = "windows")]
const WINDOWS_MIC_STOPPED: &str = "No microphone input detected. Your mic stopped sending \
     audio. Check that it is connected, or choose another input.";

#[cfg(target_os = "windows")]
fn windows_mic_silence_message(
    reason: crate::capture::mic_silence::MicSilenceReason,
) -> &'static str {
    match reason {
        crate::capture::mic_silence::MicSilenceReason::DigitalSilence => WINDOWS_MIC_SILENT,
        crate::capture::mic_silence::MicSilenceReason::NoChunks => WINDOWS_MIC_STOPPED,
    }
}

/// A short, PII-free reason the Windows mic did not start, for diagnostics.
/// Never the device name or the OS error text.
#[cfg(target_os = "windows")]
fn windows_mic_error_code(err: &anyhow::Error) -> &'static str {
    use crate::windows_privacy::{status, Capability};
    if status(Capability::Microphone) == crate::commands::PermissionStatusDto::Denied {
        return "privacy_denied";
    }
    let message = format!("{err:#}");
    if message.contains("requested mic device not found") {
        "device_not_found"
    } else if message.contains("no default input device") {
        "no_input_device"
    } else {
        "start_failed"
    }
}

#[cfg(target_os = "windows")]
async fn start_capture<R: Runtime>(
    app: &AppHandle<R>,
    api_base: &str,
    bearer: &str,
    recording_id: &RecordingId,
    file_path: &std::path::Path,
    active_slot: &Arc<Mutex<Option<ActiveRecording>>>,
    source: Option<&CaptureSourceDto>,
    audio: &AudioOptionsDto,
    video: &VideoOptionsDto,
    webcam: Option<WebcamCaptureDto>,
    capture_source: Option<CaptureSourceMetadataDto>,
    state: &Arc<Mutex<RecordingStateDto>>,
    mode: crate::types::RecordingMode,
) -> Result<()> {
    const FPS: u32 = 30;

    // Camera-only records the camera itself, not the screen.
    let (screen, handles) = match source {
        Some(CaptureSourceDto::Camera { device_id }) => {
            crate::capture::windows_camera::start(app, device_id, video.max_height)
                .await
                .map_err(|e| {
                    CaptureFailure::tag(
                        "camera_start_failed",
                        e.context("start Windows camera capture"),
                    )
                })?
        }
        _ => WinScreenCapturer::start(FPS, source, video.max_height)
            .await
            .map_err(|e| {
                CaptureFailure::tag(
                    "screen_capture_failed",
                    e.context("start Windows screen capture"),
                )
            })?,
    };
    let WinScreenCaptureHandles {
        mut video_rx,
        width,
        height,
        crop,
        capture: cursor_capture,
        started_at: capture_anchor,
    } = handles;

    crate::mic_monitor::stop_and_wait().await;
    let (mic, mic_rx, mic_error) = if audio.include_mic {
        // Supervised: rebuilt mid-take when the stream errors, the device
        // leaves and returns, or Windows feeds it zeros after microphone
        // access was turned off and on (beta 1.1.81). The supervisor runs
        // even when the first open fails, so allowing access or plugging the
        // mic in during the take brings the audio in. Its first open waits
        // on a thread, so it runs off the async runtime.
        let device_id = audio.mic_device_id.clone();
        let started = tokio::task::spawn_blocking(move || {
            WinMicSupervisor::start(device_id.as_deref())
        })
        .await
        .map_err(|err| anyhow!("mic supervisor start task failed: {err}"))
        .and_then(|started| started);
        match started {
            Ok((m, rx, None)) => (Some(m), Some(rx), None),
            Ok((m, rx, Some(err))) => {
                // The take starts without the mic (system audio may still be
                // on); the user is told once it runs, below, and the warning
                // clears if the supervisor brings the mic in.
                let code = windows_mic_error_code(&err);
                tracing::warn!(
                    mic_error = code,
                    "Windows mic did not open at start; recording and retrying: {err:#}"
                );
                (Some(m), Some(rx), Some(code))
            }
            Err(err) => {
                let code = windows_mic_error_code(&err);
                tracing::warn!(
                    mic_error = code,
                    "Windows mic capture unavailable; recording without mic: {err:#}"
                );
                (None, None, Some(code))
            }
        }
    } else {
        (None, None, None)
    };
    let mut mic_rx = mic_rx;

    let (loopback, loopback_rx) = if audio.include_system_audio {
        match WinLoopbackCapturer::start() {
            Ok((l, rx)) => (Some(l), Some(rx)),
            Err(err) => {
                tracing::warn!(
                    "Windows system-audio loopback unavailable; recording without it: {err:#}"
                );
                (None, None)
            }
        }
    } else {
        (None, None)
    };
    let mut loopback_rx = loopback_rx;

    let encoder_cfg = EncoderConfig {
        width,
        height,
        fps: FPS,
        video_bitrate_bps: crate::capture_health::video_bitrate_for_height(video.max_height),
    };
    let mut encoder = Mp4Encoder::open(file_path, encoder_cfg).map_err(|e| {
        CaptureFailure::tag("encoder_open_failed", e.context("open ffmpeg MP4 encoder"))
    })?;
    // WASAPI loopback sends nothing while nothing plays, and a mic can be off
    // or fail to start, so a take could end with a zero-packet audio track
    // Keep the track filled with silence until real audio comes.
    encoder.enable_silence_prefill();

    // Both Instant and Studio upload (Studio hands off to the editor on
    // stop); only the debug dev session stays local. See macOS path for
    // the full rationale. Local AI recordings never upload: their bearer is
    // empty, so an initiate would 401 and sign the user out.
    let uploader = if mode == crate::types::RecordingMode::Local
        || (crate::edition::is_dev_bypass(bearer) && !is_local_api_base(api_base))
    {
        tracing::info!("dev session: skipping streaming upload (local studio)");
        None
    } else {
        Some(
            StreamingUploader::start(
                app,
                api_base.to_string(),
                bearer.to_string(),
                recording_id.clone(),
                file_path.to_path_buf(),
                None,
                video.max_height,
                mode == crate::types::RecordingMode::Instant,
            )
            .await
            // A server refusal passes through untouched; anything else here
            // is the network or the server, not the capture.
            .map_err(crate::capture::failure::initiate_failure)?,
        )
    };

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    let pump_file_path = file_path.to_path_buf();
    let pump_reduce_noise = audio.reduce_noise && mic_rx.is_some();

    // Created BEFORE the pump so the pump can hold its own handle. It used to
    // be built further down, after this task was already spawned, which is
    // precisely why mute/pause did nothing on Windows: the flags existed and
    // the UI wrote to them, but the only code that could act on them had no
    // reference to read.
    let pause = PauseState::new();
    let pump_pause = Arc::clone(&pause);

    // Live check for a mic that opened but records nothing. The
    // pump only touches atomics here; the ticker makes the decision, so the
    // check can never slow or block capture.
    let mic_activity = Arc::new(crate::capture::mic_silence::MicActivity::new());
    let pump_mic_activity = Arc::clone(&mic_activity);
    let mic_silence_summary =
        Arc::new(Mutex::new(crate::capture::mic_silence::MicSilenceSummary::default()));
    let pump_mic_silence_summary = Arc::clone(&mic_silence_summary);

    let pump_counters = Arc::new(CaptureCounters::new(Instant::now()));
    let pump_recording_id = recording_id.clone();
    let pump_include_mic = audio.include_mic;
    let pump_include_system_audio = audio.include_system_audio;
    // Whether the mic opened at Start; a supervisor that is still retrying
    // after a failed first open does not count.
    let pump_mic_started = mic.is_some() && mic_error.is_none();
    let pump_mic_error = mic_error;
    let pump_mic_reopen = mic.as_ref().map(|m| m.reopen_stats());

    let pump_task: JoinHandle<Result<u64>> = tokio::spawn(async move {
        let mut audio_mixer = WinLiveAudioMixer::new();
        // Sized from the encoder config, NOT from whatever WGC happens to
        // deliver — WGC always delivers the monitor's native resolution.
        let mut video_scaler = WinVideoScaler::new(width, height);
        // One cursor per source: mic and loopback are independent device
        // streams and must each advance by their own sample count.
        let mut mic_lane = WinAudioLane::new("mic", LanePolicy::Continuous)
            .with_noise_suppression(pump_reduce_noise);
        let mut loopback_lane = WinAudioLane::new("loopback", LanePolicy::Gapped);
        let mut mic_agc = WinMicAgc::new();
        // Raw loopback dump for diagnosis. Writes exactly what cpal hands us,
        // BEFORE any lane placement, mixing or limiting — so a distorted dump
        // means the problem is capture/config, and a clean dump means it is
        // our processing. Off unless CLIPY_DUMP_LOOPBACK is set.
        //
        //   ffplay -f f32le -ar 48000 -ch_layout stereo <file>
        let mut loopback_dump: Option<std::io::BufWriter<std::fs::File>> =
            std::env::var("CLIPY_DUMP_LOOPBACK").ok().and_then(|_| {
                let path = std::env::temp_dir().join("clipy-loopback-raw.f32");
                match std::fs::File::create(&path) {
                    Ok(f) => {
                        tracing::warn!(path = %path.display(), "dumping raw loopback PCM");
                        Some(std::io::BufWriter::new(f))
                    }
                    Err(e) => {
                        tracing::warn!("loopback dump open failed: {e}");
                        None
                    }
                }
            });
        let mut video_frames: u64 = 0;
        let mut mic_chunks: u64 = 0;
        let mut mic_chunks_muted: u64 = 0;
        let mut loopback_chunks: u64 = 0;
        let mut mixed_audio_frames: u64 = 0;

        let mut discarded_video: u64 = 0;
        while video_rx.try_recv().is_ok() {
            discarded_video += 1;
        } 
        if let Some(rx) = mic_rx.as_mut() {
            while rx.try_recv().is_ok() {}
        }
        if let Some(rx) = loopback_rx.as_mut() {
            while rx.try_recv().is_ok() {}
        }
        // A frame captured while paused cannot start the timeline; wait for one
        // after the resume. Audio that arrives meanwhile is discarded: it has
        // no place before the first frame (it would land at 0, over the start
        // of the take), and the channels are unbounded, so a pause on a still
        // screen would otherwise pile it up.
        let first_frame = loop {
            tokio::select! {
                biased;
                maybe_v = video_rx.recv() => match maybe_v {
                    Some(f) if pump_pause.captured_while_paused(f.captured_at) => {}
                    other => break other,
                },
                maybe_mic = async {
                    match mic_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    if maybe_mic.is_none() {
                        mic_rx = None;
                    }
                }
                maybe_lb = async {
                    match loopback_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    if maybe_lb.is_none() {
                        loopback_rx = None;
                    }
                }
            }
        };
        let capture_anchor = match first_frame {
            Some(f) => {
                let anchor = f.captured_at;
                match queue_win_video(&mut encoder, &mut video_scaler, crop, &f, anchor, &pump_pause) {
                    Ok(()) => pump_counters.note_source_frame(),
                    Err(e) => tracing::error!("queue_win_video (first frame): {e:#}"),
                }
                video_frames += 1;
                anchor
            }
            // Capture ended before a single frame arrived; keep the original
            // anchor so the finalize path still has a sane timeline.
            None => capture_anchor,
        };
        if discarded_video > 0 {
            tracing::info!(
                discarded_video,
                "discarded WGC frames captured during recording setup"
            );
        }
        pump_mic_activity.mark_pump_live();

        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => {
                    // Drain whatever is still queued — capture sources
                    // may have buffered a frame or two when stop fired.
                    while let Ok(f) = video_rx.try_recv() {
                        if pump_pause.captured_while_paused(f.captured_at) {
                            continue;
                        }
                        match queue_win_video(&mut encoder, &mut video_scaler, crop, &f, capture_anchor, &pump_pause) {
                            Ok(()) => pump_counters.note_source_frame(),
                            Err(e) => tracing::error!("queue_win_video (drain): {e:#}"),
                        }
                        video_frames += 1;
                    }
                    if let Some(rx) = mic_rx.as_mut() {
                        while let Ok(mut c) = rx.try_recv() {
                            if pump_pause.captured_while_paused(c.captured_at) {
                                mic_lane.drop_paused_chunk();
                                continue;
                            }
                            // if pump_pause.is_mic_muted() {
                            //     for sample in c.samples.iter_mut() {
                            //         *sample = 0.0;
                            //     }
                            // }
                            let mic_muted = pump_pause.is_mic_muted();
                            mic_lane.set_muted(mic_muted);

                            if mic_muted {
                                mic_chunks_muted += 1;

                                for sample in c.samples.iter_mut() {
                                    *sample = 0.0;
                                }
                            }

                            if mic_chunks % 100 == 0 {
                                tracing::info!(
                                    mic_muted,
                                    mic_chunks,
                                    mic_chunks_muted,
                                    "Windows mic state"
                                );
                            }

                            if let Err(e) = queue_win_audio(
                                &mut encoder,
                                &mut audio_mixer,
                                &mut mic_lane,
                                0,
                                &c,
                                capture_anchor,
                                &pump_pause,
                                &mut mixed_audio_frames,
                                "mic",
                            ) {
                                tracing::error!("queue_win_audio mic (drain): {e:#}");
                            }

                            mic_chunks += 1;
                        }
                    }
                    if let Some(rx) = loopback_rx.as_mut() {
                        while let Ok(c) = rx.try_recv() {
                            if pump_pause.captured_while_paused(c.captured_at) {
                                continue;
                            }
                            if let Err(e) = queue_win_audio(
                                &mut encoder, &mut audio_mixer, &mut loopback_lane, 1, &c,
                                capture_anchor, &pump_pause, &mut mixed_audio_frames, "loopback",
                            ) {
                                tracing::error!("queue_win_audio loopback (drain): {e:#}");
                            }
                            loopback_chunks += 1;
                        }
                    }
                    break;
                }
                maybe_mic = async {
                    match mic_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    match maybe_mic {
                        Some(mut c) => {
                            if pump_pause.captured_while_paused(c.captured_at) {
                                mic_lane.drop_paused_chunk();
                                continue;
                            }
                            let mic_muted = pump_pause.is_mic_muted();
                            mic_lane.set_muted(mic_muted);
                            if mic_muted {
                                mic_chunks_muted += 1;
                                for sample in c.samples.iter_mut() {
                                    *sample = 0.0;
                                }
                            }
                            // Feed the level meter. After the mute zeroing, so
                            // a muted mic reads flat; before the AGC, so the
                            // meter shows what the microphone is picking up
                            // rather than our makeup gain. Same order as the
                            // macOS pump.
                            pump_pause.observe_mic_samples(&c.samples);
                            pump_mic_activity.observe(&c.samples);
                            // After the mute check: a muted lane must stay
                            // truly silent, and the AGC's noise gate would
                            // ignore an all-zero block anyway.
                            mic_agc.apply(&mut c.samples, c.channels);
                            if let Err(e) = queue_win_audio(
                                &mut encoder, &mut audio_mixer, &mut mic_lane, 0, &c,
                                capture_anchor, &pump_pause, &mut mixed_audio_frames, "mic",
                            ) {
                                tracing::error!("queue_win_audio mic: {e:#}");
                            }
                            mic_chunks += 1;
                        }
                        None => { mic_rx = None; }
                    }
                }
                maybe_lb = async {
                    match loopback_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    match maybe_lb {
                        Some(c) => {
                            if pump_pause.captured_while_paused(c.captured_at) {
                                continue;
                            }
                            if let Some(dump) = loopback_dump.as_mut() {
                                use std::io::Write;
                                for sample in c.samples.iter() {
                                    let _ = dump.write_all(&sample.to_le_bytes());
                                }
                            }
                            if let Err(e) = queue_win_audio(
                                &mut encoder, &mut audio_mixer, &mut loopback_lane, 1, &c,
                                capture_anchor, &pump_pause, &mut mixed_audio_frames, "loopback",
                            ) {
                                tracing::error!("queue_win_audio loopback: {e:#}");
                            }
                            loopback_chunks += 1;
                        }
                        None => { loopback_rx = None; }
                    }
                }
                // Polled LAST, deliberately. `biased;` above resolves
                // branches in declaration order, and this channel is
                // effectively always ready whenever the pump cannot keep up
                // with capture (the "WGC video channel full" case). With video
                // first, it won every iteration and the mic and loopback
                // branches were never polled at all — audio chunks queued up
                // untouched and were only processed by the shutdown drain,
                // AFTER the recording had ended. That is why live mic mute
                // appeared to do nothing: the toggle had already been undone
                // by the time any chunk was looked at.
                //
                // Audio is small, latency-sensitive and cannot be re-derived;
                // video frames are large and already droppable. Audio first.
                maybe_v = video_rx.recv() => {
                    match maybe_v {
                        Some(f) => {
                            // Drop frames captured while paused; every other
                            // frame is stamped with the paused time before it
                            // removed (`win_timeline_offset`), so the pause is
                            // cut out instead of playing as a frozen frame.
                            if pump_pause.captured_while_paused(f.captured_at) {
                                continue;
                            }
                            match queue_win_video(&mut encoder, &mut video_scaler, crop, &f, capture_anchor, &pump_pause) {
                                Ok(()) => pump_counters.note_source_frame(),
                                Err(e) => tracing::error!("queue_win_video: {e:#}"),
                            }
                            video_frames += 1;
                        }
                        None => break,
                    }
                }
            }
        }

        if let Some(dump) = loopback_dump.as_mut() {
            use std::io::Write;
            let _ = dump.flush();
        }
        mixed_audio_frames += audio_mixer.flush(&mut encoder)?;
        tracing::info!(
            mic_makeup_gain_db = 20.0 * mic_agc.peak_gain.log10(),
            video_frames,
            mic_chunks,
            mic_chunks_muted,
            loopback_chunks,
            mixed_audio_frames,
            "Windows pump: finalizing encoder"
        );
        crate::capture_health::remember_capture_health(
            &pump_recording_id,
            crate::capture_health::CaptureHealthReport {
                source_video_frames: Some(pump_counters.source_video_frames()),
                last_source_frame_ms: pump_counters.last_source_frame_ms(),
                audio: Some(crate::capture_health::AudioStateReport {
                    include_mic: pump_include_mic,
                    include_system_audio: pump_include_system_audio,
                    mic_started: pump_mic_started,
                    mic_error: pump_mic_error,
                    mic_chunks,
                    loopback_chunks,
                    mic_silence: pump_mic_started.then(|| *pump_mic_silence_summary.lock()),
                    mic_reopen: pump_mic_reopen
                        .as_ref()
                        .and_then(|stats| stats.lock().ok().map(|stats| stats.clone())),
                }),
                screen_capture: None,
            },
        );
        encoder.finish().context("Mp4Encoder::finish (Windows)")?;

        let bytes = std::fs::metadata(&pump_file_path)
            .map(|m| m.len())
            .unwrap_or(0);
        Ok(bytes)
    });

    let started_at = Instant::now();

    let ticker_app = app.clone();
    let ticker_state = state.clone();
    let ticker_path = file_path.to_path_buf();
    let ticker_pause = Arc::clone(&pause);
    let ticker_has_mic = mic.is_some();
    // Kept on screen for the whole take, so the recording HUD says why there
    // is no mic level instead of only the log knowing.
    let mut ticker_mic_warning = mic_error.map(|_| WINDOWS_MIC_START_FAILED);
    let ticker_mic_activity = Arc::clone(&mic_activity);
    let ticker_mic_delivered = mic.as_ref().map(|m| m.delivered_chunks());
    let ticker_mic_silence_summary = Arc::clone(&mic_silence_summary);
    state.lock().mic_active = ticker_has_mic;
    let ticker_task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_elapsed_ms: u64 = 0;
        let mut displayed_mic_level = 0.0f32;
        let mut mic_watch = crate::capture::mic_silence::MicSilenceWatch::new();
        let mut last_mic_muted = ticker_pause.is_mic_muted();
        loop {
            tick.tick().await;
            let phase = {
                let s = ticker_state.lock();
                s.phase
            };
            if phase == RecordingPhase::Countdown {
                continue;
            }
            if phase != RecordingPhase::Recording && phase != RecordingPhase::Paused {
                break;
            }
            // Pause-aware, matching macOS: raw `started_at.elapsed()` kept
            // counting through a pause, so the timer disagreed with the
            // recording it was timing.
            let elapsed_ms = ticker_pause.effective_elapsed_us(&started_at) / 1_000;
            let elapsed_delta_ms = elapsed_ms.saturating_sub(last_elapsed_ms);
            last_elapsed_ms = elapsed_ms;
            // Peak-hold with decay, identical to macOS: jump to a louder
            // reading at once, fall back gradually, snap to zero near silence.
            // `take_mic_level` resets the pump's running peak, so each tick
            // reports only what was heard since the last one.
            if ticker_has_mic {
                let level = ticker_pause.take_mic_level();
                displayed_mic_level = if level > displayed_mic_level {
                    level
                } else {
                    displayed_mic_level * 0.65
                };
                if displayed_mic_level < 0.01 {
                    displayed_mic_level = 0.0;
                }
            }
            // Mic opened but records nothing: digital silence or no chunks at
            // all. Only time recording with the mic unmuted counts; a step
            // that starts or ends muted is skipped because the pump zeroed
            // part of it. See `capture::mic_silence` for why this is not the
            // macOS level check.
            let mut silence_warning = None;
            let mic_muted = ticker_pause.is_mic_muted();
            if ticker_has_mic {
                let (chunks, peak) = ticker_mic_activity.take();
                let delivered = ticker_mic_delivered
                    .as_ref()
                    .map(|d| d.swap(0, std::sync::atomic::Ordering::Relaxed))
                    .unwrap_or(0);
                // The mic failed to open at Start and the supervisor has
                // since brought it in: the "no mic audio" notice is no
                // longer true. From here the live silence check speaks.
                if delivered > 0 {
                    ticker_mic_warning = None;
                }
                let active = phase == RecordingPhase::Recording
                    && !ticker_pause.is_paused()
                    && !mic_muted
                    && !last_mic_muted
                    && ticker_mic_activity.pump_live();
                silence_warning = mic_watch
                    .tick(crate::capture::mic_silence::MicTick {
                        elapsed_delta_ms,
                        active,
                        delivered,
                        chunks,
                        peak,
                    })
                    .map(windows_mic_silence_message);
                *ticker_mic_silence_summary.lock() = mic_watch.summary();
            }
            last_mic_muted = mic_muted;
            let bytes = tokio::fs::metadata(&ticker_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            let dto = {
                let mut s = ticker_state.lock();
                s.elapsed_ms = Some(elapsed_ms);
                s.bytes_written = Some(bytes);
                s.mic_level = ticker_has_mic.then_some(displayed_mic_level);
                // Report the live mute state. Without this the DTO emits a
                // stale `false` every tick, the UI resets its own toggle, and
                // every click therefore sends `muted = true` — latching the
                // flag on permanently and silencing the mic for good.
                s.mic_muted = mic_muted;
                s.mic_active = ticker_has_mic;
                // English constants with a `native.errors` key, shown in
                // the reader's language (i18n::localize_message).
                s.mic_silence_warning = ticker_mic_warning
                    .or(silence_warning)
                    .map(crate::i18n::localize_message);
                s.clone()
            };
            let _ = ticker_app.emit(EVENT_RECORDING_STATE_CHANGED, dto);
        }
    });

    // Cursor tracker — see macOS construction site above for rationale. A
    // camera-only recording has no screen for the cursor to map onto.
    // Pause-aware so its stamps skip the paused time the video now cuts out.
    let cursor_tracker = cursor_capture
        .map(|_| crate::cursor_track::CursorTracker::start_paused_aware(Arc::clone(&pause)));

    // `pause` is created above, before the pump task, so the pump holds a
    // handle and can actually honour mute/pause. The live mic arm feeds
    // `observe_mic_samples` and the ticker publishes `mic_level`, which is what
    // drives the meter under the mic toggle.
    //
    // The shared finalize-time silence check stays off here: it needs
    // `add_unmuted_mic_ms` and judges silence with the macOS meter threshold,
    // which a quiet room on Windows can sit under. Before the meter was fed it
    // fired on every take. With that counter at zero it can never fire; the
    // ticker's `MicSilenceWatch` above is the Windows check instead.
    let webcam_for_activation = webcam.clone();

    // Resource samples once a minute, as on macOS (Instant takes only).
    if let (Some(upload), crate::types::RecordingMode::Instant) = (uploader.as_ref(), mode) {
        crate::recording_health::spawn(
            app.clone(),
            recording_id.clone(),
            state.clone(),
            pause.clone(),
            started_at,
            file_path.to_path_buf(),
            Some(upload.health.clone()),
        );
    }
    let active = ActiveRecording {
        recording_id: recording_id.clone(),
        file_path: file_path.to_path_buf(),
        started_at,
        pause,
        bearer: bearer.to_string(),
        api_base: api_base.to_string(),
        cursor_tracker,
        cursor_capture,
        capture_source,
        // The Windows app records every window as a fixed area.
        window_only: false,
        mode,
        webcam,
        audio: audio.clone(),
        shutdown_tx: Some(shutdown_tx),
        pump_task: Some(pump_task),
        ticker_task: Some(ticker_task),
        // Already `Option<UploaderHandle>` — see macOS path comment.
        uploader,
        win_screen: Some(screen),
        win_mic: mic,
        win_loopback: loopback,
    };
    *active_slot.lock() = Some(active);

    // The take is running without the microphone the user asked for: say so
    // now, not only at Stop.
    if mic_error.is_some() {
        let _ = app.emit(
            EVENT_RECORDING_AUDIO_WARNING,
            serde_json::json!({ "message": crate::i18n::t("notifications.windowsMicStartFailed") }),
        );
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title(crate::edition::APP_NAME)
            .body(crate::i18n::t("notifications.windowsMicStartFailed"))
            .show();
    }

    // Area capture suppresses Windows' own capture indicator (it would outline
    // the whole display, since that is what WGC captures), so draw our own
    // frame around the region instead.
    //
    // The window is expanded by `HIGHLIGHT_INSET` on every side: the frame
    // renders a 4px stroke inset 4px from the window edge, so without the
    // expansion the stroke would sit INSIDE the crop and be recorded into the
    // video. Expanding puts its inner edge exactly on the region boundary.
    //
    // AREA ONLY, deliberately. Window capture is also a crop now, but the
    // user picked a window that already has its own visible border, and macOS
    // draws nothing for window capture either.
    //
    // The crop is in its display's local pixel space; the frame is drawn on
    // the virtual desktop, so it takes the crop's screen origin from the
    // capture viewport (display origin + crop offset).
    if let (Some(c), Some(CaptureSourceDto::Area { .. })) = (crop, source) {
        let origin = cursor_capture
            .as_ref()
            .and_then(|v| Some((v.screen_x?.round() as i32, v.screen_y?.round() as i32)))
            .unwrap_or((c.x as i32, c.y as i32));
        show_region_highlight(app, origin, c);
    }

    let Some(cursor_capture) = cursor_capture else {
        crate::commands::teardown_cursor_trail_overlay(app);
        return Ok(());
    };

    if let Some(webcam) = webcam_for_activation
        .as_ref()
        .filter(|webcam| webcam.enabled)
    {
        if let Err(err) = crate::commands::show_recording_webcam_bubble(
            app,
            webcam,
            Some(source_rect_from_capture_viewport(cursor_capture)),
            mode == crate::types::RecordingMode::Instant,
        ) {
            tracing::error!("webcam bubble activation failed: {err}");
        }
    }

    // Flare, as on macOS. The overlay covers the captured area on the virtual
    // desktop, in the same physical pixels the cursor is read in.
    if mode != crate::types::RecordingMode::Studio {
        if let Err(err) = crate::commands::show_cursor_trail_overlay(
            app,
            win_screen_rect_from_capture_viewport(cursor_capture),
            true,
        ) {
            tracing::warn!("cursor trail overlay activation failed: {err}");
        }
    } else {
        crate::commands::teardown_cursor_trail_overlay(app);
    }
    Ok(())
}

/// The captured area on the virtual desktop, in physical pixels. The
/// viewport's `x`/`y` are local to its display; `screen_*` carry the origin.
#[cfg(target_os = "windows")]
fn win_screen_rect_from_capture_viewport(
    capture: crate::cursor_track::CaptureViewport,
) -> SourceHighlightRectDto {
    SourceHighlightRectDto {
        x: capture.screen_x.unwrap_or(capture.x),
        y: capture.screen_y.unwrap_or(capture.y),
        width: capture.screen_width.unwrap_or(capture.width),
        height: capture.screen_height.unwrap_or(capture.height),
    }
}

// ---------------------------------------------------------------------------
// Windows-only encoder helpers
// ---------------------------------------------------------------------------

/// Resizes native-resolution WGC frames to the encoder's configured size.
///
/// WGC cannot scale (its frame pool is fixed at the capture item's native
/// size) and the encoder's converter only changes pixel format, so without
/// this nothing resizes. Context is cached and rebuilt when the input size
/// changes (resolution/DPI change mid-recording).
#[cfg(target_os = "windows")]
struct WinVideoScaler {
    ctx: Option<ffmpeg::software::scaling::Context>,
    src: (u32, u32),
    dst_w: u32,
    dst_h: u32,
}

// SAFETY: swscale's context wraps a raw pointer, so the compiler will not
// auto-derive `Send`. It is safe to MOVE between threads, just not to access
// concurrently — the same property `Mp4Encoder` relies on above. The scaler is
// constructed inside the pump task, is owned solely by it, and every call goes
// through `&mut self` from that one task; no handle escapes.
#[cfg(target_os = "windows")]
unsafe impl Send for WinVideoScaler {}

#[cfg(target_os = "windows")]
impl WinVideoScaler {
    fn new(dst_w: u32, dst_h: u32) -> Self {
        Self {
            ctx: None,
            src: (0, 0),
            dst_w,
            dst_h,
        }
    }

    /// Returns a BGRA frame at the encoder's size. Passes the input straight
    /// through when it already matches, so the common "record at native
    /// resolution" case costs nothing.
    fn scale(&mut self, input: ffmpeg::frame::Video) -> Result<ffmpeg::frame::Video> {
        use ffmpeg::format::Pixel;
        use ffmpeg::software::scaling::{flag::Flags, Context as SwsContext};

        let (in_w, in_h) = (input.width(), input.height());
        if in_w == self.dst_w && in_h == self.dst_h {
            return Ok(input);
        }

        if self.ctx.is_none() || self.src != (in_w, in_h) {
            self.ctx = Some(
                SwsContext::get(
                    Pixel::BGRA,
                    in_w,
                    in_h,
                    Pixel::BGRA,
                    self.dst_w,
                    self.dst_h,
                    // BILINEAR: downscaling a desktop is the normal case and
                    // FAST_BILINEAR visibly aliases text.
                    Flags::BILINEAR,
                )
                .map_err(|e| anyhow!("WGC scaler init {in_w}x{in_h}: {e:?}"))?,
            );
            self.src = (in_w, in_h);
        }

        let ctx = self
            .ctx
            .as_mut()
            .expect("scaler context built immediately above");
        let mut out = ffmpeg::frame::Video::empty();
        ctx.run(&input, &mut out)
            .map_err(|e| anyhow!("WGC sws_scale: {e:?}"))?;
        out.set_pts(input.pts());
        Ok(out)
    }
}

/// Where a sample captured at `at` lands on the output timeline: its time
/// since `anchor` minus the paused time between the two (Cap's
/// `unpaused_offset`). A pause before the anchor frame (a still screen sends
/// no frame) is not on the timeline, so it is not subtracted. Callers drop
/// samples captured inside a pause first.
#[cfg(any(target_os = "windows", test))]
fn win_timeline_offset(pause: &PauseState, anchor: Instant, at: Instant) -> Duration {
    let paused = pause
        .paused_before(at)
        .saturating_sub(pause.paused_before(anchor));
    at.saturating_duration_since(anchor).saturating_sub(paused)
}

/// The recording id in a recoverable file's name (`<uuid>.mp4`), or `None`
/// for any other name. Only a UUID-shaped stem is returned, so a renamed file
/// can never put user text into telemetry.
fn recovered_recording_id(file_path: &std::path::Path) -> Option<String> {
    let stem = file_path.file_stem()?.to_str()?;
    let uuid_shaped = stem.len() == 36
        && stem.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        });
    uuid_shaped.then(|| stem.to_ascii_lowercase())
}

#[cfg(test)]
mod pause_window_tests {
    use super::{win_timeline_offset, PauseState};
    use std::time::{Duration, Instant};

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// Satendra's Windows repro: 20 s recording, a 10 s pause, 10 s more.
    fn twenty_then_ten_second_pause(t0: Instant) -> std::sync::Arc<PauseState> {
        let pause = PauseState::new();
        pause.windows.lock().push((t0 + ms(20_000), Some(t0 + ms(30_000))));
        pause
    }

    #[test]
    fn samples_inside_a_pause_are_dropped() {
        let t0 = Instant::now();
        let pause = twenty_then_ten_second_pause(t0);
        assert!(!pause.captured_while_paused(t0 + ms(19_999)));
        assert!(pause.captured_while_paused(t0 + ms(20_000)));
        assert!(pause.captured_while_paused(t0 + ms(29_999)));
        assert!(!pause.captured_while_paused(t0 + ms(30_000)));
    }

    #[test]
    fn the_pause_is_cut_from_the_timeline() {
        let t0 = Instant::now();
        let pause = twenty_then_ten_second_pause(t0);
        assert_eq!(win_timeline_offset(&pause, t0, t0 + ms(19_000)), ms(19_000));
        // The first frame after the resume follows straight on from the last
        // one before the pause, instead of 10 s of frozen frame later.
        assert_eq!(win_timeline_offset(&pause, t0, t0 + ms(30_000)), ms(20_000));
        assert_eq!(win_timeline_offset(&pause, t0, t0 + ms(40_000)), ms(30_000));
    }

    #[test]
    fn a_sample_queued_across_the_resume_keeps_its_place() {
        // Captured just before the pause but handled after the resume: it
        // still belongs before the cut, unlike an anchor shift applied when
        // the pump reads it.
        let t0 = Instant::now();
        let pause = twenty_then_ten_second_pause(t0);
        assert_eq!(win_timeline_offset(&pause, t0, t0 + ms(19_990)), ms(19_990));
    }

    #[test]
    fn an_open_pause_drops_everything_after_its_start() {
        let pause = PauseState::new();
        let before = Instant::now();
        pause.begin_pause();
        let during = Instant::now();
        assert!(!pause.captured_while_paused(before));
        assert!(pause.captured_while_paused(during));
        pause.end_pause();
        // Ending again (stop after resume) must not reopen or move the window.
        pause.end_pause();
        assert!(!pause.captured_while_paused(Instant::now() + ms(1)));
        assert_eq!(pause.windows.lock().len(), 1);
    }

    #[test]
    fn a_pause_before_the_first_frame_is_not_subtracted() {
        // Paused on a still screen before WGC sent its first frame, which then
        // anchors the timeline at 12.5 s.
        let t0 = Instant::now();
        let pause = PauseState::new();
        pause.windows.lock().push((t0 + ms(2_000), Some(t0 + ms(12_000))));
        let anchor = t0 + ms(12_500);
        assert_eq!(win_timeline_offset(&pause, anchor, anchor), ms(0));
        assert_eq!(win_timeline_offset(&pause, anchor, anchor + ms(5_000)), ms(5_000));
    }

    #[test]
    fn stop_from_paused_keeps_dropping_until_teardown() {
        let pause = PauseState::new();
        pause.begin_pause();
        pause.end_pause_for_stop();
        assert!(!pause.is_paused());
        assert!(pause.captured_while_paused(Instant::now() + ms(50)));
    }

    #[test]
    fn several_pauses_add_up() {
        let t0 = Instant::now();
        let pause = PauseState::new();
        pause.windows.lock().push((t0 + ms(5_000), Some(t0 + ms(8_000))));
        pause.windows.lock().push((t0 + ms(12_000), Some(t0 + ms(20_000))));
        assert_eq!(win_timeline_offset(&pause, t0, t0 + ms(10_000)), ms(7_000));
        assert_eq!(win_timeline_offset(&pause, t0, t0 + ms(25_000)), ms(14_000));
    }
}

/// Convert a WGC BGRA frame into an `ffmpeg::frame::Video` with the
/// encoder's PTS arithmetic applied, then queue it.
#[cfg(target_os = "windows")]
fn queue_win_video(
    encoder: &mut Mp4Encoder,
    scaler: &mut WinVideoScaler,
    crop: Option<WinCropRect>,
    frame: &WinVideoFrame,
    anchor: Instant,
    pause: &PauseState,
) -> Result<()> {
    use ffmpeg::format::Pixel;

    // These are the buffer's OWN dimensions (see `capture::windows::VideoFrame`),
    // so the stride arithmetic below is correct by construction.
    let src_w = frame.width;
    let src_h = frame.height;
    if frame.bgra.len() < (src_w as usize) * (src_h as usize) * 4 {
        bail!(
            "WGC BGRA buffer too small: got {} bytes, expected {} ({}×{})",
            frame.bgra.len(),
            (src_w as usize) * (src_h as usize) * 4,
            src_w,
            src_h
        );
    }

    // Region capture: re-clamp against THIS frame rather than trusting the
    // rect computed at start. A display mode or DPI change mid-recording
    // resizes frames, and a stale rect would otherwise read out of bounds.
    let (off_x, off_y, width, height) = match crop {
        Some(c) => {
            let x = c.x.min(src_w.saturating_sub(2));
            let y = c.y.min(src_h.saturating_sub(2));
            let w = (c.width.min(src_w - x) & !1).max(2);
            let h = (c.height.min(src_h - y) & !1).max(2);
            (x as usize, y as usize, w, h)
        }
        None => (0, 0, src_w, src_h),
    };

    let mut ff = ffmpeg::frame::Video::new(Pixel::BGRA, width, height);
    let src_row_bytes = (src_w as usize) * 4;
    let row_bytes = (width as usize) * 4;
    let dst_stride = ff.stride(0);
    let dst = ff.data_mut(0);
    for y in 0..(height as usize) {
        // Source row walks the FULL frame stride; only `row_bytes` are copied,
        // starting at the crop's x offset.
        let s = (y + off_y) * src_row_bytes + off_x * 4;
        let d = y * dst_stride;
        dst[d..d + row_bytes].copy_from_slice(&frame.bgra[s..s + row_bytes]);
    }

    let since_anchor = win_timeline_offset(pause, anchor, frame.captured_at);
    let pts_us = (since_anchor.as_secs_f64() * VIDEO_TIME_BASE as f64) as i64;
    ff.set_pts(Some(pts_us.max(0)));
    // Resize to the encoder's configured size. No-op when the user records at
    // native resolution; required whenever they picked a smaller one, because
    // the encoder cannot resize and WGC would not.
    let ff = scaler.scale(ff)?;
    encoder.queue_video(ff)?;
    Ok(())
}

/// Convert a cpal interleaved-f32 chunk into the mixer's planar-stereo
/// format and feed it to the encoder via the running audio mixer.
/// Mic makeup gain for Windows — a port of the macOS AGC (`MIC_AGC_*`).
///
/// Nothing else in the Windows pipeline can raise level, so a raw capture plays
/// back noticeably quieter than typical screen recordings even with the input
/// slider at 100% — the same QA finding that motivated the macOS AGC.
///
/// Same shape and same bounds as macOS: lift toward a speech RMS target in
/// small steps, only while the block actually carries signal, never above
/// +18 dB. Adaptation is gated on an RMS noise gate, so a silent room is never
/// amplified into hiss.
///
/// It also cannot clip: macOS has a peak limiter downstream as its safety
/// ceiling and Windows does not, so the applied gain is additionally capped at
/// whatever keeps this block's peak below full scale.
#[cfg(target_os = "windows")]
struct WinMicAgc {
    gain: f32,
    peak_gain: f32,
}

#[cfg(target_os = "windows")]
impl WinMicAgc {
    fn new() -> Self {
        Self {
            gain: 1.0,
            peak_gain: 1.0,
        }
    }

    /// Applies makeup gain in place to one interleaved chunk.
    fn apply(&mut self, samples: &mut [f32], channels: u16) {
        const TARGET_RMS: f32 = 0.125; // -18 dBFS speech RMS (macOS parity)
        const MAX_GAIN: f32 = 8.0; // +18 dB ceiling
        const NOISE_GATE_RMS: f32 = 0.003; // -50 dBFS: do not adapt on silence
        const BLOCK_FRAMES: f32 = 3_840.0; // macOS adaptation block
        const RISE_PER_BLOCK: f32 = 1.06; // ~+0.5 dB
        const FALL_PER_BLOCK: f32 = 0.89; // ~-1 dB

        if samples.is_empty() {
            return;
        }
        let mut sum_sq = 0.0f64;
        let mut peak = 0.0f32;
        for s in samples.iter() {
            if s.is_finite() {
                let a = s.abs();
                if a > peak {
                    peak = a;
                }
                sum_sq += (*s as f64) * (*s as f64);
            }
        }
        let rms = (sum_sq / samples.len() as f64).sqrt() as f32;

        // Adapt only on real signal, and scale the step to this chunk's size so
        // the rate matches macOS regardless of the cpal buffer length.
        if rms > NOISE_GATE_RMS {
            let frames = (samples.len() / channels.max(1) as usize) as f32;
            let steps = frames / BLOCK_FRAMES;
            let desired = (TARGET_RMS / rms).clamp(1.0, MAX_GAIN);
            self.gain = if desired > self.gain {
                (self.gain * RISE_PER_BLOCK.powf(steps)).min(desired)
            } else {
                (self.gain * FALL_PER_BLOCK.powf(steps)).max(desired).max(1.0)
            };
        }

        // Hard safety: never let the applied gain push this block past full
        // scale. Stands in for the peak limiter the Windows mix lacks.
        let safe = if peak > 0.0 {
            (0.99 / peak).max(1.0)
        } else {
            MAX_GAIN
        };
        let applied = self.gain.min(safe).min(MAX_GAIN);
        if applied > 1.0 {
            for s in samples.iter_mut() {
                *s *= applied;
            }
        }
        if applied > self.peak_gain {
            self.peak_gain = applied;
        }
    }
}

/// Sample-accurate write cursor for ONE audio source (mic or loopback).
///
/// Chunks used to be placed using wall-clock `Instant::now()` while the mixer
/// drained at a strict 1024 samples/frame. The two clocks disagreed, so writes
/// overlapped (summing on top of existing audio) or left silence gaps. A
/// soundcard stream is contiguous, so wall clock is used only to anchor the
/// lane; each chunk then appends at `cursor`. Gross drift triggers a resync.
#[cfg(target_os = "windows")]
struct WinAudioLane {
    cursor: Option<i64>,
    label: &'static str,
    policy: LanePolicy,
    resyncs: u64,
    placed: u64,
    /// Converts a non-48 kHz device to the encoder rate.
    rate: LaneRateConverter,
    /// Off unless this is the microphone lane and the user turned
    /// "Reduce background noise" on.
    noise: LaneNoiseFilter,
    /// Stream generation of the last chunk (`WinAudioChunk::generation`).
    generation: Option<u32>,
    /// The next chunk is the first of a rebuilt stream (a mic reopen).
    new_stream: bool,
}

/// Per-lane conversion from whatever rate the device delivers to
/// `SAMPLE_RATE`. Not Windows-gated in test builds so the macOS
/// `cargo test` in Desktop Check exercises it; only `queue_win_audio`
/// uses it in a shipped build.
#[cfg(any(target_os = "windows", test))]
struct LaneRateConverter {
    label: &'static str,
    /// Rebuilt when the device's rate changes (the cpal supervisor can
    /// reopen a different device mid-recording).
    resampler: Option<WinLaneResampler>,
    /// A source rate whose resampler could not be built or run. Reported
    /// once, then that rate's chunks are dropped quietly for the rest of
    /// the recording.
    failed_rate: Option<u32>,
}

/// Stereo planar f32 at the device rate -> stereo planar f32 at
/// `SAMPLE_RATE`. Same swresample approach as the macOS `MicResampler`;
/// kept per lane so the filter history carries across callbacks and the
/// output is continuous.
#[cfg(any(target_os = "windows", test))]
struct WinLaneResampler {
    context: ffmpeg::software::resampling::Context,
    source_rate: u32,
}

#[cfg(any(target_os = "windows", test))]
impl WinLaneResampler {
    fn new(source_rate: u32) -> Result<Self> {
        let planar = ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar);
        let context = ffmpeg::software::resampler(
            (planar, ffmpeg::ChannelLayout::STEREO, source_rate),
            (planar, ffmpeg::ChannelLayout::STEREO, SAMPLE_RATE as u32),
        )
        .map_err(|error| anyhow!("create audio resampler {source_rate}->{SAMPLE_RATE}: {error:?}"))?;
        Ok(Self {
            context,
            source_rate,
        })
    }

    fn resample(&mut self, planes: &[Vec<f32>; 2]) -> Result<[Vec<f32>; 2]> {
        let planar = ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar);
        let samples = planes[0].len().min(planes[1].len());
        let mut input = ffmpeg::frame::Audio::new(planar, samples, ffmpeg::ChannelLayout::STEREO);
        input.set_rate(self.source_rate);
        for (ch, plane) in planes.iter().enumerate() {
            input.plane_mut::<f32>(ch)[..samples].copy_from_slice(&plane[..samples]);
        }

        let pending_samples = self
            .context
            .delay()
            .map(|delay| delay.output.max(0) as u64)
            .unwrap_or(0);
        let converted_samples = (samples as u64)
            .saturating_mul(SAMPLE_RATE as u64)
            .div_ceil(self.source_rate.max(1) as u64);
        let capacity = pending_samples
            .saturating_add(converted_samples)
            .saturating_add(16)
            .min(i32::MAX as u64) as usize;
        let mut output = ffmpeg::frame::Audio::new(planar, capacity, ffmpeg::ChannelLayout::STEREO);
        output.set_rate(SAMPLE_RATE as u32);
        self.context
            .run(&input, &mut output)
            .map_err(|error| anyhow!("resample audio {}->{SAMPLE_RATE}: {error:?}", self.source_rate))?;
        // `run` shrinks `output` to the samples actually produced.
        let produced = output.samples();
        Ok([
            output.plane::<f32>(0)[..produced].to_vec(),
            output.plane::<f32>(1)[..produced].to_vec(),
        ])
    }
}

/// How a source's chunks map onto the recording timeline.
///
/// The two Windows audio sources are NOT the same shape, and treating them
/// identically is what garbled system audio.
#[cfg(target_os = "windows")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum LanePolicy {
    /// Continuous device stream (microphone). The device runs at a fixed rate
    /// whether or not anyone is speaking, so consecutive callbacks are exactly
    /// adjacent in sample space. Append at the cursor and ignore wall-clock
    /// jitter; resync only on gross drift.
    Continuous,
    /// Discontinuous source (WASAPI loopback). Windows only delivers packets
    /// while the endpoint is actually rendering — real silence produces NO
    /// packets at all, not silent ones. Appending contiguously therefore packs
    /// audio from either side of a silence together and compresses the
    /// timeline, which is audible as speed-up and garbling.
    ///
    /// Position by wall clock instead, but never move backwards: gaps stay as
    /// genuine silence, and jitter can never overlap previously written audio.
    Gapped,
}

/// 250ms at 48kHz. Comfortably larger than callback jitter (sub-millisecond to
/// a few ms), small enough that a genuine dropout is corrected promptly.
#[cfg(target_os = "windows")]
const AUDIO_RESYNC_THRESHOLD_SAMPLES: i64 = (SAMPLE_RATE as i64) / 4;

/// 50ms at 48kHz — the point at which a `Gapped` lane treats a jump as real
/// silence rather than jitter. Callback jitter is sub-millisecond to a few ms;
/// a genuine pause in rendering is hundreds of ms. Sitting well above the
/// first and well below the second keeps ordinary jitter contiguous (no
/// crackle) while still preserving true silences.
#[cfg(target_os = "windows")]
const AUDIO_GAP_THRESHOLD_SAMPLES: i64 = (SAMPLE_RATE as i64) / 20;

#[cfg(any(target_os = "windows", test))]
impl LaneRateConverter {
    fn new(label: &'static str) -> Self {
        Self {
            label,
            resampler: None,
            failed_rate: None,
        }
    }

    /// Resamples one chunk's stereo planes from `source_rate` to
    /// `SAMPLE_RATE`. `Ok(None)` means this rate already failed and was
    /// reported; the caller drops the chunk without logging again, so a
    /// broken resampler costs one Sentry event per recording, not one per
    /// callback.
    fn resample(&mut self, source_rate: u32, planes: [Vec<f32>; 2]) -> Result<Option<[Vec<f32>; 2]>> {
        if self.failed_rate == Some(source_rate) {
            return Ok(None);
        }
        if self
            .resampler
            .as_ref()
            .is_none_or(|current| current.source_rate != source_rate)
        {
            if let Some(previous) = self.resampler.as_ref() {
                tracing::info!(
                    lane = self.label,
                    from = previous.source_rate,
                    to = source_rate,
                    "audio device rate changed; rebuilding resampler"
                );
            } else {
                tracing::info!(
                    lane = self.label,
                    source_rate,
                    target_rate = SAMPLE_RATE,
                    "resampling audio lane to encoder rate"
                );
            }
            self.resampler = None;
            match WinLaneResampler::new(source_rate) {
                Ok(resampler) => self.resampler = Some(resampler),
                Err(e) => {
                    self.failed_rate = Some(source_rate);
                    return Err(e);
                }
            }
        }
        let Some(resampler) = self.resampler.as_mut() else {
            return Ok(None);
        };
        match resampler.resample(&planes) {
            Ok(out) => Ok(Some(out)),
            Err(e) => {
                self.resampler = None;
                self.failed_rate = Some(source_rate);
                Err(e)
            }
        }
    }
}

/// "Reduce background noise" on one Windows audio lane; only the microphone
/// lane turns it on. Not Windows-gated in test builds, like
/// `LaneRateConverter`, so the macOS Desktop Check exercises it.
///
/// It runs per lane, after resampling and before the mixer sums the lane with
/// loopback, so it sees 48 kHz microphone audio only and never touches what
/// the speakers played. The microphone lane is contiguous
/// (`LanePolicy::Continuous`) and the filter preserves length, so it can
/// stream chunk by chunk. There is no reset: the Windows pump opens one
/// microphone per recording and never reopens it, so the room it learns
/// cannot change device mid-take.
#[cfg(any(target_os = "windows", test))]
struct LaneNoiseFilter {
    /// One per channel, or none when the filter is off.
    denoisers: Option<[crate::denoise::NoiseSuppressor; 2]>,
    /// Live mute. The pump zeroes a muted chunk before it gets here, but the
    /// filter still holds `LATENCY_SAMPLES` of audio from before the mute and
    /// would emit it, so the mute is applied again to what comes out.
    muted: bool,
}

#[cfg(any(target_os = "windows", test))]
impl LaneNoiseFilter {
    fn new(enabled: bool) -> Self {
        Self {
            denoisers: enabled.then(|| {
                [
                    crate::denoise::NoiseSuppressor::new(),
                    crate::denoise::NoiseSuppressor::new(),
                ]
            }),
            muted: false,
        }
    }

    /// Filters each channel on its own, so the lane keeps the layout it has
    /// with the filter off. Averaging to mono would cost 6 dB on an interface
    /// whose second input is silent and cancel channels in opposite polarity.
    fn process(&mut self, planes: &mut [Vec<f32>; 2]) {
        let Some(denoisers) = self.denoisers.as_mut() else {
            return;
        };
        for (denoiser, plane) in denoisers.iter_mut().zip(planes.iter_mut()) {
            // Run even while muted, so the filter's history stays continuous.
            denoiser.process(plane);
            if self.muted {
                plane.fill(0.0);
            }
        }
    }

    fn discard_buffered(&mut self) {
        for denoiser in self.denoisers.iter_mut().flatten() {
            denoiser.discard_buffered();
        }
    }
}

#[cfg(target_os = "windows")]
impl WinAudioLane {
    fn new(label: &'static str, policy: LanePolicy) -> Self {
        Self {
            cursor: None,
            label,
            policy,
            resyncs: 0,
            placed: 0,
            rate: LaneRateConverter::new(label),
            noise: LaneNoiseFilter::new(false),
            generation: None,
            new_stream: false,
        }
    }

    /// A chunk from a different stream generation than the last one means
    /// the source was rebuilt (`capture::windows::MicSupervisor`). Its first
    /// chunk is placed by the capture clock, not straight after the old
    /// stream's last one: the reopen left a gap, and appending would shift
    /// this lane early for the rest of the take.
    fn observe_generation(&mut self, generation: u32) {
        if self.generation.is_some_and(|previous| previous != generation) {
            self.new_stream = true;
            self.noise.discard_buffered();
        }
        self.generation = Some(generation);
    }

    /// Turns the microphone noise filter on for this lane. Logged for the same
    /// reason as the macOS mixer: it is the one setting that changes what the
    /// microphone sounds like.
    fn with_noise_suppression(mut self, enabled: bool) -> Self {
        self.noise = LaneNoiseFilter::new(enabled);
        if enabled {
            tracing::info!(
                lane = self.label,
                latency_samples = crate::denoise::LATENCY_SAMPLES,
                "microphone noise reduction enabled for this recording"
            );
        }
        self
    }

    fn set_muted(&mut self, muted: bool) {
        self.noise.muted = muted;
    }

    /// Called for each chunk dropped while paused. The stream is cut there, so
    /// the filter must not play its buffered pre-pause audio at the resume.
    fn drop_paused_chunk(&mut self) {
        self.noise.discard_buffered();
    }

    /// Returns the per-channel sample position this chunk should be written at,
    /// and advances the cursor past it.
    ///
    /// `wall_pts` is the wall-clock-derived position, used only to anchor the
    /// first chunk and to detect gross drift thereafter.
    /// Debug counter so a bounded diagnostic can print the first N decisions.
    fn seen(&self) -> u64 {
        self.placed
    }

    fn place(&mut self, wall_pts: i64, samples: usize) -> i64 {
        self.placed = self.placed.saturating_add(1);
        let samples = samples as i64;
        match self.cursor {
            // First chunk: anchor against the shared capture anchor so this
            // lane lines up with video and with the other audio lane.
            None => {
                self.cursor = Some(wall_pts + samples);
                wall_pts
            }
            // Discontinuous source: honour real elapsed time, leaving genuine
            // gaps as silence, but never write behind what is already
            // committed.
            //
            // The tolerance is load-bearing. Taking `max(cursor, wall_pts)`
            // outright treats ordinary callback jitter — a few samples of it,
            // on most chunks — as if it were a real gap, inserting a tiny
            // silence every ~10 ms. That is audible as a steady crackle at the
            // callback rate. Only a jump larger than any plausible jitter is a
            // real pause in rendering; anything smaller stays contiguous.
            // First chunk of a rebuilt stream: back on the capture clock,
            // never behind what is already written.
            Some(cursor) if self.new_stream => {
                self.new_stream = false;
                let pos = crate::capture::mic_reopen::position_after_reopen(cursor, wall_pts);
                self.cursor = Some(pos + samples);
                pos
            }
            Some(cursor) if self.policy == LanePolicy::Gapped => {
                let drift = wall_pts - cursor;
                let pos = if drift > AUDIO_GAP_THRESHOLD_SAMPLES {
                    wall_pts
                } else {
                    cursor
                };
                self.cursor = Some(pos + samples);
                pos
            }
            Some(cursor) => {
                let drift = wall_pts - cursor;
                if drift.abs() > AUDIO_RESYNC_THRESHOLD_SAMPLES {
                    self.resyncs = self.resyncs.saturating_add(1);
                    tracing::warn!(
                        lane = self.label,
                        drift_samples = drift,
                        drift_ms = (drift * 1000) / SAMPLE_RATE as i64,
                        resyncs = self.resyncs,
                        "audio lane drifted beyond threshold; resyncing to wall clock"
                    );
                    self.cursor = Some(wall_pts + samples);
                    wall_pts
                } else {
                    // Normal path: append exactly where the previous chunk
                    // ended. No gap, no overlap, regardless of callback jitter.
                    self.cursor = Some(cursor + samples);
                    cursor
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn queue_win_audio(
    encoder: &mut Mp4Encoder,
    mixer: &mut WinLiveAudioMixer,
    lane: &mut WinAudioLane,
    lane_slot: usize,
    chunk: &WinAudioChunk,
    anchor: Instant,
    pause: &PauseState,
    mixed_frames: &mut u64,
    _source: &str,
) -> Result<()> {
    use ffmpeg::format::{sample, Sample};
    use ffmpeg::ChannelLayout;

    if chunk.samples.is_empty() {
        return Ok(());
    }
    if chunk.sample_rate == 0 {
        return Ok(());
    }
    lane.observe_generation(chunk.generation);

    // De-interleave + downmix/upmix to stereo at the device's own rate.
    // Inputs come in as `chunk.channels` interleaved. We always produce
    // 2-channel planar f32 so the AAC encoder accepts it directly.
    let n_in = chunk.channels.max(1) as usize;
    let samples_per_channel = chunk.samples.len() / n_in;
    if samples_per_channel == 0 {
        return Ok(());
    }
    let mut planes: [Vec<f32>; 2] = [
        Vec::with_capacity(samples_per_channel),
        Vec::with_capacity(samples_per_channel),
    ];
    for (ch, plane) in planes.iter_mut().enumerate() {
        // Mono duplicates to both channels; multi-channel takes channel 0 + 1
        // (most common is stereo or 5.1; the latter we coarse-downmix by
        // ignoring extra channels).
        let src_ch = ch.min(n_in - 1);
        plane.extend(
            chunk
                .samples
                .chunks_exact(n_in)
                .map(|frame| frame[src_ch])
                .map(|sample| if sample.is_finite() { sample } else { 0.0 }),
        );
    }

    // Devices running at anything but 48 kHz (44.1 kHz headsets, 32 kHz
    // Bluetooth hands-free, ...) are resampled to the encoder rate. This used
    // to bail per chunk, which dropped that lane's audio for the whole
    // recording and sent one Sentry error per ~10 ms callback.
    let mut planes = if chunk.sample_rate == SAMPLE_RATE as u32 {
        planes
    } else {
        match lane.rate.resample(chunk.sample_rate, planes)? {
            Some(resampled) => resampled,
            // The resampler for this rate already failed and was reported
            // once; drop quietly rather than erroring on every callback.
            None => return Ok(()),
        }
    };
    lane.noise.process(&mut planes);
    let samples_per_channel = planes[0].len().min(planes[1].len());
    if samples_per_channel == 0 {
        return Ok(());
    }
    let mut frame = ffmpeg::frame::Audio::new(
        Sample::F32(sample::Type::Planar),
        samples_per_channel,
        ChannelLayout::STEREO,
    );
    frame.set_rate(SAMPLE_RATE as u32);
    for (ch, plane) in planes.iter().enumerate().take(AUDIO_CHANNELS as usize) {
        frame.plane_mut::<f32>(ch)[..samples_per_channel]
            .copy_from_slice(&plane[..samples_per_channel]);
    }

    // Wall clock anchors the lane; the lane decides where the samples land.
    // Using `wall_pts` directly here is what caused the gaps/overlaps.
    let since_anchor = win_timeline_offset(pause, anchor, chunk.captured_at);
    let wall_pts = (since_anchor.as_secs_f64() * SAMPLE_RATE as f64) as i64;
    let pts_samples = lane.place(wall_pts.max(0), samples_per_channel);
    frame.set_pts(Some(pts_samples.max(0)));

    mixer.push(frame, lane_slot)?;
    *mixed_frames += mixer.drain_to_encoder(encoder)?;
    Ok(())
}

/// Lightweight Windows-side audio mixer: sums planar-f32-stereo frames
/// arriving from multiple sources (mic + loopback) onto a shared timeline.
///
/// The mac path has a more elaborate mixer (`LiveAudioMixer`) that runs
/// SCK's mach-time PTS through a per-source dejitter; for Windows we
/// take a simpler approach because both cpal streams already share the
/// process's wall clock. Late-arriving samples just overwrite earlier
/// silence; gaps stay as silence.
#[cfg(target_os = "windows")]
struct WinLiveAudioMixer {
    /// Buffer of summed samples, planar by channel.
    channels: [std::collections::VecDeque<f32>; 2],
    /// Peak-limiter gain, <= 1.0. See `limit_block`.
    limiter_gain: f32,
    /// How far each source has written, in absolute samples. Index 0 = mic,
    /// 1 = loopback. `None` until that source delivers its first chunk.
    ///
    /// Draining is gated on the SLOWEST of these. Without that gate the
    /// faster source drives `buffer_start_pts` past the slower one, and the
    /// slower source's next chunk lands at a negative offset and is dropped
    /// by `push` — silently deleting one input. That is what removed mic
    /// audio once loopback started flowing reliably.
    frontiers: [Option<i64>; 2],
    /// PTS (in samples since anchor) of the first sample in `channels[*]`.
    buffer_start_pts: Option<i64>,
    /// Smallest PTS we've ever buffered; PTS arithmetic clamps to this.
    earliest_seen_pts: Option<i64>,
}

#[cfg(target_os = "windows")]
impl WinLiveAudioMixer {
    fn new() -> Self {
        Self {
            channels: [
                std::collections::VecDeque::new(),
                std::collections::VecDeque::new(),
            ],
            buffer_start_pts: None,
            earliest_seen_pts: None,
            limiter_gain: 1.0,
            frontiers: [None, None],
        }
    }

    /// Peak limiter over one already-summed block — a port of the macOS
    /// limiter in `LiveAudioMixer::drain`.
    ///
    /// Mic and system audio are summed (`*slot += s`), so either source alone
    /// can sit under full scale while the SUM clips. macOS has this stage;
    /// Windows did not, which is why enabling both together distorted.
    ///
    /// Attack is instantaneous and flat across the block: there is no
    /// look-ahead, so easing INTO a reduction would leave the block's early
    /// samples — exactly where a transient lives — above the ceiling and
    /// relying on the clamp, i.e. clipping. Release ramps per sample, because
    /// stepping the gain up at block boundaries is what makes recovery audible
    /// as pumping. Every value on the ramp is <= `required`, so ramping up
    /// cannot overshoot the ceiling.
    fn limit_block(&mut self, block: &mut [[f32; 2]], peak: f32) {
        // 0.05 per 80 ms on macOS, rescaled to this 1024-sample frame so a
        // fully-ducked mix still recovers over roughly 1.6 s.
        const RELEASE_PER_FRAME: f32 = 0.05 * (1024.0 / 3_840.0);
        let required = if peak > 0.98 { 0.98 / peak } else { 1.0 };
        let attacking = required < self.limiter_gain;
        let start = if attacking { required } else { self.limiter_gain };
        let target = if attacking {
            required
        } else {
            required.min(self.limiter_gain + RELEASE_PER_FRAME)
        };
        let n = block.len();
        let step = if n > 1 {
            (target - start) / (n - 1) as f32
        } else {
            0.0
        };
        for (i, frame) in block.iter_mut().enumerate() {
            let gain = start + step * i as f32;
            frame[0] = (frame[0] * gain).clamp(-1.0, 1.0);
            frame[1] = (frame[1] * gain).clamp(-1.0, 1.0);
        }
        self.limiter_gain = target;
    }

    /// Samples a source may lag the leader by before it is treated as stalled.
    ///
    /// Without a bound, one source going quiet (WASAPI loopback delivers
    /// nothing while the endpoint is idle) would hold the drain gate closed
    /// forever and the mix would stop. 1 s is far beyond normal jitter and
    /// far below anything a listener would notice as latency.
    const LAGGARD_WINDOW_SAMPLES: i64 = SAMPLE_RATE as i64;

    /// Highest position it is safe to emit: the slowest non-stalled source.
    fn drain_limit(&self) -> i64 {
        let mut leader = i64::MIN;
        for f in self.frontiers.iter().flatten() {
            leader = leader.max(*f);
        }
        if leader == i64::MIN {
            return i64::MIN;
        }
        let mut limit = i64::MAX;
        for f in self.frontiers.iter().flatten() {
            if leader - *f <= Self::LAGGARD_WINDOW_SAMPLES {
                limit = limit.min(*f);
            }
        }
        if limit == i64::MAX {
            leader
        } else {
            limit
        }
    }

    fn push(&mut self, frame: ffmpeg::frame::Audio, slot: usize) -> Result<()> {
        let samples = frame.samples();
        if samples == 0 {
            return Ok(());
        }
        let pts = frame
            .pts()
            .ok_or_else(|| anyhow!("audio frame missing pts"))?;

        // First-write: anchor the buffer's PTS at the first frame's PTS.
        let buf_start = *self.buffer_start_pts.get_or_insert(pts);
        self.earliest_seen_pts = Some(self.earliest_seen_pts.map(|e| e.min(pts)).unwrap_or(pts));

        // Compute offset into the buffer for this frame.
        let offset_signed = pts - buf_start;
        if offset_signed < 0 {
            // Late arrival before buffer start — extend forwards by
            // unshifting silence + adjusting start. Rare; we just
            // clamp to 0 to avoid a pathological buffer-front extension.
            // The Mac mixer handles this more carefully; for the
            // first Windows release this approximation is fine.
            return Ok(());
        }
        let offset = offset_signed as usize;

        for ch in 0..(AUDIO_CHANNELS as usize) {
            let src = frame.plane::<f32>(ch);
            let need_len = offset + samples;
            if self.channels[ch].len() < need_len {
                // Extend with silence so we can index up to need_len.
                let extra = need_len - self.channels[ch].len();
                self.channels[ch].extend(std::iter::repeat(0.0_f32).take(extra));
            }
            // Sum into the existing buffer at `offset..offset+samples`.
            // VecDeque doesn't expose a contiguous-slice indexing; fall
            // back to per-sample mutation.
            for (i, &s) in src.iter().enumerate().take(samples) {
                let buf_idx = offset + i;
                if let Some(slot) = self.channels[ch].get_mut(buf_idx) {
                    *slot += s;
                }
            }
        }

        if let Some(f) = self.frontiers.get_mut(slot) {
            let end = offset_signed + samples as i64 + buf_start;
            *f = Some(f.map_or(end, |prev| prev.max(end)));
        }

        Ok(())
    }

    /// Pop AAC-sized frames off the front of the buffer and feed them
    /// to the encoder. Returns the number of encoder frames emitted.
    fn drain_to_encoder(&mut self, encoder: &mut Mp4Encoder) -> Result<u64> {
        const FRAME_SIZE: usize = 1024;
        let mut emitted = 0u64;
        let limit = self.drain_limit();
        while self.channels[0].len() >= FRAME_SIZE
            && self.buffer_start_pts.unwrap_or(0) + FRAME_SIZE as i64 <= limit
        {
            let pts = self.buffer_start_pts.unwrap_or(0);
            let mut frame = ffmpeg::frame::Audio::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                FRAME_SIZE,
                ffmpeg::ChannelLayout::STEREO,
            );
            frame.set_rate(SAMPLE_RATE as u32);
            frame.set_pts(Some(pts));

            let mut block = vec![[0.0f32; 2]; FRAME_SIZE];
            let mut peak = 0.0f32;
            for ch in 0..(AUDIO_CHANNELS as usize) {
                for slot in block.iter_mut() {
                    let v = self.channels[ch].pop_front().unwrap_or(0.0);
                    slot[ch] = v;
                    peak = peak.max(v.abs());
                }
            }
            self.limit_block(&mut block, peak);
            for ch in 0..(AUDIO_CHANNELS as usize) {
                let dst = frame.plane_mut::<f32>(ch);
                for (sample, slot) in dst.iter_mut().zip(block.iter()) {
                    *sample = slot[ch];
                }
            }

            self.buffer_start_pts = Some(pts + FRAME_SIZE as i64);
            encoder.queue_audio(frame)?;
            emitted += 1;
        }
        Ok(emitted)
    }

    /// Final flush — emit one partial frame for whatever's left.
    fn flush(&mut self, encoder: &mut Mp4Encoder) -> Result<u64> {
        // Stop time: no more input is coming, so the laggard gate must not
        // hold anything back. Marking every source as caught up lets the
        // normal drain emit the remaining full frames.
        let leader = self.frontiers.iter().flatten().copied().max();
        if let Some(leader) = leader {
            for f in self.frontiers.iter_mut() {
                if f.is_some() {
                    *f = Some(leader);
                }
            }
        }
        let mut emitted = self.drain_to_encoder(encoder)?;
        let leftover = self.channels[0].len();
        if leftover > 0 {
            let pts = self.buffer_start_pts.unwrap_or(0);
            let mut frame = ffmpeg::frame::Audio::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                leftover,
                ffmpeg::ChannelLayout::STEREO,
            );
            frame.set_rate(SAMPLE_RATE as u32);
            frame.set_pts(Some(pts));

            let mut block = vec![[0.0f32; 2]; leftover];
            let mut peak = 0.0f32;
            for ch in 0..(AUDIO_CHANNELS as usize) {
                for slot in block.iter_mut() {
                    let v = self.channels[ch].pop_front().unwrap_or(0.0);
                    slot[ch] = v;
                    peak = peak.max(v.abs());
                }
            }
            self.limit_block(&mut block, peak);
            for ch in 0..(AUDIO_CHANNELS as usize) {
                let dst = frame.plane_mut::<f32>(ch);
                for (sample, slot) in dst.iter_mut().zip(block.iter()) {
                    *sample = slot[ch];
                }
            }
            encoder.queue_audio(frame)?;
            emitted += 1;
        }
        Ok(emitted)
    }
}

#[cfg(test)]
mod cursor_sidecar_tests {
    //! End-to-end check that exercises the cursor track → sidecar JSON
    //! pipeline without going anywhere near ScreenCaptureKit. This is the
    //! integration test that proves the recording lifecycle wires up
    //! correctly: tracker runs in its own thread, we stop + harvest it,
    //! the sidecar writer produces JSON files, and the JSON parses back
    //! into the same shapes native Studio consumes.
    //!
    //! What's NOT covered here: the encoder pump, SCK capture, the
    //! uploader. Each of those has its own test (`encoder::tests`,
    //! `upload::tests`). Together they cover the live pipeline end-to-end.
    use crate::cursor_track::{
        CaptureViewport, CoordSpace, CursorEvent, CursorTrack, CursorTracker,
    };
    use crate::types::{
        AudioOptionsDto, CaptureSourceDto, CaptureSourceMetadataDto, RecordingMode,
        RecordingSourceTab, StudioRecordingDto, WebcamCaptureDto, WebcamLayoutDto,
    };
    use crate::zoom_segments::{FocalCurvePoint, ZoomSegment};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    #[cfg(target_os = "macos")]
    #[test]
    fn camera_video_timeline_excludes_pause_and_remains_monotonic() {
        use super::{
            apply_pending_pause_shift, next_video_pts, us_to_mach_delta, PauseState, VideoSample,
        };
        let timebase = cidre::mach::TimeBaseInfo::new();
        let sample = |elapsed_us| VideoSample::Camera {
            frame: ffmpeg::frame::Video::empty(),
            mach_pts: us_to_mach_delta(elapsed_us, &timebase),
        };
        let mut anchor = None;
        let mut previous = -1;
        assert_eq!(
            next_video_pts(&sample(1_000_000), &timebase, &mut anchor, &mut previous).unwrap(),
            0
        );
        assert_eq!(
            next_video_pts(&sample(1_033_333), &timebase, &mut anchor, &mut previous).unwrap(),
            33_333
        );
        let pause = PauseState::new();
        pause
            .pending_shift_us
            .store(2_000_000, std::sync::atomic::Ordering::Release);
        assert!(apply_pending_pause_shift(&pause, &mut anchor, &timebase));
        assert!(
            !apply_pending_pause_shift(&pause, &mut anchor, &timebase),
            "a pause window is consumed once"
        );
        assert_eq!(
            next_video_pts(&sample(3_066_666), &timebase, &mut anchor, &mut previous).unwrap(),
            66_666
        );
        assert_eq!(
            next_video_pts(&sample(3_066_666), &timebase, &mut anchor, &mut previous).unwrap(),
            66_667
        );
    }

    #[test]
    fn window_takes_record_their_capture_mode_even_without_picker_metadata() {
        use crate::types::{CaptureSourceDto, RecordingSourceTab, WindowCaptureModeDto};
        let window = CaptureSourceDto::Window { id: 7 };

        // Agent bridge and hotkey starts pass no metadata of their own.
        let agent = super::stamp_window_capture(None, Some(&window), true).unwrap();
        assert_eq!(agent.source_tab, RecordingSourceTab::Window);
        assert!(matches!(
            agent.source,
            Some(CaptureSourceDto::Window { id: 7 })
        ));
        assert_eq!(agent.window_capture, Some(WindowCaptureModeDto::Window));
        let area = super::stamp_window_capture(None, Some(&window), false).unwrap();
        assert_eq!(area.window_capture, Some(WindowCaptureModeDto::Area));

        // A display take without metadata stays without it.
        let display = CaptureSourceDto::Display { id: 1 };
        assert!(super::stamp_window_capture(None, Some(&display), false).is_none());
        assert!(super::stamp_window_capture(None, None, false).is_none());

        // Picker metadata keeps its own fields and gains the mode.
        let picked = crate::types::CaptureSourceMetadataDto {
            source_tab: RecordingSourceTab::Window,
            source: Some(window.clone()),
            window_app_name: Some("Safari".into()),
            window_title: Some("Docs".into()),
            controlled_evidence: None,
            window_capture: None,
        };
        let stamped = super::stamp_window_capture(Some(picked), Some(&window), true).unwrap();
        assert_eq!(stamped.window_title.as_deref(), Some("Docs"));
        assert_eq!(stamped.window_capture, Some(WindowCaptureModeDto::Window));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn active_capture_is_window_only_follows_the_live_recording() {
        let rec = super::RecordingController::new("http://localhost:3000".to_string());
        assert!(
            !rec.active_capture_is_window_only(),
            "idle is not a window-only take"
        );

        let seed = |window_only: bool| super::ActiveRecording {
            recording_id: "rec-1".to_string(),
            file_path: PathBuf::from("/tmp/rec-1.mp4"),
            started_at: Instant::now(),
            pause: super::PauseState::new(),
            bearer: "token".to_string(),
            api_base: "http://localhost:3000".to_string(),
            cursor_tracker: None,
            cursor_capture: None,
            capture_source: None,
            window_only,
            mode: RecordingMode::Instant,
            webcam: None,
            audio: AudioOptionsDto::default(),
            shutdown_tx: None,
            pump_task: None,
            ticker_task: None,
            uploader: None,
            screen: None,
            mic: None,
        };

        *rec.active.lock() = Some(seed(true));
        assert!(rec.active_capture_is_window_only());

        *rec.active.lock() = Some(seed(false));
        assert!(!rec.active_capture_is_window_only());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn active_webcam_context_includes_capture_rect_for_toolbar_toggle() {
        let rec = super::RecordingController::new("http://localhost:3000".to_string());
        let capture = CaptureViewport {
            x: 120.0,
            y: 64.0,
            width: 1440.0,
            height: 900.0,
            output_width: 1440,
            output_height: 900,
            screen_x: Some(0.0),
            screen_y: Some(0.0),
            screen_width: Some(1440.0),
            screen_height: Some(900.0),
        };
        let webcam = WebcamCaptureDto {
            enabled: true,
            layout: WebcamLayoutDto::Bubble,
            shape: crate::types::WebcamShapeDto::Square,
            size: crate::types::WebcamSizeDto::Medium,
            device_id: Some("camera-1".to_string()),
        };

        *rec.active.lock() = Some(super::ActiveRecording {
            recording_id: "rec-1".to_string(),
            file_path: PathBuf::from("/tmp/rec-1.mp4"),
            started_at: Instant::now(),
            pause: super::PauseState::new(),
            bearer: "token".to_string(),
            api_base: "http://localhost:3000".to_string(),
            cursor_tracker: None,
            cursor_capture: Some(capture),
            capture_source: None,
            window_only: false,
            mode: RecordingMode::Instant,
            webcam: Some(webcam.clone()),
            audio: AudioOptionsDto::default(),
            shutdown_tx: None,
            pump_task: None,
            ticker_task: None,
            uploader: None,
            screen: None,
            mic: None,
        });

        let (actual_webcam, mode, rect) = rec.active_webcam_context().expect("active recording");

        assert_eq!(
            actual_webcam.map(|w| w.device_id),
            Some(webcam.device_id.clone())
        );
        assert_eq!(mode, RecordingMode::Instant);
        let rect = rect.expect("capture rect");
        assert_eq!(
            (rect.x, rect.y, rect.width, rect.height),
            (120.0, 64.0, 1440.0, 900.0)
        );
        rec.update_active_webcam_appearance(
            crate::types::WebcamShapeDto::Circle,
            crate::types::WebcamSizeDto::Large,
        );
        let (updated, updated_mode, updated_rect) = rec.active_webcam_context().unwrap();
        let updated = updated.unwrap();
        assert_eq!(updated.shape, crate::types::WebcamShapeDto::Circle);
        assert_eq!(updated.size, crate::types::WebcamSizeDto::Large);
        assert_eq!(updated.device_id, webcam.device_id);
        assert_eq!(updated_mode, mode);
        assert_eq!(updated_rect.unwrap().width, rect.width);
    }

    #[cfg(target_os = "macos")]
    fn silent_mix_frame(samples: usize, pts: i64) -> ffmpeg::frame::Audio {
        let mut frame = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
            samples,
            ffmpeg::ChannelLayout::STEREO,
        );
        frame.set_rate(super::SAMPLE_RATE as u32);
        for plane in 0..2 {
            frame.data_mut(plane).fill(0);
        }
        frame.set_pts(Some(pts));
        frame
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_audio_mixer_waits_for_slowest_started_source() {
        let mut mixer = super::LiveAudioMixer::new(["system_audio", "mic"]).expect("audio mixer");
        mixer
            .push(silent_mix_frame(960, 0), "mic")
            .expect("push mic");
        mixer
            .push(
                silent_mix_frame(
                    super::LiveAudioMixer::LATENCY_SAMPLES as usize
                        + super::LiveAudioMixer::DRAIN_CHUNK_SAMPLES
                        + 960,
                    960,
                ),
                "mic",
            )
            .expect("push later mic");
        assert!(
            mixer.ready_until_pts(0).is_none(),
            "mixer should not drain while an expected source has not started"
        );
        mixer
            .push(silent_mix_frame(960, 5140), "system_audio")
            .expect("push delayed system audio");
        assert!(
            mixer.ready_until_pts(0).is_some_and(|pts| pts <= 0),
            "slow source should hold back ready audio until it catches up"
        );
        assert_eq!(mixer.dropped_stale_frames, 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_audio_mixer_does_not_grow_forever_behind_a_stalled_source() {
        let mut mixer = super::LiveAudioMixer::new(["system_audio", "mic"]).expect("audio mixer");
        mixer.mark_source_seen("mic", 960);
        mixer.mark_source_seen("system_audio", super::SAMPLE_RATE as i64 * 30);

        // Assert the exact bound, not merely "> 0": the laggard bypass must
        // advance to `max_seen - STARTUP_GRACE - LATENCY`. A regression that
        // silently changed which term is subtracted would still be positive.
        let expected = super::SAMPLE_RATE as i64 * 30
            - super::LiveAudioMixer::STARTUP_GRACE_SAMPLES
            - super::LiveAudioMixer::LATENCY_SAMPLES;
        assert_eq!(
            mixer.ready_until_pts(0),
            Some(expected),
            "an inactive source must stop pinning the mixed PCM buffer"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_mic_channel_selection_uses_the_lane_that_carries_signal() {
        let mut selector = super::MicChannelSelector::default();
        let channel_zero_active = [0.5_f32, 0.0, -0.5, 0.0];
        let channel_one_active = [0.0_f32, 0.5, 0.0, -0.5];

        assert_eq!(selector.select(&channel_zero_active, 2), 0);
        assert_eq!(selector.select(&channel_one_active, 2), 1);
        assert_eq!(selector.select(&[0.25, -0.25], 1), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_mic_channel_selection_stabilizes_after_initial_signal() {
        let mut selector = super::MicChannelSelector::default();
        let channel_one_active = (0..4_800)
            .flat_map(|_| [0.001_f32, 0.05])
            .collect::<Vec<_>>();

        assert_eq!(selector.select(&channel_one_active, 2), 1);
        assert_eq!(selector.selected, Some(1));
        assert_eq!(selector.select(&[0.5, 0.0, -0.5, 0.0], 2), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_audio_mixer_preserves_original_mic_waveform() {
        let mut mixer = super::LiveAudioMixer::new(["mic"]).expect("audio mixer");
        let samples = super::LiveAudioMixer::DRAIN_CHUNK_SAMPLES;
        for block in 0..20 {
            let original = (0..samples)
                .map(|index| {
                    let time = (block * samples + index) as f32 / 48_000.0;
                    0.4 * (2.0 * std::f32::consts::PI * 1_000.0 * time).sin()
                })
                .collect::<Vec<_>>();
            let mut input = silent_mix_frame(samples, (block * samples) as i64);
            for channel in 0..2 {
                input.plane_mut::<f32>(channel).copy_from_slice(&original);
            }
            mixer.push(input, "mic").expect("push mic");
            let output = mixer.pop_frame(samples).expect("mix audio");
            for channel in 0..2 {
                let max_error = output
                    .plane::<f32>(channel)
                    .iter()
                    .zip(&original)
                    .map(|(actual, expected)| (actual - expected).abs())
                    .fold(0.0_f32, f32::max);
                assert!(max_error < 1.0e-6, "mic waveform changed: {max_error}");
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_noise_suppression_is_off_unless_the_recording_asked_for_it() {
        let off = super::LiveAudioMixer::new(["system_audio", "mic"])
            .expect("audio mixer")
            .with_noise_suppression(false);
        assert!(off.mic_denoiser.is_none(), "the filter must be opt-in");

        let on = super::LiveAudioMixer::new(["system_audio", "mic"])
            .expect("audio mixer")
            .with_noise_suppression(true);
        assert!(on.mic_denoiser.is_some());

        // System audio is the machine, not a room: nothing to estimate.
        let system_only = super::LiveAudioMixer::new(["system_audio"])
            .expect("audio mixer")
            .with_noise_suppression(true);
        assert!(system_only.mic_denoiser.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_noise_suppression_quietens_the_room_and_leaves_system_audio_alone() {
        // Steady noise on the mic lane, a tone on the system lane. Afterwards
        // the mix should hold noticeably less of the room while the system
        // audio arrives at exactly the level it was played at — the filter
        // must never reach across into what the user's speakers produced.
        let samples = super::LiveAudioMixer::DRAIN_CHUNK_SAMPLES;
        let blocks = 40; // 3.2 s: past the estimator's ~1.4 s window.
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let room: Vec<f32> = (0..samples * blocks)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                0.05 * ((state >> 40) as f32 / 8_388_608.0 - 1.0)
            })
            .collect();
        let played: Vec<f32> = (0..samples * blocks)
            .map(|n| 0.2 * (2.0 * std::f32::consts::PI * 440.0 * n as f32 / 48_000.0).sin())
            .collect();

        let run = |suppress: bool| {
            let mut mixer = super::LiveAudioMixer::new(["system_audio", "mic"])
                .expect("audio mixer")
                .with_noise_suppression(suppress);
            let mut mixed = Vec::new();
            for block in 0..blocks {
                let span = block * samples..(block + 1) * samples;
                for (label, source) in [("mic", &room), ("system_audio", &played)] {
                    let mut frame = silent_mix_frame(samples, (block * samples) as i64);
                    for channel in 0..2 {
                        frame.plane_mut::<f32>(channel)[..samples]
                            .copy_from_slice(&source[span.clone()]);
                    }
                    mixer.push(frame, label).expect("push");
                }
                let output = mixer.pop_frame(samples).expect("mix");
                mixed.extend_from_slice(&output.plane::<f32>(0)[..samples]);
            }
            mixed
        };

        let filtered = run(true);
        let untouched = run(false);
        // Measure over the last second, once the estimate has settled.
        let tail = filtered.len() - 48_000..filtered.len();
        let residual = |mixed: &[f32]| {
            tail.clone()
                .map(|i| {
                    let played_here = played[i];
                    ((mixed[i] - played_here) as f64).powi(2)
                })
                .sum::<f64>()
                .sqrt()
        };
        assert!(
            residual(&filtered) < residual(&untouched) * 0.5,
            "the room was not quietened: {} against {}",
            residual(&filtered),
            residual(&untouched)
        );

        // And the system lane came through the untouched mix exactly.
        for index in tail {
            assert!(
                (untouched[index] - (played[index] + room[index])).abs() < 1.0e-6,
                "unfiltered mix changed at {index}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_a_new_microphone_generation_restarts_the_noise_estimate() {
        // The reset belongs at the boundary in the BUFFER, not at the moment
        // the new device's first chunk is received. Those are up to
        // LATENCY_SAMPLES apart, and resetting on arrival cleared a converged
        // estimate and then let the old device's still-queued audio retrain it
        // — so the new microphone got filtered with the old one's profile and
        // no reset was left to correct it.
        let mut mixer = super::LiveAudioMixer::new(["mic"])
            .expect("audio mixer")
            .with_noise_suppression(true);
        let generation = crate::capture::audio::MicStreamGeneration::initial();
        assert!(mixer.begin_mic_generation(generation));

        let samples = super::LiveAudioMixer::DRAIN_CHUNK_SAMPLES;
        let learned = |mixer: &super::LiveAudioMixer| {
            mixer
                .mic_denoiser
                .as_ref()
                .expect("denoiser")
                .windows_learned()
        };
        let push_block = |mixer: &mut super::LiveAudioMixer, block: usize, level: f32| {
            let mut frame = silent_mix_frame(samples, (block * samples) as i64);
            for channel in 0..2 {
                frame.plane_mut::<f32>(channel)[..samples].fill(level);
            }
            mixer.push(frame, "mic").expect("push mic");
        };

        // Old device: enough audio for the estimate to fill its window.
        for block in 0..20 {
            push_block(&mut mixer, block, 0.02);
            mixer.pop_frame(samples).expect("mix");
        }
        assert!(learned(&mixer) > 0, "the filter built no estimate at all");
        let before_switch = learned(&mixer);

        // The device is reopened. Nothing has been drained yet, so nothing
        // about the estimate may change here.
        let next = generation.next();
        assert!(mixer.begin_mic_generation(next));
        assert_eq!(
            learned(&mixer),
            before_switch,
            "the estimate was thrown away while the old device's audio was still queued"
        );

        // The new device's first block is pushed, and the reset lands when the
        // mixer drains it rather than when it arrived.
        push_block(&mut mixer, 20, 0.02);
        assert_eq!(
            learned(&mixer),
            before_switch,
            "a queued boundary must not reset the filter before it is reached"
        );
        mixer.pop_frame(samples).expect("mix");
        assert!(
            learned(&mixer) < before_switch,
            "the filter did not restart when the new microphone's audio was drained"
        );
        assert!(
            mixer.mic_reset_pts.is_empty(),
            "the boundary should be consumed once it is crossed"
        );
    }

    /// Speech-like microphone input for the noise tests: a 1 kHz tone in
    /// 150 ms bursts, so the filter's noise floor is the gaps, not the tone.
    #[cfg(target_os = "macos")]
    fn bursty_tone(position: usize) -> f32 {
        if (position / 7_200).is_multiple_of(2) {
            0.3 * (2.0 * std::f32::consts::PI * 1_000.0 * position as f32 / 48_000.0).sin()
        } else {
            0.0
        }
    }

    /// Pushes `chunks` microphone chunks of `CHUNK` samples from `position`,
    /// popping a mixed block whenever a whole one is buffered, the way the
    /// pump's 10 ms mic callbacks meet the mixer's 80 ms drain.
    #[cfg(target_os = "macos")]
    fn feed_mic(
        mixer: &mut super::LiveAudioMixer,
        position: &mut usize,
        chunks: usize,
        signal: impl Fn(usize) -> f32,
        mixed: &mut Vec<f32>,
    ) {
        const CHUNK: usize = 480;
        let block = super::LiveAudioMixer::DRAIN_CHUNK_SAMPLES;
        for _ in 0..chunks {
            let mut frame = silent_mix_frame(CHUNK, *position as i64);
            for channel in 0..2 {
                for (index, sample) in frame.plane_mut::<f32>(channel)[..CHUNK]
                    .iter_mut()
                    .enumerate()
                {
                    *sample = signal(*position + index);
                }
            }
            mixer.push(frame, "mic").expect("push mic");
            *position += CHUNK;
            while mixed.len() + block <= *position {
                let output = mixer.pop_frame(block).expect("mix");
                mixed.extend_from_slice(&output.plane::<f32>(0)[..block]);
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_noise_suppression_keeps_the_microphone_silent_from_the_moment_it_is_muted() {
        // The pump zeroes muted PCM, but the filter still holds ~21 ms of what
        // was said just before the mute. That must not reach the recording.
        let mut mixer = super::LiveAudioMixer::new(["mic"])
            .expect("audio mixer")
            .with_noise_suppression(true);
        let mut position = 0;
        let mut mixed = Vec::new();

        // 1.01 s of speech, ending in the middle of a burst and of a block.
        feed_mic(&mut mixer, &mut position, 101, bursty_tone, &mut mixed);
        let muted_at = position;
        assert_ne!(
            bursty_tone(muted_at - 1),
            0.0,
            "the mute must land mid-word"
        );

        mixer.set_mic_muted(true);
        feed_mic(&mut mixer, &mut position, 100, |_| 0.0, &mut mixed);
        let unmuted_at = position;
        mixer.set_mic_muted(false);
        feed_mic(&mut mixer, &mut position, 100, bursty_tone, &mut mixed);

        let leak = mixed[muted_at..unmuted_at]
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        assert_eq!(
            leak, 0.0,
            "speech from before the mute was recorded after it"
        );

        // The mute starts where it was pressed, not at the start of the mixer
        // block that holds it: the speech just before it is kept.
        let before = mixed[muted_at - 512..muted_at]
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        assert!(
            before > 0.05,
            "speech from before the mute was cut: {before}"
        );
        let after = mixed[unmuted_at + crate::denoise::LATENCY_SAMPLES..]
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        assert!(after > 0.05, "the microphone stayed silent after unmuting");
        assert!(
            mixer.mic_muted_ranges.is_empty(),
            "drained ranges must be released"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_noise_suppression_does_not_replay_pre_pause_audio_after_a_resume() {
        // While paused the pump drops mic chunks and the pause shift closes the
        // gap, so the first audio after the resume sits right after the last
        // audio before the pause. The filter's buffered pre-pause tail must be
        // dropped there, not played at the resumed position.
        let mut mixer = super::LiveAudioMixer::new(["mic"])
            .expect("audio mixer")
            .with_noise_suppression(true);
        let mut position = 0;
        let mut mixed = Vec::new();

        feed_mic(&mut mixer, &mut position, 101, bursty_tone, &mut mixed);
        let resumed_at = position;
        // Chunks dropped while paused.
        for _ in 0..50 {
            mixer.note_mic_cut();
        }
        // The room is quiet after the resume.
        feed_mic(&mut mixer, &mut position, 100, |_| 0.0, &mut mixed);

        // What the filter knew about the room is kept across a pause.
        let learned = mixer
            .mic_denoiser
            .as_ref()
            .expect("denoiser")
            .windows_learned();
        assert!(learned > 0, "the noise floor was thrown away at the pause");

        let kept = mixed[resumed_at - 512..resumed_at]
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        assert!(kept > 0.05, "audio before the pause was cut early: {kept}");

        let replayed = mixed[resumed_at..]
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        assert!(
            replayed < 1.0e-6,
            "audio from before the pause was played after the resume: {replayed}"
        );
        assert!(
            mixer.mic_cut_pts.is_empty(),
            "the cut should be consumed once crossed"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_live_mute_silences_mic_chunks_only_while_muted() {
        let pause = super::PauseState::new();
        let mut speech = vec![0.25_f32, -0.5, 0.75];
        assert!(!super::apply_live_mic_mute(&pause, &mut speech));
        assert_eq!(
            speech,
            [0.25, -0.5, 0.75],
            "an unmuted chunk must pass through"
        );

        pause.set_mic_muted(true);
        assert!(super::apply_live_mic_mute(&pause, &mut speech));
        assert_eq!(speech, [0.0; 3], "a muted chunk must be silenced");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_mic_resampling_is_continuous_across_callback_boundaries() {
        ffmpeg::init().expect("initialize ffmpeg");
        let generation = crate::capture::audio::MicStreamGeneration::initial();
        for rate in [8_000, 16_000, 24_000, 44_100, 96_000] {
            let input = (0..rate)
                .map(|index| {
                    0.2 * (2.0 * std::f32::consts::PI * 1_000.0 * index as f32 / rate as f32).sin()
                })
                .collect::<Vec<_>>();
            let mut whole = super::MicResampler::new(rate, generation).expect("resampler");
            let expected = whole.resample(&input).expect("whole signal");
            let mut streaming = super::MicResampler::new(rate, generation).expect("resampler");
            let mut actual = Vec::new();
            for chunk in input.chunks(127) {
                actual.extend(streaming.resample(chunk).expect("callback"));
            }
            assert_eq!(actual.len(), expected.len(), "rate={rate}");
            assert!((47_800..=48_000).contains(&actual.len()), "rate={rate}");
            let max_error = actual
                .iter()
                .zip(&expected)
                .map(|(actual, expected)| (actual - expected).abs())
                .fold(0.0_f32, f32::max);
            assert!(
                max_error < 1.0e-5,
                "callback discontinuity at {rate} Hz: {max_error}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_mic_resampling_resets_on_device_reopen_and_keeps_capture_clock() {
        ffmpeg::init().expect("initialize ffmpeg");
        let generation = crate::capture::audio::MicStreamGeneration::initial();
        let timebase = cidre::mach::TimeBaseInfo { numer: 1, denom: 1 };
        let mut timeline = super::MicTimeline::default();
        let mut selector = super::MicChannelSelector::default();
        let mut resampler = None;
        for (index, rate, value, generation) in [
            (1, 44_100, 0.4_f32, generation),
            (2, 44_100, 0.0, generation.next()),
            (3, 48_000, 0.2, generation.next().next()),
        ] {
            let chunk = crate::capture::audio::AudioPcmF32 {
                samples: vec![value; rate as usize / 10],
                sample_rate: rate,
                channels: 1,
                generation,
                mach_pts: index * 100_000_000 + 1,
            };
            let output = super::mic_audio_frame(
                &chunk,
                &timebase,
                Some(1),
                &mut timeline,
                &mut selector,
                &mut resampler,
            )
            .expect("convert mic")
            .expect("audio frame");
            // Each reopen carries its own HAL capture time and lands exactly
            // there on the shared clock — no carry-over from the old device.
            assert_eq!(output.pts(), Some(index as i64 * 4_800));
            assert_eq!(
                timeline.placed_end_pts,
                index as i64 * 4_800 + output.samples() as i64
            );
            if value == 0.0 {
                assert!(output.plane::<f32>(0).iter().all(|sample| *sample == 0.0));
            }
            if rate == 48_000 {
                assert_eq!(output.samples(), 4_800);
                assert_eq!(output.plane::<f32>(0), chunk.samples);
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_mic_resampler_converts_44k1_to_48k_without_invalid_samples() {
        ffmpeg::init().expect("initialize ffmpeg");
        let generation = crate::capture::audio::MicStreamGeneration::initial();
        let mut resampler = super::MicResampler::new(44_100, generation).expect("resampler");
        let input = (0..4_410)
            .map(|index| {
                let time = index as f32 / 44_100.0;
                0.2 * (2.0 * std::f32::consts::PI * 1_000.0 * time).sin()
            })
            .collect::<Vec<_>>();

        let output = resampler.resample(&input).expect("resample audio");

        assert!((4_700..=4_900).contains(&output.len()));
        assert!(output.iter().all(|sample| sample.is_finite()));
        assert!(output.iter().any(|sample| sample.abs() > 0.1));
    }

    // Not Windows-gated: the macOS Desktop Check runs it, so the Windows
    // conversion path is exercised on every PR.
    #[test]
    fn windows_audio_lane_resamples_non_48k_devices_continuously() {
        // 44.1 kHz and 32 kHz devices used to be dropped
        // with one error per chunk. They now resample to the encoder rate.
        ffmpeg::init().expect("initialize ffmpeg");
        for rate in [44_100u32, 32_000, 16_000] {
            let mut lane = super::LaneRateConverter::new("mic");
            let chunk = (rate / 100) as usize; // 10 ms callbacks
            let mut produced = 0usize;
            for callback in 0..100usize {
                let tone = (0..chunk)
                    .map(|index| {
                        let time = (callback * chunk + index) as f32 / rate as f32;
                        0.2 * (2.0 * std::f32::consts::PI * 440.0 * time).sin()
                    })
                    .collect::<Vec<_>>();
                let [left, right] = lane
                    .resample(rate, [tone.clone(), tone])
                    .expect("resample")
                    .expect("resampler available");
                assert_eq!(left.len(), right.len());
                assert!(left.iter().chain(right.iter()).all(|sample| sample.is_finite()));
                produced += left.len();
            }
            // One second of input is one second at 48 kHz, minus the
            // filter's small startup delay.
            let expected = super::SAMPLE_RATE as usize;
            assert!(
                produced <= expected && produced + 256 >= expected,
                "{rate} Hz produced {produced} samples for one second"
            );
        }
    }

    // Not Windows-gated, like the resampler test above: the Windows filter
    // path runs on every PR's macOS check.
    #[test]
    fn windows_noise_filter_is_off_unless_the_recording_asked_for_it() {
        assert!(super::LaneNoiseFilter::new(false).denoisers.is_none());
        assert!(super::LaneNoiseFilter::new(true).denoisers.is_some());

        // Off means untouched, sample for sample, including a stereo mic
        // whose channels differ.
        let mut off = super::LaneNoiseFilter::new(false);
        let left: Vec<f32> = (0..480).map(|n| (n as f32 * 0.01).sin() * 0.3).collect();
        let right: Vec<f32> = left.iter().map(|sample| -sample * 0.5).collect();
        let mut planes = [left.clone(), right.clone()];
        off.process(&mut planes);
        assert_eq!(planes, [left, right]);
    }

    #[test]
    fn windows_noise_filter_keeps_the_microphone_channels_apart() {
        // A two-input interface with only the first input live, and a pair
        // wired in opposite polarity. Averaging to mono would halve the first
        // and cancel the second; filtering per channel keeps both.
        let latency = crate::denoise::LATENCY_SAMPLES;
        let tone: Vec<f32> = (0..19_200)
            .map(|n| 0.3 * (2.0 * std::f32::consts::PI * 440.0 * n as f32 / 48_000.0).sin())
            .collect();
        let mut filter = super::LaneNoiseFilter::new(true);
        let mut one_sided = [Vec::new(), Vec::new()];
        let mut inverted = [Vec::new(), Vec::new()];
        let mut opposite = super::LaneNoiseFilter::new(true);
        for block in tone.chunks(480) {
            let mut planes = [block.to_vec(), vec![0.0; block.len()]];
            filter.process(&mut planes);
            one_sided[0].extend_from_slice(&planes[0]);
            one_sided[1].extend_from_slice(&planes[1]);

            let mut planes = [block.to_vec(), block.iter().map(|s| -s).collect()];
            opposite.process(&mut planes);
            inverted[0].extend_from_slice(&planes[0]);
            inverted[1].extend_from_slice(&planes[1]);
        }

        let energy = |samples: &[f32]| samples.iter().map(|s| (*s as f64).powi(2)).sum::<f64>();
        let span = latency..tone.len();
        let input = energy(&tone[..tone.len() - latency]);
        assert!(
            energy(&one_sided[0][span.clone()]) > input * 0.8,
            "the live input lost level: {} against {input}",
            energy(&one_sided[0][span.clone()])
        );
        assert!(one_sided[1].iter().all(|s| *s == 0.0), "the silent input picked up signal");
        assert!(energy(&inverted[1][span]) > input * 0.8, "opposite channels cancelled");
        for (left, right) in inverted[0].iter().zip(&inverted[1]) {
            assert!((left + right).abs() < 1.0e-6, "the channels stopped mirroring");
        }
    }

    #[test]
    fn windows_noise_filter_records_nothing_while_muted() {
        // The pump zeroes a muted chunk before the filter, but the filter
        // still holds ~21 ms of speech from before the mute. None of it may
        // come out while the mute is on.
        let speech: Vec<f32> = (0..480)
            .map(|n| 0.3 * (2.0 * std::f32::consts::PI * 440.0 * n as f32 / 48_000.0).sin())
            .collect();
        let mut filter = super::LaneNoiseFilter::new(true);
        let feed = |filter: &mut super::LaneNoiseFilter, muted: bool| {
            filter.muted = muted;
            let input = if muted { vec![0.0; speech.len()] } else { speech.clone() };
            let mut planes = [input.clone(), input];
            filter.process(&mut planes);
            planes
        };
        for _ in 0..20 {
            feed(&mut filter, false);
        }
        for _ in 0..5 {
            let planes = feed(&mut filter, true);
            assert!(
                planes.iter().flatten().all(|s| *s == 0.0),
                "speech from before the mute was recorded"
            );
        }
        let mut resumed = Vec::new();
        for _ in 0..10 {
            resumed.extend(feed(&mut filter, false)[0].clone());
        }
        assert!(resumed.iter().any(|s| s.abs() > 0.05), "unmuting did not bring the mic back");
    }

    #[test]
    fn windows_noise_filter_does_not_replay_speech_after_a_pause() {
        // Speak, pause (the pump drops those chunks), resume in silence: the
        // filter's buffered tail from before the pause must not come out at
        // the resume.
        let speech: Vec<f32> = (0..480)
            .map(|n| 0.3 * (2.0 * std::f32::consts::PI * 440.0 * n as f32 / 48_000.0).sin())
            .collect();
        let mut filter = super::LaneNoiseFilter::new(true);
        for _ in 0..20 {
            filter.process(&mut [speech.clone(), speech.clone()]);
        }
        filter.discard_buffered();
        for _ in 0..5 {
            let mut planes = [vec![0.0; 480], vec![0.0; 480]];
            filter.process(&mut planes);
            assert!(
                planes.iter().flatten().all(|s| *s == 0.0),
                "speech from before the pause was replayed"
            );
        }
    }

    #[test]
    fn windows_noise_filter_quietens_a_steady_room_on_the_mic_lane() {
        // Steady noise in 10 ms callbacks, the size cpal delivers on Windows
        // and deliberately not a multiple of the filter's hop.
        let chunk = 480;
        let chunks = 320; // 3.2 s: past the estimator's ~1.4 s window.
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let room: Vec<f32> = (0..chunk * chunks)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                0.05 * ((state >> 40) as f32 / 8_388_608.0 - 1.0)
            })
            .collect();

        let run = |enabled: bool| {
            let mut filter = super::LaneNoiseFilter::new(enabled);
            let mut out = Vec::with_capacity(room.len());
            for block in room.chunks(chunk) {
                let mut planes = [block.to_vec(), block.to_vec()];
                filter.process(&mut planes);
                assert_eq!(planes[0].len(), block.len(), "the filter changed the length");
                assert_eq!(planes[0], planes[1], "a mono mic must stay identical on both sides");
                out.extend_from_slice(&planes[0]);
            }
            out
        };

        let filtered = run(true);
        let untouched = run(false);
        assert_eq!(filtered.len(), room.len());
        assert_eq!(untouched, room);
        // Measure over the last second, once the estimate has settled.
        let tail = filtered.len() - 48_000..;
        let energy = |samples: &[f32]| {
            samples.iter().map(|s| (*s as f64).powi(2)).sum::<f64>().sqrt()
        };
        assert!(
            energy(&filtered[tail.clone()]) < energy(&untouched[tail.clone()]) * 0.5,
            "the room was not quietened: {} against {}",
            energy(&filtered[tail.clone()]),
            energy(&untouched[tail])
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_mic_processing_resets_when_stream_generation_changes() {
        let mut selector = super::MicChannelSelector::default();
        let mut mixer = super::LiveAudioMixer::new(["mic"]).expect("audio mixer");
        let first_generation = crate::capture::audio::MicStreamGeneration::initial();
        let next_generation = first_generation.next();
        let channel_one_active = (0..4_800)
            .flat_map(|_| [0.001_f32, 0.05])
            .collect::<Vec<_>>();
        let channel_zero_active = (0..4_800)
            .flat_map(|_| [0.05_f32, 0.001])
            .collect::<Vec<_>>();

        assert_eq!(
            selector.select_for_generation(&channel_one_active, 2, first_generation),
            1
        );
        assert!(mixer.begin_mic_generation(first_generation));
        assert!(mixer.begin_mic_generation(next_generation));

        assert_eq!(
            selector.select_for_generation(&channel_zero_active, 2, next_generation),
            0
        );
        assert!(mixer.begin_mic_generation(next_generation));
        assert!(!mixer.begin_mic_generation(first_generation));
        assert_eq!(mixer.mic_generation, Some(next_generation));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_audio_mixer_silent_system_lane_does_not_halve_microphone_level() {
        let mut mixer = super::LiveAudioMixer::new(["mic", "system_audio"]).unwrap();
        let mut generation = crate::capture::audio::MicStreamGeneration::initial();
        let count = super::LiveAudioMixer::DRAIN_CHUNK_SAMPLES;
        for block in 0..6 {
            if block == 3 {
                generation = generation.next();
            }
            assert!(mixer.begin_mic_generation(generation));
            let pts = (block * count) as i64;
            let samples = if block == 5 { 73 } else { count };
            let level = if block == 2 { 0.0 } else { 0.02 };
            let mut mic = silent_mix_frame(samples, pts);
            for channel in 0..2 {
                mic.plane_mut::<f32>(channel).fill(level);
            }
            mixer.push(mic, "mic").unwrap();
            if block % 2 == 0 {
                mixer
                    .push(silent_mix_frame(samples, pts), "system_audio")
                    .unwrap();
            }
            let output = mixer.pop_frame(samples).unwrap();
            assert_eq!(output.pts(), Some(pts));
            assert_eq!(output.samples(), samples);
            for channel in 0..2 {
                assert!(
                    output
                        .plane::<f32>(channel)
                        .iter()
                        .all(|sample| *sample == level),
                    "silent system capture must not attenuate the microphone in block {block}"
                );
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_audio_mixer_keeps_mic_level_stable_across_quiet_phrases_and_silence() {
        for include_system in [false, true] {
            let mut sources = vec!["mic"];
            if include_system {
                sources.push("system_audio");
            }
            let mut mixer = super::LiveAudioMixer::new(sources).expect("audio mixer");
            let samples = super::LiveAudioMixer::DRAIN_CHUNK_SAMPLES;
            let mut pts = 0_i64;
            for block in 0..301 {
                let count = if block == 300 { 73 } else { samples };
                let amplitude = match block % 100 {
                    0..=29 | 70..=99 => 0.02,
                    30..=49 => 0.0,
                    _ => 0.4,
                };
                let original = (0..count)
                    .map(|index| {
                        let time = (pts + index as i64) as f32 / 48_000.0;
                        amplitude * (2.0 * std::f32::consts::PI * 220.0 * time).sin()
                    })
                    .collect::<Vec<_>>();
                let mut input = silent_mix_frame(count, pts);
                for channel in 0..2 {
                    input.plane_mut::<f32>(channel).copy_from_slice(&original);
                }
                mixer.push(input, "mic").expect("push mic");
                if include_system {
                    let mut system = silent_mix_frame(count, pts);
                    system.plane_mut::<f32>(0).fill(0.1);
                    system.plane_mut::<f32>(1).fill(-0.05);
                    mixer
                        .push(system, "system_audio")
                        .expect("push system audio");
                }
                let output = mixer.pop_frame(count).expect("mix audio");
                assert_eq!(output.samples(), count);
                assert_eq!(output.pts(), Some(pts));
                for channel in 0..2 {
                    let system = if !include_system {
                        0.0
                    } else if channel == 0 {
                        0.1
                    } else {
                        -0.05
                    };
                    for (actual, mic) in output.plane::<f32>(channel).iter().zip(&original) {
                        let expected = mic + system;
                        assert_eq!(*actual, expected, "level changed in block {block}");
                    }
                }
                pts += count as i64;
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_audio_mixer_preserves_source_levels_below_limiter_ceiling() {
        let mut mixer = super::LiveAudioMixer::new(["mic", "system_audio"]).unwrap();
        let count = super::LiveAudioMixer::DRAIN_CHUNK_SAMPLES;
        for (block, system_level) in [None, Some(0.0), Some(0.2), Some(0.0), None, Some(-0.2)]
            .into_iter()
            .enumerate()
        {
            let pts = (block * count) as i64;
            let mut mic = silent_mix_frame(count, pts);
            for channel in 0..2 {
                mic.plane_mut::<f32>(channel).fill(0.4);
            }
            mixer.push(mic, "mic").unwrap();
            if let Some(level) = system_level {
                let mut system = silent_mix_frame(count, pts);
                system.plane_mut::<f32>(0).fill(level);
                system.plane_mut::<f32>(1).fill(-level);
                mixer.push(system, "system_audio").unwrap();
            }
            let output = mixer.pop_frame(count).unwrap();
            for channel in 0..2 {
                let system = system_level.unwrap_or(0.0) * if channel == 0 { 1.0 } else { -1.0 };
                let expected = 0.4 + system;
                assert!(output
                    .plane::<f32>(channel)
                    .iter()
                    .all(|sample| *sample == expected));
            }
            assert_eq!(mixer.limiter_gain, 1.0, "sub-ceiling sources must not duck");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_audio_mixer_limiter_protects_overlapping_loud_sources() {
        let mut mixer = super::LiveAudioMixer::new(["mic", "system_audio"]).unwrap();
        let count = super::LiveAudioMixer::DRAIN_CHUNK_SAMPLES;
        for source in ["mic", "system_audio"] {
            let mut input = silent_mix_frame(count, 0);
            for channel in 0..2 {
                input.plane_mut::<f32>(channel).fill(0.8);
            }
            mixer.push(input, source).unwrap();
        }
        let output = mixer.pop_frame(count).unwrap();
        for channel in 0..2 {
            assert!(output
                .plane::<f32>(channel)
                .iter()
                .all(|sample| *sample > 0.9 && *sample <= 0.981));
        }
        assert!(mixer.limiter_gain < 1.0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_audio_mixer_limiter_releases_smoothly_back_to_capture_level() {
        let mut mixer = super::LiveAudioMixer::new(["mic", "system_audio"]).unwrap();
        let count = super::LiveAudioMixer::DRAIN_CHUNK_SAMPLES;
        for source in ["mic", "system_audio"] {
            let mut input = silent_mix_frame(count, 0);
            for channel in 0..2 {
                input.plane_mut::<f32>(channel).fill(0.8);
            }
            mixer.push(input, source).unwrap();
        }
        mixer.pop_frame(count).unwrap();
        let mut previous = 0.02 * mixer.limiter_gain;
        for block in 1..=20 {
            let mut mic = silent_mix_frame(count, (block * count) as i64);
            for channel in 0..2 {
                mic.plane_mut::<f32>(channel).fill(0.02);
            }
            mixer.push(mic, "mic").unwrap();
            let output = mixer.pop_frame(count).unwrap();
            assert_eq!(output.plane::<f32>(0), output.plane::<f32>(1));
            for sample in output.plane::<f32>(0) {
                assert!(*sample >= previous && *sample <= 0.02);
                assert!(*sample - previous < 0.000_001);
                previous = *sample;
            }
        }
        assert_eq!(mixer.limiter_gain, 1.0);
        assert_eq!(previous, 0.02);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_audio_mixer_preserves_system_only_stereo_levels() {
        let mut mixer = super::LiveAudioMixer::new(["system_audio"]).unwrap();
        let mut input = silent_mix_frame(73, 0);
        input.plane_mut::<f32>(0).fill(0.8);
        input.plane_mut::<f32>(1).fill(-0.4);
        mixer.push(input, "system_audio").unwrap();
        let output = mixer.pop_frame(73).unwrap();
        assert!(output.plane::<f32>(0).iter().all(|sample| *sample == 0.8));
        assert!(output.plane::<f32>(1).iter().all(|sample| *sample == -0.4));
        assert_eq!(mixer.limiter_gain, 1.0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_audio_mixer_startup_grace_only_waits_on_sources_that_never_started() {
        // The laggard bypass answers "is this source keeping up?". It must not
        // also answer "has it started?" — a source that delivered late and is
        // far behind would otherwise re-open the startup grace gate and hold
        // the buffer during exactly the window the bound exists to protect.
        let mut lagging = super::LiveAudioMixer::new(["system_audio", "mic"]).expect("audio mixer");
        lagging.mark_source_seen("mic", 960);
        lagging.mark_source_seen("system_audio", super::SAMPLE_RATE as i64 * 5);
        assert!(
            lagging.ready_until_pts(0).is_some(),
            "a started-but-lagging source must not re-enter the startup grace"
        );

        // A source that has produced nothing at all still gets the grace.
        let mut silent = super::LiveAudioMixer::new(["system_audio", "mic"]).expect("audio mixer");
        silent.mark_source_seen("system_audio", super::SAMPLE_RATE as i64 * 5);
        assert!(
            silent.ready_until_pts(0).is_none(),
            "a source that has not started yet must still be waited for"
        );
    }

    #[test]
    fn cursor_lifecycle_writes_parseable_sidecars() {
        // Spin up a real tracker for a tiny window so the polling thread
        // has a chance to capture at least one sample (even if the mouse
        // is idle, the start-state Move is recorded on the first poll).
        let tracker = CursorTracker::start();
        std::thread::sleep(Duration::from_millis(60));
        let track = tracker.stop();

        // Write the sidecars to a temp dir that imitates the real
        // recordings dir layout — `<id>.mp4` plus the two JSON files.
        let dir = tempfile::tempdir().expect("tempdir");
        let mp4 = dir.path().join("rec123.mp4");
        std::fs::write(&mp4, b"\0\0\0\0ftypmp42").expect("touch mp4");

        // Simulated 5-second recording for the zoom generator.
        let camera = dir.path().join("rec123.camera.webm");
        std::fs::write(&camera, b"webm").expect("touch camera");
        let audio = AudioOptionsDto {
            include_system_audio: true,
            include_mic: false,
            mic_device_id: Some("Test Mic".to_string()),
            reduce_noise: false,
        };
        let webcam = WebcamCaptureDto {
            enabled: true,
            layout: crate::types::WebcamLayoutDto::Bubble,
            shape: crate::types::WebcamShapeDto::Square,
            size: crate::types::WebcamSizeDto::Medium,
            device_id: None,
        };
        let capture_source = CaptureSourceMetadataDto {
            source_tab: RecordingSourceTab::Window,
            source: Some(CaptureSourceDto::Window { id: 42 }),
            window_app_name: Some("TextEdit".to_string()),
            window_title: Some("Untitled".to_string()),
            controlled_evidence: None,
            window_capture: Some(crate::types::WindowCaptureModeDto::Window),
        };
        super::write_cursor_sidecars(
            &mp4,
            &track,
            5_000,
            None,
            Some(&capture_source),
            Some(&audio),
            Some(&webcam),
            Some(&camera),
            true,
        );

        let cursor_json = dir.path().join("rec123.cursor.json");
        let zoom_json = dir.path().join("rec123.zoom.json");
        let input_events_json = dir.path().join("rec123.input-events.json");
        let studio_project_json = dir.path().join("rec123.project.json");
        let project_json = dir.path().join("rec123.screencharm-project.json");
        let record_info_json = dir.path().join("rec123.record-info.json");
        let player_props_json = dir.path().join("rec123.player-props.json");
        let screen_charm_json = dir.path().join("rec123.screencharm.json");
        assert!(cursor_json.exists(), "cursor sidecar missing");
        assert!(zoom_json.exists(), "zoom sidecar missing");
        assert!(
            input_events_json.exists(),
            "Screen Charm raw input-events sidecar missing"
        );
        assert!(
            project_json.exists(),
            "Screen Charm project.json projection missing"
        );
        assert!(
            !studio_project_json.exists(),
            "Screen Charm compatibility writer must not occupy Studio project.json"
        );
        assert!(
            record_info_json.exists(),
            "Screen Charm record-info projection missing"
        );
        assert!(
            player_props_json.exists(),
            "Screen Charm playerProps projection missing"
        );
        assert!(
            screen_charm_json.exists(),
            "Screen Charm compatibility sidecar missing"
        );

        // Round-trip the cursor sidecar.
        let cursor_bytes = std::fs::read(&cursor_json).expect("read cursor");
        let cursor_back: crate::cursor_track::CursorTrack =
            serde_json::from_slice(&cursor_bytes).expect("parse cursor json");
        assert_eq!(cursor_back.sample_hz, track.sample_hz);
        assert_eq!(
            cursor_back
                .capture_source
                .as_ref()
                .and_then(|metadata| metadata.window_app_name.as_deref()),
            Some("TextEdit")
        );

        // Round-trip the zoom sidecar — an idle tracker produced no clicks
        // so this should be the empty array, which is valid JSON.
        let zoom_bytes = std::fs::read(&zoom_json).expect("read zoom");
        let zoom_back: Vec<ZoomSegment> =
            serde_json::from_slice(&zoom_bytes).expect("parse zoom json");
        assert!(
            zoom_back.is_empty(),
            "idle tracker should produce no segments"
        );

        let raw_input_bytes = std::fs::read(&input_events_json).expect("read input-events");
        let raw_input_back: serde_json::Value =
            serde_json::from_slice(&raw_input_bytes).expect("parse input-events json");
        assert!(
            raw_input_back.as_array().is_some(),
            "raw input-events should be an array"
        );

        let record_info_back: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&record_info_json).expect("read record-info projection"),
        )
        .expect("parse record-info projection");
        assert_eq!(
            record_info_back
                .get("files")
                .and_then(|v| v.as_array())
                .and_then(|files| files.first())
                .and_then(|file| file.get("type"))
                .and_then(|v| v.as_str()),
            Some("screen")
        );
        assert_eq!(
            record_info_back
                .get("clipyCaptureSource")
                .and_then(|value| value.get("windowTitle"))
                .and_then(|value| value.as_str()),
            Some("Untitled")
        );

        let player_props_back: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&player_props_json).expect("read playerProps projection"),
        )
        .expect("parse playerProps projection");
        assert_eq!(
            player_props_back
                .get("sourceCursorBakedInVideo")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            player_props_back
                .get("showClickEffect")
                .and_then(|v| v.as_bool()),
            Some(true)
        );

        let project_back: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&project_json).expect("read project projection"))
                .expect("parse project projection");
        assert_eq!(
            project_back
                .get("recording")
                .and_then(|v| v.get("micExtractedFromWebcam"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert!(
            project_back.get("playerProps").is_none(),
            "recording-time project projection should stay close to Screen Charm's project.json"
        );
        assert_eq!(
            project_back
                .get("projectSettings")
                .and_then(|v| v.get("editorSettings"))
                .and_then(|v| v.get("clickEffects"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            project_back
                .get("files")
                .and_then(|v| v.get("additionalFiles"))
                .and_then(|v| v.as_array())
                .and_then(|files| files.first())
                .and_then(|file| file.get("filename"))
                .and_then(|v| v.as_str()),
            Some("rec123.record-info.json")
        );

        let screen_charm_bytes = std::fs::read(&screen_charm_json).expect("read compat json");
        let screen_charm_back: serde_json::Value =
            serde_json::from_slice(&screen_charm_bytes).expect("parse compat json");
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("cursorTrackVersion"))
                .and_then(|v| v.as_u64()),
            Some(2)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("camera"))
                .and_then(|v| v.get("trackMode"))
                .and_then(|v| v.as_str()),
            Some("separate")
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("audio"))
                .and_then(|v| v.get("includeSystemAudio"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("hasMicrophone"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("hasSystemAudio"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("hasWebcam"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("recordSystemAudio"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("webcamFileName"))
                .and_then(|v| v.as_str()),
            Some("rec123.camera.webm")
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("microphoneFileName"))
                .map(|v| v.is_null()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("micExtractedFromWebcam"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("audioSidecarsWritten"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("clipyAudioTrackMode"))
                .and_then(|v| v.as_str()),
            Some("mixed-into-main")
        );
        assert_eq!(
            screen_charm_back
                .get("screenCharmReference")
                .and_then(|v| v.get("audioSidecars"))
                .and_then(|v| v.get("electronWritesExtractedWavSidecars"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("projectSettings")
                .and_then(|v| v.get("editorSettings"))
                .and_then(|v| v.get("backgroundImage"))
                .and_then(|v| v.as_str()),
            Some(super::SCREEN_CHARM_DEFAULT_BACKGROUND_IMAGE)
        );
        assert_eq!(
            screen_charm_back
                .get("files")
                .and_then(|v| v.get("inputEvents"))
                .and_then(|v| v.get("filename"))
                .and_then(|v| v.as_str()),
            Some("rec123.input-events.json")
        );
        assert_eq!(
            screen_charm_back
                .get("files")
                .and_then(|v| v.get("screenCharmProject"))
                .and_then(|v| v.get("filename"))
                .and_then(|v| v.as_str()),
            Some("rec123.screencharm-project.json")
        );
        assert_eq!(
            screen_charm_back
                .get("files")
                .and_then(|v| v.get("recordInfoFile"))
                .and_then(|v| v.get("filename"))
                .and_then(|v| v.as_str()),
            Some("rec123.record-info.json")
        );
        assert_eq!(
            screen_charm_back
                .get("files")
                .and_then(|v| v.get("playerPropsSidecar"))
                .and_then(|v| v.get("filename"))
                .and_then(|v| v.as_str()),
            Some("rec123.player-props.json")
        );
        assert_eq!(
            screen_charm_back
                .get("files")
                .and_then(|v| v.get("webcamVideo"))
                .and_then(|v| v.get("filename"))
                .and_then(|v| v.as_str()),
            Some("rec123.camera.webm")
        );
        assert_eq!(
            screen_charm_back
                .get("files")
                .and_then(|v| v.get("screenCharmAudioSidecars"))
                .and_then(|v| v.get("microphoneEnhancedAudio"))
                .and_then(|v| v.get("present"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            screen_charm_back
                .get("files")
                .and_then(|v| v.get("cameraSidecar"))
                .and_then(|v| v.get("filename"))
                .and_then(|v| v.as_str()),
            Some("rec123.camera.webm")
        );
        assert_eq!(
            screen_charm_back
                .get("recordInfo")
                .and_then(|v| v.get("files"))
                .and_then(|v| v.as_array())
                .and_then(|files| {
                    files
                        .iter()
                        .find(|file| file.get("type").and_then(|v| v.as_str()) == Some("mouse"))
                })
                .and_then(|file| file.get("filename"))
                .and_then(|v| v.as_str()),
            Some("rec123.input-events.json")
        );
        assert_eq!(
            screen_charm_back
                .get("recordInfo")
                .and_then(|v| v.get("files"))
                .and_then(|v| v.as_array())
                .and_then(|files| {
                    files.iter().find(|file| {
                        file.get("clipyType").and_then(|v| v.as_str()) == Some("camera")
                    })
                })
                .and_then(|file| file.get("type"))
                .and_then(|v| v.as_str()),
            Some("webcam")
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("camera"))
                .and_then(|v| v.get("screenCharmFileName"))
                .and_then(|v| v.as_str()),
            Some("webcam.mp4")
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("audio"))
                .and_then(|v| v.get("screenCharmFileNames"))
                .and_then(|v| v.get("systemAudio"))
                .and_then(|v| v.as_str()),
            Some("system_audio.wav")
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("audio"))
                .and_then(|v| v.get("screenCharmFileNames"))
                .and_then(|v| v.get("microphoneEnhanced"))
                .and_then(|v| v.as_str()),
            Some("microphone_enhanced.wav")
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("frameCount"))
                .and_then(|v| v.as_u64()),
            Some(300)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("fullRecordingFramesCount"))
                .and_then(|v| v.as_u64()),
            Some(300)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("recordingDurationInFrames"))
                .and_then(|v| v.as_u64()),
            Some(300)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("defaultZoomInLevel"))
                .and_then(|v| v.as_f64()),
            Some(2.0)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("zoomDurationSec"))
                .and_then(|v| v.as_f64()),
            Some(0.8)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("framesData"))
                .and_then(|v| v.as_array())
                .map(|frames| frames.len()),
            Some(300)
        );
        let first_frame_data = screen_charm_back
            .get("playerProps")
            .and_then(|v| v.get("framesData"))
            .and_then(|v| v.as_array())
            .and_then(|frames| frames.first())
            .and_then(|v| v.as_array())
            .expect("first framesData row");
        let first_cursor_width = first_frame_data
            .get(5)
            .and_then(|v| v.as_f64())
            .expect("first frame cursor svg width");
        assert!(
            (first_cursor_width - super::SCREEN_CHARM_CURSOR_SVG_WIDTH).abs() < f64::EPSILON
                || (first_cursor_width - super::SCREEN_CHARM_TEXT_CURSOR_SVG_WIDTH).abs()
                    < f64::EPSILON,
            "unexpected first frame cursor svg width: {first_cursor_width}"
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("cursorPositions"))
                .and_then(|v| v.as_array())
                .is_some(),
            true
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("showClickEffect"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("projectSettings")
                .and_then(|v| v.get("editorSettings"))
                .and_then(|v| v.get("clickEffects"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("sourceCursorBakedInVideo"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("showCursor"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("sourceCursorBakedInVideo"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("screenCharmCompat"))
                .and_then(|v| v.get("renderedCursorDisabledByDefault"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("systemSoundOn"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("webcamFileName"))
                .and_then(|v| v.as_str())
                .map(|path| path.ends_with("rec123.camera.webm")),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("screenCharmCompat"))
                .and_then(|v| v.get("screenCharmMicrophoneFileName"))
                .and_then(|v| v.as_str()),
            Some("microphone.wav")
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("screenCharmCompat"))
                .and_then(|v| v.get("screenCharmSystemAudioFileName"))
                .and_then(|v| v.as_str()),
            Some("system_audio.wav")
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("screenCharmCompat"))
                .and_then(|v| v.get("screenCharmMicrophoneEnhancedFileName"))
                .and_then(|v| v.as_str()),
            Some("microphone_enhanced.wav")
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("screenCharmCompat"))
                .and_then(|v| v.get("screenCharmMediaFiles"))
                .and_then(|v| v.get("rawInputEvents"))
                .and_then(|v| v.as_str()),
            Some("recording.input-events.json")
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("screenCharmCompat"))
                .and_then(|v| v.get("clipyWritesExtractedWavSidecars"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("screenCharmCompat"))
                .and_then(|v| v.get("screenCharmElectronWritesExtractedWavSidecars"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn screen_charm_input_events_map_capture_to_encoded_frames() {
        let track = CursorTrack {
            events: vec![
                CursorEvent::Move {
                    time_ms: 0.0,
                    x: 150,
                    y: 250,
                    cursor_type: Some("textcursor".to_string()),
                },
                CursorEvent::Down {
                    time_ms: 500.0,
                    button: 1,
                    x: 200,
                    y: 300,
                    cursor_type: Some("textcursor".to_string()),
                    render_x: None,
                    render_y: None,
                },
                CursorEvent::Move {
                    time_ms: 600.0,
                    x: 220,
                    y: 320,
                    cursor_type: Some("textcursor".to_string()),
                },
                CursorEvent::Up {
                    time_ms: 700.0,
                    button: 1,
                    x: 200,
                    y: 300,
                    cursor_type: Some("textcursor".to_string()),
                },
                CursorEvent::Scroll {
                    time_ms: 760.0,
                    x: 240,
                    y: 330,
                    delta_x: -1,
                    delta_y: 4,
                    cursor_type: Some("cursor".to_string()),
                },
                CursorEvent::KeyDown {
                    time_ms: 800.0,
                    key_code: 0,
                },
                CursorEvent::KeyUp {
                    time_ms: 850.0,
                    key_code: 0,
                },
            ],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture_source: None,
            click_elements: Vec::new(),
            capture: Some(CaptureViewport {
                x: 100.0,
                y: 200.0,
                width: 400.0,
                height: 300.0,
                output_width: 800,
                output_height: 600,
                screen_x: Some(0.0),
                screen_y: Some(0.0),
                screen_width: Some(1_600.0),
                screen_height: Some(1_200.0),
            }),
            capture_timeline: Vec::new(),
        };

        let events = super::screen_charm_input_events(&track, 1_000);
        assert_eq!(events.len(), 65);
        assert_eq!(events[0]["eventType"], "moved");
        assert_eq!(events[0]["frame"], 0);
        assert_eq!(events[0]["x"], 100.0);
        assert_eq!(events[0]["y"], 100.0);
        assert_eq!(events[0]["cursorType"], "textcursor");
        assert_eq!(events[59]["eventType"], "moved");
        assert_eq!(events[59]["frame"], 59);
        assert_eq!(events[60]["eventType"], "down");
        assert_eq!(events[60]["frame"], 30);
        assert_eq!(events[60]["x"], 200.0);
        assert_eq!(events[60]["y"], 200.0);
        assert_eq!(events[60]["cursorType"], "textcursor");
        assert_eq!(events[60]["cursorEvent"], true);
        assert_eq!(events[60]["button"], 1);
        assert_eq!(events[61]["eventType"], "up");
        assert_eq!(events[61]["frame"], 42);
        assert_eq!(events[62]["eventType"], "scroll");
        assert_eq!(events[62]["frame"], 46);
        assert_eq!(events[62]["x"], 280.0);
        assert_eq!(events[62]["y"], 260.0);
        assert_eq!(events[62]["cursorEvent"], false);
        assert_eq!(events[62]["deltaX"], -1);
        assert_eq!(events[62]["deltaY"], 4);
        assert_eq!(events[62]["inputType"], "scroll");
        assert_eq!(events[63]["eventType"], "down");
        assert_eq!(events[63]["frame"], 48);
        assert_eq!(events[63]["x"], 0.0);
        assert_eq!(events[63]["y"], 0.0);
        assert_eq!(events[63]["cursorEvent"], false);
        assert_eq!(events[63]["keyCode"], 0);
        assert_eq!(events[63]["inputType"], "keyboard");
        assert_eq!(events[64]["eventType"], "up");
        assert_eq!(events[64]["frame"], 51);

        let raw_events = super::screen_charm_raw_input_events(&track);
        assert_eq!(raw_events.len(), 7);
        assert_eq!(raw_events[0]["type"], "mouse");
        assert_eq!(raw_events[0]["mouseEventType"], "moved");
        assert_eq!(raw_events[0]["cursorType"], "textcursor");
        assert_eq!(raw_events[0]["x"], 0.094);
        assert_eq!(raw_events[0]["y"], 0.792);
        assert_eq!(raw_events[0]["time"]["seconds"], 0.0);
        assert_eq!(raw_events[1]["mouseEventType"], "down");
        assert_eq!(raw_events[1]["x"], 0.125);
        assert_eq!(raw_events[1]["y"], 0.75);
        assert_eq!(raw_events[2]["mouseEventType"], "dragged");
        assert_eq!(raw_events[2]["x"], 0.138);
        assert_eq!(raw_events[2]["y"], 0.733);
        assert_eq!(raw_events[3]["mouseEventType"], "up");
        assert_eq!(raw_events[4]["type"], "mouse");
        assert_eq!(raw_events[4]["mouseEventType"], "scroll");
        assert_eq!(raw_events[4]["x"], 0.15);
        assert_eq!(raw_events[4]["y"], 0.725);
        assert_eq!(raw_events[4]["deltaX"], -1);
        assert_eq!(raw_events[4]["deltaY"], 4);
        assert_eq!(raw_events[4]["time"]["seconds"], 0.76);
        assert_eq!(raw_events[5]["type"], "keyboard");
        assert_eq!(raw_events[5]["keyboardEventType"], "down");
        assert!(raw_events[5].get("keyCode").is_none());
        assert_eq!(raw_events[5]["time"]["seconds"], 0.8);
    }

    #[test]
    fn cursor_sidecar_writes_screen_charm_click_render_anchor() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mp4 = dir.path().join("rec456.mp4");
        std::fs::write(&mp4, b"\0\0\0\0ftypmp42").expect("touch mp4");
        let track = CursorTrack {
            events: vec![
                CursorEvent::Move {
                    time_ms: 1_000.0,
                    x: 44,
                    y: 55,
                    cursor_type: Some("cursor".to_string()),
                },
                CursorEvent::Down {
                    time_ms: 1_004.0,
                    button: 1,
                    x: 10,
                    y: 20,
                    cursor_type: Some("cursor".to_string()),
                    render_x: None,
                    render_y: None,
                },
            ],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture_source: None,
            click_elements: Vec::new(),
            capture: None,
            capture_timeline: Vec::new(),
        };

        super::write_cursor_sidecars(&mp4, &track, 2_000, None, None, None, None, None, true);

        let cursor_json = dir.path().join("rec456.cursor.json");
        let cursor_back: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&cursor_json).expect("read cursor json"))
                .expect("parse cursor json");
        let down = cursor_back
            .get("events")
            .and_then(|events| events.as_array())
            .and_then(|events| {
                events
                    .iter()
                    .find(|event| event.get("kind").and_then(|v| v.as_str()) == Some("down"))
            })
            .expect("down event");
        assert_eq!(down.get("x").and_then(|v| v.as_i64()), Some(10));
        assert_eq!(down.get("y").and_then(|v| v.as_i64()), Some(20));
        assert_eq!(down.get("render_x").and_then(|v| v.as_f64()), Some(44.0));
        assert_eq!(down.get("render_y").and_then(|v| v.as_f64()), Some(55.0));
    }

    #[test]
    fn screen_charm_sidecar_uses_full_display_dimensions_when_available() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mp4 = dir.path().join("rec789.mp4");
        std::fs::write(&mp4, b"\0\0\0\0ftypmp42").expect("touch mp4");
        let track = CursorTrack {
            events: vec![CursorEvent::Move {
                time_ms: 0.0,
                x: 150,
                y: 250,
                cursor_type: Some("cursor".to_string()),
            }],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture_source: None,
            click_elements: Vec::new(),
            capture: None,
            capture_timeline: Vec::new(),
        };
        super::write_cursor_sidecars(
            &mp4,
            &track,
            1_000,
            Some(CaptureViewport {
                x: 100.0,
                y: 200.0,
                width: 400.0,
                height: 300.0,
                output_width: 800,
                output_height: 600,
                screen_x: Some(0.0),
                screen_y: Some(0.0),
                screen_width: Some(1_600.0),
                screen_height: Some(1_200.0),
            }),
            None,
            None,
            None,
            None,
            true,
        );

        let screen_charm_json = dir.path().join("rec789.screencharm.json");
        let screen_charm_bytes = std::fs::read(&screen_charm_json).expect("read compat json");
        let screen_charm_back: serde_json::Value =
            serde_json::from_slice(&screen_charm_bytes).expect("parse compat json");
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("screenWidth"))
                .and_then(|v| v.as_f64()),
            Some(3_200.0)
        );
        assert_eq!(
            screen_charm_back
                .get("recording")
                .and_then(|v| v.get("screenHeight"))
                .and_then(|v| v.as_f64()),
            Some(2_400.0)
        );
        assert_eq!(
            screen_charm_back
                .get("recordInfo")
                .and_then(|v| v.get("files"))
                .and_then(|v| v.as_array())
                .and_then(|files| {
                    files
                        .iter()
                        .find(|file| file.get("type").and_then(|v| v.as_str()) == Some("screen"))
                })
                .and_then(|file| file.get("videoDimensions"))
                .and_then(|v| v.get("width"))
                .and_then(|v| v.as_u64()),
            Some(800)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("xOffset"))
                .and_then(|v| v.as_f64()),
            Some(200.0)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("yOffset"))
                .and_then(|v| v.as_f64()),
            Some(400.0)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("finalWidth"))
                .and_then(|v| v.as_f64()),
            Some(960.0)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("finalHeight"))
                .and_then(|v| v.as_f64()),
            Some(636.0)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("paddingXInPixels"))
                .and_then(|v| v.as_f64()),
            Some(80.0)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("paddingYInPixels"))
                .and_then(|v| v.as_f64()),
            Some(18.0)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("backgroundImage"))
                .and_then(|v| v.as_str()),
            Some(super::SCREEN_CHARM_DEFAULT_BACKGROUND_IMAGE)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("backgroundColor"))
                .map(|v| v.is_null()),
            Some(true)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("borderRadius"))
                .and_then(|v| v.as_u64()),
            Some(70)
        );
        assert_eq!(
            screen_charm_back
                .get("playerProps")
                .and_then(|v| v.get("shadowIntensity"))
                .and_then(|v| v.as_f64()),
            Some(0.5)
        );
        assert_eq!(
            screen_charm_back
                .get("projectSettings")
                .and_then(|v| v.get("editorSettings"))
                .and_then(|v| v.get("finalWidth"))
                .and_then(|v| v.as_f64()),
            Some(960.0)
        );
        assert_eq!(
            screen_charm_back
                .get("projectSettings")
                .and_then(|v| v.get("editorSettings"))
                .and_then(|v| v.get("finalHeight"))
                .and_then(|v| v.as_f64()),
            Some(636.0)
        );
    }

    #[test]
    fn screen_charm_player_zoom_scale_ramps_segment_boundaries() {
        let segments = vec![ZoomSegment {
            start_s: 1.0,
            end_s: 3.0,
            amount: 1.5,
            ramp_s: Some(0.5),
            mode: crate::zoom_segments::ZoomMode::Auto,
            focal_curve: None,
        }];

        assert_eq!(super::screen_charm_player_zoom_scale(&segments, 0.9), 1.0);
        assert!((super::screen_charm_player_zoom_scale(&segments, 1.0) - 1.0).abs() < 0.001);
        assert!((super::screen_charm_player_zoom_scale(&segments, 1.25) - 1.25).abs() < 0.001);
        assert!((super::screen_charm_player_zoom_scale(&segments, 2.0) - 1.5).abs() < 0.001);
        assert!((super::screen_charm_player_zoom_scale(&segments, 2.75) - 1.25).abs() < 0.001);
        assert_eq!(super::screen_charm_player_zoom_scale(&segments, 3.1), 1.0);
    }

    #[test]
    fn screen_charm_frames_data_uses_observed_cursor_svg_widths() {
        let track = CursorTrack {
            events: vec![
                CursorEvent::Move {
                    time_ms: 0.0,
                    x: 100,
                    y: 100,
                    cursor_type: Some("cursor".to_string()),
                },
                CursorEvent::Move {
                    time_ms: 1000.0,
                    x: 120,
                    y: 140,
                    cursor_type: Some("textcursor".to_string()),
                },
            ],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture_source: None,
            click_elements: Vec::new(),
            capture: None,
            capture_timeline: Vec::new(),
        };

        let frames = super::screen_charm_player_frames_data(&track, &[], 90, 800, 600, 0.0);
        let arrow_frame = frames[0].as_array().expect("arrow frame data array");
        let text_frame = frames[60].as_array().expect("text frame data array");

        assert_eq!(
            arrow_frame.get(5).and_then(|v| v.as_f64()),
            Some(super::SCREEN_CHARM_CURSOR_SVG_WIDTH)
        );
        assert_eq!(arrow_frame.get(8).and_then(|v| v.as_str()), Some("cursor"));
        assert_eq!(
            text_frame.get(5).and_then(|v| v.as_f64()),
            Some(super::SCREEN_CHARM_TEXT_CURSOR_SVG_WIDTH)
        );
        assert_eq!(
            text_frame.get(8).and_then(|v| v.as_str()),
            Some("textcursor")
        );
    }

    #[test]
    fn screen_charm_frames_data_uses_manual_focal_for_zoom_target() {
        let track = CursorTrack {
            events: vec![CursorEvent::Move {
                time_ms: 0.0,
                x: 100,
                y: 100,
                cursor_type: Some("cursor".to_string()),
            }],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture_source: None,
            click_elements: Vec::new(),
            capture: None,
            capture_timeline: Vec::new(),
        };
        let segments = vec![ZoomSegment {
            start_s: 1.0,
            end_s: 3.0,
            amount: 2.0,
            ramp_s: Some(0.5),
            mode: crate::zoom_segments::ZoomMode::Manual { x: 300.0, y: 200.0 },
            focal_curve: None,
        }];

        let frames = super::screen_charm_player_frames_data(&track, &segments, 180, 800, 600, 0.0);
        let active_frame = frames[120].as_array().expect("frame data array");

        assert_eq!(active_frame[0], 200.0);
        assert_eq!(active_frame[1], 200.0);
        assert_eq!(active_frame[2], 2.0);
        assert_eq!(active_frame[3], 100.0);
        assert_eq!(active_frame[4], 100.0);
    }

    #[test]
    fn screen_charm_frames_data_prefers_saved_focal_curve() {
        let track = CursorTrack {
            events: vec![CursorEvent::Move {
                time_ms: 0.0,
                x: 100,
                y: 100,
                cursor_type: Some("cursor".to_string()),
            }],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture_source: None,
            click_elements: Vec::new(),
            capture: None,
            capture_timeline: Vec::new(),
        };
        let segments = vec![ZoomSegment {
            start_s: 1.0,
            end_s: 3.0,
            amount: 2.0,
            ramp_s: Some(0.5),
            mode: crate::zoom_segments::ZoomMode::Auto,
            focal_curve: Some(vec![
                FocalCurvePoint {
                    time_s: 1.0,
                    x: 300.0,
                    y: 200.0,
                },
                FocalCurvePoint {
                    time_s: 3.0,
                    x: 500.0,
                    y: 400.0,
                },
            ]),
        }];

        let frames = super::screen_charm_player_frames_data(&track, &segments, 180, 800, 600, 0.0);
        let active_frame = frames[120].as_array().expect("frame data array");

        assert_eq!(active_frame[0], 0.0);
        assert_eq!(active_frame[1], 0.0);
        assert_eq!(active_frame[2], 2.0);
        assert_eq!(active_frame[3], 100.0);
        assert_eq!(active_frame[4], 100.0);
    }

    #[test]
    fn screen_charm_player_zooms_project_timeline_entries() {
        let track = CursorTrack {
            events: vec![
                CursorEvent::Move {
                    time_ms: 900.0,
                    x: 100,
                    y: 120,
                    cursor_type: Some("cursor".to_string()),
                },
                CursorEvent::Down {
                    time_ms: 1_800.0,
                    button: 1,
                    x: 200,
                    y: 240,
                    cursor_type: Some("cursor".to_string()),
                    render_x: None,
                    render_y: None,
                },
            ],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture_source: None,
            click_elements: Vec::new(),
            capture: None,
            capture_timeline: Vec::new(),
        };
        let segments = vec![ZoomSegment {
            start_s: 1.0,
            end_s: 3.1,
            amount: 2.0,
            ramp_s: Some(0.8),
            mode: crate::zoom_segments::ZoomMode::Auto,
            focal_curve: None,
        }];

        let zooms = super::screen_charm_player_zooms(&track, &segments, 360, 800, 600);
        assert_eq!(zooms.len(), 1);
        let zoom = &zooms[0];
        assert_eq!(zoom["zoomInStartFrame"], 60);
        assert_eq!(zoom["zoomOutStartFrame"], 186);
        assert_eq!(zoom["level"], 2.0);
        assert_eq!(zoom["followCursor"], true);
        assert_eq!(zoom["clickFrame"], 108);
        assert_eq!(zoom["clickX"], 200.0);
        assert_eq!(zoom["clickY"], 240.0);
        assert_eq!(zoom["clickAnchorX"], 400.0);
        assert_eq!(zoom["clickAnchorY"], 120.0);

        let scales = zoom["scales"].as_array().expect("scales array");
        assert_eq!(scales.len(), 175);
        assert_eq!(scales.first().unwrap()["frame"], 60);
        assert_eq!(scales.first().unwrap()["scale"], 1.0);
        assert_eq!(scales[48]["frame"], 108);
        assert_eq!(scales[48]["scale"], 2.0);
        assert_eq!(scales[126]["frame"], 186);
        assert_eq!(scales[126]["scale"], 2.0);
        assert_eq!(scales.last().unwrap()["frame"], 234);
        assert_eq!(scales.last().unwrap()["scale"], 1.0);

        let positions = zoom["positions"].as_array().expect("positions array");
        assert_eq!(positions.len(), 145);
        assert_eq!(positions.first().unwrap()["frame"], 108);
        assert_eq!(positions.first().unwrap()["actualX"], 400.0);
        assert_eq!(positions.first().unwrap()["actualY"], 120.0);
        assert_eq!(positions.last().unwrap()["frame"], 252);
    }

    #[test]
    fn screen_charm_player_zooms_positions_use_saved_focal_curve() {
        let track = CursorTrack {
            events: vec![CursorEvent::Move {
                time_ms: 0.0,
                x: 20,
                y: 20,
                cursor_type: Some("cursor".to_string()),
            }],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture_source: None,
            click_elements: Vec::new(),
            capture: None,
            capture_timeline: Vec::new(),
        };
        let segments = vec![ZoomSegment {
            start_s: 1.0,
            end_s: 2.0,
            amount: 2.0,
            ramp_s: Some(0.8),
            mode: crate::zoom_segments::ZoomMode::Auto,
            focal_curve: Some(vec![FocalCurvePoint {
                time_s: 1.8,
                x: 300.0,
                y: 200.0,
            }]),
        }];

        let zooms = super::screen_charm_player_zooms(&track, &segments, 300, 800, 600);
        let positions = zooms[0]["positions"].as_array().expect("positions array");

        assert_eq!(positions.first().unwrap()["frame"], 108);
        assert_eq!(positions.first().unwrap()["actualX"], 200.0);
        assert_eq!(positions.first().unwrap()["actualY"], 200.0);
    }

    #[test]
    fn screen_charm_media_refresh_adds_late_camera_sidecar() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mp4 = dir.path().join("rec456.mp4");
        std::fs::write(&mp4, b"\0\0\0\0ftypmp42").expect("touch mp4");
        let track = CursorTrack {
            events: vec![CursorEvent::Move {
                time_ms: 0.0,
                x: 10,
                y: 10,
                cursor_type: Some("cursor".to_string()),
            }],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture_source: None,
            click_elements: Vec::new(),
            capture: None,
            capture_timeline: Vec::new(),
        };
        let audio = AudioOptionsDto {
            include_system_audio: false,
            include_mic: true,
            mic_device_id: Some("Default Mic".to_string()),
            reduce_noise: false,
        };
        let webcam = WebcamCaptureDto {
            enabled: true,
            layout: crate::types::WebcamLayoutDto::Left,
            shape: crate::types::WebcamShapeDto::Square,
            size: crate::types::WebcamSizeDto::Medium,
            device_id: None,
        };
        super::write_cursor_sidecars(
            &mp4,
            &track,
            1_000,
            None,
            None,
            Some(&audio),
            Some(&webcam),
            None,
            true,
        );

        let camera = dir.path().join("rec456.camera.webm");
        std::fs::write(&camera, b"webm").expect("touch camera");
        let mut recording = StudioRecordingDto {
            recording_id: "rec456".to_string(),
            public_id: "local-rec456".to_string(),
            remote_public_id: None,
            video_id: None,
            share_url: None,
            local_file_path: mp4,
            cursor_path: Some(dir.path().join("rec456.cursor.json")),
            zoom_path: Some(dir.path().join("rec456.zoom.json")),
            camera_path: Some(camera),
            project_path: Some(dir.path().join("rec456.project.json")),
            screen_charm_path: Some(dir.path().join("rec456.screencharm.json")),
            cursor_json: None,
            zoom_json: None,
            project_json: None,
            screen_charm_json: None,
            webcam: Some(webcam),
            audio: Some(audio),
            bytes: 12,
            duration_ms: 1_000,
        };
        super::refresh_screen_charm_media_metadata(&mut recording);
        let sidecar = recording
            .screen_charm_json
            .expect("screen charm json refreshed");
        assert_eq!(
            sidecar
                .get("recording")
                .and_then(|v| v.get("camera"))
                .and_then(|v| v.get("trackMode"))
                .and_then(|v| v.as_str()),
            Some("separate")
        );
        assert_eq!(
            sidecar
                .get("recording")
                .and_then(|v| v.get("hasWebcam"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            sidecar
                .get("recording")
                .and_then(|v| v.get("webcamFileName"))
                .and_then(|v| v.as_str()),
            Some("rec456.camera.webm")
        );
        assert_eq!(
            sidecar
                .get("files")
                .and_then(|v| v.get("cameraSidecar"))
                .and_then(|v| v.get("filename"))
                .and_then(|v| v.as_str()),
            Some("rec456.camera.webm")
        );
        assert_eq!(
            sidecar
                .get("recordInfo")
                .and_then(|v| v.get("files"))
                .and_then(|v| v.as_array())
                .map(|files| {
                    files
                        .iter()
                        .any(|file| file.get("type").and_then(|v| v.as_str()) == Some("webcam"))
                }),
            Some(true)
        );
        assert_eq!(
            sidecar
                .get("playerProps")
                .and_then(|v| v.get("showCamera"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            sidecar
                .get("playerProps")
                .and_then(|v| v.get("webcamFileName"))
                .and_then(|v| v.as_str())
                .map(|path| path.ends_with("rec456.camera.webm")),
            Some(true)
        );
        assert_eq!(
            sidecar
                .get("playerProps")
                .and_then(|v| v.get("muteMic"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            sidecar
                .get("playerProps")
                .and_then(|v| v.get("micExtractedFromWebcam"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            sidecar
                .get("playerProps")
                .and_then(|v| v.get("screenCharmCompat"))
                .and_then(|v| v.get("screenCharmMediaFiles"))
                .and_then(|v| v.get("systemAudio"))
                .and_then(|v| v.as_str()),
            Some("system_audio.wav")
        );
        assert_eq!(
            sidecar
                .get("playerProps")
                .and_then(|v| v.get("screenCharmCompat"))
                .and_then(|v| v.get("screenCharmSystemAudioExtractedFromRecording"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
    }
}

#[cfg(test)]
mod recovery_tests {
    use std::fs::{File, FileTimes};
    use std::time::{Duration, SystemTime};

    #[tokio::test]
    async fn recovery_scan_keeps_recent_failures_and_purges_expired_artifacts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(20 * 24 * 60 * 60);
        let recent_id = "11111111-1111-4111-8111-111111111111";
        let expired_id = "22222222-2222-4222-8222-222222222222";
        let orphan_id = "33333333-3333-4333-8333-333333333333";
        let studio_id = "44444444-4444-4444-8444-444444444444";
        let recent_mp4 = dir.path().join(format!("{recent_id}.mp4"));
        let expired_mp4 = dir.path().join(format!("{expired_id}.mp4"));
        let orphan_cursor = dir.path().join(format!("{orphan_id}.cursor.json"));
        let studio_mp4 = dir.path().join(format!("{studio_id}.mp4"));
        let studio_metadata = dir.path().join(format!("{studio_id}.studio.json"));
        let empty_id = "55555555-5555-4555-8555-555555555555";
        let empty_mp4 = dir.path().join(format!("{empty_id}.mp4"));

        std::fs::write(&recent_mp4, b"recent failed recording").expect("write recent");
        std::fs::write(recent_mp4.with_extension("cursor.json"), b"{}")
            .expect("write recent sidecar");
        std::fs::write(&expired_mp4, b"expired failed recording").expect("write expired");
        std::fs::write(expired_mp4.with_extension("cursor.json"), b"{}")
            .expect("write expired sidecar");
        std::fs::write(&orphan_cursor, b"{}").expect("write orphan sidecar");
        std::fs::write(&studio_mp4, b"retained studio recording").expect("write studio mp4");
        std::fs::write(&studio_metadata, b"{}").expect("write studio metadata");
        std::fs::write(&empty_mp4, b"").expect("write empty recording");
        std::fs::write(dir.path().join("notes.txt"), b"unrelated").expect("write unrelated");

        let recent_file = File::options()
            .write(true)
            .open(&recent_mp4)
            .expect("open recent");
        recent_file
            .set_times(FileTimes::new().set_modified(now - Duration::from_secs(60 * 60)))
            .expect("set recent mtime");
        let expired_file = File::options()
            .write(true)
            .open(&expired_mp4)
            .expect("open expired");
        expired_file
            .set_times(FileTimes::new().set_modified(now - Duration::from_secs(8 * 24 * 60 * 60)))
            .expect("set expired mtime");
        let orphan_file = File::options()
            .write(true)
            .open(&orphan_cursor)
            .expect("open orphan");
        orphan_file
            .set_times(FileTimes::new().set_modified(now - Duration::from_secs(8 * 24 * 60 * 60)))
            .expect("set orphan mtime");
        for path in [&studio_mp4, &studio_metadata] {
            let file = File::options()
                .write(true)
                .open(path)
                .expect("open studio file");
            file.set_times(
                FileTimes::new().set_modified(now - Duration::from_secs(8 * 24 * 60 * 60)),
            )
            .expect("set studio mtime");
        }

        let recoverable = super::list_recoverable_recordings_in_dir(dir.path(), now, None)
            .await
            .expect("scan recovery files");

        assert_eq!(recoverable.len(), 1);
        assert_eq!(recoverable[0].recording_id, recent_id);
        assert_eq!(
            recoverable[0].bytes,
            b"recent failed recording".len() as u64
        );
        assert!(
            recent_mp4.exists(),
            "recent failed recording must stay recoverable"
        );
        assert!(
            recent_mp4.with_extension("cursor.json").exists(),
            "recent sidecars must stay available for retry"
        );
        assert!(!expired_mp4.exists(), "expired MP4 must be purged");
        assert!(
            !expired_mp4.with_extension("cursor.json").exists(),
            "expired sidecars must be purged with their MP4"
        );
        assert!(
            !orphan_cursor.exists(),
            "expired sidecars left by an interrupted cleanup must be purged"
        );
        assert!(
            studio_mp4.exists(),
            "Studio MP4 must stay out of recovery cleanup"
        );
        assert!(
            studio_metadata.exists(),
            "Studio metadata must stay out of recovery cleanup"
        );
        assert!(
            empty_mp4.exists(),
            "a recent empty artifact stays scoped to the seven-day retention window"
        );
        assert!(
            dir.path().join("notes.txt").exists(),
            "purge must not touch unrelated local files"
        );
    }

    /// What an offline start left behind on beta 1.1.81: `ftyp` + `moov`
    /// from a fragmented MP4 encoder and nothing else.
    fn header_only_mp4() -> Vec<u8> {
        let mut out = Vec::new();
        for (kind, payload) in [(b"ftyp", 20usize), (b"moov", 1_200usize)] {
            out.extend_from_slice(&((8 + payload) as u32).to_be_bytes());
            out.extend_from_slice(kind);
            out.extend(std::iter::repeat_n(1u8, payload));
        }
        out
    }

    #[tokio::test]
    async fn recovery_scan_never_offers_a_header_only_mp4_and_spares_the_active_take() {
        let dir = tempfile::tempdir().expect("tempdir");
        let now = SystemTime::now();
        let old_id = "66666666-6666-4666-8666-666666666666";
        let fresh_id = "77777777-7777-4777-8777-777777777777";
        let active_id = "88888888-8888-4888-8888-888888888888";
        let media_id = "99999999-9999-4999-8999-999999999999";
        let old_mp4 = dir.path().join(format!("{old_id}.mp4"));
        let fresh_mp4 = dir.path().join(format!("{fresh_id}.mp4"));
        let active_mp4 = dir.path().join(format!("{active_id}.mp4"));
        let media_mp4 = dir.path().join(format!("{media_id}.mp4"));
        for path in [&old_mp4, &fresh_mp4, &active_mp4] {
            std::fs::write(path, header_only_mp4()).expect("write header-only mp4");
        }
        let mut with_media = header_only_mp4();
        for (kind, payload) in [(b"moof", 40usize), (b"mdat", 500usize)] {
            with_media.extend_from_slice(&((8 + payload) as u32).to_be_bytes());
            with_media.extend_from_slice(kind);
            with_media.extend(std::iter::repeat_n(1u8, payload));
        }
        std::fs::write(&media_mp4, &with_media).expect("write mp4 with a fragment");
        for path in [&old_mp4, &active_mp4] {
            File::options()
                .write(true)
                .open(path)
                .expect("open")
                .set_times(FileTimes::new().set_modified(now - Duration::from_secs(60 * 60)))
                .expect("set mtime");
        }

        let recoverable =
            super::list_recoverable_recordings_in_dir(dir.path(), now, Some(active_id))
                .await
                .expect("scan recovery files");

        let ids: Vec<&str> = recoverable.iter().map(|r| r.recording_id.as_str()).collect();
        assert_eq!(ids, vec![media_id], "only the take with media is offered");
        assert!(!old_mp4.exists(), "an old header-only file is removed");
        assert!(fresh_mp4.exists(), "a fresh header-only file is hidden, not removed yet");
        assert!(active_mp4.exists(), "the take being recorded is never touched");
        assert!(media_mp4.exists());
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_mic_warning_tests {
    /// The HUD shows these through `i18n::localize_message`, which only
    /// translates a sentence that is a `native.errors` value word for word.
    #[test]
    fn mic_warnings_have_a_catalog_code() {
        for sentence in [
            super::WINDOWS_MIC_START_FAILED,
            super::WINDOWS_MIC_SILENT,
            super::WINDOWS_MIC_STOPPED,
        ] {
            assert!(crate::i18n::has_error_code(sentence), "{sentence}");
        }
    }
}
