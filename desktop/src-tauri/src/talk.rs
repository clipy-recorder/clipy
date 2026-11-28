//! Talk to your agent: hold a key, talk and point, let go, and Clipy pastes
//! what you said plus the path of the take's AREC where you were typing.
//!
//! It is a short Local take with nothing new underneath. The capture, live
//! transcript, Flare (hold Control to point) and the AREC are the ordinary
//! Local pipeline; this module only adds the key, the lifecycle around one
//! take, and the paste at the end.
//!
//! Keys (Preferences → Talk to your agent, off until chosen):
//! - Hold the talk key (Fn, or Right Option) to talk; letting go stops the
//!   take and pastes.
//! - Double-tap it to talk hands-free; tap it once more to stop and paste.
//! - Esc throws the take away and pastes nothing.
//! - While talking, hold Control to point, exactly as in any recording.
//!
//! Rules this module keeps:
//! - A hold only starts after `HOLD_START_MS`, and a hold that turns into a
//!   shortcut (Fn+F1, Fn+arrow, Option+letter) never starts anything.
//! - It never starts over a recording that is already running (a person's
//!   or an agent's), and a take stopped from the recording controls still
//!   pastes, since the user asked for it.
//! - The paste waits a few seconds for the transcript and never for moment
//!   selection: the AREC path is usable at once (it says Preparing) and is
//!   updated in place, which is what an agent reads.
//! - A failure never loses the take; it stays in Local recordings, and the
//!   notification says what happened.
//!
//! macOS only for now. Windows has no on-device transcript, so the words
//! would arrive after the paste; its key reading and paste already exist
//! elsewhere and can be wired in once that is solved.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// A press held this long without another key starts a hold-to-talk take.
/// Longer than a tap, so a quick Fn press (emoji picker, input source) does
/// not start recording.
pub(crate) const HOLD_START_MS: u64 = 300;
/// A press shorter than this, with no other key, counts as a tap.
pub(crate) const TAP_MAX_MS: u64 = 250;
/// The second press of a double tap must come within this of the first
/// release.
pub(crate) const DOUBLE_TAP_GAP_MS: u64 = 350;
/// Shorter takes are treated as an accident and discarded.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MIN_TAKE: Duration = Duration::from_millis(800);
/// A take stops by itself after this, as if the key were let go.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAX_TAKE: Duration = Duration::from_secs(300);
/// How long a take stopped from the recording controls has to be sealed or
/// discarded before the paste gives up on it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const EXTERNAL_STOP_WAIT: Duration = Duration::from_secs(10);
/// How long the paste waits for the transcript before pasting without it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const WORDS_WAIT: Duration = Duration::from_secs(6);

const KEY_STORE: &str = "talk_key";
const PASTE_STORE: &str = "talk_paste";

/// Which key talks. Stored as its `as_str`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum TalkKey {
    #[default]
    Off,
    /// The Fn / Globe key.
    Fn,
    /// Right Option. Left Option is left alone: it types accents.
    RightOption,
}

impl TalkKey {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "fn" => Some(Self::Fn),
            "right_option" => Some(Self::RightOption),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Fn => "fn",
            Self::RightOption => "right_option",
        }
    }
}

/// What lands where the user was typing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum PasteStyle {
    /// What was said, then the AREC path.
    #[default]
    WordsAndPath,
    /// The AREC path only.
    Path,
    /// What was said only: plain dictation. The take is still kept.
    Words,
}

impl PasteStyle {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "words_and_path" => Some(Self::WordsAndPath),
            "path" => Some(Self::Path),
            "words" => Some(Self::Words),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::WordsAndPath => "words_and_path",
            Self::Path => "path",
            Self::Words => "words",
        }
    }
}

/// The paste for a finished take, or `None` when there is nothing to paste
/// (dictation only, and nothing was heard).
pub(crate) fn compose_paste(style: PasteStyle, words: Option<&str>, arec: &Path) -> Option<String> {
    let words = words.map(str::trim).filter(|w| !w.is_empty());
    let path = arec.to_string_lossy();
    match style {
        PasteStyle::Path => Some(path.into_owned()),
        PasteStyle::Words => words.map(str::to_string),
        PasteStyle::WordsAndPath => Some(match words {
            Some(words) => format!("{words}\n\nClipy recording: {path}"),
            None => format!("Clipy recording: {path}"),
        }),
    }
}

