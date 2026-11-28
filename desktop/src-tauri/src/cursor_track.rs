//! Cursor + click tracking that runs alongside the encoder.
//!
//! Captures a timestamped event stream that downstream tooling — either
//! native Studio or future on-device renderers — can turn into auto-zoom
//! keyframes, cursor smoothing, and click highlights.
//!
//! Algorithm reference: Screen Studio-style click-to-zoom is a published
//! technique. Cap.so ships an AGPL implementation; this is a clean-room
//! rewrite using only the public `device_query` crate API. No Cap source
//! is reused.
//!
//! Threading model: a single OS thread polls cursor position + button
//! state, plus keyboard down/up state where the platform exposes it, at
//! `POLL_HZ`. The thread owns its `DeviceState` (the crate returns
//! non-`Send` handles on some platforms) and pushes deltas into an
//! adaptively downsampled bounded buffer. Stop is signalled via an
//! `AtomicBool` so the thread joins cleanly without holding the runtime.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

#[cfg(not(target_os = "macos"))]
use device_query::{DeviceQuery, DeviceState};

/// Sampling rate. 60Hz is plenty for both auto-zoom interval generation
/// (which only inspects click timestamps) and post-record cursor smoothing
/// (Studio resamples at whatever frame rate the output needs).
const POLL_HZ: u64 = 60;
const POLL_PERIOD: Duration = Duration::from_millis(1000 / POLL_HZ);
const MAX_CURSOR_EVENTS: usize = 50_000;
/// Matches the server's `capture_timeline` limit, so a long window-only
/// recording compacts here instead of failing the sidecar upload.
const MAX_CAPTURE_VIEWPORT_SAMPLES: usize = 10_000;
const MAX_CLICK_ELEMENT_SAMPLES: usize = 10_000;
#[cfg(target_os = "macos")]
const CAPTURE_VIEWPORT_POLL_PERIOD: Duration = Duration::from_millis(200);
const CAPTURE_VIEWPORT_EPSILON: f64 = 0.5;

/// One sample in the event stream. `time_ms` is monotonic milliseconds
/// since the tracker started — meant to align with the recording's
/// PTS-zero origin. Coords are raw screen pixels (logical on macOS,
/// physical on Windows) so the editor can correlate against the captured
/// frame's coordinate space.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CursorEvent {
    Move {
        time_ms: f64,
        x: i32,
        y: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor_type: Option<String>,
    },
    Down {
        time_ms: f64,
        button: u8,
        x: i32,
        y: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        render_x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        render_y: Option<f64>,
    },
    Up {
        time_ms: f64,
        button: u8,
        x: i32,
        y: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor_type: Option<String>,
    },
    Scroll {
        time_ms: f64,
        x: i32,
        y: i32,
        delta_x: i32,
        delta_y: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor_type: Option<String>,
    },
    KeyDown {
        time_ms: f64,
        key_code: u16,
    },
    KeyUp {
        time_ms: f64,
        key_code: u16,
    },
    /// The annotation overlay switching on or off, whatever flipped it: a
    /// Control hold, the HUD pen toggle, or Escape. Recorded so a highlight
    /// made with the pen toggled by hand — which leaves no key event — is
    /// still reconstructible by key-moment fusion.
    Annotation {
        time_ms: f64,
        active: bool,
    },
}

impl CursorEvent {
    pub fn time_ms(&self) -> f64 {
        match self {
            CursorEvent::Move { time_ms, .. }
            | CursorEvent::Down { time_ms, .. }
            | CursorEvent::Up { time_ms, .. }
            | CursorEvent::Scroll { time_ms, .. }
            | CursorEvent::KeyDown { time_ms, .. }
            | CursorEvent::KeyUp { time_ms, .. }
            | CursorEvent::Annotation { time_ms, .. } => *time_ms,
        }
    }
}

struct CursorEventBuffer {
    events: VecDeque<CursorEvent>,
    move_events: usize,
    move_stride: u64,
    moves_seen: u64,
    compactions: u64,
}

impl CursorEventBuffer {
    fn new() -> Self {
        Self {
            // Grow into the bound rather than reserving it up front — every
            // recording, however short, would otherwise pay the full ceiling.
            events: VecDeque::with_capacity(4096),
            move_events: 0,
            move_stride: 1,
            moves_seen: 0,
            compactions: 0,
        }
    }

    fn push(&mut self, event: CursorEvent) {
        let is_move = matches!(event, CursorEvent::Move { .. });
        if is_move {
            self.moves_seen = self.moves_seen.saturating_add(1);
            if self.moves_seen % self.move_stride != 0 {
                return;
            }
        }

        if self.events.len() >= MAX_CURSOR_EVENTS {
            self.compact_moves();
        }
        if self.events.len() >= MAX_CURSOR_EVENTS {
            if is_move {
                return;
            }
            if matches!(self.events.pop_front(), Some(CursorEvent::Move { .. })) {
                self.move_events = self.move_events.saturating_sub(1);
            }
        }
        if is_move {
            self.move_events = self.move_events.saturating_add(1);
        }
        self.events.push_back(event);
    }

    fn compact_moves(&mut self) {
        if self.move_events == 0 {
            return;
        }
        let before = self.events.len();
        let mut keep_move = true;
        let mut retained_moves = 0;
        self.events.retain(|event| {
            if matches!(event, CursorEvent::Move { .. }) {
                keep_move = !keep_move;
                if keep_move {
                    retained_moves += 1;
                }
                keep_move
            } else {
                true
            }
        });
        self.move_events = retained_moves;
        self.move_stride = self.move_stride.saturating_mul(2);
        self.compactions = self.compactions.saturating_add(1);
        if self.compactions == 1 || self.compactions.is_power_of_two() {
            tracing::warn!(
                before,
                after = self.events.len(),
                compactions = self.compactions,
                move_stride = self.move_stride,
                max_events = MAX_CURSOR_EVENTS,
                "cursor telemetry compacted to stay within its memory budget"
            );
        }
    }
}

impl Default for CursorEventBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Viewport samples for a window-only recording, which follows its window.
/// Bounded the same way as the event buffer: past the cap it keeps every
/// other sample and doubles its stride.
struct CaptureTimelineBuffer {
    samples: Vec<CaptureViewportSample>,
    sample_stride: u64,
    samples_seen: u64,
    /// The last sample is one the stride would have dropped, kept only
    /// because it is the newest: the sampler pushes on change, so a window
    /// that then stays still would otherwise leave a stale viewport mapping
    /// every later click. The next push replaces it.
    provisional_tail: bool,
}

impl CaptureTimelineBuffer {
    fn new(initial: Option<CaptureViewportSample>) -> Self {
        Self {
            samples: initial.into_iter().collect(),
            sample_stride: 1,
            samples_seen: u64::from(initial.is_some()),
            provisional_tail: false,
        }
    }

    // Fed by the macOS sampler only.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn push(&mut self, sample: CaptureViewportSample) {
        self.samples_seen = self.samples_seen.saturating_add(1);
        if self.provisional_tail {
            self.samples.pop();
            self.provisional_tail = false;
        }
        let on_stride = self.samples_seen % self.sample_stride == 0;
        if self.samples.len() >= MAX_CAPTURE_VIEWPORT_SAMPLES {
            let before = self.samples.len();
            self.samples = self
                .samples
                .drain(..)
                .enumerate()
                .filter_map(|(index, sample)| (index % 2 == 0).then_some(sample))
                .collect();
            self.sample_stride = self.sample_stride.saturating_mul(2).max(1);
            tracing::warn!(
                before,
                after = self.samples.len(),
                sample_stride = self.sample_stride,
                max_samples = MAX_CAPTURE_VIEWPORT_SAMPLES,
                "capture viewport telemetry compacted to stay within its memory budget"
            );
        }
        self.samples.push(sample);
        self.provisional_tail = !on_stride;
    }
}

impl Default for CaptureTimelineBuffer {
    fn default() -> Self {
        Self::new(None)
    }
}

/// The full captured track. Serialized as the sidecar JSON next to the
/// recording MP4. Schema is intentionally simple: a single flat array
/// keyed by `kind`, easy to consume from native Studio with no extra
/// glue code.
#[derive(Default, Clone, Debug, Serialize, Deserialize)]
pub struct CursorTrack {
    pub events: Vec<CursorEvent>,
    /// Sampling rate in Hz so consumers can interpolate sensibly without
    /// hard-coding the same constant.
    pub sample_hz: u64,
    /// Coordinate space hint. macOS reports logical (post-DPI) pixels,
    /// Windows reports physical. The editor needs to know which to scale
    /// against the captured frame.
    pub coord_space: CoordSpace,
    /// Capture-space mapping. Clipy keeps raw OS coordinates and adds this
    /// viewport so Studio can convert them precisely. The optional
    /// `screen_*` fields describe the full display in the same coordinate
    /// space; Screen Charm's raw input-event file normalizes against that
    /// full display, not the cropped capture rectangle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture: Option<CaptureViewport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capture_timeline: Vec<CaptureViewportSample>,
    /// User-selected capture source metadata. This is separate from
    /// `capture` geometry so audits can distinguish display/window/area
    /// choices and controlled dev harness captures.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_source: Option<crate::types::CaptureSourceMetadataDto>,
    /// AX element identity sampled at each click (macOS):
    /// the accessibility role + visible label of the UI element under the
    /// cursor at mouse-down. Parallel to the `down` events in `events`
    /// (matched by time_ms) instead of inline fields so the event enum's
    /// many literal construction sites stay untouched. Feeds key-moment
    /// captions so agents get "clicked 'Submit'" instead of coordinates.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub click_elements: Vec<ClickElementSample>,
}

