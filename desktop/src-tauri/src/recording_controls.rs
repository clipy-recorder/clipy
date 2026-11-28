use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

#[derive(Clone, Deserialize, Serialize)]
pub struct Hint {
    text: String,
    y: f64,
}

#[derive(Default)]
pub struct HintState(Mutex<Option<Hint>>);

/// Set by `init` when the hint window could not be made click-through
/// (Windows 10). Its clickable area is then cut down to the bubble it shows,
/// so a notice that stays up for a whole take ("No mic input") does not block
/// clicks on the app beside the dock.
static HINT_TAKES_CLICKS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The hint bubble's box in the hint window, in CSS pixels.
#[derive(Clone, Copy, Deserialize)]
pub struct HintBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The last bubble box the page reported. Kept in CSS pixels so the clip can
/// be redone at the display's scale whenever the hint moves: a move to a
/// display with other scaling changes the clip but not the bubble's CSS size,
/// so the page has nothing new to report.
static HINT_BOUNDS: Mutex<Option<HintBounds>> = Mutex::new(None);

/// Cut the hint window's clickable area down to the last reported bubble, at
/// the window's current scale. Only on Windows 10 (see `HINT_TAKES_CLICKS`).
fn clip_hint_to_bubble<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    if HINT_TAKES_CLICKS.load(std::sync::atomic::Ordering::Relaxed) {
        let (Some(bounds), Ok(scale)) = (*HINT_BOUNDS.lock(), window.scale_factor()) else {
            return;
        };
        let px = |css: f64| (css * scale).round() as i32;
        // The margins leave room for the bubble's shadow (0 6px 18px), so the
        // clip does not cut it off flat.
        crate::commands::clip_window_to_rect(
            window,
            px(bounds.x - 18.0),
            px(bounds.y - 12.0),
            px(bounds.x + bounds.width.max(0.0) + 18.0),
            px(bounds.y + bounds.height.max(0.0) + 24.0),
        );
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DockEdge {
    Left,
    Right,
}

impl DockEdge {
    fn as_str(self) -> &'static str {
        match self {
            DockEdge::Left => "left",
            DockEdge::Right => "right",
        }
    }
}

/// Where the collapsed dock is notched, and where the expanded dock goes back
/// to. Only the x is kept: the peek stays centred on the dock's own centre, so
/// the height-keeping shift in `set_recording_controls_size` restores the y.
#[derive(Clone, Copy)]
struct Notch {
    edge: DockEdge,
    restore_x: f64,
}

#[derive(Default)]
pub struct DockState(Mutex<Option<Notch>>);

/// The notch goes on whichever side of the screen the dock is closer to, so
/// collapsing never sends it across the screen.
fn nearest_edge(center_x: f64, left: f64, right: f64) -> DockEdge {
    if center_x - left <= right - center_x {
        DockEdge::Left
    } else {
        DockEdge::Right
    }
}

/// A fresh layout (new recording, new source) owns the dock position again.
pub(crate) fn forget_notch(app: &AppHandle) {
    if let Some(state) = app.try_state::<DockState>() {
        *state.0.lock() = None;
    }
}

#[tauri::command]
pub fn get_recording_controls_hint(state: tauri::State<'_, HintState>) -> Option<Hint> {
    state.0.lock().clone()
}

/// Sent by the hint page whenever its bubble changes size. Does nothing
/// unless the hint window takes clicks (see `HINT_TAKES_CLICKS`).
#[tauri::command]
pub fn set_recording_hint_bounds(
    window: tauri::WebviewWindow,
    bounds: HintBounds,
) -> Result<(), String> {
    if window.label() != "recording-hint"
        || ![bounds.x, bounds.y, bounds.width, bounds.height]
            .iter()
            .all(|v| v.is_finite())
    {
        return Err("Invalid recording hint bounds".into());
    }
    *HINT_BOUNDS.lock() = Some(bounds);
    clip_hint_to_bubble(&window);
    Ok(())
}