// ---------- Key tracking (pure, tested on every platform) ----------

/// One reading of the keys.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TalkKeys {
    /// The talk key is down.
    pub trigger: bool,
    /// A key that is not a modifier is down too (Esc not included).
    pub other_key: bool,
    pub escape: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TalkMode {
    Hold,
    HandsFree,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TalkAction {
    Start(TalkMode),
    Stop,
    Cancel,
}

/// Turns key readings into start, stop and cancel.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct TalkTracker {
    down_since: Option<u64>,
    /// Another key went down during this press: it is a shortcut.
    chorded: bool,
    /// When the last clean tap ended, for a double tap.
    last_tap_up: Option<u64>,
    active: Option<TalkMode>,
    /// The current press already did its job (started hands-free or stopped
    /// it); its release does nothing.
    swallow: bool,
}

impl TalkTracker {
    pub(crate) fn active(&self) -> Option<TalkMode> {
        self.active
    }

    /// The take ended elsewhere (stopped from the controls, failed to
    /// start): forget it without acting on the keys still held.
    pub(crate) fn clear_active(&mut self) {
        if self.active.take().is_some() && self.down_since.is_some() {
            self.swallow = true;
        }
    }

    pub(crate) fn update(&mut self, keys: TalkKeys, now_ms: u64) -> Option<TalkAction> {
        if self.active.is_some() && keys.escape {
            self.active = None;
            self.last_tap_up = None;
            if self.down_since.is_some() {
                self.swallow = true;
            }
            return Some(TalkAction::Cancel);
        }

        match (keys.trigger, self.down_since) {
            // Pressed.
            (true, None) => {
                self.down_since = Some(now_ms);
                self.chorded = keys.other_key;
                if self.active == Some(TalkMode::HandsFree) {
                    self.active = None;
                    self.swallow = true;
                    return Some(TalkAction::Stop);
                }
                let double = self
                    .last_tap_up
                    .take()
                    .is_some_and(|up| now_ms.saturating_sub(up) <= DOUBLE_TAP_GAP_MS);
                if self.active.is_none() && double && !self.chorded {
                    self.active = Some(TalkMode::HandsFree);
                    self.swallow = true;
                    return Some(TalkAction::Start(TalkMode::HandsFree));
                }
                None
            }
            // Held.
            (true, Some(since)) => {
                if keys.other_key {
                    self.chorded = true;
                }
                if self.active.is_none()
                    && !self.chorded
                    && !self.swallow
                    && now_ms.saturating_sub(since) >= HOLD_START_MS
                {
                    self.active = Some(TalkMode::Hold);
                    return Some(TalkAction::Start(TalkMode::Hold));
                }
                None
            }
            // Released.
            (false, Some(since)) => {
                let held = now_ms.saturating_sub(since);
                let chorded = self.chorded;
                let swallow = self.swallow;
                self.down_since = None;
                self.chorded = false;
                self.swallow = false;
                if swallow {
                    return None;
                }
                if self.active == Some(TalkMode::Hold) {
                    self.active = None;
                    return Some(TalkAction::Stop);
                }
                if self.active.is_none() && !chorded && held < TAP_MAX_MS {
                    self.last_tap_up = Some(now_ms);
                }
                None
            }
            (false, None) => None,
        }
    }
}

// ---------- Settings ----------

pub(crate) fn talk_key(app: &AppHandle) -> TalkKey {
    app.store(crate::commands::SETTINGS_STORE)
        .ok()
        .and_then(|s| s.get(KEY_STORE))
        .and_then(|v| v.as_str().and_then(TalkKey::parse))
        .unwrap_or_default()
}