impl CursorTrack {
    pub fn capture_at(&self, time_ms: f64) -> Option<CaptureViewport> {
        let mut capture = self.capture;
        for sample in &self.capture_timeline {
            if sample.time_ms <= time_ms {
                capture = Some(sample.viewport);
            } else {
                break;
            }
        }
        capture
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct CaptureViewport {
    /// Top-left of the captured source in the same coordinate space as
    /// `CursorEvent::{x,y}`.
    pub x: f64,
    pub y: f64,
    /// Captured source size in cursor-coordinate units.
    pub width: f64,
    pub height: f64,
    /// Encoded video dimensions for this capture.
    pub output_width: u32,
    pub output_height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_height: Option<f64>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct CaptureViewportSample {
    pub time_ms: f64,
    #[serde(flatten)]
    pub viewport: CaptureViewport,
}

/// Where the window's pixels sit inside the encoded frame, in output
/// pixels, as ScreenCaptureKit reports it on each frame. Equal to the whole
/// frame until the window is resized to a different shape, when SCK fits it
/// inside the fixed frame with bars.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContentPlacement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Written by the capture callback, read by the cursor sampler.
pub type SharedContentPlacement = Arc<Mutex<Option<ContentPlacement>>>;

/// Turn a frame's `SCStreamFrameInfoContentRect` and
/// `SCStreamFrameInfoScaleFactor` into output pixels.
///
/// The rect's size is in points, but its origin's unit is not settled:
/// Chromium's consumer scales only the size and passes the origin through.
/// So every reading (size scaled or not, origin scaled or not) is tried, and
/// the geometry decides: with scales-to-fit the content spans the frame on at
/// least one axis and is centered on the other, so the reading that spans and
/// leaves the most even bars wins; on a tie the unscaled origin (Chromium's
/// reading) is kept. Anything that does not fit the frame is rejected, so a
/// misread attachment leaves the plain window mapping in place rather than
/// skewing every cursor sample.
pub fn content_placement_in_output(
    rect: (f64, f64, f64, f64),
    scale_factor: f64,
    output_width: f64,
    output_height: f64,
) -> Option<ContentPlacement> {
    const SLACK: f64 = 2.0;
    let fits = |x: f64, y: f64, w: f64, h: f64| {
        [x, y, w, h].iter().all(|v| v.is_finite())
            && w >= 2.0
            && h >= 2.0
            && x >= -SLACK
            && y >= -SLACK
            && x + w <= output_width + SLACK
            && y + h <= output_height + SLACK
    };
    let (x, y, w, h) = rect;
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let spans =
        |w: f64, h: f64| (w - output_width).abs() <= SLACK || (h - output_height).abs() <= SLACK;
    // How uneven the bars are: 0 for content centered in the frame.
    let imbalance = |x: f64, y: f64, w: f64, h: f64| {
        (x - (output_width - x - w)).abs() + (y - (output_height - y - h)).abs()
    };
    let mut best: Option<((bool, f64), (f64, f64, f64, f64))> = None;
    for (w, h) in [(w * scale, h * scale), (w, h)] {
        for (x, y) in [(x, y), (x * scale, y * scale)] {
            if !fits(x, y, w, h) {
                continue;
            }
            // Lower is better: spanning first, then the most even bars.
            let rank = (!spans(w, h), imbalance(x, y, w, h));
            if best.is_none_or(|(best_rank, _)| {
                rank.0 < best_rank.0 || (rank.0 == best_rank.0 && rank.1 < best_rank.1 - 0.5)
            }) {
                best = Some((rank, (x, y, w, h)));
            }
        }
    }
    let (_, (x, y, w, h)) = best?;
    let x = x.clamp(0.0, output_width);
    let y = y.clamp(0.0, output_height);
    Some(ContentPlacement {
        x,
        y,
        width: w.min(output_width - x),
        height: h.min(output_height - y),
    })
}

/// What the sampler needs to follow a window-only recording.
#[derive(Clone)]
pub struct CaptureTimelineConfig {
    pub window_id: u32,
    pub initial: CaptureViewport,
    pub content: SharedContentPlacement,
}

/// The viewport that maps a cursor point to the right output pixel while
/// the window sits at `bounds` (global logical points) and its pixels fill
/// `content` inside the frame.
///
/// Consumers map with `(x - viewport.x) / viewport.width * output_width`,
/// i.e. they assume the viewport fills the frame. When SCK letterboxes a
/// resized window that is no longer true, so the viewport is widened past
/// the window by the bars: the window's left edge then lands on the
/// content's left edge and its right edge on the content's right edge.
/// Without a placement it is the window itself, the pre-2026-08-15 mapping.
pub fn window_capture_viewport(
    bounds: (f64, f64, f64, f64),
    content: Option<ContentPlacement>,
    baseline: CaptureViewport,
) -> CaptureViewport {
    let (x, y, width, height) = bounds;
    let width = width.max(2.0);
    let height = height.max(2.0);
    let output_width = f64::from(baseline.output_width.max(2));
    let output_height = f64::from(baseline.output_height.max(2));
    let (x, y, width, height) = match content {
        Some(c) if c.width >= 2.0 && c.height >= 2.0 => {
            // Output pixels per point, per axis.
            let scale_x = c.width / width;
            let scale_y = c.height / height;
            (
                x - c.x / scale_x,
                y - c.y / scale_y,
                output_width / scale_x,
                output_height / scale_y,
            )
        }
        _ => (x, y, width, height),
    };
    CaptureViewport {
        x,
        y,
        width,
        height,
        output_width: baseline.output_width,
        output_height: baseline.output_height,
        screen_x: baseline.screen_x,
        screen_y: baseline.screen_y,
        screen_width: baseline.screen_width,
        screen_height: baseline.screen_height,
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn capture_viewport_changed(previous: CaptureViewport, next: CaptureViewport) -> bool {
    (previous.x - next.x).abs() > CAPTURE_VIEWPORT_EPSILON
        || (previous.y - next.y).abs() > CAPTURE_VIEWPORT_EPSILON
        || (previous.width - next.width).abs() > CAPTURE_VIEWPORT_EPSILON
        || (previous.height - next.height).abs() > CAPTURE_VIEWPORT_EPSILON
}

/// Accessibility identity of the element under the cursor at a mouse-down,
/// keyed by the same pause-excluded `time_ms` as the matching `down` event.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClickElementSample {
    pub time_ms: f64,
    /// AX role, e.g. "AXButton", "AXLink". None when the AX query failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Best visible label: AXTitle, else AXDescription, else AXValue for
    /// static text. Trimmed and capped at capture time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordSpace {
    LogicalMacos,
    PhysicalWindows,
}

impl Default for CoordSpace {
    fn default() -> Self {
        // Picked to match the dev host so a default-constructed track
        // (only used by tests + serde fallbacks) stays consistent with
        // what live tracking would emit on macOS.
        CoordSpace::LogicalMacos
    }
}

/// Handle returned by `CursorTracker::start`. Call `stop()` to halt the
/// polling thread and harvest the captured events.
pub struct CursorTracker {
    events: Arc<Mutex<CursorEventBuffer>>,
    capture_timeline: Arc<Mutex<CaptureTimelineBuffer>>,
    click_elements: Arc<Mutex<VecDeque<ClickElementSample>>>,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
    coord_space: CoordSpace,
}

impl CursorTracker {
    // Used by the Windows capture path + tests; macOS uses the
    // paused-aware variant.
    #[allow(dead_code)]
    pub fn start() -> Self {
        Self::start_inner(None, None)
    }

    /// Pause-aware variant: while the shared PauseState is
    /// paused, no samples are recorded, and `time_ms` is stamped on the
    /// pause-excluded timeline so events stay aligned with the video PTS
    /// (which excludes paused time via the pump's anchor shift).
    #[allow(dead_code)]
    pub fn start_paused_aware(pause: Arc<crate::recording::PauseState>) -> Self {
        Self::start_inner(Some(pause), None)
    }

    /// Window-only recordings follow their window, so the viewport is
    /// sampled alongside the cursor and written as `capture_timeline`.
    pub fn start_paused_aware_with_capture_timeline(
        pause: Arc<crate::recording::PauseState>,
        capture: Option<CaptureTimelineConfig>,
    ) -> Self {
        Self::start_inner(Some(pause), capture)
    }

    fn start_inner(
        pause: Option<Arc<crate::recording::PauseState>>,
        capture: Option<CaptureTimelineConfig>,
    ) -> Self {
        let events = Arc::new(Mutex::new(CursorEventBuffer::new()));
        let capture_timeline = Arc::new(Mutex::new(CaptureTimelineBuffer::new(
            capture.as_ref().map(|capture| CaptureViewportSample {
                time_ms: 0.0,
                viewport: capture.initial,
            }),
        )));
        let click_elements = Arc::new(Mutex::new(VecDeque::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let started_at = Instant::now();

        let events_t = events.clone();
        let capture_timeline_t = capture_timeline.clone();
        let click_elements_t = click_elements.clone();
        let stop_t = stop.clone();
        let handle = std::thread::Builder::new()
            .name("clipy-cursor-track".to_string())
            .spawn(move || {
                poll_loop(
                    events_t,
                    capture_timeline_t,
                    click_elements_t,
                    stop_t,
                    started_at,
                    pause,
                    capture,
                )
            })
            .expect("spawn cursor-track thread");

        Self {
            events,
            capture_timeline,
            click_elements,
            stop,
            handle: Some(handle),
            coord_space: current_coord_space(),
        }
    }

    /// Stop the polling thread and return the captured track. Idempotent
    /// — repeat calls return an empty clone.
    pub fn stop(mut self) -> CursorTrack {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            // Worst-case the join waits one poll period; cheap.
            if h.join().is_err() {
                eprintln!("clipy cursor tracker thread panicked");
            }
        }
        let events = std::mem::take(&mut *self.events.lock())
            .events
            .into_iter()
            .collect();
        let capture_timeline = std::mem::take(&mut *self.capture_timeline.lock()).samples;
        let click_elements = std::mem::take(&mut *self.click_elements.lock())
            .into_iter()
            .collect();
        CursorTrack {
            events,
            sample_hz: POLL_HZ,
            coord_space: self.coord_space,
            capture: None,
            capture_timeline,
            capture_source: None,
            click_elements,
        }
    }
}

impl Drop for CursorTracker {
    fn drop(&mut self) {
        // Defensive: if the caller forgot to call `stop()`, still halt
        // the thread so it doesn't outlive the recording.
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            if h.join().is_err() {
                eprintln!("clipy cursor tracker thread panicked while dropping");
            }
        }
    }
}

struct MouseSample {
    x: i32,
    y: i32,
    buttons: [bool; 5],
    cursor_type: Option<String>,
}

pub fn current_cursor_position() -> Option<(i32, i32)> {
    #[cfg(target_os = "macos")]
    {
        // Position only — deliberately NOT `current_mouse_sample`, which also
        // runs an Accessibility cursor-type probe (autoreleases objects). The
        // flare trail calls this at 60 Hz and only needs x/y; the CGEvent it
        // creates is released here, so this path allocates nothing lasting.
        use std::ffi::c_void;
        use std::ptr;

        #[repr(C)]
        struct CGPoint {
            x: f64,
            y: f64,
        }
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventCreate(source: *const c_void) -> *mut c_void;
            fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFRelease(cf: *const c_void);
        }

        let event = unsafe { CGEventCreate(ptr::null()) };
        if event.is_null() {
            return None;
        }
        let location = unsafe { CGEventGetLocation(event) };
        unsafe { CFRelease(event as *const c_void) };
        Some((location.x.round() as i32, location.y.round() as i32))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let device = DeviceState::new();
        current_mouse_sample(&device).map(|sample| (sample.x, sample.y))
    }
}

const KEY_STATES: usize = 128;

/// The one key code the sidecar stores for every key that is not a modifier.
/// No macOS virtual key uses 127 (they stop at 126), so it reads as "a key
/// that is not a modifier" and never as a particular key.
pub(crate) const TYPED_KEY_CODE: u16 = 127;
// Checked when the crate compiles: no real key, and not a modifier, so every
// reader that tells typing from modifiers still sees typing.
const _: () = assert!(TYPED_KEY_CODE > 126 && (TYPED_KEY_CODE < 54 || TYPED_KEY_CODE > 63));

/// The key code the sidecar records for a physical key: modifiers (54 to 63,
/// Control is 59 and 62) keep their own code, every other key becomes
/// [`TYPED_KEY_CODE`].
///
/// Everything that reads key events needs only that much: a Flare is a held
/// Control, a key pressed during the hold makes it a chord, and a typing
/// burst is a run of keys that are not modifiers. Which letters were pressed
/// is the user's typed content, which Clipy does not capture (see the AXValue
/// rule for click labels). Without this, a password or token typed during a
/// take could be read back from `recording.cursor.json`, which the AREC points
/// agents to, and from `recording.input-events.json`. Windows already records
/// modifiers only.
pub(crate) fn sidecar_key_code(key_code: u16) -> u16 {
    if (54..=63).contains(&key_code) {
        key_code
    } else {
        TYPED_KEY_CODE
    }
}

/// Run `f` inside an autorelease pool on macOS. This thread is a bare
/// `std::thread` with no Cocoa run loop, so nothing drains the autoreleased
/// objects that the Accessibility / CoreGraphics calls below create on every
/// poll. Without an explicit pool they accumulate without bound — at 60 Hz
/// that measured ~2 GB/min of leaked Foundation shared-memory regions and
/// OOM-killed the whole app after ~20 min of recording. Draining once per
/// iteration keeps steady-state memory flat.
#[cfg(target_os = "macos")]
fn with_autorelease_pool<T>(f: impl FnOnce() -> T) -> T {
    objc2::rc::autoreleasepool(|_| f())
}

#[cfg(not(target_os = "macos"))]
fn with_autorelease_pool<T>(f: impl FnOnce() -> T) -> T {
    f()
}

fn poll_loop(
    events: Arc<Mutex<CursorEventBuffer>>,
    capture_timeline: Arc<Mutex<CaptureTimelineBuffer>>,
    click_elements: Arc<Mutex<VecDeque<ClickElementSample>>>,
    stop: Arc<AtomicBool>,
    origin: Instant,
    pause: Option<Arc<crate::recording::PauseState>>,
    capture: Option<CaptureTimelineConfig>,
) {
    #[cfg(not(target_os = "macos"))]
    let _ = &click_elements;
    #[cfg(not(target_os = "macos"))]
    let device = DeviceState::new();
    // Only macOS records a window by itself; the Windows app always records
    // the fixed area and never passes a timeline config.
    #[cfg(not(target_os = "macos"))]
    let _ = (&capture_timeline, &capture);
    let mut last_pos: Option<(i32, i32)> = None;
    // device_query returns up to a handful of buttons; tracking 5 is
    // enough for left/middle/right + back/forward and matches the typical
    // mouse shape. Index 0 in `button_pressed` is the left button.
    let mut last_buttons: [bool; 5] = [false; 5];
    let mut last_keys: [bool; KEY_STATES] = [false; KEY_STATES];
    // The overlay is reset to off when the recording's cursor-trail session
    // starts, so the first flip seen here is a real turn-on.
    let mut last_annotation = false;
    #[cfg(target_os = "macos")]
    let scroll_tap = MacScrollEventTap::new(
        events.clone(),
        origin,
        pause.clone(),
        capture.as_ref().map(|capture| capture.window_id),
    );
    #[cfg(target_os = "macos")]
    let mut click_element_evictions = 0_u64;
    // A window-only take shows one window, so a press on another app's
    // window, and keys typed into another app, stay out of its evidence. A
    // release is recorded exactly when its press was.
    #[cfg(target_os = "macos")]
    let mut evidence_scope = capture
        .as_ref()
        .map(|capture| WindowEvidenceScope::new(capture.window_id));
    let mut recorded_buttons: [bool; 5] = [false; 5];
    let mut recorded_keys: [bool; KEY_STATES] = [false; KEY_STATES];
    #[cfg(target_os = "macos")]
    let mut capture_sampler = capture.map(|capture| {
        let previous = capture.initial;
        (capture, previous, Instant::now())
    });

    while !stop.load(Ordering::Relaxed) {
        // While paused, record nothing (and don't pump scrolls — their
        // stamps would land inside the excluded window). State deltas
        // (buttons/keys) keep being tracked so a press held across the
        // pause doesn't produce a phantom edge on resume.
        if pause.as_ref().is_some_and(|p| p.is_paused()) {
            std::thread::sleep(POLL_PERIOD);
            continue;
        }

        // Everything that touches Cocoa / Accessibility / CoreGraphics runs
        // inside one autorelease pool per iteration (see `with_autorelease_pool`).
        with_autorelease_pool(|| {
            #[cfg(target_os = "macos")]
            scroll_tap.pump();
            #[cfg(target_os = "macos")]
            if let Some(scope) = evidence_scope.as_mut() {
                scope.next_poll();
            }

            let now_ms = match pause.as_ref() {
                Some(p) => p.effective_elapsed_us(&origin) as f64 / 1000.0,
                None => origin.elapsed().as_secs_f64() * 1000.0,
            };
            #[cfg(target_os = "macos")]
            if let Some((capture, previous, last_poll)) = capture_sampler.as_mut() {
                if last_poll.elapsed() >= CAPTURE_VIEWPORT_POLL_PERIOD {
                    *last_poll = Instant::now();
                    // A minimized, hidden or closed window yields no bounds:
                    // keep the last viewport, which is also what the video
                    // shows.
                    if let Some(bounds) = current_window_bounds(capture.window_id) {
                        let next = window_capture_viewport(
                            bounds,
                            *capture.content.lock(),
                            capture.initial,
                        );
                        if capture_viewport_changed(*previous, next) {
                            capture_timeline.lock().push(CaptureViewportSample {
                                time_ms: now_ms,
                                viewport: next,
                            });
                            *previous = next;
                        }
                    }
                }
            }
            #[cfg(target_os = "macos")]
            let sample = current_mouse_sample();
            #[cfg(not(target_os = "macos"))]
            let sample = current_mouse_sample(&device);

            let Some(sample) = sample else {
                return;
            };
            let pos = (sample.x, sample.y);

            if last_pos != Some(pos) {
                events.lock().push(CursorEvent::Move {
                    time_ms: now_ms,
                    x: pos.0,
                    y: pos.1,
                    cursor_type: sample.cursor_type.clone(),
                });
                last_pos = Some(pos);
            }

            for (i, slot) in last_buttons.iter_mut().enumerate() {
                let pressed = sample.buttons[i];
                if pressed != *slot {
                    *slot = pressed;
                    if pressed {
                        #[cfg(target_os = "macos")]
                        let admitted = evidence_scope
                            .as_mut()
                            .is_none_or(|scope| scope.admits_press(pos.0, pos.1));
                        #[cfg(not(target_os = "macos"))]
                        let admitted = true;
                        recorded_buttons[i] = admitted;
                    }
                    if !recorded_buttons[i] {
                        continue;
                    }
                    if !pressed {
                        recorded_buttons[i] = false;
                    }
                    let ev = if pressed {
                        // One AX probe per click (not per poll): resolve the
                        // element under the cursor so agent output can say
                        // WHAT was clicked, not just where. Non-fatal, macOS
                        // only, and skipped entirely when nothing is found.
                        #[cfg(target_os = "macos")]
                        if let Some((role, label)) = accessibility_element_info_at(pos.0, pos.1) {
                            if role.is_some() || label.is_some() {
                                let mut click_elements = click_elements.lock();
                                if click_elements.len() >= MAX_CLICK_ELEMENT_SAMPLES {
                                    click_elements.pop_front();
                                    click_element_evictions =
                                        click_element_evictions.saturating_add(1);
                                    if click_element_evictions == 1
                                        || click_element_evictions.is_power_of_two()
                                    {
                                        tracing::warn!(
                                            click_element_evictions,
                                            max_samples = MAX_CLICK_ELEMENT_SAMPLES,
                                            "click accessibility telemetry evicted its oldest sample"
                                        );
                                    }
                                }
                                click_elements.push_back(ClickElementSample {
                                    time_ms: now_ms,
                                    role,
                                    label,
                                });
                            }
                        }
                        CursorEvent::Down {
                            time_ms: now_ms,
                            button: (i + 1) as u8,
                            x: pos.0,
                            y: pos.1,
                            cursor_type: sample.cursor_type.clone(),
                            render_x: None,
                            render_y: None,
                        }
                    } else {
                        CursorEvent::Up {
                            time_ms: now_ms,
                            button: (i + 1) as u8,
                            x: pos.0,
                            y: pos.1,
                            cursor_type: sample.cursor_type.clone(),
                        }
                    };
                    events.lock().push(ev);
                }
            }

            // Pen state, sampled on the same clock as the key events so a
            // Control-hold flare's annotation span lines up with its key span.
            let annotation = crate::commands::cursor_trail_enabled();
            if annotation != last_annotation {
                events.lock().push(CursorEvent::Annotation {
                    time_ms: now_ms,
                    active: annotation,
                });
                last_annotation = annotation;
            }

            if let Some(keys) = current_keyboard_state() {
                for (key_code, slot) in last_keys.iter_mut().enumerate() {
                    let pressed = keys[key_code];
                    if pressed != *slot {
                        *slot = pressed;
                        if pressed {
                            #[cfg(target_os = "macos")]
                            let admitted = evidence_scope
                                .as_mut()
                                .is_none_or(WindowEvidenceScope::admits_keys);
                            #[cfg(not(target_os = "macos"))]
                            let admitted = true;
                            recorded_keys[key_code] = admitted;
                        }
                        if !recorded_keys[key_code] {
                            continue;
                        }
                        if !pressed {
                            recorded_keys[key_code] = false;
                        }
                        // The sidecar gets which kind of key, never which
                        // key: see `sidecar_key_code`.
                        let recorded_code = sidecar_key_code(key_code as u16);
                        let ev = if pressed {
                            CursorEvent::KeyDown {
                                time_ms: now_ms,
                                key_code: recorded_code,
                            }
                        } else {
                            CursorEvent::KeyUp {
                                time_ms: now_ms,
                                key_code: recorded_code,
                            }
                        };
                        events.lock().push(ev);
                    }
                }
            }

            #[cfg(target_os = "macos")]
            scroll_tap.pump();
        });

        std::thread::sleep(POLL_PERIOD);
    }
}

#[cfg(target_os = "macos")]
struct MacScrollEventTap {
    _context: Option<Box<MacScrollTapContext>>,
    tap: *mut std::ffi::c_void,
    source: *mut std::ffi::c_void,
    run_loop: *mut std::ffi::c_void,
}

#[cfg(target_os = "macos")]
impl MacScrollEventTap {
    fn new(
        events: Arc<Mutex<CursorEventBuffer>>,
        origin: Instant,
        pause: Option<Arc<crate::recording::PauseState>>,
        window_id: Option<u32>,
    ) -> Self {
        let mut context = Box::new(MacScrollTapContext {
            events,
            origin,
            pause,
            window_scope: window_id.map(|window_id| Mutex::new(ScrollWindowScope::new(window_id))),
        });
        let context_ptr = (&mut *context) as *mut MacScrollTapContext as *mut std::ffi::c_void;

        let tap = unsafe {
            mac_scroll_tap_ffi::CGEventTapCreate(
                mac_scroll_tap_ffi::K_CG_SESSION_EVENT_TAP,
                mac_scroll_tap_ffi::K_CG_HEAD_INSERT_EVENT_TAP,
                mac_scroll_tap_ffi::K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
                1_u64 << mac_scroll_tap_ffi::K_CG_EVENT_SCROLL_WHEEL,
                mac_scroll_event_callback,
                context_ptr,
            )
        };
        if tap.is_null() {
            return Self {
                _context: None,
                tap,
                source: std::ptr::null_mut(),
                run_loop: std::ptr::null_mut(),
            };
        }

        let source = unsafe {
            mac_scroll_tap_ffi::CFMachPortCreateRunLoopSource(std::ptr::null_mut(), tap, 0)
        };
        let run_loop = unsafe { mac_scroll_tap_ffi::CFRunLoopGetCurrent() };
        if !source.is_null() && !run_loop.is_null() {
            unsafe {
                mac_scroll_tap_ffi::CFRunLoopAddSource(
                    run_loop,
                    source,
                    mac_scroll_tap_ffi::kCFRunLoopDefaultMode,
                );
                mac_scroll_tap_ffi::CGEventTapEnable(tap, true);
            }
        }

        Self {
            _context: Some(context),
            tap,
            source,
            run_loop,
        }
    }

    fn pump(&self) {
        if self.tap.is_null() {
            return;
        }
        unsafe {
            mac_scroll_tap_ffi::CFRunLoopRunInMode(
                mac_scroll_tap_ffi::kCFRunLoopDefaultMode,
                0.001,
                true,
            );
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacScrollEventTap {
    fn drop(&mut self) {
        unsafe {
            if !self.run_loop.is_null() && !self.source.is_null() {
                mac_scroll_tap_ffi::CFRunLoopRemoveSource(
                    self.run_loop,
                    self.source,
                    mac_scroll_tap_ffi::kCFRunLoopDefaultMode,
                );
            }
            if !self.tap.is_null() {
                mac_scroll_tap_ffi::CGEventTapEnable(self.tap, false);
                mac_scroll_tap_ffi::CFMachPortInvalidate(self.tap);
                mac_scroll_tap_ffi::CFRelease(self.tap as *const std::ffi::c_void);
            }
            if !self.source.is_null() {
                mac_scroll_tap_ffi::CFRelease(self.source as *const std::ffi::c_void);
            }
        }
    }
}

#[cfg(target_os = "macos")]
struct MacScrollTapContext {
    events: Arc<Mutex<CursorEventBuffer>>,
    origin: Instant,
    pause: Option<Arc<crate::recording::PauseState>>,
    /// Set for a window-only take: a scroll counts only over the recorded
    /// window itself, by the same rule as a press.
    window_scope: Option<Mutex<ScrollWindowScope>>,
}

/// The window list a window-only take's scrolls are judged against. Scroll
/// events arrive in bursts, so the list is reused for a short while rather
/// than read for every event.
#[cfg(target_os = "macos")]
struct ScrollWindowScope {
    window_id: u32,
    listed: Vec<ListedWindow>,
    read_at: Option<Instant>,
}

#[cfg(target_os = "macos")]
impl ScrollWindowScope {
    const REUSE_FOR: Duration = Duration::from_millis(100);

    fn new(window_id: u32) -> Self {
        Self {
            window_id,
            listed: Vec::new(),
            read_at: None,
        }
    }

    fn admits(&mut self, x: f64, y: f64) -> bool {
        if self
            .read_at
            .is_none_or(|read_at| read_at.elapsed() >= Self::REUSE_FOR)
        {
            self.listed = listed_windows_front_to_back();
            self.read_at = Some(Instant::now());
        }
        let own_pid = i64::from(std::process::id());
        press_lands_on_window(&self.listed, self.window_id, own_pid, x, y)
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn mac_scroll_event_callback(
    _proxy: *mut std::ffi::c_void,
    event_type: u32,
    event: *mut std::ffi::c_void,
    user_info: *mut std::ffi::c_void,
) -> *mut std::ffi::c_void {
    if event_type == mac_scroll_tap_ffi::K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT
        || event_type == mac_scroll_tap_ffi::K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT
    {
        return event;
    }
    if event_type != mac_scroll_tap_ffi::K_CG_EVENT_SCROLL_WHEEL || user_info.is_null() {
        return event;
    }

    let context = &*(user_info as *const MacScrollTapContext);
    let location = mac_scroll_tap_ffi::CGEventGetLocation(event);
    let mut delta_y = mac_scroll_tap_ffi::CGEventGetIntegerValueField(
        event,
        mac_scroll_tap_ffi::K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_1,
    ) as i32;
    let mut delta_x = mac_scroll_tap_ffi::CGEventGetIntegerValueField(
        event,
        mac_scroll_tap_ffi::K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_2,
    ) as i32;
    if delta_x == 0 && delta_y == 0 {
        delta_y = mac_scroll_tap_ffi::CGEventGetIntegerValueField(
            event,
            mac_scroll_tap_ffi::K_CG_SCROLL_WHEEL_EVENT_POINT_DELTA_AXIS_1,
        ) as i32;
        delta_x = mac_scroll_tap_ffi::CGEventGetIntegerValueField(
            event,
            mac_scroll_tap_ffi::K_CG_SCROLL_WHEEL_EVENT_POINT_DELTA_AXIS_2,
        ) as i32;
    }
    if delta_x != 0 || delta_y != 0 {
        // Pause-aware: scrolls during a pause are dropped; stamps use the
        // pause-excluded timeline so they align with the video PTS.
        if context.pause.as_ref().is_some_and(|p| p.is_paused()) {
            return event;
        }
        if context
            .window_scope
            .as_ref()
            .is_some_and(|scope| !scope.lock().admits(location.x, location.y))
        {
            return event;
        }
        let time_ms = match context.pause.as_ref() {
            Some(p) => p.effective_elapsed_us(&context.origin) as f64 / 1000.0,
            None => context.origin.elapsed().as_secs_f64() * 1000.0,
        };
        context.events.lock().push(CursorEvent::Scroll {
            time_ms,
            x: location.x.round() as i32,
            y: location.y.round() as i32,
            delta_x,
            delta_y,
            cursor_type: current_cursor_type(),
        });
    }
    event
}

#[cfg(target_os = "macos")]
mod mac_scroll_tap_ffi {
    use std::ffi::c_void;

    pub const K_CG_SESSION_EVENT_TAP: u32 = 1;
    pub const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
    pub const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
    pub const K_CG_EVENT_SCROLL_WHEEL: u32 = 22;
    pub const K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xffff_fffe;
    pub const K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xffff_ffff;
    pub const K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_1: i32 = 11;
    pub const K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_2: i32 = 12;
    pub const K_CG_SCROLL_WHEEL_EVENT_POINT_DELTA_AXIS_1: i32 = 96;
    pub const K_CG_SCROLL_WHEEL_EVENT_POINT_DELTA_AXIS_2: i32 = 97;

    #[repr(C)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: unsafe extern "C" fn(
                proxy: *mut c_void,
                event_type: u32,
                event: *mut c_void,
                user_info: *mut c_void,
            ) -> *mut c_void,
            user_info: *mut c_void,
        ) -> *mut c_void;
        pub fn CGEventTapEnable(tap: *mut c_void, enable: bool);
        pub fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
        pub fn CGEventGetIntegerValueField(event: *mut c_void, field: i32) -> i64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub static kCFRunLoopDefaultMode: *const c_void;
        pub fn CFMachPortCreateRunLoopSource(
            allocator: *mut c_void,
            port: *mut c_void,
            order: isize,
        ) -> *mut c_void;
        pub fn CFMachPortInvalidate(port: *mut c_void);
        pub fn CFRunLoopGetCurrent() -> *mut c_void;
        pub fn CFRunLoopAddSource(run_loop: *mut c_void, source: *mut c_void, mode: *const c_void);
        pub fn CFRunLoopRemoveSource(
            run_loop: *mut c_void,
            source: *mut c_void,
            mode: *const c_void,
        );
        pub fn CFRunLoopRunInMode(
            mode: *const c_void,
            seconds: f64,
            return_after_source_handled: bool,
        ) -> i32;
        pub fn CFRelease(cf: *const c_void);
    }
}

#[cfg(target_os = "macos")]
fn current_mouse_sample() -> Option<MouseSample> {
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const c_void) -> *mut c_void;
        fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
        fn CGEventSourceButtonState(state_id: u32, button: u32) -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    let event = unsafe { CGEventCreate(ptr::null()) };
    if event.is_null() {
        return None;
    }
    let location = unsafe { CGEventGetLocation(event) };
    unsafe { CFRelease(event as *const c_void) };

    let mut buttons = [false; 5];
    for (index, slot) in buttons.iter_mut().enumerate() {
        // kCGEventSourceStateCombinedSessionState = 0.
        // CGMouseButton values are zero-based: left=0, right=1, center=2.
        *slot = unsafe { CGEventSourceButtonState(0, index as u32) };
    }

    Some(MouseSample {
        x: location.x.round() as i32,
        y: location.y.round() as i32,
        buttons,
        cursor_type: current_cursor_type_at(location.x.round() as i32, location.y.round() as i32),
    })
}

/// The window's current frame in global logical points, the same space as
/// cursor samples. `None` once the window is minimized, closed, or gone.
#[cfg(target_os = "macos")]
fn current_window_bounds(window_id: u32) -> Option<(f64, f64, f64, f64)> {
    // SAFETY: both arrays are +1 references created here (or null), read
    // here and released before returning; nothing borrowed escapes. The id
    // array holds the window id itself as a pointer-sized value with no
    // callbacks, which is how CGWindowListCreateDescriptionFromArray expects
    // its CGWindowID array.
    unsafe {
        let id_value = window_id as usize as *const std::ffi::c_void;
        let ids =
            mac_window_bounds_ffi::CFArrayCreate(std::ptr::null(), &id_value, 1, std::ptr::null());
        if ids.is_null() {
            return None;
        }
        // Describes exactly the windows named, on screen or not.
        let windows = mac_window_bounds_ffi::CGWindowListCreateDescriptionFromArray(ids);
        mac_window_bounds_ffi::CFRelease(ids);
        if windows.is_null() {
            return None;
        }
        let result = read_window_bounds(windows, window_id);
        mac_window_bounds_ffi::CFRelease(windows);
        result
    }
}

/// The bounds of `window_id` in a CGWindowList description array, matched by
/// window number rather than by position in the array. A window that is not
/// on screen (minimized, or on another Space) yields none: its reported
/// geometry is not what the video is showing, which still holds the last
/// visible frame.
#[cfg(target_os = "macos")]
unsafe fn read_window_bounds(
    windows: *const std::ffi::c_void,
    window_id: u32,
) -> Option<(f64, f64, f64, f64)> {
    let count = mac_window_bounds_ffi::CFArrayGetCount(windows);
    for index in 0..count {
        let window = mac_window_bounds_ffi::CFArrayGetValueAtIndex(windows, index);
        if window.is_null() {
            continue;
        }
        if cf_dictionary_number(window, "kCGWindowNumber").map(|id| id.round())
            != Some(f64::from(window_id))
        {
            continue;
        }
        if !cf_dictionary_flag(window, "kCGWindowIsOnscreen") {
            return None;
        }
        return window_dictionary_bounds(window);
    }
    None
}

/// A window description's `kCGWindowBounds`, when it has a real size.
#[cfg(target_os = "macos")]
unsafe fn window_dictionary_bounds(
    window: *const std::ffi::c_void,
) -> Option<(f64, f64, f64, f64)> {
    let mut bounds: *const std::ffi::c_void = std::ptr::null();
    if mac_window_bounds_ffi::CFDictionaryGetValueIfPresent(
        window,
        mac_window_bounds_ffi::kCGWindowBounds,
        &mut bounds,
    ) == 0
        || bounds.is_null()
    {
        return None;
    }
    let x = cf_dictionary_number(bounds, "X")?;
    let y = cf_dictionary_number(bounds, "Y")?;
    let width = cf_dictionary_number(bounds, "Width")?;
    let height = cf_dictionary_number(bounds, "Height")?;
    (width > 0.0 && height > 0.0).then_some((x, y, width, height))
}

#[cfg(target_os = "macos")]
unsafe fn cf_dictionary_number(dict: *const std::ffi::c_void, key: &str) -> Option<f64> {
    use std::ffi::CString;

    let key = CString::new(key).ok()?;
    let key_ref = mac_window_bounds_ffi::CFStringCreateWithCString(
        std::ptr::null(),
        key.as_ptr().cast::<u8>(),
        mac_window_bounds_ffi::K_CF_STRING_ENCODING_UTF8,
    );
    if key_ref.is_null() {
        return None;
    }
    let mut value_ref: *const std::ffi::c_void = std::ptr::null();
    let found = mac_window_bounds_ffi::CFDictionaryGetValueIfPresent(dict, key_ref, &mut value_ref);
    mac_window_bounds_ffi::CFRelease(key_ref);
    if found == 0 || value_ref.is_null() {
        return None;
    }
    let mut value = 0.0_f64;
    let ok = mac_window_bounds_ffi::CFNumberGetValue(
        value_ref,
        mac_window_bounds_ffi::K_CF_NUMBER_DOUBLE_TYPE,
        (&mut value as *mut f64).cast(),
    );
    (ok != 0).then_some(value)
}

/// A CFBoolean entry; absent counts as false, which is how Window Services
/// reports a window that is not on screen.
#[cfg(target_os = "macos")]
unsafe fn cf_dictionary_flag(dict: *const std::ffi::c_void, key: &str) -> bool {
    use std::ffi::CString;

    let Ok(key) = CString::new(key) else {
        return false;
    };
    let key_ref = mac_window_bounds_ffi::CFStringCreateWithCString(
        std::ptr::null(),
        key.as_ptr().cast::<u8>(),
        mac_window_bounds_ffi::K_CF_STRING_ENCODING_UTF8,
    );
    if key_ref.is_null() {
        return false;
    }
    let mut value_ref: *const std::ffi::c_void = std::ptr::null();
    let found = mac_window_bounds_ffi::CFDictionaryGetValueIfPresent(dict, key_ref, &mut value_ref);
    mac_window_bounds_ffi::CFRelease(key_ref);
    found != 0 && !value_ref.is_null() && mac_window_bounds_ffi::CFBooleanGetValue(value_ref) != 0
}

#[cfg(target_os = "macos")]
mod mac_window_bounds_ffi {
    use std::ffi::{c_uchar, c_void};

    pub const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
    pub const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    pub const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    pub const K_CF_NUMBER_DOUBLE_TYPE: i32 = 13;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub static kCGWindowBounds: *const c_void;
        pub fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *const c_void;
        pub fn CGWindowListCreateDescriptionFromArray(window_array: *const c_void)
            -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFArrayCreate(
            allocator: *const c_void,
            values: *const *const c_void,
            num_values: isize,
            callbacks: *const c_void,
        ) -> *const c_void;
        pub fn CFArrayGetCount(array: *const c_void) -> isize;
        pub fn CFBooleanGetValue(boolean: *const c_void) -> c_uchar;
        pub fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        pub fn CFDictionaryGetValueIfPresent(
            dict: *const c_void,
            key: *const c_void,
            value: *mut *const c_void,
        ) -> c_uchar;
        pub fn CFNumberGetValue(
            number: *const c_void,
            number_type: i32,
            value: *mut c_void,
        ) -> c_uchar;
        pub fn CFStringCreateWithCString(
            allocator: *const c_void,
            c_str: *const u8,
            encoding: u32,
        ) -> *const c_void;
        pub fn CFRelease(cf: *const c_void);
    }
}

#[cfg(target_os = "macos")]
const NS_CURSOR_TYPE_MAPPINGS: &[(&[u8], &str)] = &[
    (b"IBeamCursor\0", "textcursor"),
    (b"IBeamCursorForVerticalLayout\0", "textcursor"),
    (b"pointingHandCursor\0", "handpointing"),
    (b"closedHandCursor\0", "handgrabbing"),
    (b"openHandCursor\0", "handopen"),
    (b"crosshairCursor\0", "cross"),
    (b"resizeLeftRightCursor\0", "resizeleftright"),
    (b"resizeUpDownCursor\0", "resizeupdown"),
    (b"resizeLeftCursor\0", "resizewest"),
    (b"resizeRightCursor\0", "resizeeast"),
    (b"resizeUpCursor\0", "resizenorth"),
    (b"resizeDownCursor\0", "resizesouth"),
    (b"operationNotAllowedCursor\0", "notallowed"),
    (b"disappearingItemCursor\0", "notallowed"),
    (b"dragLinkCursor\0", "handpointing"),
    (b"dragCopyCursor\0", "handpointing"),
    (b"contextualMenuCursor\0", "handpointing"),
    (b"arrowCursor\0", "cursor"),
];

#[cfg(target_os = "macos")]
fn current_cursor_type_at(x: i32, y: i32) -> Option<String> {
    let appkit = current_cursor_type();
    if appkit
        .as_deref()
        .is_some_and(|cursor_type| cursor_type != "cursor")
    {
        return appkit;
    }
    accessibility_cursor_type_at(x, y).or(appkit)
}

/// Both cursor-type probes call into AppKit / the AX runtime from this
/// background thread. Any NSException there is a *foreign* exception — Rust
/// cannot unwind it and the whole process aborts ("Rust cannot catch foreign
/// exceptions", seen at recording start on the clipy-cursor-track
/// thread). Catch at the ObjC boundary and drop the sample's
/// cursor type instead of the app.
#[cfg(target_os = "macos")]
fn current_cursor_type() -> Option<String> {
    objc2::exception::catch(current_cursor_type_unguarded)
        .ok()
        .flatten()
}

#[cfg(target_os = "macos")]
fn accessibility_cursor_type_at(x: i32, y: i32) -> Option<String> {
    objc2::exception::catch(|| accessibility_cursor_type_at_unguarded(x, y))
        .ok()
        .flatten()
}

/// AX identity (role + visible label) of the element under the cursor.
/// Same foreign-exception guard as the cursor-type probes — an NSException
/// from the AX runtime must never abort the tracker thread.
#[cfg(target_os = "macos")]
fn accessibility_element_info_at(x: i32, y: i32) -> Option<(Option<String>, Option<String>)> {
    objc2::exception::catch(|| accessibility_element_info_at_unguarded(x, y))
        .ok()
        .flatten()
}

/// Sets a Clipy window's click-through switch. Every call must go through
/// here (a test enforces it): the cursor tracker decides whether a click on
/// a Clipy window belongs to the app beneath from this switch, and on macOS
/// it can only learn the new value from a main-thread read queued behind the
/// change. Tauri sends the change and the read through the same ordered
/// channel, so the read always sees the new value.
pub(crate) fn set_ignore_cursor_events<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    ignore: bool,
) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    let change = own_click_through::begin_change();
    let result = window.set_ignore_cursor_events(ignore);
    #[cfg(target_os = "macos")]
    let _ = window.run_on_main_thread(move || own_click_through::confirm(change));
    result
}

/// The accessibility element under (x, y), resolved inside the app that owns
/// the topmost window there, or `None` when that window is Clipy's. This is
/// the only AX hit test in the app; route any new one through it.
///
/// Clipy must never hit-test itself from this thread. When an AX query lands
/// on one of our own windows (the menu-bar icon, the camera bubble, the
/// click-through overlays over the capture area), HIServices skips IPC and
/// runs AppKit's accessibility code directly on the calling thread. AppKit
/// is main-thread-only, so that races the main thread and corrupts the heap
/// (SIGABRT "pointer being freed was not allocated" on clipy-cursor-track).
/// Heap corruption is not an exception: `objc2::exception::catch`
/// cannot stop it, so the only fix is to never make the call. The pid check
/// on the result is a second line in case a foreign hit test ever resolves
/// into our process. Caller releases the returned element.
#[cfg(target_os = "macos")]
fn foreign_element_at(x: i32, y: i32) -> Option<*mut std::ffi::c_void> {
    use std::ffi::c_void;

    const K_AX_ERROR_SUCCESS: i32 = 0;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> *mut c_void;
        fn AXUIElementCopyElementAtPosition(
            application: *mut c_void,
            x: f32,
            y: f32,
            element: *mut *mut c_void,
        ) -> i32;
        fn AXUIElementGetPid(element: *mut c_void, pid: *mut i32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    let own_pid = std::process::id() as i32;
    let pid = i32::try_from(foreign_window_owner_at(x as f64, y as f64)?).ok()?;
    if pid == own_pid {
        return None;
    }
    // SAFETY: `app` and `element` are +1 references created here; each is
    // released on every path except the returned element, which the caller
    // releases.
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return None;
        }
        let mut element = std::ptr::null_mut();
        let err = AXUIElementCopyElementAtPosition(app, x as f32, y as f32, &mut element);
        CFRelease(app as *const c_void);
        if err != K_AX_ERROR_SUCCESS || element.is_null() {
            return None;
        }
        let mut element_pid = 0;
        if AXUIElementGetPid(element, &mut element_pid) != K_AX_ERROR_SUCCESS
            || element_pid == own_pid
        {
            CFRelease(element as *const c_void);
            return None;
        }
        Some(element)
    }
}

