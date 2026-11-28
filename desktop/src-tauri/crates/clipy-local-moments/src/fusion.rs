//! Moment fusion: spoken cues meet what the user's hands did, then every
//! gesture, click and rest that nothing covers becomes its own moment. A port
//! of `fuseMoments` (`keyMomentsFusion.ts`) with the defaults the hosted
//! service runs when no tuning variable is set.

use std::cmp::Ordering;

use crate::evidence::{
    cursor_position_at, cursor_position_before, cursor_speed_at, ClickCluster, HoverDwell,
    PenStroke, Point, Span,
};
use crate::js;

/// Clicks within 3 s before or 5 s after a cue can fuse with it.
pub(crate) const FUSE_BEFORE_MS: f64 = 3_000.0;
pub(crate) const FUSE_AFTER_MS: f64 = 5_000.0;
/// Above this the pointer is travelling, not pointing (px/s).
const MID_FLIGHT_MAX_SPEED_PX_S: f64 = 180.0;
/// A fallback anchor must come from a sample this close to the cue.
const FALLBACK_MAX_SAMPLE_GAP_MS: f64 = 600.0;
/// A flare shorter than this is a stray Control tap.
const STANDALONE_FLARE_MIN_MS: f64 = 400.0;
/// Sanity bound on gesture moments (flares and drawings).
const ANNOTATION_MOMENTS_CEILING: usize = 200;
const MAX_STANDALONE_FLARES: usize = ANNOTATION_MOMENTS_CEILING;
const FLARE_SAMPLE_MAX_GAP_MS: f64 = 1_000.0;
/// A flare's frame is taken this long before the release, while it is still painted.
const FLARE_TRAIL_LEAD_MS: f64 = 120.0;
const STANDALONE_HOVER_MIN_MS: f64 = 2_000.0;
const MAX_STANDALONE_CLICKS: usize = 8;
const MAX_STANDALONE_HOVERS: usize = 6;
/// Interaction moments this close to an existing moment are already covered.
const INTERACTION_DEDUPE_MS: f64 = 2_000.0;
/// Pen strokes this close together are one drawing.
const DRAW_CLUSTER_GAP_MS: f64 = 2_500.0;

/// A spoken cue from the model: where it starts and why it matters.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Cue {
    pub t_ms: f64,
    pub caption: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FusedSource {
    Deixis,
    Click,
    Fused,
    Hover,
    Draw,
    Flare,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FusedMoment {
    pub t_ms: f64,
    pub source: FusedSource,
    pub caption: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// The frame instant, always the instant the coordinates belong to.
    pub frame_at_ms: f64,
}

pub(crate) struct FuseInput<'a> {
    pub deixis: &'a [Cue],
    pub clicks: &'a [ClickCluster],
    pub moves: &'a [Point],
    pub hovers: &'a [HoverDwell],
    pub strokes: &'a [PenStroke],
    pub flares: &'a [Span],
    /// (start seconds, end seconds, text)
    pub segments: &'a [(f64, f64, String)],
    pub duration_ms: f64,
    pub max_moments: usize,
    pub max_annotation_moments: usize,
    pub normalize_at: &'a dyn Fn(f64, f64, f64) -> Option<(f64, f64)>,
}

fn cmp(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

fn contains(set: &[f64], value: f64) -> bool {
    set.contains(&value)
}

/// `caption, clicked 'Save'`, bounded.
fn with_clicked_label(caption: &str, label: Option<&str>) -> String {
    match label {
        Some(l) => js::slice_utf16(&format!("{caption}, clicked '{l}'"), 220),
        None => caption.to_string(),
    }
}

/// Globally best-first click to cue assignment.
fn assign_clicks<'a>(deixis: &[Cue], clicks: &'a [ClickCluster]) -> Vec<Option<&'a ClickCluster>> {
    let mut pairs: Vec<(usize, &ClickCluster, f64)> = Vec::new();
    for (cue_index, cue) in deixis.iter().enumerate() {
        for click in clicks {
            let delta = click.t_ms - cue.t_ms;
            if !(-FUSE_BEFORE_MS..=FUSE_AFTER_MS).contains(&delta) {
                continue;
            }
            let score = if delta >= 0.0 {
                delta
            } else {
                FUSE_AFTER_MS + delta.abs()
            };
            pairs.push((cue_index, click, score));
        }
    }
    pairs.sort_by(|a, b| cmp(a.2, b.2).then(a.0.cmp(&b.0)));
    let mut by_cue: Vec<Option<&ClickCluster>> = vec![None; deixis.len()];
    let mut taken: Vec<f64> = Vec::new();
    for (cue_index, click, _) in pairs {
        if by_cue[cue_index].is_some() || contains(&taken, click.t_ms) {
            continue;
        }
        by_cue[cue_index] = Some(click);
        taken.push(click.t_ms);
    }
    by_cue
}

