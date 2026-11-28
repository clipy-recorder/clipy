//! Auto-generate zoom segments from a cursor click track.
//!
//! Algorithm: Screen Studio-style click bursts. For each click,
//! materialize a `[click - PRE, click + POST]` interval, drop trailing
//! clicks near the very end, clamp the end to leave room for the
//! release animation, then merge overlapping or near-overlapping
//! intervals. A second clean-room motion pass adds zoom windows for
//! deliberate pointer travel even when the user does not click - common
//! in product demos where the cursor points at menus, cards, and charts.
//! The result is a sparse list of zoom windows that line up with the
//! user's actual interactions.
//!
//! Constants are aligned with what Cap.so and Screen Studio publish as
//! their defaults. This is a clean-room implementation against the same
//! published recipe — no Cap source is reused. Editor consumers can
//! override any of these without changing this file.
//!
//! Output schema is intentionally a superset of Cap's `ZoomSegment` so
//! native Studio can adopt a shared renderer later if we ever want to.

use serde::{Deserialize, Serialize};

use crate::cursor_track::{CursorEvent, CursorTrack};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ZoomSegment {
    /// Start time in seconds relative to recording start.
    pub start_s: f64,
    /// End time in seconds.
    pub end_s: f64,
    /// Zoom factor. 2.0 = double size, content-anchored on the focal point.
    pub amount: f64,
    /// Boundary ramp duration in seconds. Screen Charm uses the same
    /// 0.8s easing window for generated zoom boundaries; keep native
    /// recording and Studio preview/export on that shared timing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ramp_s: Option<f64>,
    /// Whether the segment auto-follows the cursor (`Auto`) or holds a
    /// fixed manual focal point. Auto-generated segments default to Auto.
    pub mode: ZoomMode,
    /// Optional saved focal path in source-video pixels. Screen Charm stores
    /// zoom positions as a frame curve; Clipy preserves an equivalent bounded
    /// curve when imported/authored.
    #[serde(rename = "focalCurve", skip_serializing_if = "Option::is_none")]
    pub focal_curve: Option<Vec<FocalCurvePoint>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FocalCurvePoint {
    pub time_s: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ZoomMode {
    /// Follow the cursor during the segment.
    Auto,
    /// Hold a fixed focal point. Coordinates are in the same space as the
    /// captured cursor events (see `CursorTrack::coord_space`).
    Manual { x: f64, y: f64 },
}

/// Tunables. Caller can override; defaults match the Screen Studio recipe.
#[derive(Clone, Copy, Debug)]
pub struct ZoomConfig {
    /// How far before the click the zoom begins.
    pub pre_click_ms: f64,
    /// How far after the click the zoom holds before releasing.
    pub post_click_ms: f64,
    /// Clicks inside this window are treated as one stronger interaction.
    pub click_cluster_gap_ms: f64,
    /// Two intervals are merged if their gap is at most this many ms.
    pub merge_gap_ms: f64,
    /// Ignore clicks that land this close to the end of the recording —
    /// otherwise the zoom-out animation gets clipped.
    pub trailing_ignore_ms: f64,
    /// Reserve this many ms at the very end for a clean zoom-out.
    pub end_clamp_ms: f64,
    /// Earliest possible segment start, in ms.
    pub start_min_ms: f64,
    /// Maximum number of auto segments to emit.
    pub max_segments: usize,
    /// Minimum travelled cursor distance before a move-only run is
    /// considered intentional enough to deserve a zoom.
    pub motion_min_distance_px: f64,
    /// Minimum duration for a move-only run. This filters out a single
    /// quick mouse bump at the start/end of a recording.
    pub motion_min_duration_ms: f64,
    /// Direct start-to-end displacement must be at least this fraction of
    /// `motion_min_distance_px` so zig-zag jitter does not become a zoom.
    pub motion_direct_min_ratio: f64,
    /// How much lead-in to add before a movement-triggered zoom.
    pub motion_pre_ms: f64,
    /// How long to hold after the movement settles.
    pub motion_post_ms: f64,
    /// Cursor samples separated by more than this start a new motion run.
    pub motion_gap_ms: f64,
    /// Cursor must remain within this radius to count as a dwell/focus hold.
    pub dwell_radius_px: f64,
    /// Minimum dwell duration before adding a focus zoom.
    pub dwell_min_duration_ms: f64,
    /// Maximum dwell window before a new dwell run starts.
    pub dwell_max_duration_ms: f64,
    /// Zoom factor for deliberate pointer travel.
    pub motion_amount: f64,
    /// Zoom factor for cursor dwell/focus holds.
    pub dwell_amount: f64,
    /// Pointer travel between down/up that means the press was a drag,
    /// not an intentional click target.
    pub drag_suppress_distance_px: f64,
    /// Maximum down/up span considered for drag suppression.
    pub drag_suppress_max_ms: f64,
    /// Padding around drag suppression windows.
    pub drag_suppress_pad_ms: f64,
    /// Time after a scroll event where clicks/motion are treated as noise.
    pub scroll_suppress_ms: f64,
    /// Maximum gap between key-downs in one typing burst.
    pub typing_burst_gap_ms: f64,
    /// Minimum key-down count before typing gets its own zoom hold.
    pub typing_min_key_downs: usize,
    /// Lead-in before a typing-focus zoom.
    pub typing_pre_ms: f64,
    /// Hold after a typing burst.
    pub typing_post_ms: f64,
    /// Maximum age of a cursor point used as typing focal context.
    pub typing_lookback_ms: f64,
    /// Zoom factor for typing/input focus holds.
    pub typing_amount: f64,
    /// Cursor travel tolerated before an auto zoom focal point follows.
    pub focal_dead_zone_px: f64,
    /// Fraction of cursor movement beyond the dead-zone applied to focal drift.
    pub focal_settle_ratio: f64,
}

impl Default for ZoomConfig {
    fn default() -> Self {
        Self {
            pre_click_ms: 800.0,
            post_click_ms: 1300.0,
            click_cluster_gap_ms: 2900.0,
            merge_gap_ms: 90.0,
            trailing_ignore_ms: 1000.0,
            end_clamp_ms: 800.0,
            start_min_ms: 1.0,
            max_segments: 14,
            motion_min_distance_px: 260.0,
            motion_min_duration_ms: 650.0,
            motion_direct_min_ratio: 0.62,
            motion_pre_ms: 160.0,
            motion_post_ms: 720.0,
            motion_gap_ms: 360.0,
            dwell_radius_px: 34.0,
            dwell_min_duration_ms: 1_150.0,
            dwell_max_duration_ms: 1_800.0,
            motion_amount: 1.34,
            dwell_amount: 1.18,
            drag_suppress_distance_px: 18.0,
            drag_suppress_max_ms: 1_400.0,
            drag_suppress_pad_ms: 220.0,
            scroll_suppress_ms: 420.0,
            typing_burst_gap_ms: 900.0,
            typing_min_key_downs: 3,
            typing_pre_ms: 480.0,
            typing_post_ms: 1_050.0,
            typing_lookback_ms: 1_200.0,
            typing_amount: 1.22,
            focal_dead_zone_px: 72.0,
            focal_settle_ratio: 0.62,
        }
    }
}

impl ZoomConfig {
    /// Config used for native recordings. Auto-zoom is
    /// click-only at a steady level 2: clicks
    /// cluster within ~2.9s into a few 2x holds, and the motion/dwell/typing
    /// generators are off (they were the source of the 1.3x/1.2x level
    /// oscillation). Everything else matches the defaults.
    pub fn screen_charm() -> Self {
        Self {
            motion_amount: 0.0,
            dwell_amount: 0.0,
            typing_amount: 0.0,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug)]
struct ZoomCandidate {
    start_ms: f64,
    end_ms: f64,
    amount: f64,
    ramp_s: f64,
    priority: f64,
    manual_focal: Option<(f64, f64)>,
    focal_curve: Option<Vec<FocalCurvePoint>>,
}

#[derive(Clone, Copy, Debug)]
struct ClickCluster {
    first_ms: f64,
    last_ms: f64,
    count: usize,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug)]
struct ClickPoint {
    time_ms: f64,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug)]
struct TimeWindow {
    start_ms: f64,
    end_ms: f64,
}

/// Generate zoom segments from a cursor track. `recording_duration_s` is
/// the wall-clock length of the captured recording in seconds — used to
/// clamp end positions so the final zoom-out has room to play.
pub fn generate_zoom_segments(
    track: &CursorTrack,
    recording_duration_s: f64,
    cfg: ZoomConfig,
) -> Vec<ZoomSegment> {
    const MS_PER_SECOND: f64 = 1000.0;

    if recording_duration_s <= 0.0 {
        return Vec::new();
    }

    let duration_ms = recording_duration_s * MS_PER_SECOND;
    let click_cutoff_ms = duration_ms - cfg.trailing_ignore_ms;
    let end_limit_ms = duration_ms - cfg.end_clamp_ms;
    if click_cutoff_ms <= 0.0 || end_limit_ms <= cfg.start_min_ms {
        return Vec::new();
    }

    let mut candidates: Vec<ZoomCandidate> = Vec::new();
    let suppressed_windows = suppression_windows(track, cfg);

    // Down-presses anchor the strongest zoom moments. Up events would
    // double-fire and moves are handled separately below.
    let mut clicks: Vec<ClickPoint> = track
        .events
        .iter()
        .filter_map(|ev| match ev {
            CursorEvent::Down { time_ms, x, y, .. } => Some(ClickPoint {
                time_ms: time_ms.floor(),
                x: *x as f64,
                y: *y as f64,
            }),
            _ => None,
        })
        .filter(|click| click.time_ms < click_cutoff_ms)
        .filter(|click| !is_suppressed_at(click.time_ms, &suppressed_windows))
        .collect();

    clicks.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let click_times_ms: Vec<f64> = clicks.iter().map(|click| click.time_ms).collect();

    candidates.extend(
        click_clusters(&clicks, cfg.click_cluster_gap_ms)
            .into_iter()
            .filter_map(|cluster| {
                let start = (cluster.first_ms - cfg.pre_click_ms).max(cfg.start_min_ms);
                let ramp_ms = click_ramp_s(cluster.count) * MS_PER_SECOND;
                let end = (cluster.last_ms + cfg.post_click_ms + ramp_ms).min(end_limit_ms);
                if end > start {
                    Some(ZoomCandidate {
                        start_ms: start,
                        end_ms: end,
                        amount: click_zoom_amount(cluster.count),
                        ramp_s: click_ramp_s(cluster.count),
                        priority: 5.0 + cluster.count.min(4) as f64,
                        manual_focal: None,
                        focal_curve: dead_zone_focal_curve(
                            track, start, end, cluster.x, cluster.y, cfg,
                        ),
                    })
                } else {
                    None
                }
            }),
    );

    // Secondary generators only run when their amount is enabled (> 0). A 0
    // amount truly disables the generator (native recordings use click-only
    // zooms), rather than emitting zero-strength segments.
    if cfg.motion_amount > 0.0 {
        candidates.extend(generate_motion_intervals(
            track,
            &click_times_ms,
            &suppressed_windows,
            click_cutoff_ms,
            end_limit_ms,
            cfg,
        ));
    }
    if cfg.dwell_amount > 0.0 {
        candidates.extend(generate_dwell_intervals(
            track,
            &click_times_ms,
            &suppressed_windows,
            click_cutoff_ms,
            end_limit_ms,
            cfg,
        ));
    }
    if cfg.typing_amount > 0.0 {
        candidates.extend(generate_typing_intervals(
            track,
            &suppressed_windows,
            click_cutoff_ms,
            end_limit_ms,
            cfg,
        ));
    }

    if candidates.is_empty() {
        return Vec::new();
    }

    // Sort + merge overlapping or near-overlapping intervals. A run of
    // rapid clicks (e.g. typing a sentence) collapses into one segment.
    candidates.sort_by(|a, b| {
        a.start_ms
            .partial_cmp(&b.start_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.priority
                    .partial_cmp(&a.priority)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let mut merged: Vec<ZoomCandidate> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if let Some(last) = merged.last_mut() {
            if candidate.start_ms <= last.end_ms + cfg.merge_gap_ms {
                last.end_ms = last.end_ms.max(candidate.end_ms);
                last.ramp_s = last.ramp_s.min(candidate.ramp_s);
                if candidate.priority >= last.priority {
                    last.amount = last.amount.max(candidate.amount);
                    last.priority = candidate.priority;
                    last.manual_focal = candidate.manual_focal;
                    last.focal_curve = candidate.focal_curve;
                } else {
                    last.amount = last.amount.max(candidate.amount);
                }
                continue;
            }
        }
        merged.push(candidate);
    }

    merged
        .into_iter()
        .take(cfg.max_segments)
        .map(|candidate| ZoomSegment {
            start_s: (candidate.start_ms.round()) / MS_PER_SECOND,
            end_s: (candidate.end_ms.round()) / MS_PER_SECOND,
            amount: candidate.amount,
            ramp_s: Some(candidate.ramp_s),
            mode: candidate
                .manual_focal
                .map(|(x, y)| ZoomMode::Manual { x, y })
                .unwrap_or(ZoomMode::Auto),
            focal_curve: candidate.focal_curve,
        })
        .collect()
}

fn generate_motion_intervals(
    track: &CursorTrack,
    click_times_ms: &[f64],
    suppressed_windows: &[TimeWindow],
    click_cutoff_ms: f64,
    end_limit_ms: f64,
    cfg: ZoomConfig,
) -> Vec<ZoomCandidate> {
    let mut moves: Vec<(f64, f64, f64)> = track
        .events
        .iter()
        .filter_map(|ev| match ev {
            CursorEvent::Move { time_ms, x, y, .. } => Some((*time_ms, *x as f64, *y as f64)),
            _ => None,
        })
        .filter(|(time_ms, _, _)| *time_ms < click_cutoff_ms)
        .collect();
    if moves.len() < 2 {
        return Vec::new();
    }

    moves.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut intervals = Vec::new();
    let mut run_start = moves[0];
    let mut prev = moves[0];
    let mut distance_px = 0.0;
    let mut direct_distance_px = 0.0;

    for current in moves.into_iter().skip(1) {
        let gap_ms = current.0 - prev.0;
        if gap_ms > cfg.motion_gap_ms {
            push_motion_interval(
                &mut intervals,
                run_start,
                prev,
                distance_px,
                direct_distance_px,
                click_times_ms,
                suppressed_windows,
                end_limit_ms,
                cfg,
            );
            run_start = current;
            prev = current;
            distance_px = 0.0;
            direct_distance_px = 0.0;
            continue;
        }

        distance_px += ((current.1 - prev.1).powi(2) + (current.2 - prev.2).powi(2)).sqrt();
        direct_distance_px =
            ((current.1 - run_start.1).powi(2) + (current.2 - run_start.2).powi(2)).sqrt();
        prev = current;
    }
    push_motion_interval(
        &mut intervals,
        run_start,
        prev,
        distance_px,
        direct_distance_px,
        click_times_ms,
        suppressed_windows,
        end_limit_ms,
        cfg,
    );
    intervals
}

fn push_motion_interval(
    intervals: &mut Vec<ZoomCandidate>,
    run_start: (f64, f64, f64),
    run_end: (f64, f64, f64),
    distance_px: f64,
    direct_distance_px: f64,
    click_times_ms: &[f64],
    suppressed_windows: &[TimeWindow],
    end_limit_ms: f64,
    cfg: ZoomConfig,
) {
    let duration_ms = run_end.0 - run_start.0;
    if duration_ms < cfg.motion_min_duration_ms || distance_px < cfg.motion_min_distance_px {
        return;
    }
    if direct_distance_px < cfg.motion_min_distance_px * cfg.motion_direct_min_ratio {
        return;
    }

    let start = (run_start.0 - cfg.motion_pre_ms).max(cfg.start_min_ms);
    let end = (run_end.0 + cfg.motion_post_ms).min(end_limit_ms);
    if overlaps_click_window(start, end, click_times_ms, cfg) {
        return;
    }
    if overlaps_suppressed_window(start, end, suppressed_windows) {
        return;
    }
    if end > start {
        intervals.push(ZoomCandidate {
            start_ms: start,
            end_ms: end,
            amount: cfg.motion_amount,
            ramp_s: click_ramp_s(1),
            priority: 2.5,
            manual_focal: None,
            focal_curve: None,
        });
    }
}

fn generate_dwell_intervals(
    track: &CursorTrack,
    click_times_ms: &[f64],
    suppressed_windows: &[TimeWindow],
    click_cutoff_ms: f64,
    end_limit_ms: f64,
    cfg: ZoomConfig,
) -> Vec<ZoomCandidate> {
    let mut moves: Vec<(f64, f64, f64)> = track
        .events
        .iter()
        .filter_map(|ev| match ev {
            CursorEvent::Move { time_ms, x, y, .. } => Some((*time_ms, *x as f64, *y as f64)),
            _ => None,
        })
        .filter(|(time_ms, _, _)| *time_ms < click_cutoff_ms)
        .collect();
    if moves.len() < 3 {
        return Vec::new();
    }

    moves.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut intervals = Vec::new();
    let mut anchor = moves[0];
    let mut prev = moves[0];

    for current in moves.into_iter().skip(1) {
        let distance = ((current.1 - anchor.1).powi(2) + (current.2 - anchor.2).powi(2)).sqrt();
        let too_long = current.0 - anchor.0 > cfg.dwell_max_duration_ms;
        if distance > cfg.dwell_radius_px || too_long {
            push_dwell_interval(
                &mut intervals,
                anchor,
                prev,
                track,
                click_times_ms,
                suppressed_windows,
                end_limit_ms,
                cfg,
            );
            anchor = current;
        }
        prev = current;
    }
    push_dwell_interval(
        &mut intervals,
        anchor,
        prev,
        track,
        click_times_ms,
        suppressed_windows,
        end_limit_ms,
        cfg,
    );
    intervals
}

fn push_dwell_interval(
    intervals: &mut Vec<ZoomCandidate>,
    run_start: (f64, f64, f64),
    run_end: (f64, f64, f64),
    track: &CursorTrack,
    click_times_ms: &[f64],
    suppressed_windows: &[TimeWindow],
    end_limit_ms: f64,
    cfg: ZoomConfig,
) {
    let duration_ms = run_end.0 - run_start.0;
    if duration_ms < cfg.dwell_min_duration_ms {
        return;
    }

    let start = (run_start.0 - cfg.pre_click_ms * 0.45).max(cfg.start_min_ms);
    let end = (run_end.0 + cfg.post_click_ms * 0.52).min(end_limit_ms);
    if overlaps_click_window(start, end, click_times_ms, cfg) {
        return;
    }
    if overlaps_suppressed_window(start, end, suppressed_windows) {
        return;
    }
    if end > start {
        let (focal_x, focal_y) = cursor_to_source_xy(
            track.capture_at(run_start.0),
            (run_start.1 + run_end.1) / 2.0,
            (run_start.2 + run_end.2) / 2.0,
        );
        intervals.push(ZoomCandidate {
            start_ms: start,
            end_ms: end,
            amount: cfg.dwell_amount,
            ramp_s: click_ramp_s(1),
            priority: 1.4,
            manual_focal: Some((focal_x.round(), focal_y.round())),
            focal_curve: None,
        });
    }
}

fn generate_typing_intervals(
    track: &CursorTrack,
    suppressed_windows: &[TimeWindow],
    click_cutoff_ms: f64,
    end_limit_ms: f64,
    cfg: ZoomConfig,
) -> Vec<ZoomCandidate> {
    let mut key_downs: Vec<(f64, u16)> = track
        .events
        .iter()
        .filter_map(|ev| match ev {
            CursorEvent::KeyDown { time_ms, key_code } => Some((*time_ms, *key_code)),
            _ => None,
        })
        .filter(|(time_ms, _)| *time_ms < click_cutoff_ms)
        .collect();
    if key_downs.len() < cfg.typing_min_key_downs {
        return Vec::new();
    }
    key_downs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut intervals = Vec::new();
    let mut burst: Vec<(f64, u16)> = Vec::new();
    for key in key_downs {
        if let Some(prev) = burst.last() {
            if key.0 - prev.0 > cfg.typing_burst_gap_ms {
                push_typing_interval(
                    &mut intervals,
                    &burst,
                    track,
                    suppressed_windows,
                    end_limit_ms,
                    cfg,
                );
                burst.clear();
            }
        }
        burst.push(key);
    }
    push_typing_interval(
        &mut intervals,
        &burst,
        track,
        suppressed_windows,
        end_limit_ms,
        cfg,
    );

    intervals
}

fn push_typing_interval(
    intervals: &mut Vec<ZoomCandidate>,
    burst: &[(f64, u16)],
    track: &CursorTrack,
    suppressed_windows: &[TimeWindow],
    end_limit_ms: f64,
    cfg: ZoomConfig,
) {
    if burst.len() < cfg.typing_min_key_downs || !has_text_like_key(burst) {
        return;
    }
    let Some(first) = burst.first() else {
        return;
    };
    let Some(last) = burst.last() else {
        return;
    };
    let Some((focal_x, focal_y)) = last_cursor_point_before(track, first.0, cfg.typing_lookback_ms)
    else {
        return;
    };
    let start = (first.0 - cfg.typing_pre_ms).max(cfg.start_min_ms);
    let end = (last.0 + cfg.typing_post_ms).min(end_limit_ms);
    if end <= start {
        return;
    }
    if overlaps_suppressed_window(start, end, suppressed_windows) {
        return;
    }

    let (source_x, source_y) = cursor_to_source_xy(track.capture_at(first.0), focal_x, focal_y);
    intervals.push(ZoomCandidate {
        start_ms: start,
        end_ms: end,
        amount: cfg.typing_amount,
        ramp_s: click_ramp_s(1),
        priority: 3.2,
        manual_focal: Some((source_x.round(), source_y.round())),
        focal_curve: None,
    });
}

fn last_cursor_point_before(
    track: &CursorTrack,
    time_ms: f64,
    lookback_ms: f64,
) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64)> = None;
    for event in &track.events {
        if let CursorEvent::Move {
            time_ms: event_time,
            x,
            y,
            ..
        } = event
        {
            if *event_time <= time_ms && time_ms - *event_time <= lookback_ms {
                best = Some((*x as f64, *y as f64));
            }
        }
    }
    best
}

fn has_text_like_key(burst: &[(f64, u16)]) -> bool {
    burst
        .iter()
        .any(|(_, key_code)| !is_modifier_key_code(*key_code))
}

fn is_modifier_key_code(key_code: u16) -> bool {
    matches!(key_code, 54 | 55 | 56 | 57 | 58 | 59 | 60 | 61 | 62 | 63)
}

fn cursor_to_source_xy(
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

fn click_clusters(clicks: &[ClickPoint], cluster_gap_ms: f64) -> Vec<ClickCluster> {
    let mut clusters: Vec<ClickCluster> = Vec::new();
    for click in clicks {
        let Some(current) = clusters.last_mut() else {
            clusters.push(ClickCluster {
                first_ms: click.time_ms,
                last_ms: click.time_ms,
                count: 1,
                x: click.x,
                y: click.y,
            });
            continue;
        };

        if click.time_ms - current.last_ms > cluster_gap_ms {
            clusters.push(ClickCluster {
                first_ms: click.time_ms,
                last_ms: click.time_ms,
                count: 1,
                x: click.x,
                y: click.y,
            });
        } else {
            current.last_ms = click.time_ms;
            current.x = (current.x * current.count as f64 + click.x) / (current.count as f64 + 1.0);
            current.y = (current.y * current.count as f64 + click.y) / (current.count as f64 + 1.0);
            current.count += 1;
        }
    }
    clusters
}

fn dead_zone_focal_curve(
    track: &CursorTrack,
    start_ms: f64,
    end_ms: f64,
    anchor_x: f64,
    anchor_y: f64,
    cfg: ZoomConfig,
) -> Option<Vec<FocalCurvePoint>> {
    let (mut focal_x, mut focal_y) =
        cursor_to_source_xy(track.capture_at(start_ms), anchor_x, anchor_y);
    let dead_zone = cfg.focal_dead_zone_px.max(12.0);
    let settle_ratio = cfg.focal_settle_ratio.clamp(0.35, 1.0);
    let mut curve = vec![FocalCurvePoint {
        time_s: start_ms.round() / 1000.0,
        x: focal_x.round(),
        y: focal_y.round(),
    }];

    let mut moves: Vec<(f64, f64, f64)> = track
        .events
        .iter()
        .filter_map(|event| match event {
            CursorEvent::Move { time_ms, x, y, .. } if *time_ms > start_ms && *time_ms < end_ms => {
                let (source_x, source_y) =
                    cursor_to_source_xy(track.capture_at(*time_ms), *x as f64, *y as f64);
                Some((*time_ms, source_x, source_y))
            }
            _ => None,
        })
        .collect();
    moves.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    for (time_ms, x, y) in moves {
        let dx = x - focal_x;
        let dy = y - focal_y;
        let distance = (dx.powi(2) + dy.powi(2)).sqrt();
        if distance < dead_zone {
            continue;
        }
        let overshoot = (distance - dead_zone).max(0.0);
        let step = distance.min(dead_zone * 0.45 + overshoot * settle_ratio);
        let ratio = step / distance.max(1.0);
        focal_x += dx * ratio;
        focal_y += dy * ratio;
        let point = FocalCurvePoint {
            time_s: time_ms.round() / 1000.0,
            x: focal_x.round(),
            y: focal_y.round(),
        };
        let Some(previous) = curve.last() else {
            curve.push(point);
            continue;
        };
        if (previous.time_s - point.time_s).abs() > f64::EPSILON
            || (previous.x - point.x).abs() > f64::EPSILON
            || (previous.y - point.y).abs() > f64::EPSILON
        {
            curve.push(point);
        }
    }

    let last = curve.last().cloned()?;
    let end_point = FocalCurvePoint {
        time_s: end_ms.round() / 1000.0,
        x: last.x,
        y: last.y,
    };
    if (last.time_s - end_point.time_s).abs() > f64::EPSILON {
        curve.push(end_point);
    }
    Some(curve)
}

fn overlaps_click_window(
    start_ms: f64,
    end_ms: f64,
    click_times_ms: &[f64],
    cfg: ZoomConfig,
) -> bool {
    click_times_ms.iter().any(|click_ms| {
        let click_start = (click_ms - cfg.pre_click_ms).max(cfg.start_min_ms);
        let click_end = click_ms + cfg.post_click_ms + click_ramp_s(1) * 1000.0;
        start_ms <= click_end + cfg.merge_gap_ms && end_ms >= click_start - cfg.merge_gap_ms
    })
}

fn suppression_windows(track: &CursorTrack, cfg: ZoomConfig) -> Vec<TimeWindow> {
    let mut events = track.events.clone();
    events.sort_by(|a, b| {
        a.time_ms()
            .partial_cmp(&b.time_ms())
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut windows = Vec::new();
    for (index, event) in events.iter().enumerate() {
        match event {
            CursorEvent::Scroll { time_ms, .. } => {
                windows.push(TimeWindow {
                    start_ms: (*time_ms - cfg.scroll_suppress_ms * 0.35).max(0.0),
                    end_ms: *time_ms + cfg.scroll_suppress_ms,
                });
            }
            CursorEvent::Down {
                time_ms,
                button,
                x,
                y,
                ..
            } => {
                let up = events
                    .iter()
                    .skip(index + 1)
                    .find_map(|candidate| match candidate {
                        CursorEvent::Up {
                            time_ms: up_time,
                            button: up_button,
                            x: up_x,
                            y: up_y,
                            ..
                        } if up_time > time_ms
                            && up_time - time_ms <= cfg.drag_suppress_max_ms
                            && up_button == button =>
                        {
                            Some((*up_time, *up_x, *up_y))
                        }
                        _ => None,
                    });
                let Some((up_time, up_x, up_y)) = up else {
                    continue;
                };
                let distance =
                    ((up_x as f64 - *x as f64).powi(2) + (up_y as f64 - *y as f64).powi(2)).sqrt();
                if distance >= cfg.drag_suppress_distance_px {
                    windows.push(TimeWindow {
                        start_ms: (*time_ms - cfg.drag_suppress_pad_ms).max(0.0),
                        end_ms: up_time + cfg.drag_suppress_pad_ms,
                    });
                }
            }
            _ => {}
        }
    }

    merge_windows(windows)
}

fn merge_windows(mut windows: Vec<TimeWindow>) -> Vec<TimeWindow> {
    windows.sort_by(|a, b| {
        a.start_ms
            .partial_cmp(&b.start_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut merged: Vec<TimeWindow> = Vec::new();
    for window in windows {
        if !window.start_ms.is_finite()
            || !window.end_ms.is_finite()
            || window.end_ms < window.start_ms
        {
            continue;
        }
        if let Some(last) = merged.last_mut() {
            if window.start_ms <= last.end_ms {
                last.end_ms = last.end_ms.max(window.end_ms);
                continue;
            }
        }
        merged.push(window);
    }
    merged
}

fn is_suppressed_at(time_ms: f64, windows: &[TimeWindow]) -> bool {
    windows
        .iter()
        .any(|window| time_ms >= window.start_ms && time_ms <= window.end_ms)
}

fn overlaps_suppressed_window(start_ms: f64, end_ms: f64, windows: &[TimeWindow]) -> bool {
    windows
        .iter()
        .any(|window| start_ms <= window.end_ms && end_ms >= window.start_ms)
}

fn click_zoom_amount(_count: usize) -> f64 {
    2.0
}

fn click_ramp_s(_count: usize) -> f64 {
    0.8
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor_track::{CaptureViewport, CoordSpace, CursorEvent};

    fn track_with_clicks(times_ms: &[f64]) -> CursorTrack {
        CursorTrack {
            events: times_ms
                .iter()
                .map(|&t| CursorEvent::Down {
                    time_ms: t,
                    button: 1,
                    x: 0,
                    y: 0,
                    cursor_type: Some("cursor".to_string()),
                    render_x: None,
                    render_y: None,
                })
                .collect(),
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture: None,
            capture_timeline: Vec::new(),
            capture_source: None,
            click_elements: Vec::new(),
        }
    }

    fn track_with_moves(points: &[(f64, i32, i32)]) -> CursorTrack {
        CursorTrack {
            events: points
                .iter()
                .map(|&(time_ms, x, y)| CursorEvent::Move {
                    time_ms,
                    x,
                    y,
                    cursor_type: Some("cursor".to_string()),
                })
                .collect(),
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture: None,
            capture_timeline: Vec::new(),
            capture_source: None,
            click_elements: Vec::new(),
        }
    }

    #[test]
    fn empty_track_returns_empty() {
        let track = track_with_clicks(&[]);
        let out = generate_zoom_segments(&track, 30.0, ZoomConfig::default());
        assert!(out.is_empty());
    }

    #[test]
    fn zero_duration_returns_empty() {
        let track = track_with_clicks(&[1000.0]);
        let out = generate_zoom_segments(&track, 0.0, ZoomConfig::default());
        assert!(out.is_empty());
    }

    #[test]
    fn trailing_clicks_are_dropped() {
        // 30s recording; trailing_ignore is the last 1s by default.
        // A click at 29.5s should be dropped because 29500 > 29000.
        let track = track_with_clicks(&[29_500.0]);
        let out = generate_zoom_segments(&track, 30.0, ZoomConfig::default());
        assert!(out.is_empty(), "got unexpected segments: {out:?}");
    }

    #[test]
    fn single_mid_click_becomes_single_segment() {
        let track = track_with_clicks(&[10_000.0]);
        let out = generate_zoom_segments(&track, 30.0, ZoomConfig::default());
        assert_eq!(out.len(), 1);
        let seg = &out[0];
        assert!((seg.start_s - 9.2).abs() < 1e-6);
        assert!((seg.end_s - 12.1).abs() < 1e-6);
        assert!((seg.amount - 2.0).abs() < 1e-9);
        assert_eq!(seg.ramp_s, Some(0.8));
        assert!(matches!(seg.mode, ZoomMode::Auto));
    }

    #[test]
    fn click_zoom_gets_dead_zone_focal_curve() {
        let track = CursorTrack {
            events: vec![
                CursorEvent::Down {
                    time_ms: 1_000.0,
                    button: 1,
                    x: 400,
                    y: 300,
                    cursor_type: Some("cursor".to_string()),
                    render_x: None,
                    render_y: None,
                },
                CursorEvent::Move {
                    time_ms: 1_250.0,
                    x: 420,
                    y: 318,
                    cursor_type: Some("cursor".to_string()),
                },
                CursorEvent::Move {
                    time_ms: 1_600.0,
                    x: 455,
                    y: 335,
                    cursor_type: Some("cursor".to_string()),
                },
                CursorEvent::Move {
                    time_ms: 2_100.0,
                    x: 620,
                    y: 420,
                    cursor_type: Some("cursor".to_string()),
                },
            ],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture: None,
            capture_timeline: Vec::new(),
            capture_source: None,
            click_elements: Vec::new(),
        };
        let out = generate_zoom_segments(&track, 6.0, ZoomConfig::default());
        assert_eq!(out.len(), 1, "got {out:?}");
        let curve = out[0]
            .focal_curve
            .as_ref()
            .expect("click zoom should save a stable focal curve");
        assert_eq!(curve.len(), 3);
        assert_eq!(curve[0].time_s, 0.2);
        assert_eq!((curve[0].x, curve[0].y), (400.0, 300.0));
        assert_eq!(
            (curve[1].time_s, curve[1].x, curve[1].y),
            (2.1, 526.0, 369.0)
        );
        assert_eq!(
            (curve[2].time_s, curve[2].x, curve[2].y),
            (3.1, 526.0, 369.0)
        );
    }

    #[test]
    fn close_clicks_merge_into_single_segment() {
        let track = track_with_clicks(&[10_000.0, 10_650.0]);
        let out = generate_zoom_segments(&track, 30.0, ZoomConfig::default());
        assert_eq!(out.len(), 1, "got {out:?}");
        let seg = &out[0];
        assert!((seg.start_s - 9.2).abs() < 1e-6);
        assert!((seg.end_s - 12.75).abs() < 1e-6);
        assert!((seg.amount - 2.0).abs() < 1e-9);
        assert_eq!(seg.ramp_s, Some(0.8));
    }

    #[test]
    fn far_clicks_produce_separate_segments() {
        let track = track_with_clicks(&[10_000.0, 20_000.0]);
        let out = generate_zoom_segments(&track, 60.0, ZoomConfig::default());
        assert_eq!(out.len(), 2, "got {out:?}");
        assert!((out[0].start_s - 9.2).abs() < 1e-6);
        assert!((out[1].start_s - 19.2).abs() < 1e-6);
    }

    #[test]
    fn end_clamp_caps_final_segment_end() {
        let track = track_with_clicks(&[3_000.0]);
        let out = generate_zoom_segments(&track, 5.0, ZoomConfig::default());
        assert_eq!(out.len(), 1, "got {out:?}");
        assert!((out[0].end_s - 4.2).abs() < 1e-6);
    }

    #[test]
    fn tiny_move_jitter_is_ignored() {
        let track = track_with_moves(&[
            (1_000.0, 100, 100),
            (1_100.0, 104, 103),
            (1_200.0, 108, 107),
            (1_300.0, 111, 110),
        ]);
        let out = generate_zoom_segments(&track, 30.0, ZoomConfig::default());
        assert!(out.is_empty(), "got unexpected segments: {out:?}");
    }

    #[test]
    fn deliberate_move_run_creates_auto_zoom() {
        let track = track_with_moves(&[
            (1_000.0, 100, 100),
            (1_200.0, 220, 150),
            (1_450.0, 390, 210),
            (1_700.0, 520, 260),
        ]);
        let out = generate_zoom_segments(&track, 30.0, ZoomConfig::default());
        assert_eq!(out.len(), 1, "got {out:?}");
        assert!((out[0].start_s - 0.84).abs() < 1e-6);
        assert!((out[0].end_s - 2.42).abs() < 1e-6);
        assert!((out[0].amount - 1.34).abs() < 1e-9);
        assert_eq!(out[0].ramp_s, Some(0.8));
        assert!(matches!(out[0].mode, ZoomMode::Auto));
    }

    #[test]
    fn zig_zag_motion_without_direct_displacement_is_ignored() {
        let track = track_with_moves(&[
            (1_000.0, 100, 100),
            (1_200.0, 240, 100),
            (1_400.0, 100, 100),
            (1_600.0, 240, 100),
            (1_800.0, 105, 100),
        ]);
        let out = generate_zoom_segments(&track, 30.0, ZoomConfig::default());
        assert!(out.is_empty(), "got unexpected segments: {out:?}");
    }

    #[test]
    fn dwell_focus_hold_creates_manual_focal_zoom() {
        let track = track_with_moves(&[
            (1_000.0, 100, 100),
            (1_400.0, 108, 102),
            (1_800.0, 114, 106),
            (2_200.0, 118, 110),
        ]);
        let out = generate_zoom_segments(&track, 6.0, ZoomConfig::default());
        assert_eq!(out.len(), 1, "got {out:?}");
        assert!((out[0].start_s - 0.64).abs() < 1e-6);
        assert!((out[0].end_s - 2.876).abs() < 1e-6);
        assert!((out[0].amount - 1.18).abs() < 1e-9);
        assert_eq!(out[0].ramp_s, Some(0.8));
        match out[0].mode {
            ZoomMode::Manual { x, y } => {
                assert!((x - 109.0).abs() < 1e-9);
                assert!((y - 105.0).abs() < 1e-9);
            }
            ZoomMode::Auto => panic!("dwell zoom should hold a fixed focal point"),
        }
    }

    #[test]
    fn dwell_focus_hold_maps_capture_coordinates_to_source_focal() {
        let mut track = track_with_moves(&[
            (1_000.0, 200, 100),
            (1_400.0, 204, 104),
            (1_800.0, 216, 116),
            (2_200.0, 220, 120),
        ]);
        track.capture = Some(CaptureViewport {
            x: 100.0,
            y: 50.0,
            width: 400.0,
            height: 300.0,
            output_width: 800,
            output_height: 600,
            screen_x: None,
            screen_y: None,
            screen_width: None,
            screen_height: None,
        });

        let out = generate_zoom_segments(&track, 6.0, ZoomConfig::default());
        assert_eq!(out.len(), 1, "got {out:?}");
        match out[0].mode {
            ZoomMode::Manual { x, y } => {
                assert!((x - 220.0).abs() < 1e-9);
                assert!((y - 120.0).abs() < 1e-9);
            }
            ZoomMode::Auto => panic!("dwell zoom should hold a fixed source focal point"),
        }
    }

    #[test]
    fn move_run_overlapping_click_zoom_is_skipped() {
        let track = CursorTrack {
            events: vec![
                CursorEvent::Move {
                    time_ms: 1_000.0,
                    x: 100,
                    y: 100,
                    cursor_type: Some("cursor".to_string()),
                },
                CursorEvent::Move {
                    time_ms: 1_250.0,
                    x: 350,
                    y: 150,
                    cursor_type: Some("cursor".to_string()),
                },
                CursorEvent::Move {
                    time_ms: 1_600.0,
                    x: 600,
                    y: 220,
                    cursor_type: Some("cursor".to_string()),
                },
                CursorEvent::Down {
                    time_ms: 2_000.0,
                    button: 1,
                    x: 600,
                    y: 220,
                    cursor_type: Some("cursor".to_string()),
                    render_x: None,
                    render_y: None,
                },
            ],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture: None,
            capture_timeline: Vec::new(),
            capture_source: None,
            click_elements: Vec::new(),
        };
        let out = generate_zoom_segments(&track, 30.0, ZoomConfig::default());
        assert_eq!(out.len(), 1, "got {out:?}");
        assert!((out[0].start_s - 1.2).abs() < 1e-6);
        assert!((out[0].end_s - 4.1).abs() < 1e-6);
        assert!((out[0].amount - 2.0).abs() < 1e-9);
    }

    #[test]
    fn typing_burst_creates_manual_focal_zoom() {
        let track = CursorTrack {
            events: vec![
                CursorEvent::Move {
                    time_ms: 1_400.0,
                    x: 360,
                    y: 220,
                    cursor_type: Some("textcursor".to_string()),
                },
                CursorEvent::KeyDown {
                    time_ms: 2_000.0,
                    key_code: 0,
                },
                CursorEvent::KeyDown {
                    time_ms: 2_180.0,
                    key_code: 11,
                },
                CursorEvent::KeyDown {
                    time_ms: 2_360.0,
                    key_code: 8,
                },
                CursorEvent::KeyDown {
                    time_ms: 2_540.0,
                    key_code: 2,
                },
            ],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture: None,
            capture_timeline: Vec::new(),
            capture_source: None,
            click_elements: Vec::new(),
        };
        let out = generate_zoom_segments(&track, 7.0, ZoomConfig::default());
        assert_eq!(out.len(), 1, "got {out:?}");
        assert!((out[0].start_s - 1.52).abs() < 1e-6);
        assert!((out[0].end_s - 3.59).abs() < 1e-6);
        assert!((out[0].amount - 1.22).abs() < 1e-9);
        match out[0].mode {
            ZoomMode::Manual { x, y } => {
                assert!((x - 360.0).abs() < 1e-9);
                assert!((y - 220.0).abs() < 1e-9);
            }
            ZoomMode::Auto => panic!("typing zoom should hold a fixed focal point"),
        }
    }

    #[test]
    fn typing_zoom_is_unchanged_when_the_sidecar_hides_which_keys_were_typed() {
        let burst = |key_code: fn(u16) -> u16| CursorTrack {
            events: vec![
                CursorEvent::Move {
                    time_ms: 1_400.0,
                    x: 360,
                    y: 220,
                    cursor_type: Some("textcursor".to_string()),
                },
                CursorEvent::KeyDown {
                    time_ms: 2_000.0,
                    key_code: key_code(0),
                },
                CursorEvent::KeyDown {
                    time_ms: 2_180.0,
                    key_code: key_code(11),
                },
                CursorEvent::KeyDown {
                    time_ms: 2_360.0,
                    key_code: key_code(8),
                },
                CursorEvent::KeyDown {
                    time_ms: 2_540.0,
                    key_code: key_code(2),
                },
            ],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture: None,
            capture_timeline: Vec::new(),
            capture_source: None,
            click_elements: Vec::new(),
        };
        let raw = generate_zoom_segments(&burst(|code| code), 7.0, ZoomConfig::default());
        let recorded = generate_zoom_segments(
            &burst(crate::cursor_track::sidecar_key_code),
            7.0,
            ZoomConfig::default(),
        );
        assert_eq!(raw.len(), 1, "got {raw:?}");
        assert_eq!(format!("{recorded:?}"), format!("{raw:?}"));
    }

    #[test]
    fn typing_extends_click_zoom_hold() {
        let track = CursorTrack {
            events: vec![
                CursorEvent::Move {
                    time_ms: 1_600.0,
                    x: 360,
                    y: 220,
                    cursor_type: Some("textcursor".to_string()),
                },
                CursorEvent::Down {
                    time_ms: 2_000.0,
                    button: 1,
                    x: 360,
                    y: 220,
                    cursor_type: Some("textcursor".to_string()),
                    render_x: None,
                    render_y: None,
                },
                CursorEvent::Up {
                    time_ms: 2_050.0,
                    button: 1,
                    x: 360,
                    y: 220,
                    cursor_type: Some("textcursor".to_string()),
                },
                CursorEvent::KeyDown {
                    time_ms: 2_800.0,
                    key_code: 0,
                },
                CursorEvent::KeyDown {
                    time_ms: 3_080.0,
                    key_code: 11,
                },
                CursorEvent::KeyDown {
                    time_ms: 3_360.0,
                    key_code: 8,
                },
                CursorEvent::KeyDown {
                    time_ms: 3_640.0,
                    key_code: 2,
                },
            ],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture: None,
            capture_timeline: Vec::new(),
            capture_source: None,
            click_elements: Vec::new(),
        };
        let out = generate_zoom_segments(&track, 8.0, ZoomConfig::default());
        assert_eq!(out.len(), 1, "got {out:?}");
        assert!((out[0].start_s - 1.2).abs() < 1e-6);
        assert!((out[0].end_s - 4.69).abs() < 1e-6);
        assert!((out[0].amount - 2.0).abs() < 1e-9);
        assert!(matches!(out[0].mode, ZoomMode::Auto));
    }

    #[test]
    fn drag_selection_does_not_create_zoom() {
        let track = CursorTrack {
            events: vec![
                CursorEvent::Down {
                    time_ms: 1_000.0,
                    button: 1,
                    x: 120,
                    y: 160,
                    cursor_type: Some("textcursor".to_string()),
                    render_x: None,
                    render_y: None,
                },
                CursorEvent::Move {
                    time_ms: 1_300.0,
                    x: 240,
                    y: 170,
                    cursor_type: Some("textcursor".to_string()),
                },
                CursorEvent::Move {
                    time_ms: 1_600.0,
                    x: 420,
                    y: 180,
                    cursor_type: Some("textcursor".to_string()),
                },
                CursorEvent::Up {
                    time_ms: 1_800.0,
                    button: 1,
                    x: 520,
                    y: 190,
                    cursor_type: Some("textcursor".to_string()),
                },
            ],
            sample_hz: 60,
            coord_space: CoordSpace::LogicalMacos,
            capture: None,
            capture_timeline: Vec::new(),
            capture_source: None,
            click_elements: Vec::new(),
        };
        let out = generate_zoom_segments(&track, 7.0, ZoomConfig::default());
        assert!(out.is_empty(), "got unexpected segments: {out:?}");
    }

    #[test]
    fn max_segments_caps_noisy_click_runs() {
        let times: Vec<f64> = (0..8)
            .map(|index| 1_000.0 + index as f64 * 4_000.0)
            .collect();
        let out = generate_zoom_segments(
            &track_with_clicks(&times),
            36.0,
            ZoomConfig {
                max_segments: 3,
                ..ZoomConfig::default()
            },
        );
        assert_eq!(out.len(), 3, "got {out:?}");
    }
}