/// The window list costs a WindowServer round trip; at 60 Hz a short-lived
/// cache is plenty for "who owns the pixel under the cursor".
#[cfg(target_os = "macos")]
const WINDOW_OWNER_CACHE_TTL: Duration = Duration::from_millis(150);

#[cfg(target_os = "macos")]
fn foreign_window_owner_at(x: f64, y: f64) -> Option<i64> {
    use std::cell::RefCell;

    thread_local! {
        static CACHE: RefCell<Option<(Instant, Vec<ListedWindow>)>> = const { RefCell::new(None) };
    }

    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let stale = cache
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() >= WINDOW_OWNER_CACHE_TTL);
        if stale {
            *cache = Some((Instant::now(), listed_windows_front_to_back()));
            own_click_through::request_refresh();
        }
        let (_, windows) = cache.as_ref()?;
        let click_through = own_click_through::snapshot();
        topmost_foreign_owner(windows, std::process::id() as i64, &click_through, x, y)
    })
}

/// The app that owns the topmost visible window at (x, y), or `None` when
/// that window is Clipy's. Clipy windows that ignore the mouse (the cursor
/// trail and source highlight over the capture area, the recording hint) are
/// looked through: a click passes them to the app beneath, so that app is
/// what was clicked. Any other Clipy window (the menu-bar icon, the camera
/// bubble and its controls, the cursor trail while the pen is drawing) took
/// the click itself, and labelling it with the app behind would invent a step
/// the user never took. A Clipy window missing from the snapshot counts as
/// clickable.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn topmost_foreign_owner(
    windows: &[ListedWindow],
    own_pid: i64,
    own_click_through: &[u32],
    x: f64,
    y: f64,
) -> Option<i64> {
    let window = windows
        .iter()
        .filter(|window| window.alpha > 0.0)
        .filter(|window| {
            !(window.owner_pid == own_pid && own_click_through.contains(&window.number))
        })
        .find(|window| {
            let (left, top, width, height) = window.bounds;
            x >= left && x < left + width && y >= top && y < top + height
        })?;
    (window.owner_pid != own_pid).then_some(window.owner_pid)
}