pub(crate) fn paste_style(app: &AppHandle) -> PasteStyle {
    app.store(crate::commands::SETTINGS_STORE)
        .ok()
        .and_then(|s| s.get(PASTE_STORE))
        .and_then(|v| v.as_str().and_then(PasteStyle::parse))
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkSettingsDto {
    /// False where talk is not built yet (everything but macOS).
    supported: bool,
    key: &'static str,
    paste: &'static str,
    /// What macOS does on a Fn press: `nothing`, `input_source`, `emoji`,
    /// `dictation`, or `None` when it could not be read. Anything but
    /// `nothing` opens on top of a Fn take, so Settings says how to change it.
    fn_usage: Option<&'static str>,
}

#[tauri::command]
pub fn get_talk_settings(app: AppHandle) -> TalkSettingsDto {
    TalkSettingsDto {
        supported: cfg!(target_os = "macos"),
        key: talk_key(&app).as_str(),
        paste: paste_style(&app).as_str(),
        fn_usage: fn_usage(),
    }
}

#[tauri::command]
pub fn set_talk_settings(
    app: AppHandle,
    key: Option<String>,
    paste: Option<String>,
) -> Result<(), String> {
    let store = app
        .store(crate::commands::SETTINGS_STORE)
        .map_err(|e| e.to_string())?;
    if let Some(key) = key {
        let parsed = TalkKey::parse(&key).ok_or_else(|| format!("unknown talk key: {key}"))?;
        if parsed != TalkKey::Off && !cfg!(target_os = "macos") {
            return Err("Talk to your agent is available on Mac only for now".into());
        }
        store.set(KEY_STORE, serde_json::json!(parsed.as_str()));
    }
    if let Some(paste) = paste {
        let parsed =
            PasteStyle::parse(&paste).ok_or_else(|| format!("unknown paste style: {paste}"))?;
        store.set(PASTE_STORE, serde_json::json!(parsed.as_str()));
    }
    store.save().map_err(|e| e.to_string())
}

/// `AppleFnUsageType` from `com.apple.HIToolbox`: 0 do nothing, 1 change
/// input source, 2 emoji and symbols, 3 start dictation.
#[cfg(target_os = "macos")]
fn fn_usage() -> Option<&'static str> {
    let output = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "com.apple.HIToolbox", "AppleFnUsageType"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "0" => Some("nothing"),
        "1" => Some("input_source"),
        "2" => Some("emoji"),
        "3" => Some("dictation"),
        _ => None,
    }
}

#[cfg(not(target_os = "macos"))]
fn fn_usage() -> Option<&'static str> {
    None
}

