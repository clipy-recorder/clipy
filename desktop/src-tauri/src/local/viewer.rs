//! The AREC viewer: a document-sized window that shows a local recording
//! (video, moments, transcript) straight from its folder. Opened from the
//! panel, from a `clipy://local/<id>` link, or by opening the `.arec` file.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentDto {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDto {
    timestamp_ms: u64,
    frame_time_ms: u64,
    reason: String,
    path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRecordingDto {
    id: String,
    directory: PathBuf,
    video_path: PathBuf,
    arec_path: PathBuf,
    duration_ms: u64,
    recorded_at_ms: u64,
    stage: String,
    message: String,
    segments: Vec<TranscriptSegmentDto>,
    frames: Vec<FrameDto>,
    click_count: usize,
}

fn read_json(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

pub fn read<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<LocalRecordingDto> {
    let dir = super::directory(app, id)?;
    let status = read_json(&dir.join("status.json"));
    if status.is_null() {
        bail!("Recording not found");
    }
    let metadata = read_json(&dir.join("metadata.json"));
    let transcript = read_json(&dir.join("transcript.json"));
    let interactions = read_json(&dir.join("recording.cursor.json"));
    let segments = transcript["segments"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| TranscriptSegmentDto {
            start_ms: s["startMs"].as_u64().unwrap_or(0),
            end_ms: s["endMs"].as_u64().unwrap_or(0),
            text: s["text"].as_str().unwrap_or("").to_string(),
        })
        .collect();
    let frames = read_json(&dir.join("frames.json"))
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let requested = f["timestampMs"].as_u64()?;
            Some(FrameDto {
                timestamp_ms: requested,
                frame_time_ms: f["frameTimeMs"].as_f64().unwrap_or(requested as f64).round() as u64,
                reason: f["reason"].as_str().unwrap_or("").to_string(),
                path: dir.join(f["frame"].as_str()?),
            })
        })
        .collect();
    let click_count = interactions["events"]
        .as_array()
        .map(|events| events.iter().filter(|e| e["kind"] == "down").count())
        .unwrap_or(0);
    Ok(LocalRecordingDto {
        id: id.to_string(),
        video_path: dir.join("recording.mp4"),
        arec_path: dir.join("recording.arec"),
        directory: dir,
        duration_ms: metadata["duration_ms"].as_u64().unwrap_or(0),
        recorded_at_ms: status["updated_at_ms"].as_u64().unwrap_or(0),
        stage: status["stage"].as_str().unwrap_or("").to_string(),
        message: status["message"].as_str().unwrap_or("").to_string(),
        segments,
        frames,
        click_count,
    })
}

pub fn show<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<()> {
    open_window(app, id, false)
}

/// Opened by the app itself when processing finished, rather than by the
/// user. The viewer offers to stop doing that only on this path — the same
/// strip on a window the user asked for would be offering to turn off
/// something they did not experience.
pub fn show_automatically<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<()> {
    open_window(app, id, true)
}

fn open_window<R: Runtime>(app: &AppHandle<R>, id: &str, automatic: bool) -> Result<()> {
    // Validates the id and confirms the folder exists before a window opens.
    read(app, id)?;
    let label = format!("viewer-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show()?;
        window.unminimize().ok();
        window.set_focus()?;
        return Ok(());
    }
    let auto = if automatic { "&auto=1" } else { "" };
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html#viewer?id={id}{auto}").into()),
    )
    .title(crate::i18n::t("windowTitles.localRecording"))
    .inner_size(1200.0, 780.0)
    .min_inner_size(900.0, 600.0)
    .center()
    .build()
    .context("open viewer window")?;
    window.set_focus().ok();
    Ok(())
}

/// A path handed over by Finder: the `.arec` itself, any file in the
/// recording folder, or the folder. Anything outside the recordings root is
/// refused, so an arbitrary dropped file can never open a window.
pub fn show_path<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<()> {
    let root = super::root(app)?.canonicalize().context("recordings folder")?;
    let path = path.canonicalize().context("recording path")?;
    let dir = if path.is_dir() { path.clone() } else { path.parent().context("recording folder")?.to_path_buf() };
    if dir.parent() != Some(root.as_path()) {
        bail!("Not a Clipy recording: {}", path.display());
    }
    let id = dir
        .file_name()
        .and_then(|name| name.to_str())
        .context("recording id")?;
    show(app, id)
}

#[tauri::command]
pub fn read_local_recording(app: AppHandle, id: String) -> Result<LocalRecordingDto, String> {
    read(&app, &id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn show_local_viewer(app: AppHandle, id: String) -> Result<(), String> {
    show(&app, &id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn reveal_local_recording_file(path: PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        // Explorer reports its own exit code inconsistently, so only the
        // spawn is checked.
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = path;
        Err("Local mode is available on macOS and Windows only".into())
    }
}