/// Window numbers of Clipy's own windows that currently ignore the mouse.
///
/// `ignoresMouseEvents` can only be read on the main thread, and the cursor
/// tracker has no app handle, so the tracker queues a read on the main
/// dispatch queue and uses the latest answer. The cursor trail flips between
/// click-through and drawable at runtime, so this is read, not configured,
/// and each flip is confirmed through `set_ignore_cursor_events` above.
#[cfg(target_os = "macos")]
mod own_click_through {
    use std::ffi::c_void;
    use std::os::raw::{c_char, c_schar};
    use std::sync::atomic::{AtomicBool, Ordering};

    use std::sync::atomic::AtomicU64;

    use parking_lot::Mutex;

    static SNAPSHOT: Mutex<Vec<u32>> = Mutex::new(Vec::new());
    static PENDING: AtomicBool = AtomicBool::new(false);
    /// Bumped before any Clipy window's click-through switch changes, and
    /// confirmed by a main-thread read queued behind that change. Until the
    /// latest change is confirmed the snapshot is not trusted and every
    /// Clipy window counts as clickable: a pen click right after the cursor
    /// trail turns drawable must not be labelled with the app beneath.
    static CHANGES_BEGUN: AtomicU64 = AtomicU64::new(0);
    static CHANGES_CONFIRMED: AtomicU64 = AtomicU64::new(0);