#[tauri::command]
pub fn set_recording_controls_size(
    window: tauri::WebviewWindow,
    height: f64,
    width: Option<f64>,
    collapsed: Option<bool>,
    dock: tauri::State<'_, DockState>,
) -> Result<Option<&'static str>, String> {
    // The dock is a 64px column; the pen palette opens beside it, so the
    // webview asks for a wider window while that is showing. The floor is 20
    // rather than the dock's own width because the user can collapse the dock
    // to a slim peek, which is narrower than any of its buttons.
    let width = width.unwrap_or(64.0);
    if window.label() != "stop-controls"
        || !height.is_finite()
        || !(1.0..=720.0).contains(&height)
        || !width.is_finite()
        || !(20.0..=340.0).contains(&width)
    {
        return Err("Invalid recording controls size".into());
    }
    // Keep the rail centred on the spot Rust chose for it: a height change
    // from the webview would otherwise grow the window downwards and leave
    // the dock sitting above the middle of the screen.
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let previous = window
        .outer_size()
        .map(|size| {
            (
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            )
        })
        .unwrap_or((width, height));
    let origin = window
        .outer_position()
        .map(|p| (f64::from(p.x) / scale, f64::from(p.y) / scale))
        .ok();
    // Read before resizing: a notch widening back into a dock beside another
    // display can overlap that display more than its own, and the OS would
    // then report the neighbour as the window's monitor.
    let work_area = window.current_monitor().ok().flatten().map(|monitor| {
        let work = monitor.work_area();
        let left = f64::from(work.position.x) / scale;
        let top = f64::from(work.position.y) / scale;
        (
            left,
            left + f64::from(work.size.width) / scale,
            top,
            top + f64::from(work.size.height) / scale,
        )
    });
    window
        .set_size(LogicalSize::new(width.ceil(), height.ceil()))
        .map_err(|e| e.to_string())?;
    let mut notch = dock.0.lock();
    let mut edge = None;
    if let Some((x, y)) = origin {
        // Truncated so a shrink and the matching grow cancel exactly; rounding
        // each half-pixel away from zero drifted the dock 1px per round trip.
        let shift = ((previous.1 - height.ceil()) / 2.0).trunc();
        let mut new_x = x;
        let mut new_y = y + shift;
        if let Some((left, right, top, bottom)) = work_area {
            if collapsed.unwrap_or(false) {
                // Collapsed: a notch flush against the nearer screen edge, the
                // same tab the extension's rail leaves behind.
                let current = *notch.get_or_insert(Notch {
                    edge: nearest_edge(x + previous.0 / 2.0, left, right),
                    restore_x: x,
                });
                new_x = match current.edge {
                    DockEdge::Left => left,
                    DockEdge::Right => right - width.ceil(),
                };
                edge = Some(current.edge.as_str());
            } else if let Some(previous_notch) = notch.take() {
                // The saved x can predate a display change made while the dock
                // was collapsed, so it must land back on the current screen.
                new_x = previous_notch.restore_x.min(right - width.ceil());
            }
            // The window keeps its left edge when it narrows, so a dock dragged
            // partly past the left of the screen would collapse to a peek that
            // is entirely off it, leaving a live take with no visible Stop.
            new_x = new_x.max(left);
            new_y = new_y.clamp(top, (bottom - height.ceil()).max(top));
        }
        if (new_x - x).abs() >= 1.0 || (new_y - y).abs() >= 1.0 {
            window
                .set_position(LogicalPosition::new(new_x.round(), new_y.round()))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(edge)
}

#[tauri::command]
pub fn set_recording_controls_hint(
    window: tauri::WebviewWindow,
    hint: Option<Hint>,
    state: tauri::State<'_, HintState>,
) -> Result<(), String> {
    if window.label() != "stop-controls"
        || hint
            .as_ref()
            .is_some_and(|h| h.text.len() > 1024 || !h.y.is_finite())
    {
        return Err("Invalid recording controls hint".into());
    }
    let app = window.app_handle();
    let overlay = app
        .get_webview_window("recording-hint")
        .ok_or("Recording hint window missing")?;
    *state.0.lock() = hint.clone();
    let Some(hint) = hint else {
        return overlay.hide().map_err(|e| e.to_string());
    };
    if !window.is_visible().map_err(|e| e.to_string())? {
        return overlay.hide().map_err(|e| e.to_string());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let origin = window.outer_position().map_err(|e| e.to_string())?;
    // Sit just past the dock's right edge. Capped at the dock's own width so
    // the pen palette, which widens this window, does not push hints for the
    // dock's buttons out to the far side of it; floored by the live width so a
    // collapsed dock does not leave its hint floating in empty space.
    let gutter = window
        .outer_size()
        .map(|size| f64::from(size.width) / scale)
        .unwrap_or(64.0)
        .min(64.0);
    let mut x = f64::from(origin.x) / scale + gutter;
    let mut y = f64::from(origin.y) / scale + hint.y - 72.0;
    if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
        let work = monitor.work_area();
        let left = f64::from(work.position.x) / scale;
        let top = f64::from(work.position.y) / scale;
        let right = left + f64::from(work.size.width) / scale;
        let bottom = top + f64::from(work.size.height) / scale;
        if x + 208.0 > right {
            x = f64::from(origin.x) / scale - 216.0;
        }
        x = x.clamp(left, (right - 208.0).max(left));
        y = y.clamp(top, (bottom - 144.0).max(top));
    }
    overlay
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    // The move may have crossed to a display with other scaling.
    clip_hint_to_bubble(&overlay);
    overlay
        .emit("recording-controls-hint", &hint)
        .map_err(|e| e.to_string())?;
    // `init` set the hint's affinity once, at launch. If the session has
    // moved to or from Remote Desktop since, the old affinity would draw the
    // hint black, so it is set again each time the hint appears. Its
    // click-through mode stays as `init` chose it: a click-through hint that
    // is excluded again on Windows 10 is simply recorded, never black.
    #[cfg(target_os = "windows")]
    if !overlay.is_visible().unwrap_or(true) {
        crate::commands::exclude_window_from_capture(&overlay);
    }
    overlay.show().map_err(|e| e.to_string())
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    app.manage(HintState::default());
    app.manage(DockState::default());
    if let Some(window) = app.get_webview_window("recording-hint") {
        // Hints never own mouse input, even over another application's
        // controls. Except on Windows 10 2004 and later: click-through makes
        // the window layered, and Windows 10 ignores capture exclusion on a
        // layered window (Windows 11 honours it), so the tooltip would still
        // be recorded. There the hint takes clicks instead, only on the
        // bubble it shows (`set_recording_hint_bounds`). Where exclusion
        // would draw a black box instead (before 2004, Remote Desktop, a
        // streamed display; see `capture_exclusion`) the hint is not excluded,
        // so it stays click-through and recorded, as it always was there. An
        // unreadable build counts as Windows 11.
        #[cfg(target_os = "windows")]
        let excludable = crate::commands::window_hwnd(&window)
            .is_some_and(|hwnd| crate::capture_exclusion::blocker(hwnd).is_none());
        #[cfg(target_os = "macos")]
        let click_through = true;
        #[cfg(target_os = "windows")]
        let click_through = !excludable
            || crate::commands::windows_build().map_or(true, |build| build >= 22000);
        #[cfg(target_os = "linux")]
        let click_through = false;

        if click_through {
            crate::cursor_track::set_ignore_cursor_events(&window, true)?;
        } else {
            HINT_TAKES_CLICKS.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        #[cfg(target_os = "macos")]
        {
            window.set_visible_on_all_workspaces(true)?;
            if let Ok(ns_window) = window.ns_window() {
                unsafe { crate::commands::set_window_sharing_none(ns_window) };
            }
        }
        #[cfg(target_os = "windows")]
        if excludable {
            crate::commands::exclude_window_from_capture(&window);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notch_goes_to_the_nearer_edge() {
        assert_eq!(nearest_edge(40.0, 0.0, 1440.0), DockEdge::Left);
        assert_eq!(nearest_edge(1400.0, 0.0, 1440.0), DockEdge::Right);
        // Dead centre stays on the left, where the dock starts.
        assert_eq!(nearest_edge(720.0, 0.0, 1440.0), DockEdge::Left);
        // Secondary display to the left of the primary.
        assert_eq!(nearest_edge(-1880.0, -1920.0, 0.0), DockEdge::Left);
        assert_eq!(nearest_edge(-30.0, -1920.0, 0.0), DockEdge::Right);
    }
}