struct PointerAnchor {
    x: f64,
    y: f64,
    at_ms: f64,
    dwell: Option<HoverDwell>,
}

/// 0 when `t` is inside the span, otherwise how far outside it is.
fn distance_to(t: f64, start: f64, end: f64) -> f64 {
    if t < start {
        start - t
    } else if t > end {
        t - end
    } else {
        0.0
    }
}

fn resolve_pointer_anchor(
    t_ms: f64,
    moves: &[Point],
    hovers: &[HoverDwell],
    normalize_at: &dyn Fn(f64, f64, f64) -> Option<(f64, f64)>,
) -> Option<PointerAnchor> {
    let window_start = t_ms - FUSE_BEFORE_MS;
    let window_end = t_ms + FUSE_AFTER_MS;
    let mut best: Option<&HoverDwell> = None;
    let mut best_distance = f64::INFINITY;
    for dwell in hovers {
        if dwell.end_ms < window_start || dwell.start_ms > window_end {
            continue;
        }
        let d = distance_to(t_ms, dwell.start_ms, dwell.end_ms);
        if d < best_distance {
            best = Some(dwell);
            best_distance = d;
        }
    }
    if let Some(dwell) = best {
        let at_ms = dwell.end_ms;
        if let Some((x, y)) = normalize_at(dwell.x, dwell.y, at_ms) {
            return Some(PointerAnchor {
                x,
                y,
                at_ms,
                dwell: Some(*dwell),
            });
        }
    }
    // No dwell: a raw sample only when the pointer was parked.
    let (sx, sy) = cursor_position_at(moves, t_ms, FALLBACK_MAX_SAMPLE_GAP_MS)?;
    if cursor_speed_at(moves, t_ms).is_some_and(|speed| speed > MID_FLIGHT_MAX_SPEED_PX_S) {
        return None;
    }
    let (x, y) = normalize_at(sx, sy, t_ms)?;
    Some(PointerAnchor {
        x,
        y,
        at_ms: t_ms,
        dwell: None,
    })
}

/// Strokes grouped into one drawing, anchored at their bounding-box centre.
struct Drawing {
    start_ms: f64,
    end_ms: f64,
    x: f64,
    y: f64,
}

fn group_drawings(strokes: &[PenStroke]) -> Vec<Drawing> {
    let mut ordered: Vec<&PenStroke> = strokes.iter().collect();
    ordered.sort_by(|a, b| cmp(a.start_ms, b.start_ms));
    let mut groups: Vec<Vec<&PenStroke>> = Vec::new();
    for stroke in ordered {
        if let Some(current) = groups.last_mut() {
            if let Some(previous) = current.last() {
                if stroke.start_ms - previous.end_ms <= DRAW_CLUSTER_GAP_MS {
                    current.push(stroke);
                    continue;
                }
            }
        }
        groups.push(vec![stroke]);
    }
    groups
        .into_iter()
        .filter_map(|group| {
            let points: Vec<(f64, f64)> = group
                .iter()
                .flat_map(|s| s.points.iter().copied())
                .collect();
            if points.is_empty() {
                return None;
            }
            let min =
                |f: fn(&(f64, f64)) -> f64| points.iter().map(f).fold(f64::INFINITY, f64::min);
            let max =
                |f: fn(&(f64, f64)) -> f64| points.iter().map(f).fold(f64::NEG_INFINITY, f64::max);
            let cx = (min(|p| p.0) + max(|p| p.0)) / 2.0;
            let cy = (min(|p| p.1) + max(|p| p.1)) / 2.0;
            Some(Drawing {
                start_ms: group
                    .iter()
                    .map(|s| s.start_ms)
                    .fold(f64::INFINITY, f64::min),
                end_ms: group
                    .iter()
                    .map(|s| s.end_ms)
                    .fold(f64::NEG_INFINITY, f64::max),
                x: js::fixed_number(cx, 4),
                y: js::fixed_number(cy, 4),
            })
        })
        .collect()
}