    #[repr(C)]
    struct DispatchQueue {
        _private: [u8; 0],
    }

    extern "C" {
        static _dispatch_main_q: DispatchQueue;
        fn dispatch_async_f(
            queue: *const DispatchQueue,
            context: *mut c_void,
            work: extern "C" fn(*mut c_void),
        );
    }

    pub(super) fn snapshot() -> Vec<u32> {
        if CHANGES_CONFIRMED.load(Ordering::Acquire) < CHANGES_BEGUN.load(Ordering::Acquire) {
            return Vec::new();
        }
        SNAPSHOT.lock().clone()
    }

    pub(super) fn begin_change() -> u64 {
        CHANGES_BEGUN.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Main thread only, queued after the change it confirms.
    pub(super) fn confirm(change: u64) {
        if let Ok(Some(numbers)) = objc2::exception::catch(|| unsafe { read_on_main() }) {
            *SNAPSHOT.lock() = numbers;
            CHANGES_CONFIRMED.fetch_max(change, Ordering::AcqRel);
        }
    }

    pub(super) fn request_refresh() {
        if PENDING.swap(true, Ordering::AcqRel) {
            return;
        }
        // SAFETY: the main queue lives for the whole process and `refresh`
        // ignores its context.
        unsafe {
            dispatch_async_f(
                std::ptr::addr_of!(_dispatch_main_q),
                std::ptr::null_mut(),
                refresh,
            )
        };
    }

    extern "C" fn refresh(_context: *mut c_void) {
        if let Ok(Some(numbers)) = objc2::exception::catch(|| unsafe { read_on_main() }) {
            *SNAPSHOT.lock() = numbers;
        }
        PENDING.store(false, Ordering::Release);
    }

    /// SAFETY: main thread only.
    unsafe fn read_on_main() -> Option<Vec<u32>> {
        #[link(name = "AppKit", kind = "framework")]
        extern "C" {}

        extern "C" {
            fn objc_getClass(name: *const c_char) -> *mut c_void;
            fn sel_registerName(name: *const c_char) -> *const c_void;
            fn objc_msgSend();
        }

        type SendObject = unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void;
        type SendIndex = unsafe extern "C" fn(*mut c_void, *const c_void, usize) -> *mut c_void;
        type SendInteger = unsafe extern "C" fn(*mut c_void, *const c_void) -> isize;
        type SendBool = unsafe extern "C" fn(*mut c_void, *const c_void) -> c_schar;
        let send_object: SendObject = std::mem::transmute(objc_msgSend as *const c_void);
        let send_index: SendIndex = std::mem::transmute(objc_msgSend as *const c_void);
        let send_integer: SendInteger = std::mem::transmute(objc_msgSend as *const c_void);
        let send_bool: SendBool = std::mem::transmute(objc_msgSend as *const c_void);
        let sel = |name: &[u8]| sel_registerName(name.as_ptr().cast());

        let ns_application = objc_getClass(b"NSApplication\0".as_ptr().cast());
        if ns_application.is_null() {
            return None;
        }
        let app = send_object(ns_application, sel(b"sharedApplication\0"));
        if app.is_null() {
            return None;
        }
        let windows = send_object(app, sel(b"windows\0"));
        if windows.is_null() {
            return None;
        }
        let count = send_integer(windows, sel(b"count\0")).max(0) as usize;
        let object_at_index = sel(b"objectAtIndex:\0");
        let window_number = sel(b"windowNumber\0");
        let ignores_mouse_events = sel(b"ignoresMouseEvents\0");
        let mut numbers = Vec::new();
        for index in 0..count {
            let window = send_index(windows, object_at_index, index);
            if window.is_null() {
                continue;
            }
            let number = send_integer(window, window_number);
            if number > 0 && send_bool(window, ignores_mouse_events) != 0 {
                numbers.push(number as u32);
            }
        }
        Some(numbers)
    }
}

#[cfg(target_os = "macos")]
fn accessibility_element_info_at_unguarded(
    x: i32,
    y: i32,
) -> Option<(Option<String>, Option<String>)> {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    const K_CFSTRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_AX_ERROR_SUCCESS: i32 = 0;
    const LABEL_MAX_CHARS: usize = 200;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCopyAttributeValue(
            element: *mut c_void,
            attribute: *const c_void,
            value: *mut *mut c_void,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const u8,
            encoding: u32,
        ) -> *const c_void;
        fn CFStringGetCString(
            the_string: *const c_void,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
        fn CFGetTypeID(cf: *const c_void) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFRelease(cf: *const c_void);
    }

    unsafe fn make_cf_string(bytes: &[u8]) -> *const c_void {
        CFStringCreateWithCString(std::ptr::null(), bytes.as_ptr(), K_CFSTRING_ENCODING_UTF8)
    }

    unsafe fn copy_attribute(
        element: *mut c_void,
        attribute: *const c_void,
    ) -> Option<*mut c_void> {
        if element.is_null() || attribute.is_null() {
            return None;
        }
        let mut value = std::ptr::null_mut();
        if AXUIElementCopyAttributeValue(element, attribute, &mut value) == K_AX_ERROR_SUCCESS
            && !value.is_null()
        {
            Some(value)
        } else {
            None
        }
    }

    /// Extract a CF value into a trimmed, capped Rust string — only when it
    /// actually IS a CFString (AXValue can be CFNumber/CFBoolean).
    unsafe fn cf_value_to_string(value: *const c_void) -> Option<String> {
        if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
            return None;
        }
        let mut buf = [0i8 as c_char; 1024];
        if CFStringGetCString(
            value,
            buf.as_mut_ptr(),
            buf.len() as isize,
            K_CFSTRING_ENCODING_UTF8,
        ) == 0
        {
            return None;
        }
        let raw = std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy();
        let cleaned: String = raw
            .replace(['\r', '\n', '\t'], " ")
            .trim()
            .chars()
            .take(LABEL_MAX_CHARS)
            .collect();
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    }

    unsafe {
        let role_attr = make_cf_string(b"AXRole\0");
        let parent_attr = make_cf_string(b"AXParent\0");
        let title_attr = make_cf_string(b"AXTitle\0");
        let description_attr = make_cf_string(b"AXDescription\0");
        let value_attr = make_cf_string(b"AXValue\0");
        let release_attrs = |attrs: [*const c_void; 5]| {
            for attr in attrs {
                if !attr.is_null() {
                    CFRelease(attr);
                }
            }
        };
        let attrs = [
            role_attr,
            parent_attr,
            title_attr,
            description_attr,
            value_attr,
        ];
        if attrs.iter().any(|attr| attr.is_null()) {
            release_attrs(attrs);
            return None;
        }

        let Some(element) = foreign_element_at(x, y) else {
            release_attrs(attrs);
            return None;
        };

        // Walk up a few ancestors: icons/labels inside buttons often carry
        // no title themselves while the wrapping AXButton does. The role
        // reported is the role of whichever node supplied the label.
        let mut leaf_role: Option<String> = None;
        let mut found: Option<(Option<String>, Option<String>)> = None;
        let mut current = element;
        for depth in 0..4 {
            let role = copy_attribute(current, role_attr).and_then(|value| {
                let s = cf_value_to_string(value as *const c_void);
                CFRelease(value as *const c_void);
                s
            });
            if depth == 0 {
                leaf_role = role.clone();
            }
            let mut label: Option<String> = None;
            for attr in [title_attr, description_attr] {
                if label.is_some() {
                    break;
                }
                if let Some(value) = copy_attribute(current, attr) {
                    label = cf_value_to_string(value as *const c_void);
                    CFRelease(value as *const c_void);
                }
            }
            // AXValue is on-screen text for static text nodes; for inputs
            // it is the user's typed content — deliberately not captured.
            if label.is_none() && role.as_deref() == Some("AXStaticText") {
                if let Some(value) = copy_attribute(current, value_attr) {
                    label = cf_value_to_string(value as *const c_void);
                    CFRelease(value as *const c_void);
                }
            }
            if let Some(label) = label {
                found = Some((role, Some(label)));
                break;
            }
            let Some(parent) = copy_attribute(current, parent_attr) else {
                break;
            };
            CFRelease(current as *const c_void);
            current = parent;
        }
        CFRelease(current as *const c_void);
        release_attrs(attrs);

        match found {
            Some(info) => Some(info),
            None => leaf_role.map(|role| (Some(role), None)),
        }
    }
}

#[cfg(target_os = "macos")]
fn current_cursor_type_unguarded() -> Option<String> {
    use std::ffi::c_void;
    use std::os::raw::{c_char, c_schar};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    unsafe {
        type SendNoArg = unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void;
        type SendBoolOneObject =
            unsafe extern "C" fn(*mut c_void, *const c_void, *mut c_void) -> c_schar;
        type SendRespondsToSelector =
            unsafe extern "C" fn(*mut c_void, *const c_void, *const c_void) -> c_schar;
        let send: SendNoArg = std::mem::transmute(objc_msgSend as *const c_void);
        let send_bool_one_object: SendBoolOneObject =
            std::mem::transmute(objc_msgSend as *const c_void);
        let responds_to_selector: SendRespondsToSelector =
            std::mem::transmute(objc_msgSend as *const c_void);
        let ns_cursor = objc_getClass(b"NSCursor\0".as_ptr() as *const c_char);
        if ns_cursor.is_null() {
            return None;
        }
        let responds_selector =
            sel_registerName(b"respondsToSelector:\0".as_ptr() as *const c_char);
        let current_cursor_selector =
            sel_registerName(b"currentCursor\0".as_ptr() as *const c_char);
        let current_system_cursor_selector =
            sel_registerName(b"currentSystemCursor\0".as_ptr() as *const c_char);
        let current =
            if responds_to_selector(ns_cursor, responds_selector, current_cursor_selector) != 0 {
                send(ns_cursor, current_cursor_selector)
            } else {
                send(ns_cursor, current_system_cursor_selector)
            };
        let current = if current.is_null()
            && responds_to_selector(ns_cursor, responds_selector, current_system_cursor_selector)
                != 0
        {
            send(ns_cursor, current_system_cursor_selector)
        } else {
            current
        };
        if current.is_null() {
            return None;
        }

        let image_selector = sel_registerName(b"image\0".as_ptr() as *const c_char);
        let tiff_representation_selector =
            sel_registerName(b"TIFFRepresentation\0".as_ptr() as *const c_char);
        let is_equal_to_data_selector =
            sel_registerName(b"isEqualToData:\0".as_ptr() as *const c_char);
        let current_image_data =
            cursor_image_data(current, send, image_selector, tiff_representation_selector);

        for (selector, cursor_type) in NS_CURSOR_TYPE_MAPPINGS {
            let selector_ref = sel_registerName(selector.as_ptr() as *const c_char);
            if responds_to_selector(ns_cursor, responds_selector, selector_ref) == 0 {
                continue;
            }
            let candidate = send(ns_cursor, selector_ref);
            if !candidate.is_null() && candidate == current {
                return Some(cursor_type.to_string());
            }
            let candidate_image_data = cursor_image_data(
                candidate,
                send,
                image_selector,
                tiff_representation_selector,
            );
            if !current_image_data.is_null()
                && !candidate_image_data.is_null()
                && send_bool_one_object(
                    current_image_data,
                    is_equal_to_data_selector,
                    candidate_image_data,
                ) != 0
            {
                return Some(cursor_type.to_string());
            }
        }
    }
    Some("cursor".to_string())
}

#[cfg(target_os = "macos")]
unsafe fn cursor_image_data(
    cursor: *mut std::ffi::c_void,
    send: unsafe extern "C" fn(
        *mut std::ffi::c_void,
        *const std::ffi::c_void,
    ) -> *mut std::ffi::c_void,
    image_selector: *const std::ffi::c_void,
    tiff_representation_selector: *const std::ffi::c_void,
) -> *mut std::ffi::c_void {
    if cursor.is_null() {
        return std::ptr::null_mut();
    }
    let image = send(cursor, image_selector);
    if image.is_null() {
        return std::ptr::null_mut();
    }
    send(image, tiff_representation_selector)
}