/// Starts the key watcher. Safe to call once at launch; does nothing off
/// macOS.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::init(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// The words of a take's transcript once it has settled, for the paste.
/// Whether Right Option is down, from `CGEventSourceFlagsState`. The key state
/// reports both Option keys as kVK_Option (58) and never kVK_RightOption (61);
/// only the device-dependent flag (NX_DEVICERALTKEYMASK) tells them apart.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn right_option_held(flags: u64) -> bool {
    const OPTION_FLAG: u64 = 0x0008_0000;
    const RIGHT_OPTION_DEVICE_FLAG: u64 = 0x40;
    flags & OPTION_FLAG != 0 && flags & RIGHT_OPTION_DEVICE_FLAG != 0
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
async fn wait_for_words(dir: &Path) -> Option<String> {
    let deadline = std::time::Instant::now() + WORDS_WAIT;
    loop {
        let settled = crate::local::read_status(dir)
            .is_some_and(|s| !matches!(s.stage.as_str(), "recording" | "transcribing"));
        if settled {
            return crate::local::transcript_words(dir);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn notify(app: &AppHandle, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(crate::i18n::t("notifications.talkTitle"))
        .body(body)
        .show();
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn arec_of(dir: &Path) -> PathBuf {
    dir.join("recording.arec")
}

/// How a take ended when it was stopped outside the talk key: `Some(true)`
/// once it was sealed (`metadata.json`), `Some(false)` once it was discarded
/// (the `cancelled` marker `local::cancel` writes, or the folder already
/// trashed), `None` while it is still undecided. Discard empties the active
/// recording before it marks the take, so "no active recording" alone does
/// not mean the take was kept.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn external_outcome(dir: &Path) -> Option<bool> {
    if !dir.exists() || dir.join("cancelled").exists() {
        Some(false)
    } else if dir.join("metadata.json").exists() {
        Some(true)
    } else {
        None
    }
}

/// Waits for `external_outcome` to decide. Undecided after the wait counts
/// as not kept: pasting the path of a take that may be gone is worse than
/// pasting nothing, and the take stays in Local recordings either way.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
async fn kept_after_external_stop(dir: &Path) -> bool {
    let deadline = std::time::Instant::now() + EXTERNAL_STOP_WAIT;
    loop {
        if let Some(kept) = external_outcome(dir) {
            return kept;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use crate::clipboard_history::PasteTarget;
    use crate::recording::RecordingController;
    use crate::types::{CaptureSourceDto, RecordingMode, RecordingPhase};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;
    use tauri::Manager;

    const POLL: Duration = Duration::from_millis(15);
    const POLL_OFF: Duration = Duration::from_millis(500);

    static STARTED: AtomicBool = AtomicBool::new(false);

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Phase {
        Starting,
        Recording,
        Finishing,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum End {
        Stop,
        Cancel,
    }

    struct Session {
        phase: Phase,
        recording_id: Option<String>,
        dir: Option<PathBuf>,
        target: Option<PasteTarget>,
        started: Instant,
        /// Stop or Esc arrived while the capture was still starting.
        pending: Option<End>,
    }

    static SESSION: parking_lot::Mutex<Option<Session>> = parking_lot::Mutex::new(None);

    pub(super) fn init(app: &AppHandle) {
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        if let Err(err) = std::thread::Builder::new()
            .name("clipy-talk".to_string())
            .spawn(move || run(app))
        {
            tracing::warn!("talk key watcher did not start: {err}");
        }
    }

    fn read_keys(key: TalkKey) -> TalkKeys {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventSourceKeyState(state_id: u32, key: u16) -> bool;
            fn CGEventSourceFlagsState(state_id: u32) -> u64;
        }
        // kCGEventFlagMaskSecondaryFn.
        const FN_FLAG: u64 = 0x0080_0000;
        const KVK_FUNCTION: u16 = 0x3F;
        const KVK_ESCAPE: u16 = 0x35;
        // kCGEventSourceStateCombinedSessionState = 0.
        let down = |code: u16| unsafe { CGEventSourceKeyState(0, code) };
        let trigger = match key {
            TalkKey::Off => false,
            TalkKey::Fn => {
                down(KVK_FUNCTION) || unsafe { CGEventSourceFlagsState(0) } & FN_FLAG != 0
            }
            TalkKey::RightOption => right_option_held(unsafe { CGEventSourceFlagsState(0) }),
        };
        if !trigger && SESSION.lock().is_none() {
            return TalkKeys::default();
        }
        // Virtual keycodes 54-63 are the modifiers (Command, Shift, Caps Lock,
        // Option, Control, Fn); Control is how Flare points, so modifiers
        // never make the press a shortcut.
        let other_key = (0..128u16)
            .filter(|code| !(54..=63).contains(code) && *code != KVK_ESCAPE)
            .any(down);
        TalkKeys {
            trigger,
            other_key,
            escape: down(KVK_ESCAPE),
        }
    }

    fn run(app: AppHandle) {
        let clock = Instant::now();
        let mut tracker = TalkTracker::default();
        let mut key = TalkKey::Off;
        let mut key_read_at: Option<Instant> = None;
        loop {
            // The setting changes rarely; read it once a second.
            if key_read_at.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                key = talk_key(&app);
                key_read_at = Some(Instant::now());
            }
            if key == TalkKey::Off && SESSION.lock().is_none() {
                tracker = TalkTracker::default();
                std::thread::sleep(POLL_OFF);
                continue;
            }
            std::thread::sleep(POLL);

            reconcile(&app, &mut tracker);

            let keys = read_keys(key);
            let now_ms = clock.elapsed().as_millis() as u64;
            match tracker.update(keys, now_ms) {
                Some(TalkAction::Start(mode)) => {
                    if !try_begin(&app) {
                        tracker.clear_active();
                    } else {
                        tracing::info!(?mode, "talk take starting");
                    }
                }
                Some(TalkAction::Stop) => request_end(&app, End::Stop),
                Some(TalkAction::Cancel) => request_end(&app, End::Cancel),
                None => {}
            }
        }
    }

    /// Keeps the tracker and the session in step with what happened outside
    /// the keys: a take stopped from the controls, a failed start, the time
    /// limit.
    fn reconcile(app: &AppHandle, tracker: &mut TalkTracker) {
        let mut stop_now = false;
        let mut external_stop = false;
        {
            let guard = SESSION.lock();
            match guard.as_ref() {
                None => tracker.clear_active(),
                Some(session) if session.phase == Phase::Recording => {
                    let ours = session.recording_id.as_deref();
                    let still = app
                        .state::<RecordingController>()
                        .active_recording_id()
                        .is_some_and(|id| Some(id.as_str()) == ours);
                    if !still {
                        external_stop = true;
                    } else if session.started.elapsed() >= MAX_TAKE {
                        stop_now = true;
                    }
                }
                Some(_) => {}
            }
        }
        if external_stop {
            tracker.clear_active();
            end(app, End::Stop, true);
        } else if stop_now {
            tracker.clear_active();
            end(app, End::Stop, false);
        }
    }

    fn try_begin(app: &AppHandle) -> bool {
        {
            let mut guard = SESSION.lock();
            if guard.is_some() {
                return false;
            }
            if app.state::<RecordingController>().dto().phase != RecordingPhase::Idle {
                return false;
            }
            *guard = Some(Session {
                phase: Phase::Starting,
                recording_id: None,
                dir: None,
                // Read before anything can take focus.
                target: crate::clipboard_history::frontmost_target(),
                started: Instant::now(),
                pending: None,
            });
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            match begin(&app).await {
                Ok((recording_id, dir)) => {
                    let pending = {
                        let mut guard = SESSION.lock();
                        let Some(session) = guard.as_mut() else {
                            return;
                        };
                        session.recording_id = Some(recording_id);
                        session.dir = Some(dir);
                        session.phase = Phase::Recording;
                        session.started = Instant::now();
                        session.pending.take()
                    };
                    if let Some(how) = pending {
                        end(&app, how, false);
                    }
                }
                Err(err) => {
                    tracing::warn!("talk take did not start: {err:#}");
                    *SESSION.lock() = None;
                    notify(
                        &app,
                        &crate::i18n::t_with(
                            "notifications.talkStartFailed",
                            &[("reason", crate::api_error::user_message(&err))],
                        ),
                    );
                }
            }
        });
        true
    }

    async fn begin(app: &AppHandle) -> anyhow::Result<(String, PathBuf)> {
        crate::local::preflight_new_recording(app).await?;
        let settings = crate::commands::get_recording_settings(app.clone()).unwrap_or_default();
        let mut audio = settings.audio;
        // Your voice is the point; the computer's own audio would only
        // muddy the words.
        audio.include_mic = true;
        audio.include_system_audio = false;
        let source = display_under_pointer().map(|id| CaptureSourceDto::Display { id });
        let recording_id = app
            .state::<RecordingController>()
            .start(
                app,
                String::new(),
                source,
                Some(audio),
                None,
                None,
                None,
                RecordingMode::Local,
                0,
            )
            .await?;
        let recording_id = recording_id.to_string();
        let dir = crate::local::directory(app, &recording_id)?;
        if let Err(err) = crate::local::mark_talk_take(&dir) {
            tracing::warn!("talk take marker could not be written: {err:#}");
        }
        Ok((recording_id, dir))
    }

    fn display_under_pointer() -> Option<u32> {
        #[repr(C)]
        struct CGPoint {
            x: f64,
            y: f64,
        }
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGGetDisplaysWithPoint(
                point: CGPoint,
                max_displays: u32,
                displays: *mut u32,
                matching: *mut u32,
            ) -> i32;
        }
        let (x, y) = crate::cursor_track::current_cursor_position()?;
        let mut display = 0u32;
        let mut count = 0u32;
        // SAFETY: room for exactly the one display asked for.
        let err = unsafe {
            CGGetDisplaysWithPoint(
                CGPoint {
                    x: x as f64,
                    y: y as f64,
                },
                1,
                &mut display,
                &mut count,
            )
        };
        (err == 0 && count == 1).then_some(display)
    }

    fn request_end(app: &AppHandle, how: End) {
        {
            let mut guard = SESSION.lock();
            let Some(session) = guard.as_mut() else {
                return;
            };
            match session.phase {
                Phase::Starting => {
                    session.pending = Some(how);
                    return;
                }
                Phase::Finishing => return,
                Phase::Recording => {}
            }
        }
        end(app, how, false);
    }

    /// Stops (unless it already stopped elsewhere), then pastes or discards.
    fn end(app: &AppHandle, how: End, already_stopped: bool) {
        let (recording_id, dir, target, started) = {
            let mut guard = SESSION.lock();
            let Some(session) = guard.as_mut() else {
                return;
            };
            if session.phase == Phase::Finishing {
                return;
            }
            session.phase = Phase::Finishing;
            match (session.recording_id.clone(), session.dir.clone()) {
                (Some(id), Some(dir)) => (id, dir, session.target, session.started),
                _ => {
                    *guard = None;
                    return;
                }
            }
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            finish(
                &app,
                how,
                already_stopped,
                &recording_id,
                &dir,
                target,
                started,
            )
            .await;
            *SESSION.lock() = None;
        });
    }

    async fn finish(
        app: &AppHandle,
        how: End,
        already_stopped: bool,
        recording_id: &str,
        dir: &Path,
        target: Option<PasteTarget>,
        started: Instant,
    ) {
        let rec = app.state::<RecordingController>();
        let ours = || {
            rec.active_recording_id()
                .is_some_and(|id| id.as_str() == recording_id)
        };
        let accidental = !already_stopped && started.elapsed() < MIN_TAKE;
        if how == End::Cancel || accidental {
            if ours() {
                if let Err(err) = rec.stop(app).await {
                    tracing::warn!("talk take could not be stopped for discard: {err:#}");
                }
            }
            if let Err(err) = crate::local::discard(app, dir.to_path_buf()).await {
                tracing::warn!("talk take could not be discarded: {err:#}");
            }
            return;
        }
        if already_stopped {
            // Stopped from the recording controls: Stop keeps the take,
            // Discard throws it away and must paste nothing.
            if !kept_after_external_stop(dir).await {
                return;
            }
        } else if ours() {
            if let Err(err) = rec.stop(app).await {
                tracing::warn!("talk take did not stop cleanly: {err:#}");
                notify(app, &crate::i18n::t("notifications.talkStopFailed"));
                return;
            }
        }
        let style = paste_style(app);
        let words = if style == PasteStyle::Path {
            None
        } else {
            wait_for_words(dir).await
        };
        let Some(text) = compose_paste(style, words.as_deref(), &arec_of(dir)) else {
            notify(app, &crate::i18n::t("notifications.talkNoWords"));
            return;
        };
        if !crate::clipboard_history::paste_text_into(app, &text, target).await {
            notify(app, &crate::i18n::t("notifications.talkCopiedOnly"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(trigger: bool) -> TalkKeys {
        TalkKeys {
            trigger,
            ..TalkKeys::default()
        }
    }

    /// Feeds (trigger, at_ms) readings and collects the actions.
    fn run(steps: &[(bool, u64)]) -> Vec<TalkAction> {
        let mut tracker = TalkTracker::default();
        steps
            .iter()
            .filter_map(|&(down, at)| tracker.update(keys(down), at))
            .collect()
    }

    #[test]
    fn a_hold_starts_after_the_grace_and_release_stops() {
        assert_eq!(
            run(&[
                (true, 0),
                (true, 100),
                (true, HOLD_START_MS),
                (true, 2_000),
                (false, 2_100)
            ]),
            vec![TalkAction::Start(TalkMode::Hold), TalkAction::Stop]
        );
    }

    #[test]
    fn a_short_tap_does_nothing() {
        assert!(run(&[(true, 0), (true, 100), (false, 150)]).is_empty());
    }

    #[test]
    fn a_double_tap_starts_hands_free_and_the_next_tap_stops() {
        assert_eq!(
            run(&[
                (true, 0),
                (false, 120),
                (true, 300),
                // Held past the hold grace: still hands-free, no second start.
                (true, 900),
                (false, 950),
                (false, 5_000),
                (true, 5_100),
                (false, 5_200),
                (false, 6_000),
            ]),
            vec![TalkAction::Start(TalkMode::HandsFree), TalkAction::Stop]
        );
    }

    #[test]
    fn a_slow_second_tap_is_not_a_double_tap() {
        assert!(run(&[
            (true, 0),
            (false, 100),
            (true, 100 + DOUBLE_TAP_GAP_MS + 50),
            (false, 600)
        ])
        .is_empty());
    }

    #[test]
    fn a_shortcut_never_starts() {
        let mut tracker = TalkTracker::default();
        assert_eq!(tracker.update(keys(true), 0), None);
        let chord = TalkKeys {
            trigger: true,
            other_key: true,
            escape: false,
        };
        assert_eq!(tracker.update(chord, 50), None);
        assert_eq!(tracker.update(keys(true), 1_000), None);
        assert_eq!(tracker.update(keys(false), 1_100), None);
        // And it does not count as the first half of a double tap.
        assert_eq!(tracker.update(keys(true), 1_200), None);
        assert_eq!(tracker.update(keys(false), 1_250), None);
    }

    #[test]
    fn escape_cancels_and_the_release_does_nothing() {
        let mut tracker = TalkTracker::default();
        tracker.update(keys(true), 0);
        assert_eq!(
            tracker.update(keys(true), HOLD_START_MS),
            Some(TalkAction::Start(TalkMode::Hold))
        );
        let esc = TalkKeys {
            trigger: true,
            other_key: false,
            escape: true,
        };
        assert_eq!(tracker.update(esc, 1_000), Some(TalkAction::Cancel));
        assert_eq!(tracker.update(keys(false), 1_100), None);
        assert_eq!(tracker.active(), None);
    }

    #[test]
    fn a_take_ended_elsewhere_ignores_the_held_key() {
        let mut tracker = TalkTracker::default();
        tracker.update(keys(true), 0);
        tracker.update(keys(true), HOLD_START_MS);
        tracker.clear_active();
        assert_eq!(tracker.update(keys(true), 2_000), None);
        assert_eq!(tracker.update(keys(false), 2_100), None);
    }

    #[test]
    fn paste_puts_the_words_first_then_the_path() {
        let arec = Path::new("/r/recording.arec");
        assert_eq!(
            compose_paste(PasteStyle::WordsAndPath, Some("  make this blue "), arec).unwrap(),
            "make this blue\n\nClipy recording: /r/recording.arec"
        );
        assert_eq!(
            compose_paste(PasteStyle::WordsAndPath, None, arec).unwrap(),
            "Clipy recording: /r/recording.arec"
        );
        assert_eq!(
            compose_paste(PasteStyle::Path, Some("x"), arec).unwrap(),
            "/r/recording.arec"
        );
        assert_eq!(
            compose_paste(PasteStyle::Words, Some("hi"), arec).unwrap(),
            "hi"
        );
        assert_eq!(compose_paste(PasteStyle::Words, Some("  "), arec), None);
    }

    #[test]
    fn a_take_stopped_elsewhere_pastes_only_once_it_was_kept() {
        let dir = std::env::temp_dir().join(format!("clipy-talk-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Discard has emptied the active recording but not marked the take yet.
        assert_eq!(external_outcome(&dir), None);
        std::fs::write(dir.join("metadata.json"), b"{}").unwrap();
        assert_eq!(external_outcome(&dir), Some(true));
        // A cancel marker wins even when the take was sealed first.
        std::fs::write(dir.join("cancelled"), b"cancelled").unwrap();
        assert_eq!(external_outcome(&dir), Some(false));
        std::fs::remove_dir_all(&dir).unwrap();
        // Trashed.
        assert_eq!(external_outcome(&dir), Some(false));
    }

    #[test]
    fn right_option_is_told_apart_from_left_by_the_device_flag() {
        // Flags read on a MacBook Pro keyboard, 2026-11-28.
        assert!(right_option_held(0x80140));
        assert!(!right_option_held(0x80120));
        assert!(!right_option_held(0x100));
        assert!(!right_option_held(0x40));
    }

    #[test]
    fn settings_round_trip() {
        for key in [TalkKey::Off, TalkKey::Fn, TalkKey::RightOption] {
            assert_eq!(TalkKey::parse(key.as_str()), Some(key));
        }
        for style in [
            PasteStyle::WordsAndPath,
            PasteStyle::Path,
            PasteStyle::Words,
        ] {
            assert_eq!(PasteStyle::parse(style.as_str()), Some(style));
        }
        assert_eq!(TalkKey::parse("right_command"), None);
    }
}