/// What the speaker said within 8 s of `t_ms`.
fn narration_around(segments: &[(f64, f64, String)], t_ms: f64) -> String {
    let window = 8_000.0;
    let parts: Vec<&str> = segments
        .iter()
        .filter(|(start, end, _)| start * 1000.0 <= t_ms + window && end * 1000.0 >= t_ms - window)
        .map(|(_, _, text)| js::trim(text))
        .collect();
    js::trim(&parts.join(" ")).to_string()
}

fn saying_suffix(narration: &str) -> String {
    if narration.is_empty() {
        return " (no narration at this moment)".into();
    }
    let ellipsis = if js::utf16_len(narration) > 110 {
        "\u{2026}"
    } else {
        ""
    };
    format!(
        ", while saying: \"{}{ellipsis}\"",
        js::slice_utf16(narration, 110)
    )
}

fn flare_position(moves: &[Point], at_ms: f64) -> Option<(f64, f64)> {
    cursor_position_at(moves, at_ms, FLARE_SAMPLE_MAX_GAP_MS)
        .or_else(|| cursor_position_before(moves, at_ms))
}

pub(crate) fn fuse(input: &FuseInput) -> Vec<FusedMoment> {
    let FuseInput {
        deixis,
        clicks,
        moves,
        hovers,
        segments,
        duration_ms,
        normalize_at,
        ..
    } = *input;
    let click_by_cue = assign_clicks(deixis, clicks);
    let used_clicks: Vec<f64> = click_by_cue.iter().flatten().map(|c| c.t_ms).collect();
    let mut used_dwells: Vec<f64> = Vec::new();
    let annotations = group_drawings(input.strokes);
    let mut used_annotations: Vec<f64> = Vec::new();
    let flares = input.flares;
    let mut used_flares: Vec<f64> = Vec::new();

    let flare_anchor_for = |t_ms: f64| -> Option<(Span, f64, f64, f64)> {
        let mut best: Option<&Span> = None;
        let mut best_distance = f64::INFINITY;
        for flare in flares {
            if flare.end_ms < t_ms - FUSE_BEFORE_MS || flare.start_ms > t_ms + FUSE_AFTER_MS {
                continue;
            }
            let d = distance_to(t_ms, flare.start_ms, flare.end_ms);
            if d < best_distance {
                best = Some(flare);
                best_distance = d;
            }
        }
        let best = best?;
        let at_ms = best.start_ms.max(best.end_ms - FLARE_TRAIL_LEAD_MS);
        let (px, py) = flare_position(moves, at_ms)?;
        let (x, y) = normalize_at(px, py, at_ms)?;
        Some((*best, at_ms, x, y))
    };

    let annotation_for = |t_ms: f64| -> Option<&Drawing> {
        let mut best: Option<&Drawing> = None;
        let mut best_distance = f64::INFINITY;
        for a in &annotations {
            if a.end_ms < t_ms - FUSE_BEFORE_MS || a.start_ms > t_ms + FUSE_AFTER_MS {
                continue;
            }
            let d = distance_to(t_ms, a.start_ms, a.end_ms);
            if d < best_distance {
                best = Some(a);
                best_distance = d;
            }
        }
        best
    };

    let mut moments: Vec<FusedMoment> = Vec::new();
    for (index, cue) in deixis.iter().enumerate() {
        if let Some(click) = click_by_cue[index] {
            let norm = normalize_at(click.x, click.y, click.t_ms);
            moments.push(FusedMoment {
                t_ms: cue.t_ms,
                source: FusedSource::Fused,
                caption: with_clicked_label(&cue.caption, click.label.as_deref()),
                x: norm.map(|n| n.0),
                y: norm.map(|n| n.1),
                frame_at_ms: click.t_ms,
            });
            continue;
        }
        if let Some((flare, at_ms, x, y)) = flare_anchor_for(cue.t_ms) {
            used_flares.push(flare.start_ms);
            moments.push(FusedMoment {
                t_ms: cue.t_ms,
                source: FusedSource::Flare,
                caption: cue.caption.clone(),
                x: Some(x),
                y: Some(y),
                frame_at_ms: at_ms.min(duration_ms),
            });
            continue;
        }
        if let Some(drawn) = annotation_for(cue.t_ms) {
            used_annotations.push(drawn.start_ms);
            moments.push(FusedMoment {
                t_ms: cue.t_ms,
                source: FusedSource::Draw,
                caption: cue.caption.clone(),
                x: Some(drawn.x),
                y: Some(drawn.y),
                frame_at_ms: drawn.end_ms.min(duration_ms),
            });
            continue;
        }
        let anchor = resolve_pointer_anchor(cue.t_ms, moves, hovers, normalize_at);
        if let Some(dwell) = anchor.as_ref().and_then(|a| a.dwell) {
            used_dwells.push(dwell.start_ms);
        }
        moments.push(FusedMoment {
            t_ms: cue.t_ms,
            source: if anchor.is_some() {
                FusedSource::Hover
            } else {
                FusedSource::Deixis
            },
            caption: cue.caption.clone(),
            x: anchor.as_ref().map(|a| a.x),
            y: anchor.as_ref().map(|a| a.y),
            frame_at_ms: anchor.as_ref().map_or(cue.t_ms, |a| a.at_ms),
        });
    }

    let covered = |moments: &[FusedMoment], t_ms: f64| {
        moments
            .iter()
            .any(|m| (m.t_ms - t_ms).abs() < INTERACTION_DEDUPE_MS)
    };
    let is_annotation =
        |m: &FusedMoment| matches!(m.source, FusedSource::Flare | FusedSource::Draw);
    let remaining = |moments: &[FusedMoment]| {
        input
            .max_moments
            .saturating_sub(moments.iter().filter(|m| !is_annotation(m)).count())
    };
    let budget_for = |moments: &[FusedMoment], cap: usize| cap.min(remaining(moments));

    let annotation_ceiling = ANNOTATION_MOMENTS_CEILING.min(input.max_annotation_moments);
    let flare_budget = MAX_STANDALONE_FLARES.min(annotation_ceiling);
    let mut standalone_flares: Vec<&Span> = flares
        .iter()
        .filter(|f| !contains(&used_flares, f.start_ms))
        .filter(|f| !covered(&moments, f.start_ms))
        .filter(|f| f.end_ms - f.start_ms >= STANDALONE_FLARE_MIN_MS)
        .collect();
    standalone_flares.sort_by(|a, b| {
        cmp(b.end_ms - b.start_ms, a.end_ms - a.start_ms).then(cmp(a.start_ms, b.start_ms))
    });
    standalone_flares.truncate(flare_budget);
    for flare in standalone_flares {
        let at_ms = flare
            .start_ms
            .max(flare.end_ms - FLARE_TRAIL_LEAD_MS)
            .min(duration_ms);
        let Some((px, py)) = flare_position(moves, at_ms) else {
            continue;
        };
        let Some((x, y)) = normalize_at(px, py, at_ms) else {
            continue;
        };
        let secs = js::to_fixed((flare.end_ms - flare.start_ms) / 1000.0, 1);
        let saying = saying_suffix(&narration_around(segments, flare.start_ms));
        moments.push(FusedMoment {
            t_ms: js::round(flare.start_ms),
            source: FusedSource::Flare,
            caption: js::slice_utf16(
                &format!("Highlights this spot with Flare for {secs}s{saying}"),
                220,
            ),
            x: Some(x),
            y: Some(y),
            frame_at_ms: js::round(at_ms),
        });
    }

    let draw_budget = annotation_ceiling.saturating_sub(
        moments
            .iter()
            .filter(|m| m.source == FusedSource::Flare)
            .count(),
    );
    let standalone_draws: Vec<&Drawing> = annotations
        .iter()
        .filter(|a| !contains(&used_annotations, a.start_ms))
        .filter(|a| !covered(&moments, a.start_ms))
        .take(draw_budget)
        .collect();
    for drawing in standalone_draws {
        let saying = saying_suffix(&narration_around(segments, drawing.start_ms));
        moments.push(FusedMoment {
            t_ms: drawing.start_ms,
            source: FusedSource::Draw,
            caption: js::slice_utf16(&format!("Draws over this area{saying}"), 220),
            x: Some(drawing.x),
            y: Some(drawing.y),
            frame_at_ms: drawing.end_ms.min(duration_ms),
        });
    }

    let click_budget = budget_for(&moments, MAX_STANDALONE_CLICKS);
    let mut standalone_clicks: Vec<&ClickCluster> = clicks
        .iter()
        .filter(|c| !contains(&used_clicks, c.t_ms))
        .collect();
    standalone_clicks.sort_by(|a, b| b.count.cmp(&a.count).then(cmp(a.t_ms, b.t_ms)));
    standalone_clicks.truncate(click_budget);
    for click in standalone_clicks {
        let Some((x, y)) = normalize_at(click.x, click.y, click.t_ms) else {
            continue;
        };
        let target = click
            .label
            .as_ref()
            .map_or_else(|| "here".to_string(), |l| format!("'{l}'"));
        let saying = saying_suffix(&narration_around(segments, click.t_ms));
        let caption = if click.count >= 2 {
            format!("Clicks {target} {} times{saying}", click.count)
        } else {
            format!("Clicks {target}{saying}")
        };
        moments.push(FusedMoment {
            t_ms: click.t_ms,
            source: FusedSource::Click,
            caption: js::slice_utf16(&caption, 220),
            x: Some(x),
            y: Some(y),
            frame_at_ms: click.t_ms,
        });
    }

    let hover_budget = budget_for(&moments, MAX_STANDALONE_HOVERS);
    let mut standalone_hovers: Vec<&HoverDwell> = hovers
        .iter()
        .filter(|d| !contains(&used_dwells, d.start_ms))
        .filter(|d| d.end_ms - d.start_ms >= STANDALONE_HOVER_MIN_MS)
        .filter(|d| {
            !covered(&moments, d.start_ms)
                && !moments.iter().any(|m| {
                    m.t_ms >= d.start_ms - INTERACTION_DEDUPE_MS
                        && m.t_ms <= d.end_ms + INTERACTION_DEDUPE_MS
                })
        })
        .collect();
    standalone_hovers.sort_by(|a, b| {
        cmp(b.end_ms - b.start_ms, a.end_ms - a.start_ms).then(cmp(a.start_ms, b.start_ms))
    });
    standalone_hovers.truncate(hover_budget);
    for dwell in standalone_hovers {
        let at_ms = dwell.end_ms.min(duration_ms);
        let Some((x, y)) = normalize_at(dwell.x, dwell.y, at_ms) else {
            continue;
        };
        let secs = js::to_fixed((dwell.end_ms - dwell.start_ms) / 1000.0, 1);
        let saying = saying_suffix(&narration_around(segments, dwell.start_ms));
        moments.push(FusedMoment {
            t_ms: dwell.start_ms,
            source: FusedSource::Hover,
            caption: js::slice_utf16(&format!("Rests the pointer here for {secs}s{saying}"), 220),
            x: Some(x),
            y: Some(y),
            frame_at_ms: at_ms,
        });
    }

    for m in &mut moments {
        m.t_ms = js::round(m.t_ms);
        m.frame_at_ms = js::round(m.frame_at_ms);
    }
    moments.sort_by(|a, b| cmp(a.t_ms, b.t_ms));
    moments
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(t_ms: f64) -> Cue {
        Cue {
            t_ms,
            caption: format!("cue at {t_ms}"),
        }
    }

    fn click(t_ms: f64) -> ClickCluster {
        ClickCluster {
            t_ms,
            x: 0.0,
            y: 0.0,
            count: 1,
            label: None,
        }
    }

    fn stroke(start_ms: f64, end_ms: f64, points: &[(f64, f64)]) -> PenStroke {
        PenStroke {
            start_ms,
            end_ms,
            points: points.to_vec(),
        }
    }

    fn segment(start_s: f64, end_s: f64, text: &str) -> (f64, f64, String) {
        (start_s, end_s, text.to_string())
    }

    /// The click time each cue was given, in cue order.
    fn assigned(deixis: &[Cue], clicks: &[ClickCluster]) -> Vec<Option<f64>> {
        assign_clicks(deixis, clicks)
            .into_iter()
            .map(|c| c.map(|c| c.t_ms))
            .collect()
    }

    // assign_clicks

    #[test]
    fn closer_cue_wins_a_contested_click() {
        // Both cues are within reach of the click; the second is 500 ms from
        // it, the first 2 s, so the second takes it and the first gets none.
        let deixis = [cue(1_000.0), cue(2_500.0)];
        assert_eq!(assigned(&deixis, &[click(3_000.0)]), [None, Some(3_000.0)]);
    }

    #[test]
    fn losing_cue_falls_back_to_its_next_best_click() {
        let deixis = [cue(0.0), cue(1_000.0)];
        let clicks = [click(1_000.0), click(3_000.0)];
        assert_eq!(assigned(&deixis, &clicks), [Some(3_000.0), Some(1_000.0)]);
    }

    #[test]
    fn equal_scores_go_to_the_earlier_cue() {
        let deixis = [cue(1_000.0), cue(1_000.0)];
        assert_eq!(assigned(&deixis, &[click(2_000.0)]), [Some(2_000.0), None]);
    }

    #[test]
    fn a_click_after_the_cue_beats_a_nearer_one_before_it() {
        // Clicks before a cue score 5 s plus their distance, so one 1 ms early
        // loses to one 4 s late.
        let deixis = [cue(10_000.0)];
        let clicks = [click(9_999.0), click(14_000.0)];
        assert_eq!(assigned(&deixis, &clicks), [Some(14_000.0)]);
    }

    #[test]
    fn a_click_before_the_cue_still_fuses_when_it_is_the_only_one() {
        assert_eq!(
            assigned(&[cue(10_000.0)], &[click(8_000.0)]),
            [Some(8_000.0)]
        );
    }

    #[test]
    fn the_fuse_window_includes_its_edges() {
        let deixis = [cue(10_000.0)];
        assert_eq!(
            assigned(&deixis, &[click(10_000.0 - FUSE_BEFORE_MS)]),
            [Some(7_000.0)]
        );
        assert_eq!(
            assigned(&deixis, &[click(10_000.0 + FUSE_AFTER_MS)]),
            [Some(15_000.0)]
        );
    }

    #[test]
    fn a_click_outside_every_cue_window_is_not_assigned() {
        let deixis = [cue(10_000.0), cue(20_000.0)];
        let clicks = [click(6_999.0), click(15_001.0), click(25_001.0)];
        assert_eq!(assigned(&deixis, &clicks), [None, None]);
    }

    #[test]
    fn no_cues_or_no_clicks_assign_nothing() {
        assert!(assign_clicks(&[], &[click(1_000.0)]).is_empty());
        assert_eq!(assigned(&[cue(1_000.0)], &[]), [None]);
    }

    // narration_around

    #[test]
    fn narration_is_empty_when_no_segment_is_near() {
        let segments = [segment(0.0, 2.0, "early"), segment(40.0, 42.0, "late")];
        assert_eq!(narration_around(&segments, 20_000.0), "");
        assert_eq!(narration_around(&[], 20_000.0), "");
    }

    #[test]
    fn narration_window_is_eight_seconds_each_side_inclusive() {
        // Segment times are in seconds, the moment in milliseconds.
        let segments = [
            segment(1.0, 2.0, "ends 8 s before"),
            segment(1.0, 1.999, "ends just past 8 s before"),
            segment(18.0, 19.0, "starts 8 s after"),
            segment(18.001, 19.0, "starts just past 8 s after"),
        ];
        assert_eq!(
            narration_around(&segments, 10_000.0),
            "ends 8 s before starts 8 s after"
        );
    }

    #[test]
    fn narration_joins_trimmed_segments_in_order() {
        let segments = [
            segment(9.0, 10.0, "  first part "),
            segment(10.0, 11.0, "\tsecond part\n"),
        ];
        assert_eq!(
            narration_around(&segments, 10_000.0),
            "first part second part"
        );
    }

    #[test]
    fn narration_includes_a_segment_spanning_the_whole_window() {
        let segments = [segment(0.0, 60.0, "a long monologue")];
        assert_eq!(narration_around(&segments, 30_000.0), "a long monologue");
    }

    // group_drawings

    #[test]
    fn strokes_far_apart_stay_separate_drawings() {
        let strokes = [
            stroke(0.0, 1_000.0, &[(0.1, 0.1), (0.3, 0.3)]),
            stroke(1_000.0 + DRAW_CLUSTER_GAP_MS + 1.0, 4_000.0, &[(0.7, 0.7)]),
        ];
        let drawings = group_drawings(&strokes);
        assert_eq!(drawings.len(), 2);
        assert_eq!((drawings[0].start_ms, drawings[0].end_ms), (0.0, 1_000.0));
        assert_eq!((drawings[0].x, drawings[0].y), (0.2, 0.2));
        assert_eq!((drawings[1].x, drawings[1].y), (0.7, 0.7));
    }

    #[test]
    fn strokes_within_the_gap_form_one_drawing() {
        // Unsorted on purpose: grouping runs in start order.
        let strokes = [
            stroke(1_000.0 + DRAW_CLUSTER_GAP_MS, 4_000.0, &[(0.9, 0.5)]),
            stroke(0.0, 1_000.0, &[(0.1, 0.2), (0.3, 0.1)]),
        ];
        let drawings = group_drawings(&strokes);
        assert_eq!(drawings.len(), 1);
        let d = &drawings[0];
        assert_eq!((d.start_ms, d.end_ms), (0.0, 4_000.0));
        // Centre of the bounding box over every point in the group.
        assert_eq!((d.x, d.y), (0.5, 0.3));
    }

    #[test]
    fn strokes_are_grouped_in_start_order_not_input_order() {
        let strokes = [
            stroke(0.0, 1_000.0, &[(0.1, 0.1)]),
            stroke(10_000.0, 11_000.0, &[(0.9, 0.9)]),
            stroke(2_000.0, 3_000.0, &[(0.3, 0.3)]),
        ];
        let spans: Vec<(f64, f64)> = group_drawings(&strokes)
            .iter()
            .map(|d| (d.start_ms, d.end_ms))
            .collect();
        assert_eq!(spans, [(0.0, 3_000.0), (10_000.0, 11_000.0)]);
    }

    #[test]
    fn drawing_centres_are_rounded_to_four_places() {
        let strokes = [stroke(0.0, 100.0, &[(0.0, 0.0), (0.123456, 0.987654)])];
        let d = &group_drawings(&strokes)[0];
        assert_eq!((d.x, d.y), (0.0617, 0.4938));
    }

    #[test]
    fn a_drawing_without_points_is_dropped() {
        let strokes = [
            stroke(0.0, 100.0, &[]),
            stroke(10_000.0, 10_100.0, &[]),
            stroke(10_200.0, 10_300.0, &[(0.4, 0.6)]),
        ];
        let drawings = group_drawings(&strokes);
        assert_eq!(drawings.len(), 1);
        assert_eq!(drawings[0].start_ms, 10_000.0);
        assert_eq!((drawings[0].x, drawings[0].y), (0.4, 0.6));
        assert!(group_drawings(&[]).is_empty());
    }

    // with_clicked_label

    #[test]
    fn a_click_label_is_appended_to_the_caption() {
        assert_eq!(
            with_clicked_label("Opens the menu", Some("Save")),
            "Opens the menu, clicked 'Save'"
        );
    }

    #[test]
    fn no_label_leaves_the_caption_unchanged() {
        assert_eq!(with_clicked_label("Opens the menu", None), "Opens the menu");
    }

    #[test]
    fn labelled_captions_are_cut_at_220_utf16_units() {
        let caption = "a".repeat(200);
        let out = with_clicked_label(&caption, Some("Save changes"));
        assert_eq!(js::utf16_len(&out), 220);
        assert!(out.ends_with(", clicked 'Save chan"));

        // An emoji counts as two units, as it does in JavaScript.
        let caption = "\u{1F600}".repeat(100);
        let out = with_clicked_label(&caption, Some("Save changes"));
        assert_eq!(js::utf16_len(&out), 220);
        assert!(out.ends_with(", clicked 'Save chan"));
    }
}