#[cfg(target_os = "macos")]
fn accessibility_cursor_type_at_unguarded(x: i32, y: i32) -> Option<String> {
    use std::ffi::c_void;

    const K_CFSTRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_AX_ERROR_SUCCESS: i32 = 0;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCopyAttributeValue(
            element: *mut c_void,
            attribute: *const c_void,
            value: *mut *mut c_void,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const u8,
            encoding: u32,
        ) -> *const c_void;
        fn CFStringCompare(left: *const c_void, right: *const c_void, options: u64) -> i64;
        fn CFRelease(cf: *const c_void);
    }

    unsafe fn make_cf_string(bytes: &[u8]) -> *const c_void {
        CFStringCreateWithCString(std::ptr::null(), bytes.as_ptr(), K_CFSTRING_ENCODING_UTF8)
    }

    unsafe fn copy_attribute(
        element: *mut c_void,
        attribute: *const c_void,
    ) -> Option<*mut c_void> {
        if element.is_null() || attribute.is_null() {
            return None;
        }
        let mut value = std::ptr::null_mut();
        if AXUIElementCopyAttributeValue(element, attribute, &mut value) == K_AX_ERROR_SUCCESS
            && !value.is_null()
        {
            Some(value)
        } else {
            None
        }
    }

    unsafe fn cf_string_matches(value: *const c_void, expected: &[u8]) -> bool {
        if value.is_null() {
            return false;
        }
        let expected_ref = make_cf_string(expected);
        if expected_ref.is_null() {
            return false;
        }
        let matches = CFStringCompare(value, expected_ref, 0) == 0;
        CFRelease(expected_ref);
        matches
    }

    unsafe fn cursor_type_for_role(role: *const c_void) -> Option<&'static str> {
        if cf_string_matches(role, b"AXTextField\0")
            || cf_string_matches(role, b"AXTextArea\0")
            || cf_string_matches(role, b"AXTextView\0")
            || cf_string_matches(role, b"AXComboBox\0")
        {
            return Some("textcursor");
        }
        if cf_string_matches(role, b"AXLink\0") || cf_string_matches(role, b"AXButton\0") {
            return Some("handpointing");
        }
        None
    }

    unsafe fn cursor_type_for_label(label: *const c_void) -> Option<&'static str> {
        if cf_string_matches(label, b"Clipy cursor resize horizontal target\0") {
            return Some("resizeleftright");
        }
        if cf_string_matches(label, b"Clipy cursor resize vertical target\0") {
            return Some("resizeupdown");
        }
        if cf_string_matches(label, b"Clipy cursor resize east target\0") {
            return Some("resizeeast");
        }
        if cf_string_matches(label, b"Clipy cursor resize west target\0") {
            return Some("resizewest");
        }
        if cf_string_matches(label, b"Clipy cursor resize north target\0") {
            return Some("resizenorth");
        }
        if cf_string_matches(label, b"Clipy cursor resize south target\0") {
            return Some("resizesouth");
        }
        if cf_string_matches(label, b"Clipy cursor resize northwest southeast target\0") {
            return Some("resizenorthwestsoutheast");
        }
        if cf_string_matches(label, b"Clipy cursor resize northeast southwest target\0") {
            return Some("resizenortheastsouthwest");
        }
        if cf_string_matches(label, b"Clipy cursor crosshair target\0") {
            return Some("cross");
        }
        if cf_string_matches(label, b"Clipy cursor not allowed target\0") {
            return Some("notallowed");
        }
        if cf_string_matches(label, b"Clipy cursor move target\0") {
            return Some("move");
        }
        if cf_string_matches(label, b"Clipy cursor open hand target\0") {
            return Some("handopen");
        }
        if cf_string_matches(label, b"Clipy cursor closed hand target\0") {
            return Some("handgrabbing");
        }
        if cf_string_matches(label, b"Clipy cursor help target\0") {
            return Some("help");
        }
        if cf_string_matches(label, b"Clipy cursor zoom in target\0") {
            return Some("zoomin");
        }
        if cf_string_matches(label, b"Clipy cursor zoom out target\0") {
            return Some("zoomout");
        }
        None
    }

    unsafe {
        let role_attr = make_cf_string(b"AXRole\0");
        let parent_attr = make_cf_string(b"AXParent\0");
        let description_attr = make_cf_string(b"AXDescription\0");
        let title_attr = make_cf_string(b"AXTitle\0");
        let value_attr = make_cf_string(b"AXValue\0");
        if role_attr.is_null()
            || parent_attr.is_null()
            || description_attr.is_null()
            || title_attr.is_null()
            || value_attr.is_null()
        {
            if !role_attr.is_null() {
                CFRelease(role_attr);
            }
            if !parent_attr.is_null() {
                CFRelease(parent_attr);
            }
            if !description_attr.is_null() {
                CFRelease(description_attr);
            }
            if !title_attr.is_null() {
                CFRelease(title_attr);
            }
            if !value_attr.is_null() {
                CFRelease(value_attr);
            }
            return None;
        }

        let Some(element) = foreign_element_at(x, y) else {
            CFRelease(role_attr);
            CFRelease(parent_attr);
            CFRelease(description_attr);
            CFRelease(title_attr);
            CFRelease(value_attr);
            return None;
        };

        let mut current = element;
        let mut inferred = None;
        for _ in 0..5 {
            if let Some(role) = copy_attribute(current, role_attr) {
                inferred = cursor_type_for_role(role as *const c_void);
                CFRelease(role as *const c_void);
                if inferred.is_some() {
                    break;
                }
            }
            for label_attr in [description_attr, title_attr, value_attr] {
                if let Some(label) = copy_attribute(current, label_attr) {
                    inferred = cursor_type_for_label(label as *const c_void);
                    CFRelease(label as *const c_void);
                    if inferred.is_some() {
                        break;
                    }
                }
            }
            if inferred.is_some() {
                break;
            }
            let Some(parent) = copy_attribute(current, parent_attr) else {
                break;
            };
            CFRelease(current as *const c_void);
            current = parent;
        }
        CFRelease(current as *const c_void);
        CFRelease(role_attr);
        CFRelease(parent_attr);
        CFRelease(description_attr);
        CFRelease(title_attr);
        CFRelease(value_attr);
        inferred.map(str::to_string)
    }
}

#[cfg(not(target_os = "macos"))]
fn current_cursor_type() -> Option<String> {
    Some("cursor".to_string())
}

#[cfg(target_os = "macos")]
fn current_keyboard_state() -> Option<[bool; KEY_STATES]> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state_id: u32, key: u16) -> bool;
        fn CGEventSourceFlagsState(state_id: u32) -> u64;
    }

    let mut keys = [false; KEY_STATES];
    for (key_code, slot) in keys.iter_mut().enumerate() {
        // kCGEventSourceStateCombinedSessionState = 0.
        *slot = unsafe { CGEventSourceKeyState(0, key_code as u16) };
    }
    // Modifier keys are not always reflected reliably by
    // CGEventSourceKeyState, especially for synthetic-but-system-posted
    // events. The flags state is the more stable source for held
    // modifiers, so merge it into the same virtual-key map used by the
    // sidecar.
    let flags = unsafe { CGEventSourceFlagsState(0) };
    const SHIFT_FLAG: u64 = 0x0002_0000;
    const CONTROL_FLAG: u64 = 0x0004_0000;
    const OPTION_FLAG: u64 = 0x0008_0000;
    const COMMAND_FLAG: u64 = 0x0010_0000;
    keys[56] |= flags & SHIFT_FLAG != 0;
    keys[59] |= flags & CONTROL_FLAG != 0;
    keys[58] |= flags & OPTION_FLAG != 0;
    keys[55] |= flags & COMMAND_FLAG != 0;
    Some(keys)
}

#[cfg(target_os = "macos")]
pub(crate) fn current_escape_key_active() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state_id: u32, key: u16) -> bool;
    }

    unsafe { CGEventSourceKeyState(0, 53) }
}

/// Keys held right now, from the same `device_query` state the pointer uses.
#[cfg(target_os = "windows")]
fn held_keys() -> Vec<device_query::Keycode> {
    DeviceState::new().get_keys()
}

#[cfg(target_os = "windows")]
pub(crate) fn current_escape_key_active() -> bool {
    held_keys().contains(&device_query::Keycode::Escape)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn current_escape_key_active() -> bool {
    false
}

/// Bare Control held down: the Flare gesture. A Command chord is excluded so
/// ⌘⌃-shortcuts do not paint; Control+click is left alone on purpose, since a
/// user pointing with a held Control is exactly what Flare is for.
#[cfg(target_os = "macos")]
pub(crate) fn current_control_key_active() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state_id: u32) -> u64;
    }
    const CONTROL_FLAG: u64 = 0x0004_0000;
    const COMMAND_FLAG: u64 = 0x0010_0000;
    let flags = unsafe { CGEventSourceFlagsState(0) };
    flags & CONTROL_FLAG != 0 && flags & COMMAND_FLAG == 0
}

/// Flare on Windows: bare Control, with Windows-key chords excluded the way
/// macOS excludes Command chords.
#[cfg(target_os = "windows")]
pub(crate) fn current_control_key_active() -> bool {
    use device_query::Keycode;
    let keys = held_keys();
    keys.iter()
        .any(|key| matches!(key, Keycode::LControl | Keycode::RControl))
        && !keys
            .iter()
            .any(|key| matches!(key, Keycode::LMeta | Keycode::RMeta))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn current_control_key_active() -> bool {
    false
}

/// What the idle pointer (`pointer.rs`) reads on each poll.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PointerKeys {
    /// Control and Shift held, with no Command/Windows or Option/Alt key.
    pub control_shift: bool,
    /// A key that is not a modifier is down too, so the hold is a shortcut
    /// (Ctrl+Shift+T, Ctrl+Shift+V) and not a pointer. Only read while
    /// `control_shift` is true.
    pub other_key: bool,
}

#[cfg(target_os = "macos")]
pub(crate) fn current_pointer_keys() -> PointerKeys {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state_id: u32, key: u16) -> bool;
        fn CGEventSourceFlagsState(state_id: u32) -> u64;
    }
    const SHIFT_FLAG: u64 = 0x0002_0000;
    const CONTROL_FLAG: u64 = 0x0004_0000;
    const OPTION_FLAG: u64 = 0x0008_0000;
    const COMMAND_FLAG: u64 = 0x0010_0000;
    // kCGEventSourceStateCombinedSessionState = 0.
    let flags = unsafe { CGEventSourceFlagsState(0) };
    let control_shift = flags & CONTROL_FLAG != 0
        && flags & SHIFT_FLAG != 0
        && flags & (OPTION_FLAG | COMMAND_FLAG) == 0;
    if !control_shift {
        return PointerKeys::default();
    }
    // Virtual keycodes 54-63 are the modifiers (Command, Shift, Caps Lock,
    // Option, Control, Fn); anything else held makes the hold a shortcut.
    let other_key = (0..KEY_STATES as u16)
        .filter(|code| !(54..=63).contains(code))
        .any(|code| unsafe { CGEventSourceKeyState(0, code) });
    PointerKeys {
        control_shift,
        other_key,
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn current_pointer_keys() -> PointerKeys {
    use device_query::Keycode;
    let keys = held_keys();
    let control = keys
        .iter()
        .any(|key| matches!(key, Keycode::LControl | Keycode::RControl));
    let shift = keys
        .iter()
        .any(|key| matches!(key, Keycode::LShift | Keycode::RShift));
    let blocked = keys.iter().any(|key| {
        matches!(
            key,
            Keycode::LMeta | Keycode::RMeta | Keycode::LAlt | Keycode::RAlt
        )
    });
    let control_shift = control && shift && !blocked;
    let other_key = control_shift
        && keys.iter().any(|key| {
            !matches!(
                key,
                Keycode::LControl
                    | Keycode::RControl
                    | Keycode::LShift
                    | Keycode::RShift
                    | Keycode::CapsLock
            )
        });
    PointerKeys {
        control_shift,
        other_key,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn current_pointer_keys() -> PointerKeys {
    PointerKeys::default()
}

#[cfg(target_os = "macos")]
pub(crate) fn current_primary_button_active() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: u32, button: u32) -> bool;
    }

    // kCGEventSourceStateCombinedSessionState = 0, left mouse button = 0.
    unsafe { CGEventSourceButtonState(0, 0) }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn current_primary_button_active() -> bool {
    let device = DeviceState::new();
    device
        .get_mouse()
        .button_pressed
        .first()
        .copied()
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub(crate) fn window_ids_front_to_back() -> Vec<u32> {
    unsafe {
        let windows = mac_window_bounds_ffi::CGWindowListCopyWindowInfo(
            mac_window_bounds_ffi::K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY
                | mac_window_bounds_ffi::K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
            0,
        );
        if windows.is_null() {
            return Vec::new();
        }

        let count = mac_window_bounds_ffi::CFArrayGetCount(windows);
        let mut ids = Vec::with_capacity(count.max(0) as usize);
        for index in 0..count {
            let window = mac_window_bounds_ffi::CFArrayGetValueAtIndex(windows, index);
            if window.is_null() {
                continue;
            }
            if let Some(id) = cf_dictionary_number(window, "kCGWindowNumber") {
                if id >= 0.0 && id <= u32::MAX as f64 {
                    ids.push(id.round() as u32);
                }
            }
        }
        mac_window_bounds_ffi::CFRelease(windows);
        ids
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn window_ids_front_to_back() -> Vec<u32> {
    Vec::new()
}

/// One on-screen window as Window Services lists it, front to back.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct ListedWindow {
    number: u32,
    owner_pid: i64,
    layer: i64,
    /// 0 for a fully transparent window, which takes no visible part.
    alpha: f64,
    /// Global logical points, the space cursor samples are in.
    bounds: (f64, f64, f64, f64),
}

/// Whether a press at `(x, y)` lands on the recorded window itself. Windows
/// are front to back, and the first one under the point takes the press,
/// whatever its layer: another app's window, and any menu or popover (the
/// recorded app's own included), is a separate window the video does not
/// show. Only Clipy's own windows (`own_pid`: the camera bubble, the cursor
/// trail, the HUD) and fully transparent ones are looked through.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn press_lands_on_window(
    windows: &[ListedWindow],
    window_id: u32,
    own_pid: i64,
    x: f64,
    y: f64,
) -> bool {
    windows
        .iter()
        .filter(|window| window.owner_pid != own_pid && window.alpha > 0.0)
        .find(|window| {
            let (left, top, width, height) = window.bounds;
            x >= left && x < left + width && y >= top && y < top + height
        })
        .is_some_and(|window| window.number == window_id)
}

/// Whether keystrokes go to the recorded window's app: the app that owns the
/// frontmost normal window is the one with keyboard focus. Keys typed into
/// any other app stay out of a window-only take.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn keys_go_to_window_app(windows: &[ListedWindow], window_id: u32) -> bool {
    let Some(owner) = windows
        .iter()
        .find(|window| window.number == window_id)
        .map(|window| window.owner_pid)
    else {
        return false;
    };
    windows
        .iter()
        .find(|window| window.layer == 0)
        .is_some_and(|window| window.owner_pid == owner)
}

/// The normal and overlay windows on screen, front to back. Empty when
/// Window Services cannot answer, which keeps a window-only take's evidence
/// out rather than letting another app's in.
#[cfg(target_os = "macos")]
fn listed_windows_front_to_back() -> Vec<ListedWindow> {
    // SAFETY: the list is a +1 reference created here, read here and
    // released before returning; nothing borrowed from it escapes.
    unsafe {
        let windows = mac_window_bounds_ffi::CGWindowListCopyWindowInfo(
            mac_window_bounds_ffi::K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY
                | mac_window_bounds_ffi::K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
            0,
        );
        if windows.is_null() {
            return Vec::new();
        }
        let count = mac_window_bounds_ffi::CFArrayGetCount(windows);
        let mut listed = Vec::with_capacity(count.max(0) as usize);
        for index in 0..count {
            let window = mac_window_bounds_ffi::CFArrayGetValueAtIndex(windows, index);
            if window.is_null() {
                continue;
            }
            let (Some(number), Some(owner_pid), Some(bounds)) = (
                cf_dictionary_number(window, "kCGWindowNumber"),
                cf_dictionary_number(window, "kCGWindowOwnerPID"),
                window_dictionary_bounds(window),
            ) else {
                continue;
            };
            if !(0.0..=u32::MAX as f64).contains(&number) {
                continue;
            }
            listed.push(ListedWindow {
                number: number.round() as u32,
                owner_pid: owner_pid.round() as i64,
                layer: cf_dictionary_number(window, "kCGWindowLayer")
                    .map_or(0, |l| l.round() as i64),
                alpha: cf_dictionary_number(window, "kCGWindowAlpha").unwrap_or(1.0),
                bounds,
            });
        }
        mac_window_bounds_ffi::CFRelease(windows);
        listed
    }
}

/// Keeps a window-only take's evidence to the recorded window. The window
/// list is read at most once per poll, and only when a press or key edge
/// needs it.
#[cfg(target_os = "macos")]
struct WindowEvidenceScope {
    window_id: u32,
    listed: Option<Vec<ListedWindow>>,
}

#[cfg(target_os = "macos")]
impl WindowEvidenceScope {
    fn new(window_id: u32) -> Self {
        Self {
            window_id,
            listed: None,
        }
    }

    fn next_poll(&mut self) {
        self.listed = None;
    }

    fn windows(&mut self) -> &[ListedWindow] {
        self.listed.get_or_insert_with(listed_windows_front_to_back)
    }

    fn admits_press(&mut self, x: i32, y: i32) -> bool {
        let window_id = self.window_id;
        let own_pid = i64::from(std::process::id());
        press_lands_on_window(
            self.windows(),
            window_id,
            own_pid,
            f64::from(x),
            f64::from(y),
        )
    }

    fn admits_keys(&mut self) -> bool {
        let window_id = self.window_id;
        keys_go_to_window_app(self.windows(), window_id)
    }
}

/// Modifiers only, under the macOS key codes the sidecar and the key-moment
/// fusion read (Control is 59, which is how a Flare hold is recognised).
/// Other keys are deliberately not recorded on Windows.
#[cfg(target_os = "windows")]
fn current_keyboard_state() -> Option<[bool; KEY_STATES]> {
    use device_query::Keycode;
    let mut keys = [false; KEY_STATES];
    for key in held_keys() {
        let code = match key {
            Keycode::LShift | Keycode::RShift => 56,
            Keycode::LControl | Keycode::RControl => 59,
            Keycode::LAlt | Keycode::RAlt => 58,
            Keycode::LMeta | Keycode::RMeta => 55,
            _ => continue,
        };
        keys[code] = true;
    }
    Some(keys)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn current_keyboard_state() -> Option<[bool; KEY_STATES]> {
    None
}

#[cfg(not(target_os = "macos"))]
fn current_mouse_sample(device: &DeviceState) -> Option<MouseSample> {
    let mouse = device.get_mouse();
    let mut buttons = [false; 5];
    for (index, slot) in buttons.iter_mut().enumerate() {
        *slot = mouse.button_pressed.get(index).copied().unwrap_or(false);
    }
    Some(MouseSample {
        x: mouse.coords.0,
        y: mouse.coords.1,
        buttons,
        cursor_type: current_cursor_type(),
    })
}

#[cfg(target_os = "macos")]
fn current_coord_space() -> CoordSpace {
    CoordSpace::LogicalMacos
}

#[cfg(target_os = "windows")]
fn current_coord_space() -> CoordSpace {
    CoordSpace::PhysicalWindows
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn current_coord_space() -> CoordSpace {
    // Linux dev builds; treat as logical so the editor falls through to
    // the macOS scaling assumption (1:1 with logical pixels).
    CoordSpace::LogicalMacos
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_keeps_modifier_codes_so_flares_and_chords_still_read() {
        for code in 54..=63 {
            assert_eq!(sidecar_key_code(code), code);
        }
        // Control, which is how a Flare hold is recognised.
        assert_eq!(sidecar_key_code(59), 59);
        assert_eq!(sidecar_key_code(62), 62);
    }

    #[test]
    fn sidecar_never_records_which_letter_was_typed() {
        // "hunter2" then Return, as macOS virtual key codes.
        let typed: [u16; 8] = [4, 32, 45, 17, 14, 15, 19, 36];
        let recorded: Vec<u16> = typed.iter().map(|&code| sidecar_key_code(code)).collect();
        assert!(recorded.iter().all(|&code| code == TYPED_KEY_CODE));
        // Escape, Space, Delete and the arrows are not modifiers either.
        for code in [53, 49, 51, 123, 124, 125, 126] {
            assert_eq!(sidecar_key_code(code), TYPED_KEY_CODE);
        }
    }

    fn listed(
        number: u32,
        owner_pid: i64,
        layer: i64,
        bounds: (f64, f64, f64, f64),
    ) -> ListedWindow {
        ListedWindow {
            number,
            owner_pid,
            layer,
            alpha: 1.0,
            bounds,
        }
    }

    #[test]
    fn click_through_changes_all_go_through_the_tracker() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![src];
        let mut offenders = Vec::new();
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs")
                    && !path.ends_with("cursor_track.rs")
                {
                    let text = std::fs::read_to_string(&path).unwrap();
                    if text.contains(".set_ignore_cursor_events(") {
                        offenders.push(path.display().to_string());
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "use crate::cursor_track::set_ignore_cursor_events so click labels \
             never look through a window that just became clickable: {offenders:?}"
        );
    }

    #[test]
    fn hit_test_owner_never_resolves_to_own_process() {
        const CLIPY: i64 = 42;
        // Front to back: our menu-bar icon, our click-through capture
        // overlay, then Safari.
        let windows = [
            listed(90, CLIPY, 25, (1200.0, 0.0, 30.0, 24.0)),
            listed(91, CLIPY, 25, (0.0, 0.0, 1512.0, 982.0)),
            listed(7, 3, 0, (0.0, 24.0, 1512.0, 958.0)),
        ];
        let owner = |x, y| topmost_foreign_owner(&windows, CLIPY, &[91], x, y);
        assert_eq!(
            owner(400.0, 400.0),
            Some(3),
            "click-through overlay is looked through"
        );
        assert_eq!(
            owner(1210.0, 10.0),
            None,
            "our menu-bar icon stops the lookup"
        );
        assert_eq!(
            topmost_foreign_owner(&windows[1..2], CLIPY, &[91], 400.0, 400.0),
            None,
            "nothing foreign behind the overlay"
        );
    }

    #[test]
    fn hit_test_stops_at_a_clickable_clipy_window() {
        const CLIPY: i64 = 42;
        // The camera controls over Safari: the click went to Clipy, not Safari.
        let windows = [
            listed(95, CLIPY, 3, (100.0, 100.0, 200.0, 50.0)),
            listed(7, 3, 0, (0.0, 0.0, 800.0, 600.0)),
        ];
        assert_eq!(
            topmost_foreign_owner(&windows, CLIPY, &[], 150.0, 120.0),
            None
        );
        assert_eq!(
            topmost_foreign_owner(&windows, CLIPY, &[], 50.0, 50.0),
            Some(3)
        );
        // Unknown to the snapshot (not read yet) counts as clickable.
        assert_eq!(
            topmost_foreign_owner(&windows, CLIPY, &[91], 150.0, 120.0),
            None
        );
    }

    #[test]
    fn hit_test_owner_is_the_topmost_visible_foreign_window() {
        let mut transparent = listed(91, 4, 30, (0.0, 0.0, 2000.0, 2000.0));
        transparent.alpha = 0.0;
        let windows = [
            transparent,
            listed(12, 2, 0, (100.0, 100.0, 200.0, 200.0)),
            listed(7, 3, 0, (0.0, 0.0, 800.0, 600.0)),
        ];
        let owner = |x, y| topmost_foreign_owner(&windows, 1, &[], x, y);
        assert_eq!(owner(150.0, 150.0), Some(2));
        assert_eq!(owner(50.0, 50.0), Some(3));
        assert_eq!(
            owner(800.0, 10.0),
            None,
            "right and bottom edges are exclusive"
        );
    }

    #[test]
    fn a_press_counts_only_on_the_recorded_window_itself() {
        const CLIPY: i64 = 1;
        // Front to back: Clipy's overlay, a transparent window, another
        // app's menu, another app's window over part of the recorded window
        // (7), then the recorded window.
        let mut transparent = listed(91, 4, 30, (0.0, 0.0, 2000.0, 2000.0));
        transparent.alpha = 0.0;
        let windows = [
            listed(90, CLIPY, 25, (0.0, 0.0, 2000.0, 2000.0)),
            transparent,
            listed(13, 2, 101, (400.0, 100.0, 100.0, 100.0)),
            listed(12, 2, 0, (100.0, 100.0, 200.0, 200.0)),
            listed(7, 3, 0, (0.0, 0.0, 800.0, 600.0)),
        ];
        let lands = |x, y| press_lands_on_window(&windows, 7, CLIPY, x, y);
        assert!(
            lands(50.0, 50.0),
            "Clipy's and transparent windows are looked through"
        );
        assert!(!lands(150.0, 150.0), "a window over it takes the press");
        assert!(
            !lands(450.0, 150.0),
            "so does another app's menu, whatever its layer"
        );
        assert!(!lands(900.0, 50.0), "outside the window");
        assert!(
            !press_lands_on_window(&[], 7, CLIPY, 50.0, 50.0),
            "no window list keeps the press out"
        );
    }

    #[test]
    fn keys_count_only_while_the_recorded_window_app_is_in_front() {
        let recorded_in_front = [
            listed(90, 1, 25, (0.0, 0.0, 10.0, 10.0)),
            listed(8, 3, 0, (0.0, 0.0, 10.0, 10.0)),
            listed(7, 3, 0, (0.0, 0.0, 10.0, 10.0)),
        ];
        assert!(
            keys_go_to_window_app(&recorded_in_front, 7),
            "another window of the same app is in front"
        );
        let other_in_front = [
            listed(12, 2, 0, (0.0, 0.0, 10.0, 10.0)),
            listed(7, 3, 0, (0.0, 0.0, 10.0, 10.0)),
        ];
        assert!(!keys_go_to_window_app(&other_in_front, 7));
        assert!(
            !keys_go_to_window_app(&other_in_front[..1], 7),
            "the recorded window is not on screen"
        );
    }

    #[test]
    fn annotation_event_round_trips_as_a_kind_tagged_flip() {
        // The server validator and key-moment fusion read exactly this shape.
        let on = CursorEvent::Annotation { time_ms: 20_103.4, active: true };
        let json = serde_json::to_value(&on).unwrap();
        assert_eq!(json, serde_json::json!({"kind":"annotation","time_ms":20_103.4,"active":true}));
        let back: CursorEvent = serde_json::from_value(json).unwrap();
        assert!(matches!(back, CursorEvent::Annotation { active: true, .. }));
        assert_eq!(back.time_ms(), 20_103.4);
        // Never sampled away: a flip is not a move.
        let mut buffer = CursorEventBuffer::new();
        buffer.move_stride = 8;
        buffer.push(on.clone());
        buffer.push(CursorEvent::Annotation { time_ms: 22_753.0, active: false });
        assert_eq!(buffer.events.len(), 2);
    }

    #[test]
    fn cursor_event_buffer_adaptively_bounds_long_recordings() {
        let mut buffer = CursorEventBuffer::new();
        for index in 0..(MAX_CURSOR_EVENTS * 4) {
            buffer.push(CursorEvent::Move {
                time_ms: index as f64,
                x: index as i32,
                y: 0,
                cursor_type: None,
            });
        }
        buffer.push(CursorEvent::Down {
            time_ms: 999_999.0,
            button: 1,
            x: 20,
            y: 30,
            cursor_type: None,
            render_x: None,
            render_y: None,
        });

        assert!(buffer.events.len() <= MAX_CURSOR_EVENTS);
        assert!(buffer.move_stride > 1);
        assert!(
            buffer
                .events
                .iter()
                .any(|event| matches!(event, CursorEvent::Down { .. })),
            "semantic events must survive move compaction"
        );
    }

    #[test]
    fn cursor_event_buffer_survives_a_buffer_full_of_semantic_events() {
        // Heavy scrolling can fill the buffer with nothing but semantic
        // events. compact_moves() then frees nothing, so it must not keep
        // widening the move stride (which would silently discard every
        // future move sample) or log on every single push.
        let mut buffer = CursorEventBuffer::new();
        for index in 0..(MAX_CURSOR_EVENTS + 5_000) {
            buffer.push(CursorEvent::Scroll {
                time_ms: index as f64,
                delta_x: 0,
                delta_y: 1,
                x: 0,
                y: 0,
                cursor_type: None,
            });
        }

        assert_eq!(buffer.events.len(), MAX_CURSOR_EVENTS);
        assert_eq!(buffer.move_events, 0);
        assert_eq!(buffer.move_stride, 1, "no moves were compacted away");
        assert_eq!(buffer.compactions, 0);

        // Sampling is still at full rate: nothing was thrown away by the
        // stride, only by the (correct) full-buffer eviction.
        assert_eq!(buffer.moves_seen, 0);
    }

    #[test]
    fn cursor_event_buffer_stops_scanning_after_the_last_move_is_compacted() {
        let mut buffer = CursorEventBuffer::new();
        buffer.push(CursorEvent::Move {
            time_ms: 0.0,
            x: 0,
            y: 0,
            cursor_type: None,
        });
        for index in 1..MAX_CURSOR_EVENTS {
            buffer.push(CursorEvent::Scroll {
                time_ms: index as f64,
                delta_x: 0,
                delta_y: 1,
                x: 0,
                y: 0,
                cursor_type: None,
            });
        }

        buffer.push(CursorEvent::Scroll {
            time_ms: MAX_CURSOR_EVENTS as f64,
            delta_x: 0,
            delta_y: 1,
            x: 0,
            y: 0,
            cursor_type: None,
        });
        assert_eq!(buffer.move_events, 0);
        assert_eq!(buffer.compactions, 1);

        for index in 0..5_000 {
            buffer.push(CursorEvent::Scroll {
                time_ms: (MAX_CURSOR_EVENTS + index + 1) as f64,
                delta_x: 0,
                delta_y: 1,
                x: 0,
                y: 0,
                cursor_type: None,
            });
        }

        assert_eq!(buffer.events.len(), MAX_CURSOR_EVENTS);
        assert_eq!(buffer.compactions, 1);
    }

    fn window_baseline() -> CaptureViewport {
        // A 800x600-point window on a 2x display, recorded at 1600x1200.
        CaptureViewport {
            x: 100.0,
            y: 50.0,
            width: 800.0,
            height: 600.0,
            output_width: 1_600,
            output_height: 1_200,
            screen_x: Some(0.0),
            screen_y: Some(0.0),
            screen_width: Some(1_512.0),
            screen_height: Some(982.0),
        }
    }

    /// The consumers' mapping (`screen_charm_event_xy`, the server's
    /// `normalizeClick`): a point inside the viewport scaled to the frame.
    fn to_output(viewport: CaptureViewport, x: f64, y: f64) -> (f64, f64) {
        (
            (x - viewport.x) / viewport.width * f64::from(viewport.output_width),
            (y - viewport.y) / viewport.height * f64::from(viewport.output_height),
        )
    }

    #[test]
    fn window_viewport_follows_a_moved_window() {
        let moved = window_capture_viewport((400.0, 300.0, 800.0, 600.0), None, window_baseline());
        assert_eq!(
            (moved.x, moved.y, moved.width, moved.height),
            (400.0, 300.0, 800.0, 600.0)
        );
        assert_eq!((moved.output_width, moved.output_height), (1_600, 1_200));
        // The window's own corner is still the frame's corner.
        assert_eq!(to_output(moved, 400.0, 300.0), (0.0, 0.0));
        assert_eq!(to_output(moved, 1_200.0, 900.0), (1_600.0, 1_200.0));
    }

    #[test]
    fn window_viewport_with_a_full_frame_placement_is_the_window() {
        let full = ContentPlacement {
            x: 0.0,
            y: 0.0,
            width: 1_600.0,
            height: 1_200.0,
        };
        let viewport =
            window_capture_viewport((100.0, 50.0, 800.0, 600.0), Some(full), window_baseline());
        assert!((viewport.x - 100.0).abs() < 1e-9 && (viewport.y - 50.0).abs() < 1e-9);
        assert!((viewport.width - 800.0).abs() < 1e-9 && (viewport.height - 600.0).abs() < 1e-9);
    }

    #[test]
    fn window_viewport_maps_through_letterbox_bars_after_a_resize() {
        // The window was widened to 1600x600 points. SCK fits it into the
        // fixed 1600x1200 frame at 1 px/pt: 600 px of content, bars of 300 px
        // above and below.
        let placement = ContentPlacement {
            x: 0.0,
            y: 300.0,
            width: 1_600.0,
            height: 600.0,
        };
        let viewport = window_capture_viewport(
            (100.0, 50.0, 1_600.0, 600.0),
            Some(placement),
            window_baseline(),
        );

        let (left, top) = to_output(viewport, 100.0, 50.0);
        let (right, bottom) = to_output(viewport, 1_700.0, 650.0);
        let (mid_x, mid_y) = to_output(viewport, 900.0, 350.0);
        assert!(
            (left - 0.0).abs() < 1e-6 && (top - 300.0).abs() < 1e-6,
            "{left},{top}"
        );
        assert!(
            (right - 1_600.0).abs() < 1e-6 && (bottom - 900.0).abs() < 1e-6,
            "{right},{bottom}"
        );
        assert!(
            (mid_x - 800.0).abs() < 1e-6 && (mid_y - 600.0).abs() < 1e-6,
            "{mid_x},{mid_y}"
        );
    }

    #[test]
    fn window_viewport_ignores_a_degenerate_placement() {
        let empty = ContentPlacement {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
        let viewport =
            window_capture_viewport((10.0, 20.0, 300.0, 200.0), Some(empty), window_baseline());
        assert_eq!(
            (viewport.x, viewport.y, viewport.width, viewport.height),
            (10.0, 20.0, 300.0, 200.0)
        );
    }

    #[test]
    fn content_rect_in_points_is_scaled_to_output_pixels() {
        let placement =
            content_placement_in_output((0.0, 150.0, 800.0, 300.0), 2.0, 1_600.0, 1_200.0)
                .expect("fits");
        assert_eq!(
            placement,
            ContentPlacement {
                x: 0.0,
                y: 300.0,
                width: 1_600.0,
                height: 600.0
            }
        );
    }

    #[test]
    fn content_rect_already_in_pixels_is_kept() {
        // Scaled by 2 it would overflow the frame, so it is read as pixels.
        let placement =
            content_placement_in_output((0.0, 300.0, 1_600.0, 600.0), 2.0, 1_600.0, 1_200.0)
                .expect("fits");
        assert_eq!(
            placement,
            ContentPlacement {
                x: 0.0,
                y: 300.0,
                width: 1_600.0,
                height: 600.0
            }
        );
    }

    #[test]
    fn content_rect_prefers_the_reading_that_spans_the_frame() {
        // Both readings fit inside 1600x1200; only the pixel reading spans
        // its width, which is what scales-to-fit content always does.
        let placement =
            content_placement_in_output((0.0, 450.0, 1_600.0, 300.0), 0.5, 1_600.0, 1_200.0)
                .expect("fits");
        assert_eq!(
            placement,
            ContentPlacement {
                x: 0.0,
                y: 450.0,
                width: 1_600.0,
                height: 300.0
            }
        );

        // When neither spans, the documented points reading wins.
        let placement =
            content_placement_in_output((10.0, 10.0, 100.0, 100.0), 2.0, 1_600.0, 1_200.0)
                .expect("fits");
        assert_eq!(
            placement,
            ContentPlacement {
                x: 20.0,
                y: 20.0,
                width: 200.0,
                height: 200.0
            }
        );
    }

    #[test]
    fn content_rect_origin_in_pixels_is_not_doubled_on_retina() {
        // A square window letterboxed into a 2000x1000 frame at 2x: the size
        // is reported in points (500x500) and the bar offset as 500 pixels,
        // as Chromium reads it. Doubling the origin would also fit the frame,
        // but puts the content against the right edge instead of centered.
        let placement =
            content_placement_in_output((500.0, 0.0, 500.0, 500.0), 2.0, 2_000.0, 1_000.0)
                .expect("fits");
        assert_eq!(
            placement,
            ContentPlacement {
                x: 500.0,
                y: 0.0,
                width: 1_000.0,
                height: 1_000.0
            }
        );
    }

    #[test]
    fn content_rect_that_cannot_fit_the_frame_is_ignored() {
        assert!(
            content_placement_in_output((0.0, 0.0, 4_000.0, 4_000.0), 2.0, 1_600.0, 1_200.0)
                .is_none()
        );
        assert!(content_placement_in_output((0.0, 0.0, 0.0, 0.0), 2.0, 1_600.0, 1_200.0).is_none());
        assert!(
            content_placement_in_output((f64::NAN, 0.0, 10.0, 10.0), 1.0, 1_600.0, 1_200.0)
                .is_none()
        );
    }

    #[test]
    fn capture_timeline_adaptively_bounds_continuous_window_changes() {
        let mut buffer = CaptureTimelineBuffer::new(None);
        for index in 0..(MAX_CAPTURE_VIEWPORT_SAMPLES * 4) {
            buffer.push(CaptureViewportSample {
                time_ms: index as f64,
                viewport: window_baseline(),
            });
        }

        assert!(buffer.samples.len() <= MAX_CAPTURE_VIEWPORT_SAMPLES);
        assert!(buffer.sample_stride > 1);
        assert!(buffer
            .samples
            .windows(2)
            .all(|pair| pair[0].time_ms < pair[1].time_ms));
    }

    #[test]
    fn capture_timeline_keeps_the_newest_viewport_after_compaction() {
        let mut buffer = CaptureTimelineBuffer::new(None);
        let total = MAX_CAPTURE_VIEWPORT_SAMPLES * 3 + 1;
        for index in 0..total {
            let mut viewport = window_baseline();
            viewport.x = index as f64;
            buffer.push(CaptureViewportSample {
                time_ms: index as f64,
                viewport,
            });
            // Whatever the stride dropped, the window's current position is
            // always the last thing the sidecar says.
            let last = buffer.samples.last().unwrap();
            assert_eq!(last.time_ms, index as f64);
            assert_eq!(last.viewport.x, index as f64);
        }
        assert!(buffer.sample_stride > 1);
        assert!(buffer.samples.len() <= MAX_CAPTURE_VIEWPORT_SAMPLES);
        assert!(buffer
            .samples
            .windows(2)
            .all(|pair| pair[0].time_ms < pair[1].time_ms));
    }

    #[test]
    fn stop_yields_track_with_metadata() {
        let tracker = CursorTracker::start();
        std::thread::sleep(Duration::from_millis(80));
        let track = tracker.stop();
        // We can't assert events were captured without controlling the
        // mouse, but the structural metadata should always be present.
        assert_eq!(track.sample_hz, POLL_HZ);
        // Either coord_space variant is acceptable depending on host.
        match track.coord_space {
            CoordSpace::LogicalMacos | CoordSpace::PhysicalWindows => {}
        }
    }

    #[test]
    fn event_time_ms_helper_returns_inner_field() {
        let m = CursorEvent::Move {
            time_ms: 123.4,
            x: 0,
            y: 0,
            cursor_type: Some("cursor".to_string()),
        };
        let d = CursorEvent::Down {
            time_ms: 456.7,
            button: 1,
            x: 0,
            y: 0,
            cursor_type: Some("cursor".to_string()),
            render_x: None,
            render_y: None,
        };
        assert!((m.time_ms() - 123.4).abs() < f64::EPSILON);
        assert!((d.time_ms() - 456.7).abs() < f64::EPSILON);
    }

    #[test]
    fn capture_at_uses_last_sample_at_or_before_time() {
        let first = CaptureViewport {
            x: 0.0,
            y: 0.0,
            width: 640.0,
            height: 360.0,
            output_width: 640,
            output_height: 360,
            screen_x: None,
            screen_y: None,
            screen_width: None,
            screen_height: None,
        };
        let second = CaptureViewport {
            x: -200.0,
            y: 80.0,
            ..first
        };
        let track = CursorTrack {
            events: Vec::new(),
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture: Some(first),
            capture_timeline: vec![
                CaptureViewportSample {
                    time_ms: 0.0,
                    viewport: first,
                },
                CaptureViewportSample {
                    time_ms: 500.0,
                    viewport: second,
                },
            ],
            capture_source: None,
            click_elements: Vec::new(),
        };

        assert_eq!(track.capture_at(499.0).map(|c| c.x), Some(0.0));
        assert_eq!(track.capture_at(500.0).map(|c| c.x), Some(-200.0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_cursor_mapping_covers_screen_charm_cursor_types() {
        let mapped: std::collections::HashSet<&str> = NS_CURSOR_TYPE_MAPPINGS
            .iter()
            .map(|(_, cursor_type)| *cursor_type)
            .collect();

        for expected in [
            "cursor",
            "textcursor",
            "handpointing",
            "handgrabbing",
            "handopen",
            "cross",
            "resizeleftright",
            "resizeupdown",
            "resizewest",
            "resizeeast",
            "resizenorth",
            "resizesouth",
            "notallowed",
        ] {
            assert!(
                mapped.contains(expected),
                "missing Screen Charm cursor type mapping for {expected}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_cursor_mapping_checks_arrow_last() {
        assert_eq!(
            NS_CURSOR_TYPE_MAPPINGS.last().map(|(_, kind)| *kind),
            Some("cursor")
        );
    }
}
