//! Tauri commands exposed to the React UI.
//! Keep 1:1 with `desktop/src/lib/bridge.ts`.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_store::StoreExt;

use crate::auth::AuthState;
use crate::recording::RecordingController;
use crate::types::{
    AreaSelectPurposeDto, AudioDeviceDto, AudioOptionsDto, CaptureSourceDto, CaptureSourceMetadataDto, CaptureSourcesDto,
    MicSignalCheckDto, RecordingId, RecordingMetadata, RecordingSettingsDto, RecordingStateDto,
    CursorPositionDto, SourceHighlightRectDto,
    StudioRecordingDto,
    VideoOptionsDto, WebcamCaptureDto, WebcamDeviceDto, WebcamLayoutDto, WebcamShapeDto,
    WebcamSizeDto, WindowInfoDto, DEFAULT_COUNTDOWN_SECONDS, EVENT_MIC_CHECK_LEVEL,
    EVENT_AREA_SELECT_PURPOSE, EVENT_STUDIO_RECORDING_UPDATED, EVENT_WEBCAM_LAYOUT_CHANGED,
    EVENT_WEBCAM_START,
    EVENT_WEBCAM_STOP,
};

static CURSOR_TRAIL_ENABLED: AtomicBool = AtomicBool::new(false);

pub(crate) fn run_on_main_thread_result<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    label: &'static str,
    callback: impl FnOnce(AppHandle<R>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let app_for_callback = app.clone();

    app.run_on_main_thread(move || {
        let _ = tx.send(callback(app_for_callback));
    })
    .map_err(|e| format!("{label} main-thread dispatch failed: {e}"))?;

    rx.recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| format!("{label} main-thread response failed: {e}"))?
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct WebcamWindowFrame {
    x: f64,
    y: f64,
}

static WEBCAM_WINDOW_FRAMES: OnceLock<
    parking_lot::Mutex<HashMap<WebcamLayoutDto, WebcamWindowFrame>>,
> = OnceLock::new();
static WEBCAM_ACTIVE_LAYOUT: OnceLock<parking_lot::Mutex<WebcamLayoutDto>> = OnceLock::new();
static WEBCAM_ACTIVE_SHAPE: OnceLock<parking_lot::Mutex<WebcamShapeDto>> = OnceLock::new();
static WEBCAM_ACTIVE_SIZE: OnceLock<parking_lot::Mutex<WebcamSizeDto>> = OnceLock::new();
static WEBCAM_ACTIVE_RECT: OnceLock<parking_lot::Mutex<Option<SourceHighlightRectDto>>> = OnceLock::new();
static WEBCAM_REQUESTED_DEVICE_ID: OnceLock<parking_lot::Mutex<Option<Option<String>>>> =
    OnceLock::new();
static CURSOR_TRAIL_SESSION: OnceLock<parking_lot::Mutex<Option<CursorTrailSession>>> =
    OnceLock::new();

struct CursorTrailSession {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

fn webcam_window_frames() -> &'static parking_lot::Mutex<HashMap<WebcamLayoutDto, WebcamWindowFrame>>
{
    WEBCAM_WINDOW_FRAMES.get_or_init(|| parking_lot::Mutex::new(HashMap::new()))
}

/// Layouts whose remembered frame came back from disk and has not been
/// applied yet. Anchoring re-centres a frame around the PREVIOUS window box
/// when the size changes, which is right for a live resize but wrong for a
/// restored point: at launch the "previous" box is the fresh window's
/// default size, so the saved spot would shift on every start.
static WEBCAM_RESTORED_LAYOUTS: OnceLock<parking_lot::Mutex<std::collections::HashSet<WebcamLayoutDto>>> =
    OnceLock::new();

fn webcam_restored_layouts() -> &'static parking_lot::Mutex<std::collections::HashSet<WebcamLayoutDto>> {
    WEBCAM_RESTORED_LAYOUTS.get_or_init(|| parking_lot::Mutex::new(std::collections::HashSet::new()))
}

fn webcam_active_layout() -> &'static parking_lot::Mutex<WebcamLayoutDto> {
    WEBCAM_ACTIVE_LAYOUT.get_or_init(|| parking_lot::Mutex::new(WebcamLayoutDto::Bubble))
}

fn webcam_active_shape() -> &'static parking_lot::Mutex<WebcamShapeDto> {
    WEBCAM_ACTIVE_SHAPE.get_or_init(|| parking_lot::Mutex::new(WebcamShapeDto::Square))
}

fn webcam_active_size() -> &'static parking_lot::Mutex<WebcamSizeDto> {
    WEBCAM_ACTIVE_SIZE.get_or_init(|| parking_lot::Mutex::new(WebcamSizeDto::default()))
}

fn webcam_requested_device_id() -> &'static parking_lot::Mutex<Option<Option<String>>> {
    WEBCAM_REQUESTED_DEVICE_ID.get_or_init(|| parking_lot::Mutex::new(None))
}

fn cursor_trail_session() -> &'static parking_lot::Mutex<Option<CursorTrailSession>> {
    CURSOR_TRAIL_SESSION.get_or_init(|| parking_lot::Mutex::new(None))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcamBubbleStateDto {
    active: bool,
    device_id: Option<String>,
    native: bool,
    camera_only: bool,
    /// False while a window-only recording runs: the bubble is its own
    /// window and cannot appear in that video, so the dock disables it.
    recordable: bool,
    layout: WebcamLayoutDto,
    shape: WebcamShapeDto,
    size: WebcamSizeDto,
    mirrored: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebcamAppearanceDto {
    layout: WebcamLayoutDto,
    shape: WebcamShapeDto,
    size: WebcamSizeDto,
    mirrored: bool,
}

pub(crate) fn remember_webcam_window_frame<R: tauri::Runtime>(window: &tauri::Window<R>) {
    if window.label() != "webcam" {
        return;
    }
    // Off means every show lands on the default spot, so there is nothing
    // to remember even within the session.
    if !persist_webcam_position_enabled(window.app_handle()) {
        return;
    }

    let Ok(position) = window.outer_position() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    if scale <= 0.0 {
        return;
    }

    let layout = *webcam_active_layout().lock();
    webcam_window_frames().lock().insert(
        layout,
        WebcamWindowFrame {
            x: position.x as f64 / scale,
            y: position.y as f64 / scale,
        },
    );
    save_webcam_window_frames_debounced(window.app_handle());
}

fn validate_recording_id(recording_id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(recording_id)
        .map(|_| ())
        .map_err(|_| "invalid recording_id".to_string())
}

fn camera_sidecar_path_for(file_path: &std::path::Path) -> Option<std::path::PathBuf> {
    ["webm", "mp4"]
        .iter()
        .map(|ext| file_path.with_extension(format!("camera.{ext}")))
        .find(|path| path.exists())
}

fn project_image_background_path(project: &serde_json::Value) -> Option<std::path::PathBuf> {
    let background = project.pointer("/style/background")?.as_object()?;
    let kind = background.get("kind")?.as_str()?;
    if kind != "image" {
        return None;
    }
    let path = background.get("path")?.as_str()?.trim();
    if path.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(path))
}

fn set_project_image_background_path(
    project: &mut serde_json::Value,
    path: String,
) -> Result<(), String> {
    let background = project
        .pointer_mut("/style/background")
        .and_then(|value| value.as_object_mut())
        .ok_or_else(|| "Invalid image background project shape".to_string())?;
    background.insert("path".to_string(), serde_json::Value::String(path));
    Ok(())
}

fn image_mime_for_path(path: &std::path::Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn read_json_if_exists(path: &std::path::Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn refresh_studio_recording_sidecars(recording: &mut StudioRecordingDto) {
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
}

#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum PermissionStatusDto {
    Granted,
    Denied,
    NotDetermined,
    NotNeeded,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPermissionsDto {
    pub screen_recording: PermissionStatusDto,
    pub accessibility: PermissionStatusDto,
    pub microphone: PermissionStatusDto,
    pub camera: PermissionStatusDto,
    pub ready: bool,
}

fn required_permissions_ready(
    screen_recording: PermissionStatusDto,
    accessibility: PermissionStatusDto,
) -> bool {
    matches!(
        (screen_recording, accessibility),
        (
            PermissionStatusDto::Granted | PermissionStatusDto::NotNeeded,
            PermissionStatusDto::Granted | PermissionStatusDto::NotNeeded
        )
    )
}

#[cfg(target_os = "macos")]
fn av_permission_status(media_type: &cidre::av::MediaType) -> Result<PermissionStatusDto, String> {
    use cidre::av;

    let status = av::CaptureDevice::authorization_status_for_media_type(media_type)
        .map_err(|e| format!("media permission check failed: {e}"))?;
    Ok(match status {
        av::AuthorizationStatus::Authorized => PermissionStatusDto::Granted,
        av::AuthorizationStatus::NotDetermined => PermissionStatusDto::NotDetermined,
        av::AuthorizationStatus::Denied | av::AuthorizationStatus::Restricted => {
            PermissionStatusDto::Denied
        }
    })
}

#[tauri::command]
pub fn check_desktop_permissions() -> Result<DesktopPermissionsDto, String> {
    #[cfg(target_os = "macos")]
    {
        use cidre::{av, ax};

        let screen_recording = if scap_screencapturekit::has_permission() {
            PermissionStatusDto::Granted
        } else {
            PermissionStatusDto::NotDetermined
        };
        let accessibility = if ax::is_process_trusted() {
            PermissionStatusDto::Granted
        } else {
            PermissionStatusDto::NotDetermined
        };
        let microphone = av_permission_status(av::MediaType::audio())?;
        let camera = av_permission_status(av::MediaType::video())?;
        Ok(DesktopPermissionsDto {
            screen_recording,
            accessibility,
            microphone,
            camera,
            ready: required_permissions_ready(screen_recording, accessibility),
        })
    }
    // Screen capture and click tracking need no grant on Windows; camera and
    // microphone have privacy switches that can block Clipy.
    #[cfg(target_os = "windows")]
    {
        use crate::windows_privacy::{status, Capability};
        Ok(DesktopPermissionsDto {
            screen_recording: PermissionStatusDto::NotNeeded,
            accessibility: PermissionStatusDto::NotNeeded,
            microphone: status(Capability::Microphone),
            camera: status(Capability::Camera),
            ready: true,
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(DesktopPermissionsDto {
            screen_recording: PermissionStatusDto::NotNeeded,
            accessibility: PermissionStatusDto::NotNeeded,
            microphone: PermissionStatusDto::NotNeeded,
            camera: PermissionStatusDto::NotNeeded,
            ready: true,
        })
    }
}

#[cfg(test)]
mod desktop_permission_tests {
    use super::{required_permissions_ready, PermissionStatusDto};

    #[test]
    fn recording_is_blocked_until_both_required_permissions_are_granted() {
        assert!(!required_permissions_ready(
            PermissionStatusDto::Granted,
            PermissionStatusDto::NotDetermined,
        ));
        assert!(!required_permissions_ready(
            PermissionStatusDto::Denied,
            PermissionStatusDto::Granted,
        ));
    }

    #[test]
    fn optional_permissions_do_not_affect_recording_readiness() {
        assert!(required_permissions_ready(
            PermissionStatusDto::Granted,
            PermissionStatusDto::Granted,
        ));
    }
}

/// Opens System Settings deep-linked to the relevant Privacy pane.
/// `pane` is one of "screen", "accessibility", "microphone", "camera". Defaults to
/// the Privacy root if unrecognised.
#[tauri::command]
pub async fn open_privacy_settings(pane: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = match pane.as_deref() {
            Some("screen") => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            Some("accessibility") => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            Some("microphone") => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            Some("camera") => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
            }
            _ => "x-apple.systempreferences:com.apple.preference.security?Privacy",
        };
        std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|e| format!("open settings failed: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use crate::windows_privacy::{open_settings, Capability};
        open_settings(pane.as_deref().and_then(Capability::from_pane))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = pane;
        Ok(())
    }
}

#[tauri::command]
pub fn relaunch_app(app: AppHandle) {
    app.request_restart();
}

/// Deep screen-capture probe. The TCC preflight can report "granted" while
/// ScreenCaptureKit itself still refuses with -3801 ("user declined TCCs") —
/// the stale-grant state after an app update or a mid-session toggle-off.
/// Preflight alone dead-ends that user: the permissions screen shows all
/// green while every capture fails. Returns whether SCK will actually serve
/// content right now.
#[tauri::command]
pub async fn probe_screen_capture(strict: Option<bool>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        // Setup passes `strict`: there a failure that is not a refusal is
        // "not confirmed", an error, never a pass.
        let strict = strict.unwrap_or(false);
        if !scap_screencapturekit::has_permission() {
            return Ok(false);
        }
        match cidre::sc::ShareableContent::current().await {
            Ok(_) => Ok(true),
            Err(err) => {
                let detail = format!("{err:?}");
                if crate::capture::macos::sck_error_is_permission_denied(&detail) {
                    tracing::warn!("screen capture probe: TCC declined (stale grant): {detail}");
                    Ok(false)
                } else if strict {
                    Err(format!("screen capture probe failed: {detail}"))
                } else {
                    // Transient SCK failure, not a permission refusal —
                    // fail open so a healthy user never sees the
                    // toggle-and-restart repair card.
                    tracing::warn!("screen capture probe failed (non-permission): {detail}");
                    Ok(true)
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = strict;
        Ok(true)
    }
}

#[tauri::command]
pub fn request_desktop_permission(permission: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use cidre::{av, ax};

        match permission.as_str() {
            "screen" => Ok(scap_screencapturekit::request_permission()),
            "accessibility" => Ok(ax::is_process_trusted_with_prompt(true)),
            "microphone" => {
                ensure_media_permission(av::MediaType::audio(), "microphone")?;
                Ok(true)
            }
            "camera" => {
                ensure_media_permission(av::MediaType::video(), "camera")?;
                Ok(true)
            }
            _ => Err(format!("unknown desktop permission: {permission}")),
        }
    }
    // Desktop apps cannot prompt on Windows: report the switch state, and the
    // setup window opens Settings when it is off.
    #[cfg(target_os = "windows")]
    {
        use crate::windows_privacy::{status, Capability};
        Ok(Capability::from_pane(&permission)
            .map_or(true, |capability| status(capability) == PermissionStatusDto::Granted))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = permission;
        Ok(true)
    }
}

#[cfg(target_os = "macos")]
fn ensure_media_permission(
    media_type: &cidre::av::MediaType,
    permission_name: &str,
) -> Result<(), String> {
    use cidre::av;

    let status = av::CaptureDevice::authorization_status_for_media_type(media_type)
        .map_err(|e| format!("{permission_name} permission check failed: {e}"))?;

    match status {
        av::AuthorizationStatus::Authorized => Ok(()),
        av::AuthorizationStatus::NotDetermined => {
            let granted = futures::executor::block_on(
                av::CaptureDevice::request_access_for_media_type(media_type),
            )
            .map_err(|e| format!("{permission_name} permission request failed: {e}"))?;
            if granted {
                Ok(())
            } else {
                Err(format!("permission_denied: {permission_name}"))
            }
        }
        av::AuthorizationStatus::Denied | av::AuthorizationStatus::Restricted => {
            Err(format!("permission_denied: {permission_name}"))
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn ensure_camera_permission() -> Result<(), String> {
    ensure_media_permission(cidre::av::MediaType::video(), "camera")
}

// Async on purpose: the first-ever camera request blocks on the system TCC
// dialog. A sync command runs on the main thread, so that block froze every
// window and the tray until the user answered — an unanswered prompt read as
// a hang that users force-quit.
#[tauri::command]
pub async fn request_camera_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(ensure_camera_permission)
            .await
            .map_err(|e| format!("camera permission task failed: {e}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

// Async on purpose: AVFoundation device discovery can stall on first use and
// must not run on the main thread (sync commands do).
#[tauri::command]
pub async fn list_webcam_devices() -> Result<Vec<WebcamDeviceDto>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        tauri::async_runtime::spawn_blocking(list_webcam_devices_impl)
            .await
            .map_err(|e| format!("webcam device listing task failed: {e}"))?
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
fn list_webcam_devices_impl() -> Result<Vec<WebcamDeviceDto>, String> {
    {
        use cidre::{api, av, ns};

        let mut device_types = vec![av::CaptureDeviceType::built_in_wide_angle_camera()];
        if api::macos_available("13.0") {
            // SAFETY: Category 8 - FFI boundary contract. The constant is only read after the macOS 13.0 availability check required by AVFoundation/cidre.
            if let Some(device_type) = unsafe { av::CaptureDeviceType::desk_view_camera() } {
                device_types.push(device_type);
            }
        }
        if api::macos_available("14.0") {
            // SAFETY: Category 8 - FFI boundary contract. The constant is only read after the macOS 14.0 availability check required by AVFoundation/cidre.
            if let Some(device_type) = unsafe { av::CaptureDeviceType::external() } {
                device_types.push(device_type);
            }
            // SAFETY: Category 8 - FFI boundary contract. The constant is only read after the macOS 14.0 availability check required by AVFoundation/cidre.
            if let Some(device_type) = unsafe { av::CaptureDeviceType::continuity_camera() } {
                device_types.push(device_type);
            }
        } else {
            device_types.push(av::CaptureDeviceType::external_unknown());
        }

        let device_types = ns::Array::from_slice(&device_types);
        let discovery = av::CaptureDeviceDiscoverySession::with_device_types_media_and_pos(
            &device_types,
            Some(av::MediaType::video()),
            av::CaptureDevicePos::Unspecified,
        );

        Ok(discovery
            .devices()
            .iter()
            .map(|device| WebcamDeviceDto {
                id: device.unique_id().to_string(),
                name: device.localized_name().to_string(),
            })
            .collect())
    }
}

#[cfg(target_os = "windows")]
fn list_webcam_devices_impl() -> Result<Vec<WebcamDeviceDto>, String> {
    use std::ptr;

    use windows::{
        core::PWSTR,
        Win32::{
            Media::MediaFoundation::{
                IMFActivate,
                MFCreateAttributes,
                MFEnumDeviceSources,
                MFStartup,
                MFShutdown,
                MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                MF_VERSION,
                MFSTARTUP_NOSOCKET,
            },
            System::Com::{
                CoInitializeEx,
                CoUninitialize,
                COINIT_MULTITHREADED,
            },
        },
    };

    // `RPC_E_CHANGED_MODE` — the thread already belongs to a COM apartment,
    // just not the one asked for.
    const RPC_E_CHANGED_MODE: i32 = 0x8001_0106u32 as i32;

    unsafe {
        // MTA then returns `RPC_E_CHANGED_MODE`, which this used to report as
        // "failed to initiate COM: HRESULT(0x80010106)" and abandon the
        // enumeration — intermittently, depending on which pooled thread we
        // landed on.
        //
        // It is not an error. COM is initialized and usable, and Media
        // Foundation device enumeration is apartment-agnostic. What it does
        // mean is that this call took NO reference, so the matching
        // `CoUninitialize` must be skipped — calling it would drop someone
        // else's reference and tear COM down under the code that set it up.
        let com = CoInitializeEx(None, COINIT_MULTITHREADED);
        let owns_com = if com.0 == RPC_E_CHANGED_MODE {
            false
        } else if com.is_err() {
            return Err(format!("failed to initialize COM: {com:?}"));
        } else {
            true
        };

        // Every exit from here on has to unwind COM, so no `?` until the
        // cleanup is in place — the old code leaked a COM reference whenever
        // `MFStartup` failed.
        let result = match MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) {
            Ok(()) => {
                let devices = enumerate_windows_webcams();
                MFShutdown().ok();
                devices
            }
            Err(e) => Err(format!("Media Foundation startup failed: {e}")),
        };

        if owns_com {
            CoUninitialize();
        }

        result
    }
}

#[cfg(target_os = "windows")]
unsafe fn enumerate_windows_webcams() -> Result<Vec<WebcamDeviceDto>, String> {
    use std::ptr;

    use windows::{
        core::PWSTR,
        Win32::Media::MediaFoundation::{
            IMFActivate,
            MFCreateAttributes,
            MFEnumDeviceSources,
            MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
        },
    };

    let mut attributes = None;

    MFCreateAttributes(&mut attributes, 2)
        .map_err(|e| format!("MFCreateAttributes failed: {e}"))?;

    let attributes = attributes
        .ok_or_else(|| "Media Foundation returned no attributes object".to_string())?;

    attributes
        .SetGUID(
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        )
        .map_err(|e| format!("failed to configure video capture enumeration: {e}"))?;

    let mut devices_ptr: *mut Option<IMFActivate> = ptr::null_mut();
    let mut device_count = 0u32;

    MFEnumDeviceSources(
        &attributes,
        &mut devices_ptr,
        &mut device_count,
    )
    .map_err(|e| format!("MFEnumDeviceSources failed: {e}"))?;

    if devices_ptr.is_null() || device_count == 0 {
        return Ok(Vec::new());
    }

    let devices = std::slice::from_raw_parts(
        devices_ptr,
        device_count as usize,
    );

    let mut result = Vec::with_capacity(device_count as usize);

    for device in devices {
        let Some(device) = device.as_ref() else {
            continue;
        };

        let name = get_activate_string(
            device,
            &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
        )?;

        let id = get_activate_string(
            device,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
        )?;

        result.push(WebcamDeviceDto {
            id,
            name,
        });
    }

    // MFEnumDeviceSources allocates this array with CoTaskMemAlloc.
    windows::Win32::System::Com::CoTaskMemFree(Some(devices_ptr.cast()));

    Ok(result)
}

#[cfg(target_os = "windows")]
unsafe fn get_activate_string(
    device: &windows::Win32::Media::MediaFoundation::IMFActivate,
    attribute: &windows::core::GUID,
) -> Result<String, String> {
    use windows::core::PWSTR;
    
    let mut value = PWSTR::null();
    let mut length = 0u32;

    device
        .GetAllocatedString(
            attribute,
            &mut value,
            &mut length,
        )
        .map_err(|e| format!("failed to read webcam attribute: {e}"))?;

    if value.is_null() {
        return Ok(String::new());
    }

    let value_string = value
        .to_string()
        .map_err(|e| format!("invalid UTF-16 webcam attribute: {e}"))?;

    windows::Win32::System::Com::CoTaskMemFree(Some(value.0.cast()));

    Ok(value_string)
}

// Async on purpose: this path can block on the camera-permission TCC dialog
// and waits up to 4s for native camera startup. As a sync command it ran on
// the main thread and froze the whole app while blocked — the reported
// "app crashes when I click the camera bubble" is that freeze force-quit.
#[tauri::command]
pub async fn show_webcam_bubble(app: AppHandle, device_id: Option<String>) -> Result<(), String> {
    if app.state::<RecordingController>().dto().phase != crate::types::RecordingPhase::Idle
        || !app
            .get_webview_window("main")
            .is_some_and(|window| window.is_visible().unwrap_or(false))
    {
        return Err("Camera preview dismissed".to_string());
    }
    let preview_request = crate::native_webcam::begin_preview_request();
    tauri::async_runtime::spawn_blocking(move || {
        show_webcam_bubble_for_request(&app, device_id, false, preview_request, true)
    })
        .await
        .map_err(|e| format!("webcam bubble task failed: {e}"))?
}

pub(crate) fn show_recording_webcam_bubble<R: Runtime>(
    app: &AppHandle<R>,
    webcam: &WebcamCaptureDto,
    rect: Option<SourceHighlightRectDto>,
    capturable: bool,
) -> Result<(), String> {
    if !webcam.enabled {
        return Ok(());
    }

    let preview_request = crate::native_webcam::begin_preview_request();
    set_webcam_layout_impl(app, webcam.layout, webcam.shape, webcam.size, rect)?;
    show_webcam_bubble_for_request(
        app,
        webcam.device_id.clone(),
        capturable,
        preview_request,
        false,
    )?;
    Ok(())
}

pub(crate) fn show_recording_webcam_bubble_for_capture_start<R: Runtime>(
    app: &AppHandle<R>,
    webcam: &WebcamCaptureDto,
    capturable: bool,
) -> Result<(), String> {
    if !webcam.enabled {
        return Ok(());
    }

    show_webcam_bubble_impl(app, webcam.device_id.clone(), capturable)?;
    Ok(())
}

pub(crate) fn show_webcam_bubble_impl<R: Runtime>(
    app: &AppHandle<R>,
    device_id: Option<String>,
    capturable: bool,
) -> Result<(), String> {
    let preview_request = crate::native_webcam::begin_preview_request();
    show_webcam_bubble_for_request(app, device_id, capturable, preview_request, false)
}

fn show_webcam_bubble_for_request<R: Runtime>(
    app: &AppHandle<R>,
    device_id: Option<String>,
    capturable: bool,
    preview_request: u64,
    require_visible_panel: bool,
) -> Result<(), String> {
    if !crate::native_webcam::preview_request_is_current(preview_request) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let skip_native_preflight =
            std::env::var("CLIPY_DESKTOP_DEV_E2E_SKIP_NATIVE_CAMERA_PREFLIGHT")
                .ok()
                .as_deref()
                == Some("1");
        if skip_native_preflight {
            tracing::warn!("skipping native AVFoundation camera permission preflight for dev E2E");
        } else {
            ensure_camera_permission()?;
        }
    }

    let native_already_running = {
        let requested = webcam_requested_device_id().lock().clone();
        requested.as_ref() == Some(&device_id) && crate::native_webcam::native_webcam_active()
    };
    *webcam_requested_device_id().lock() = Some(device_id.clone());

    let device_id_for_native = device_id.clone();
    let result = run_on_main_thread_result(app, "show webcam bubble", move |app| {
        use tauri::Manager;

        if !crate::native_webcam::preview_request_is_current(preview_request) {
            return Ok(());
        }
        if require_visible_panel
            && (app.state::<RecordingController>().dto().phase != crate::types::RecordingPhase::Idle
                || !app
                    .get_webview_window("main")
                    .is_some_and(|window| window.is_visible().unwrap_or(false)))
        {
            return Err("Camera preview dismissed".to_string());
        }
        let window = app
            .get_webview_window("webcam")
            .ok_or_else(|| "webcam window missing".to_string())?;
        let main_had_focus = app
            .get_webview_window("main")
            .filter(|main| main.is_focused().unwrap_or(false));
        window.show().map_err(|e| format!("show: {e}"))?;
        crate::cursor_track::set_ignore_cursor_events(&window, false)
            .map_err(|e| format!("webcam cursor events: {e}"))?;
        // `show()` made the bubble key. Turning the camera on from the
        // popover must not blur the popover: its source highlight follows
        // that focus, and the user is still in the picker.
        if let Some(main) = main_had_focus {
            let _ = main.set_focus();
        }
        #[cfg(target_os = "macos")]
        {
            if let Ok(ns_window) = window.ns_window() {
                // AppKit window management must run on the main thread. Set
                // the final sharing type before SCK starts; flipping through
                // NSWindowSharingNone during instant recording makes the
                // bubble disappear from the captured MP4 even if it remains
                // visible to the user.
                unsafe {
                    if capturable {
                        set_window_sharing_readonly(ns_window);
                    } else {
                        set_window_sharing_none(ns_window);
                    }
                };
            }
        }
        // Don't call set_focus — the bubble is a passive overlay; stealing
        // focus from the user's actual work app is a bad trade.
        Ok(())
    })
    .and_then(|()| {
        if !crate::native_webcam::preview_request_is_current(preview_request) {
            return Ok(());
        }
        // Camera startup can take seconds (and waits up to 4s for the native
        // worker) — keep it out of the main-thread closure above so the UI
        // never freezes while the camera spins up.
        if !native_already_running {
            match crate::native_webcam::start_native_webcam(
                app,
                device_id_for_native,
                preview_request,
            )? {
                crate::native_webcam::NativeWebcamStartOutcome::Started => {
                    if !crate::native_webcam::preview_request_is_current(preview_request) {
                        return Ok(());
                    }
                    // Show/hide are not serialized end-to-end: a hide or
                    // teardown that ran while the camera was starting found
                    // nothing registered to stop, and its window.hide() may
                    // have landed after our window.show(). If the bubble is
                    // hidden now, this freshly registered camera would run
                    // invisibly (green light with no bubble) — yield to the
                    // hide instead.
                    use tauri::Manager;
                    let visible = app
                        .get_webview_window("webcam")
                        .and_then(|w| w.is_visible().ok())
                        .unwrap_or(false);
                    if !visible {
                        *webcam_requested_device_id().lock() = None;
                        crate::native_webcam::stop_native_webcam(app);
                        let _ = app.emit_to("webcam", EVENT_WEBCAM_STOP, ());
                        return Ok(());
                    }
                }
                crate::native_webcam::NativeWebcamStartOutcome::Superseded => {
                    // A concurrent stop or newer show claimed the camera
                    // lifecycle while this one was starting; that operation
                    // owns the bubble state now. No start event, and no
                    // failure cleanup — clearing the requested device or
                    // hiding the window here would stomp the winner's work.
                    return Ok(());
                }
            }
        }
        if !crate::native_webcam::preview_request_is_current(preview_request) {
            return Ok(());
        }
        app.emit_to("webcam", EVENT_WEBCAM_START, device_id)
            .map_err(|e| format!("webcam start event: {e}"))
    });
    if result.is_err() && crate::native_webcam::preview_request_is_current(preview_request) {
        *webcam_requested_device_id().lock() = None;
        let stop_request = crate::native_webcam::stop_native_webcam(app);
        let app_for_hide = app.clone();
        let _ = app.run_on_main_thread(move || {
            use tauri::Manager;

            if !crate::native_webcam::preview_cleanup_is_current(stop_request) {
                return;
            }
            if let Some(window) = app_for_hide.get_webview_window("webcam") {
                let _ = window.hide();
            }
            if let Some(window) = app_for_hide.get_webview_window("webcam-controls") {
                let _ = window.hide();
            }
        });
    }
    result
}

/// URL of the local socket that carries raw camera frames to the bubble
/// (`camera_preview_ws`). `None` off macOS, where the bubble still gets its
/// frames as events.
#[tauri::command]
pub fn camera_preview_url() -> Option<String> {
    crate::native_webcam::camera_preview_url()
}

/// Shown when the camera is asked for during a window-only take (the dock
/// button and the camera shortcut both end up here).
pub(crate) const WINDOW_ONLY_CAMERA_REFUSAL: &str =
    "Camera isn't recorded when Clipy records only the window. To include it, choose \"Window and screen area\" under Settings → Video & audio → Window recording.";

#[tauri::command]
pub fn get_webcam_bubble_state(app: AppHandle) -> WebcamBubbleStateDto {
    let requested = webcam_requested_device_id().lock().clone();
    let native = crate::native_webcam::native_webcam_active();
    #[cfg(target_os = "macos")]
    let (requested, native) = match crate::capture::camera::active_device_id() {
        Some(device_id) => (Some(Some(device_id)), true),
        None => (requested, native),
    };
    let visible = app
        .get_webview_window("webcam")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    WebcamBubbleStateDto {
        active: visible && requested.is_some(),
        device_id: requested.flatten(),
        native,
        // try_state: on Windows a release build's webviews can call this
        // while the config windows are still being created, before
        // `setup()` manages the controller. A panic here is on the main
        // thread and kills the app; no controller yet means no capture.
        recordable: app
            .try_state::<RecordingController>()
            .map_or(true, |rec| !rec.active_capture_is_window_only()),
        camera_only: {
            #[cfg(target_os = "macos")]
            {
                crate::capture::camera::is_active()
            }
            #[cfg(target_os = "windows")]
            {
                crate::capture::windows_camera::is_active()
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                false
            }
        },
        layout: *webcam_active_layout().lock(),
        shape: *webcam_active_shape().lock(),
        size: *webcam_active_size().lock(),
        mirrored: webcam_mirrored(&app),
    }
}

const WEBCAM_CONTROLS_WIDTH: f64 = 132.0;
const WEBCAM_CONTROLS_HEIGHT: f64 = 52.0;

fn position_webcam_controls_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize, Manager};

    let webcam = app
        .get_webview_window("webcam")
        .ok_or_else(|| "webcam window missing".to_string())?;
    let controls = app
        .get_webview_window("webcam-controls")
        .ok_or_else(|| "webcam controls window missing".to_string())?;
    let scale = webcam
        .scale_factor()
        .map_err(|e| format!("webcam scale factor: {e}"))?;
    let webcam_position = webcam
        .outer_position()
        .map_err(|e| format!("webcam position: {e}"))?
        .to_logical::<f64>(scale);
    let webcam_size = webcam
        .outer_size()
        .map_err(|e| format!("webcam size: {e}"))?
        .to_logical::<f64>(scale);
    // Flush against the bubble, not 4pt below it. The pill is 36pt of chrome
    // inside a 52pt window, so it still reads as a gap — but the window itself
    // is now contiguous with the bubble, and the pointer can reach the dots
    // without crossing a strip that belongs to neither window and hides both.
    let mut x = webcam_position.x + (webcam_size.width - WEBCAM_CONTROLS_WIDTH) / 2.0;
    let mut y = webcam_position.y + webcam_size.height;
    if let Some(monitor) = webcam.current_monitor().map_err(|e| e.to_string())? {
        let work = monitor.work_area();
        let left = f64::from(work.position.x) / scale;
        let top = f64::from(work.position.y) / scale;
        let right = left + f64::from(work.size.width) / scale;
        let bottom = top + f64::from(work.size.height) / scale;
        if y + WEBCAM_CONTROLS_HEIGHT > bottom { y = webcam_position.y - WEBCAM_CONTROLS_HEIGHT; }
        x = x.clamp(left, (right - WEBCAM_CONTROLS_WIDTH).max(left));
        y = y.clamp(top, (bottom - WEBCAM_CONTROLS_HEIGHT).max(top));
    }

    // The cost is the drag handle above: while the toolbar is up it covers the
    // bubble's centre, so a drag has to start on the ring around it. That is
    // the chosen trade, and hover-to-reveal means the handle is
    // free again the moment the pointer leaves.
    #[cfg(target_os = "windows")]
    let y = webcam_position.y + (webcam_size.height - WEBCAM_CONTROLS_HEIGHT) / 2.0;

    controls
        .set_size(LogicalSize::new(
            WEBCAM_CONTROLS_WIDTH,
            WEBCAM_CONTROLS_HEIGHT,
        ))
        .map_err(|e| format!("webcam controls size: {e}"))?;
    controls
        .set_position(LogicalPosition::new(x.round(), y.round()))
        .map_err(|e| format!("webcam controls position: {e}"))?;
    Ok(())
}

pub(crate) fn sync_webcam_controls_to_bubble<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;

    // Never re-anchor under the pointer. Resizing about the bubble's bottom
    // centre already keeps this a no-op for a plain size pick, but a bubble
    // that grows into a screen edge gets clamped, and following that clamp
    // would slide the pill out from under the finger mid-click. It is
    // repositioned on the next reveal instead.
    if crate::webcam_controls::pointer_in_controls() {
        return Ok(());
    }

    let visible = app
        .get_webview_window("webcam-controls")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        position_webcam_controls_window(app)?;
    }
    Ok(())
}

/// Anchor the hover pill under the bubble and show it. Main thread only.
/// `webcam_controls` calls this from the native pointer position; nothing in
/// a webview decides when the pill appears.
pub(crate) fn reveal_webcam_controls<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;

    let controls = app
        .get_webview_window("webcam-controls")
        .ok_or_else(|| "webcam controls window missing".to_string())?;
    position_webcam_controls_window(app)?;
    controls
        .set_focusable(false)
        .map_err(|e| format!("webcam controls focusable: {e}"))?;
    crate::cursor_track::set_ignore_cursor_events(&controls, false)
        .map_err(|e| format!("webcam controls cursor events: {e}"))?;
    controls
        .set_always_on_top(true)
        .map_err(|e| format!("webcam controls always-on-top: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        controls
            .set_visible_on_all_workspaces(true)
            .map_err(|e| format!("webcam controls workspaces: {e}"))?;
        if let Ok(ns_window) = controls.ns_window() {
            // The camera window stays readable by ScreenCaptureKit, while
            // this separate interaction layer is visible only to the user.
            unsafe { set_window_sharing_none(ns_window) };
        }
    }
    // Same intent on Windows: the bubble is captured, the toolbar is not.
    #[cfg(target_os = "windows")]
    exclude_window_from_capture(&controls);
    controls
        .show()
        .map_err(|e| format!("show webcam controls: {e}"))?;
    Ok(())
}

fn webcam_mirrored<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get("webcam_mirrored"))
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

#[tauri::command]
pub fn update_webcam_appearance(
    app: AppHandle,
    shape: WebcamShapeDto,
    size: WebcamSizeDto,
    mirrored: bool,
) -> Result<(), String> {
    let layout = *webcam_active_layout().lock();
    let rect = *WEBCAM_ACTIVE_RECT
        .get_or_init(|| parking_lot::Mutex::new(None))
        .lock();
    let mut settings = get_recording_settings(app.clone())?;
    settings.webcam.shape = shape;
    settings.webcam.size = size;
    let store = app.store(SETTINGS_STORE).map_err(|err| err.to_string())?;
    store.set(
        RECORDING_SETTINGS_KEY,
        serde_json::json!(settings.normalized()),
    );
    store.set("webcam_mirrored", serde_json::json!(mirrored));
    store.save().map_err(|err| err.to_string())?;
    set_webcam_layout_impl(&app, layout, shape, size, rect)?;
    app.state::<RecordingController>()
        .update_active_webcam_appearance(shape, size);
    Ok(())
}

/// Position and resize the webcam overlay window for the Studio camera
/// layouts. The live bubble stays visible to the user during
/// recording; the captured webcam sidecar is composited separately in
/// Studio/export so it can be moved or hidden after recording.
#[tauri::command]
pub fn set_webcam_layout(
    app: AppHandle,
    layout: WebcamLayoutDto,
    shape: WebcamShapeDto,
    size: WebcamSizeDto,
    rect: Option<SourceHighlightRectDto>,
) -> Result<(), String> {
    set_webcam_layout_impl(&app, layout, shape, size, rect)
}

fn set_webcam_layout_impl<R: Runtime>(
    app: &AppHandle<R>,
    layout: WebcamLayoutDto,
    shape: WebcamShapeDto,
    size: WebcamSizeDto,
    rect: Option<SourceHighlightRectDto>,
) -> Result<(), String> {
    run_on_main_thread_result(app, "set webcam layout", move |app| {
        use tauri::{LogicalPosition, LogicalSize, Manager};

        let window = app
            .get_webview_window("webcam")
            .ok_or_else(|| "webcam window missing".to_string())?;

        let source = rect.unwrap_or(SourceHighlightRectDto {
            x: 80.0,
            y: 80.0,
            width: 1280.0,
            height: 720.0,
        });

        let previous_layout = *webcam_active_layout().lock();
        // Size and shape changes grow or shrink the bubble around its bottom
        // centre, which is the point the hover pill hangs off. Keeping the
        // top-left instead moved that edge by the whole size delta (small to
        // medium is 150pt), so the pill jumped out from under the pointer the
        // instant a size was picked and the next dot was unreachable.
        let previous_box = (previous_layout == layout)
            .then(|| current_webcam_box(&window))
            .flatten();

        *webcam_active_layout().lock() = layout;
        *webcam_active_shape().lock() = shape;
        *webcam_active_size().lock() = size;
        *WEBCAM_ACTIVE_RECT
            .get_or_init(|| parking_lot::Mutex::new(None))
            .lock() = Some(source);

        // The rect is stored above in the units it arrived in, because
        // `show_source_highlight` and the capture crop both read it that way.
        // Only the LAYOUT works in logical units, so convert here and nowhere
        // else.
        let source = source_rect_to_logical(&window, source);

        let (width, height, default_x, default_y) =
            webcam_layout_in_source(layout, shape, size, source);
        // A frame restored from disk is applied exactly once as-is; only a
        // frame remembered during this session is re-anchored to the size
        // change.
        let restored = webcam_restored_layouts().lock().remove(&layout);
        let (x, y) = webcam_window_frames()
            .lock()
            .get(&layout)
            .copied()
            .map(|frame| {
                let (x, y) = if restored {
                    (frame.x, frame.y)
                } else {
                    anchor_webcam_frame(frame, previous_box, width, height)
                };
                clamp_webcam_frame_to_source(source, x, y, width, height)
            })
            .unwrap_or((default_x, default_y));
        // ...and keep it clear of the Dock. The default bottom-right position
        // sits inside the Dock's strip, which renders above always-on-top
        // windows, so the bubble was half-swallowed on screen AND in the video.
        let (x, y) = clamp_to_work_area(&window, x, y, width, height);

        window
            .set_size(LogicalSize::new(width.round(), height.round()))
            .map_err(|e| format!("webcam layout size: {e}"))?;
        window
            .set_position(LogicalPosition::new(x.round(), y.round()))
            .map_err(|e| format!("webcam layout position: {e}"))?;
        window
            .set_always_on_top(true)
            .map_err(|e| format!("webcam layout always-on-top: {e}"))?;
        app.emit(
            EVENT_WEBCAM_LAYOUT_CHANGED,
            WebcamAppearanceDto {
                layout,
                shape,
                size,
                mirrored: webcam_mirrored(&app),
            },
        )
        .map_err(|e| format!("webcam layout event: {e}"))?;
        Ok(())
    })
}

/// List recent local Studio recordings so the Home window can reopen
/// previous editor sessions after the Studio window is closed.

fn recoverable_recording_path(
    app: &AppHandle,
    recording_id: &str,
) -> Result<std::path::PathBuf, String> {
    validate_recording_id(recording_id)?;
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("resolve app data dir: {err}"))?;
    dir.push("recordings");
    Ok(dir.join(format!("{recording_id}.mp4")))
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioRebakeDto {
    pub share_url: String,
    pub queued: bool,
    pub ready: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioShareStatusDto {
    pub share_url: String,
    pub video_url: Option<String>,
    pub processing_status: Option<String>,
    pub processing_error: Option<String>,
    pub ready: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStudioExportDto {
    pub output_path: String,
}

#[derive(Clone, Copy, Debug)]
enum NativeStudioExportFormat {
    Mp4,
    Gif,
}

impl NativeStudioExportFormat {
    fn parse(value: Option<String>) -> Result<Self, String> {
        match value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            None | Some("mp4") => Ok(Self::Mp4),
            Some("gif") => Ok(Self::Gif),
            Some(other) => Err(format!("unsupported export format: {other}")),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Gif => "gif",
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Gif => "gif",
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct NativeStudioCleanupSuggestionDto {
    pub kind: String,
    pub start_s: f64,
    pub end_s: f64,
    pub speed: f64,
    pub reason: String,
    pub original_duration_s: f64,
    pub saved_s: f64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct NativeStudioCleanupDto {
    pub duration_s: Option<f64>,
    pub suggestions: Vec<NativeStudioCleanupSuggestionDto>,
}

#[cfg(debug_assertions)]
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevStudioE2EResultDto {
    pub recording_id: String,
    pub source_path: String,
    pub camera_path: Option<String>,
    pub export_path: String,
    pub share_url: Option<String>,
    pub remote_public_id: Option<String>,
    pub remote_video_url: Option<String>,
    pub remote_processing_status: Option<String>,
    pub remote_playback_verified: bool,
    pub source_duration_ms: u64,
    pub source_bytes: u64,
    pub camera_bytes: u64,
    pub export_duration_s: Option<f64>,
    pub export_bytes: u64,
    pub cursor_events: usize,
    pub zoom_segments: usize,
    pub scroll_events: usize,
    pub synthetic_cursor_used: bool,
    pub stop_controls_visible: bool,
    pub stop_controls_always_on_top: bool,
    pub stop_controls_sharing_type: Option<usize>,
}

fn remote_public_id_for(recording: &StudioRecordingDto) -> String {
    recording.remote_public_id.clone().unwrap_or_else(|| {
        recording
            .share_url
            .as_deref()
            .and_then(|url| url.rsplit('/').next())
            .unwrap_or_default()
            .to_string()
    })
}

fn find_repo_root() -> Option<std::path::PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if dir.join("package.json").exists()
            && dir.join("desktop/scripts/export-native-studio.ts").exists()
        {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn find_packaged_studio_renderer(app: &AppHandle, file_name: &str) -> Option<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("CLIPY_NATIVE_STUDIO_RENDERER_DIR") {
        let path = std::path::PathBuf::from(dir).join(file_name);
        if path.exists() {
            return Some(path);
        }
    }
    let resource_dir = app.path().resource_dir().ok()?;
    [
        resource_dir
            .join("resources")
            .join("native-studio")
            .join(file_name),
        resource_dir.join("native-studio").join(file_name),
    ]
    .into_iter()
    .find(|path| path.exists())
}

fn find_native_studio_backgrounds_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("CLIPY_NATIVE_STUDIO_BACKGROUNDS_DIR") {
        let path = std::path::PathBuf::from(dir);
        if path.exists() {
            return Some(path);
        }
    }
    if let Some(repo_root) = find_repo_root() {
        let path = repo_root
            .join("desktop")
            .join("src-tauri")
            .join("resources")
            .join("native-studio")
            .join("backgrounds");
        if path.exists() {
            return Some(path);
        }
    }
    let resource_dir = app.path().resource_dir().ok()?;
    [
        resource_dir
            .join("resources")
            .join("native-studio")
            .join("backgrounds"),
        resource_dir.join("native-studio").join("backgrounds"),
    ]
    .into_iter()
    .find(|path| path.exists())
}

#[derive(serde::Serialize)]
pub struct NativeStudioBackgroundsDto {
    pub dir: String,
}

fn packaged_node_file_name() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Some("node-aarch64-apple-darwin")
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Some("node-x86_64-apple-darwin")
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64")
    )))]
    {
        None
    }
}

fn find_packaged_node_runtime(app: &AppHandle) -> Option<std::path::PathBuf> {
    let file_name = packaged_node_file_name()?;
    find_packaged_studio_renderer(app, file_name)
}

fn node_bin(app: &AppHandle) -> String {
    if let Ok(path) = std::env::var("CLIPY_NODE_BIN") {
        return path;
    }
    find_packaged_node_runtime(app)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "node".to_string())
}

async fn run_native_studio_export(
    app: &AppHandle,
    recording: &StudioRecordingDto,
    requested_output_path: Option<String>,
    export_format: NativeStudioExportFormat,
    cursor_json: Option<serde_json::Value>,
) -> Result<NativeStudioExportDto, String> {
    let mut recordings_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    recordings_dir.push("recordings");
    let output_path = match requested_output_path {
        Some(path) if !path.trim().is_empty() => {
            let path = std::path::PathBuf::from(path);
            if path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case(export_format.extension()))
            {
                path
            } else {
                path.with_extension(export_format.extension())
            }
        }
        _ => {
            let exports_dir = recordings_dir.join("exports");
            std::fs::create_dir_all(&exports_dir)
                .map_err(|e| format!("create exports dir: {e}"))?;
            exports_dir.join(format!(
                "{}-edited.{}",
                recording.recording_id,
                export_format.extension()
            ))
        }
    };
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create export dir: {e}"))?;
    }
    let payload_path =
        recordings_dir.join(format!("{}-export-payload.json", recording.recording_id));

    let camera_path = recording
        .camera_path
        .clone()
        .or_else(|| camera_sidecar_path_for(&recording.local_file_path));
    let payload = serde_json::json!({
        "sourcePath": recording.local_file_path,
        "outputPath": output_path,
        "projectPath": recording.project_path,
        "cursorPath": recording.cursor_path,
        "cursorJson": cursor_json,
        "zoomPath": recording.zoom_path,
        "cameraPath": camera_path,
        "format": export_format.as_str(),
    });
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|e| format!("serialize export payload: {e}"))?;
    std::fs::write(&payload_path, bytes).map_err(|e| format!("write export payload: {e}"))?;

    let payload_arg = payload_path.to_string_lossy().to_string();
    let packaged_renderer = find_packaged_studio_renderer(app, "export-native-studio.cjs");
    let output = if let Some(renderer_path) = packaged_renderer {
        let node = node_bin(app);
        tracing::info!(
            renderer = %renderer_path.display(),
            node = %node,
            "native Studio export using bundled renderer"
        );
        let renderer_arg = renderer_path.to_string_lossy().to_string();
        let renderer_dir = renderer_path.parent().map(std::path::Path::to_path_buf);
        tokio::task::spawn_blocking(move || {
            let mut cmd = std::process::Command::new(node);
            if let Some(dir) = renderer_dir {
                cmd.current_dir(dir);
            }
            cmd.args([renderer_arg.as_str(), payload_arg.as_str()])
                .output()
        })
        .await
        .map_err(|e| format!("export task panicked: {e}"))?
        .map_err(|e| format!("start packaged Studio export: {e}"))?
    } else {
        let repo_root = find_repo_root().ok_or_else(|| {
            "Local MP4 export needs either the packaged Native Studio renderer resource or the development repo checkout.".to_string()
        })?;
        tracing::info!(
            repo_root = %repo_root.display(),
            "native Studio export using dev renderer"
        );
        tokio::task::spawn_blocking(move || {
            std::process::Command::new("npm")
                .current_dir(&repo_root)
                .args([
                    "exec",
                    "tsx",
                    "--",
                    "desktop/scripts/export-native-studio.ts",
                    &payload_arg,
                ])
                .output()
        })
        .await
        .map_err(|e| format!("export task panicked: {e}"))?
        .map_err(|e| format!("start local export: {e}"))?
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "local export failed: {}{}",
            stderr.trim(),
            if stdout.trim().is_empty() {
                String::new()
            } else {
                format!("\n{}", stdout.trim())
            }
        ));
    }

    Ok(NativeStudioExportDto {
        output_path: output_path.to_string_lossy().to_string(),
    })
}

/// Open (or refocus) the native Studio editor window for a recording.
///
/// Generic over the Tauri runtime so it can be invoked both from the
/// `open_editor` command (concrete `AppHandle`) and from the recording
/// state machine's `stop()` path (`AppHandle<R>`), which is how Studio-mode
/// recordings hand off to the editor after their upload completes.
pub fn open_editor_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
    public_id: &str,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if public_id.is_empty()
        || !public_id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid public_id".to_string());
    }

    let app_url = WebviewUrl::App(format!("index.html#studio?publicId={public_id}").into());

    // If we've already opened a Studio window, close it and rebuild with
    // the requested recording route. Tauri v2 navigation requires an
    // absolute URL, while the editor uses an app-local hash route.
    let label = "editor";
    if let Some(existing) = app.get_webview_window(label) {
        existing.close().map_err(|e| format!("close editor: {e}"))?;
    }

    WebviewWindowBuilder::new(app, label, app_url)
        .title("Clipy Studio")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .focused(true)
        .build()
        .map_err(|e| format!("create editor window: {e}"))?;
    Ok(())
}

// Async on purpose: shares the show/hide paths' TCC-dialog and camera
// start/stop blocking, triggered from the recording HUD mid-recording.
#[tauri::command]
pub async fn toggle_recording_webcam(app: AppHandle) -> Result<bool, String> {
    let preview_request = crate::native_webcam::preview_request_token();
    tauri::async_runtime::spawn_blocking(move || {
        use crate::types::RecordingPhase;

        let rec = app.state::<RecordingController>();
        let phase = rec.dto().phase;
        if !matches!(phase, RecordingPhase::Recording | RecordingPhase::Paused)
            || !crate::native_webcam::preview_cleanup_is_current(preview_request)
        {
            return Err("no recording in progress".to_string());
        }
        // A window recorded by itself never contains the bubble window, so
        // turning the camera on would light it for nothing.
        if rec.active_capture_is_window_only() {
            return Err(WINDOW_ONLY_CAMERA_REFUSAL.to_string());
        }
        // The camera is the recording itself; there is no bubble to toggle.
        #[cfg(target_os = "windows")]
        if crate::capture::windows_camera::is_active() {
            return Err("the camera is the recording in camera-only mode".to_string());
        }
        let preview_request = crate::native_webcam::try_begin_preview_request(preview_request)
            .ok_or_else(|| "camera recording ended".to_string())?;
        #[cfg(target_os = "macos")]
        if crate::capture::camera::is_active() {
            return run_on_main_thread_result(&app, "toggle camera preview", move |app| {
                if !crate::native_webcam::preview_cleanup_is_current(preview_request)
                    || !crate::capture::camera::is_active()
                    || !matches!(
                        app.state::<RecordingController>().dto().phase,
                        RecordingPhase::Recording | RecordingPhase::Paused
                    )
                {
                    return Err("camera recording ended".to_string());
                }
                let window = app
                    .get_webview_window("webcam")
                    .ok_or_else(|| "webcam window missing".to_string())?;
                let visible = window.is_visible().map_err(|err| err.to_string())?;
                if visible {
                    window.hide().map_err(|err| err.to_string())?;
                    if let Some(controls) = app.get_webview_window("webcam-controls") {
                        let _ = controls.hide();
                    }
                    let _ = app.emit_to("webcam", EVENT_WEBCAM_STOP, ());
                } else {
                    window.show().map_err(|err| err.to_string())?;
                    let _ = app.emit_to(
                        "webcam",
                        EVENT_WEBCAM_START,
                        crate::capture::camera::active_device_id(),
                    );
                }
                Ok(!visible)
            });
        }
        let Some((webcam_cfg, mode, rect)) = rec.active_webcam_context() else {
            return Err("no recording in progress".to_string());
        };

        let visible = app
            .get_webview_window("webcam")
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);

        if visible {
            let stop_request = crate::native_webcam::stop_native_webcam_if_current(&app, preview_request)
                .ok_or_else(|| "camera preview superseded".to_string())?;
            *webcam_requested_device_id().lock() = None;
            hide_webcam_windows(&app, stop_request)?;
            Ok(false)
        } else {
            let device_id = webcam_cfg.as_ref().and_then(|w| w.device_id.clone());
            let layout = webcam_cfg
                .as_ref()
                .map(|w| w.layout)
                .unwrap_or(WebcamLayoutDto::Bubble);
            let shape = webcam_cfg.as_ref().map(|w| w.shape).unwrap_or_default();
            let size = webcam_cfg.as_ref().map(|w| w.size).unwrap_or_default();
            show_webcam_bubble_for_request(
                &app,
                device_id,
                mode != crate::types::RecordingMode::Studio,
                preview_request,
                false,
            )?;
            if !crate::native_webcam::preview_request_is_current(preview_request) {
                return Err("camera recording ended".to_string());
            }
            set_webcam_layout(app.clone(), layout, shape, size, rect)?;
            set_webcam_capturable(&app, mode != crate::types::RecordingMode::Studio);
            Ok(true)
        }
    })
    .await
    .map_err(|e| format!("webcam toggle task failed: {e}"))?
}

/// Whether the webcam bubble is currently on screen — the HUD's camera
/// button initializes from this.
#[tauri::command]
pub fn get_recording_webcam_visible(app: AppHandle) -> Result<bool, String> {
    Ok(app
        .get_webview_window("webcam")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false))
}

#[tauri::command]
pub fn set_cursor_trail_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    if enabled && cursor_trail_session().lock().is_none() {
        CURSOR_TRAIL_ENABLED.store(false, Ordering::SeqCst);
        return Ok(false);
    }
    let window = app.get_webview_window("cursor-trail").ok_or("Annotation window missing")?;
    crate::cursor_track::set_ignore_cursor_events(&window, !enabled).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    if enabled {
        raise_cursor_trail(&app);
    }
    CURSOR_TRAIL_ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        crate::whats_new::mark_tried(&app, "draw");
    }
    app.emit("annotation-mode", enabled).map_err(|e| e.to_string())?;
    Ok(enabled)
}

#[tauri::command]
pub fn get_cursor_trail_available() -> bool {
    cursor_trail_session().lock().is_some()
}

#[tauri::command]
pub fn get_cursor_trail_enabled() -> bool {
    cursor_trail_enabled()
}

/// Whether the annotation overlay is on right now. The cursor tracker polls
/// this to write `annotation` events into the sidecar.
pub(crate) fn cursor_trail_enabled() -> bool {
    CURSOR_TRAIL_ENABLED.load(Ordering::SeqCst)
}

/// Keep recording guide windows out of ScreenCaptureKit display captures.
/// The user still sees them while recording, but they do not get burned
/// into the screen pixels.
#[cfg(target_os = "macos")]
pub(crate) unsafe fn set_window_sharing_none(ns_window_ptr: *mut std::ffi::c_void) {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    if ns_window_ptr.is_null() {
        return;
    }

    extern "C" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    type SendFn = unsafe extern "C" fn(*mut c_void, *const c_void, usize);
    let send: SendFn = std::mem::transmute(objc_msgSend as *const c_void);
    let sel = sel_registerName(b"setSharingType:\0".as_ptr() as *const c_char);
    // NSWindowSharingNone = 0 — other processes, including SCK display
    // captures, cannot read this window's pixels.
    send(ns_window_ptr, sel, 0usize);
}

/// `kCGStatusWindowLevel` (25): one above the menu bar's
/// `kCGMainMenuWindowLevel` (24), below pop-up menus (101).
#[cfg(target_os = "macos")]
const NS_STATUS_WINDOW_LEVEL: isize = 25;

/// Lift the source-highlight frame above the menu bar.
///
/// Tauri's always-on-top is `NSFloatingWindowLevel` (3), and the menu bar
/// draws over anything below level 24. The frame is sized to the whole
/// display, so its top stroke sat under the menu bar and only the vertical
/// arm of the top-left corner accent showed below it, so the top line looked
/// missing and a stray mark appeared at the top left. The window ignores the mouse, so the menu bar stays
/// clickable through it.
///
/// Call this AFTER `set_always_on_top`, which resets the level to floating,
/// and on the main thread.
#[cfg(target_os = "macos")]
pub(crate) unsafe fn raise_above_menu_bar(ns_window_ptr: *mut std::ffi::c_void) {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    if ns_window_ptr.is_null() {
        return;
    }

    extern "C" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    type SendFn = unsafe extern "C" fn(*mut c_void, *const c_void, isize);
    let send: SendFn = std::mem::transmute(objc_msgSend as *const c_void);
    let sel = sel_registerName(b"setLevel:\0".as_ptr() as *const c_char);
    send(ns_window_ptr, sel, NS_STATUS_WINDOW_LEVEL);
}

/// Opposite of `set_window_sharing_none`: make the window's pixels
/// readable by SCK again (NSWindowSharingReadOnly = 1). Instant-mode
/// recordings burn the webcam bubble into the capture (WYSIWYG); Studio
/// keeps it excluded and ships the camera as a separate track.
#[cfg(target_os = "macos")]
pub(crate) unsafe fn set_window_sharing_readonly(ns_window_ptr: *mut std::ffi::c_void) {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    if ns_window_ptr.is_null() {
        return;
    }

    extern "C" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    type SendFn = unsafe extern "C" fn(*mut c_void, *const c_void, usize);
    let send: SendFn = std::mem::transmute(objc_msgSend as *const c_void);
    let sel = sel_registerName(b"setSharingType:\0".as_ptr() as *const c_char);
    send(ns_window_ptr, sel, 1usize);
}

/// Windows counterpart of `set_window_sharing_none`: keep a window on screen
/// for the user but out of every screen capture, including our own WGC session.
///
/// `WDA_EXCLUDEFROMCAPTURE` is what `NSWindowSharingNone` is on macOS. Without
/// it, the user-only overlays (the webcam toolbar, the recording controls, the
/// area-select dimmer) were composited into Windows recordings — the toolbar
/// showed up as a small dark panel protruding from behind the round camera
/// bubble, because the toolbar is a separate rectangular window sitting at the
/// bubble's lower edge. macOS never had the bug: every one of these call sites
/// already excluded itself, inside a `cfg(target_os = "macos")` block.
///
/// Where exclusion would draw the window as a black box (Remote Desktop, a
/// streamed or virtual display, a build before Windows 10 2004, no desktop
/// composition; see `capture_exclusion`), the window is set back to
/// `WDA_NONE` instead: drawn normally, and recorded. Every caller goes through
/// here, and the check runs on each call, so a window shown again after the
/// session moved to or from Remote Desktop gets the right affinity.
#[cfg(target_os = "windows")]
pub(crate) fn exclude_window_from_capture<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    let Some(hwnd) = window_hwnd(window) else {
        tracing::debug!(label = window.label(), "no HWND; cannot exclude from capture");
        return;
    };
    let affinity = if crate::capture_exclusion::blocker(hwnd).is_none() {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };

    // SAFETY: Category 8 — FFI contract. `hwnd` is a live top-level window
    // owned by this process; the call only sets a display-affinity flag on it
    // and borrows nothing past the call.
    unsafe {
        if let Err(err) = SetWindowDisplayAffinity(hwnd, affinity) {
            tracing::warn!(
                label = window.label(),
                affinity = affinity.0,
                "SetWindowDisplayAffinity failed: {err}"
            );
        }
    }
}

/// A window's HWND, rebuilt against OUR `windows` crate version rather than
/// reusing Tauri's: the two can disagree on whether `HWND` wraps an `isize`
/// or a pointer, and the raw value is the one thing both agree on.
#[cfg(target_os = "windows")]
pub(crate) fn window_hwnd<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<windows::Win32::Foundation::HWND> {
    let handle = window.hwnd().ok()?;
    Some(windows::Win32::Foundation::HWND(handle.0 as *mut std::ffi::c_void))
}

/// Limit where a window draws and takes clicks to one rectangle, in physical
/// pixels from its top-left corner. Clicks outside it reach whatever is
/// behind, without making the window layered (see `windows_build`).
#[cfg(target_os = "windows")]
pub(crate) fn clip_window_to_rect<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
) {
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject, SetWindowRgn};

    let Some(hwnd) = window_hwnd(window) else {
        return;
    };
    // SAFETY: Category 8 — FFI contract. `hwnd` is a live top-level window
    // owned by this process. On success the system owns the region; on
    // failure it is still ours and is freed here.
    unsafe {
        let region = CreateRectRgn(left, top, right, bottom);
        if region.is_invalid() {
            return;
        }
        if SetWindowRgn(hwnd, region, true) == 0 {
            let _ = DeleteObject(region);
            tracing::debug!(label = window.label(), "SetWindowRgn failed");
        }
    }
}

/// The Windows build number, or `None` when it cannot be read. It matters for
/// capture exclusion: `WDA_EXCLUDEFROMCAPTURE` needs build 19041 (Windows 10
/// 2004) and acts as `WDA_MONITOR`, a black box, before it (`capture_exclusion`
/// then leaves windows capturable); Windows 10 does not exclude a layered
/// (click-through) window, Windows 11 (22000+) does.
#[cfg(target_os = "windows")]
pub(crate) fn windows_build() -> Option<u32> {
    use windows::core::w;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    let mut buffer = [0u16; 16];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: Category 8 — FFI contract. `size` is the byte length of
    // `buffer`, which RegGetValueW fills with a NUL-terminated string.
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"),
            w!("CurrentBuildNumber"),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if result != ERROR_SUCCESS {
        return None;
    }
    let chars = (size as usize / 2).min(buffer.len());
    String::from_utf16_lossy(&buffer[..chars])
        .trim_end_matches('\0')
        .trim()
        .parse::<u32>()
        .ok()
}

/// Flip whether the webcam bubble is part of captured screen pixels.
/// Instant mode → capturable (viewers see the bubble exactly as placed);
pub(crate) fn set_webcam_capturable<R: tauri::Runtime>(app: &AppHandle<R>, capturable: bool) {
    if let Err(err) = set_webcam_capturable_impl(app, capturable) {
        tracing::warn!("set webcam capturable failed: {err}");
    }
}

fn set_webcam_capturable_impl<R: tauri::Runtime>(
    app: &AppHandle<R>,
    capturable: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        run_on_main_thread_result(app, "set webcam capturable", move |app| {
            if let Some(window) = app.get_webview_window("webcam") {
                if let Ok(ns_window) = window.ns_window() {
                    unsafe {
                        if capturable {
                            set_window_sharing_readonly(ns_window);
                        } else {
                            set_window_sharing_none(ns_window);
                        }
                    }
                }
            }
            Ok(())
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, capturable);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
unsafe fn window_sharing_type(ns_window_ptr: *mut std::ffi::c_void) -> Option<usize> {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    if ns_window_ptr.is_null() {
        return None;
    }

    extern "C" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    type SendFn = unsafe extern "C" fn(*mut c_void, *const c_void) -> usize;
    let send: SendFn = std::mem::transmute(objc_msgSend as *const c_void);
    let sel = sel_registerName(b"sharingType\0".as_ptr() as *const c_char);
    Some(send(ns_window_ptr, sel))
}

// Async on purpose: teardown joins the native camera worker, which can stall
// in AVFoundation teardown — blocking the main thread here deadlocks the app.
#[tauri::command]
pub async fn hide_webcam_bubble(app: AppHandle) -> Result<(), String> {
    let stop_request = stop_webcam_preview(&app);
    tauri::async_runtime::spawn_blocking(move || hide_webcam_windows(&app, stop_request))
        .await
        .map_err(|e| format!("webcam bubble task failed: {e}"))?
}

pub(crate) fn hide_webcam_bubble_impl(app: &AppHandle) -> Result<(), String> {
    let stop_request = stop_webcam_preview(app);
    hide_webcam_windows(app, stop_request)
}

fn stop_webcam_preview<R: Runtime>(app: &AppHandle<R>) -> u64 {
    *webcam_requested_device_id().lock() = None;
    crate::native_webcam::stop_native_webcam(app)
}

fn hide_webcam_windows(app: &AppHandle, stop_request: u64) -> Result<(), String> {
    run_on_main_thread_result(app, "hide webcam bubble", move |app| {
        use tauri::Manager;

        if !crate::native_webcam::preview_cleanup_is_current(stop_request) {
            return Ok(());
        }
        if let Some(window) = app.get_webview_window("webcam") {
            let _ = app.emit_to("webcam", EVENT_WEBCAM_STOP, ());
            window.hide().map_err(|e| format!("hide: {e}"))?;
        }
        if let Some(window) = app.get_webview_window("webcam-controls") {
            let _ = window.hide();
        }
        Ok(())
    })
}

/// Backend-driven webcam-bubble teardown for when a recording flow ends.
///
/// The bubble is normally hidden by the main window's React effect when the
/// recording returns to `idle`. In Studio mode, though, the editor window
/// opens and fully occludes the small main window *before* the `idle` phase
/// is emitted, so macOS throttles the occluded main webview and that effect
/// never runs — leaving the camera's `getUserMedia` stream (and its in-use
/// indicator) live after Stop. Driving the teardown from the backend fixes
/// that: the bubble window is always-on-top (never occluded), so emitting
/// `webcam-stop` reliably reaches its WebContent process and stops the
/// camera tracks; we then hide the now-idle window on the main thread.
///
/// Idempotent and cheap — no-ops when the bubble isn't showing, so it is
/// safe to call on every transition to idle (stop, cancel, failed start).
pub(crate) fn teardown_webcam_bubble<R: tauri::Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;

    let stop_request = stop_webcam_preview(app);

    // Hiding the NSWindow must run on the main (AppKit) thread; the stop
    // and cancel flows run inside a tokio task.
    let app_for_hide = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !crate::native_webcam::preview_cleanup_is_current(stop_request) {
            return;
        }
        let _ = app_for_hide.emit_to("webcam", EVENT_WEBCAM_STOP, ());
        if let Some(window) = app_for_hide.get_webview_window("webcam") {
            let _ = window.hide();
        }
        if let Some(window) = app_for_hide.get_webview_window("webcam-controls") {
            let _ = window.hide();
        }
    });
}


/// Puts Flare back at the top, then Clipy's own controls above it, the way
/// macOS layers them. Windows orders always-on-top windows by which was
/// raised last, so a window made topmost after recording started would
/// otherwise cover the trail.
#[cfg(target_os = "windows")]
fn raise_cursor_trail<R: Runtime>(app: &AppHandle<R>) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOOWNERZORDER, SWP_NOSIZE,
    };

    let raise = |label: &str| {
        let Some(window) = app.get_webview_window(label) else {
            return;
        };
        if !window.is_visible().unwrap_or(false) {
            return;
        }
        let Ok(handle) = window.hwnd() else {
            return;
        };
        let hwnd = HWND(handle.0 as *mut std::ffi::c_void);
        // SAFETY: Category 8 — FFI contract. `hwnd` is a live top-level window
        // of this process; the async flag posts the move so this thread never
        // waits on the window's UI thread.
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS,
            );
        }
    };
    raise("cursor-trail");
    for label in ["webcam", "webcam-controls", "notes", "stop-controls"] {
        raise(label);
    }
}

/// Points per cursor unit for an overlay over `rect`. On Windows the rect and
/// the cursor are physical pixels, while the window is placed and drawn in
/// logical ones; macOS is logical throughout.
#[allow(unused_variables)]
fn cursor_trail_point_scale<R: Runtime>(app: &AppHandle<R>, rect: &SourceHighlightRectDto) -> f64 {
    #[cfg(target_os = "windows")]
    {
        app.get_webview_window("cursor-trail")
            .and_then(|window| {
                monitor_scale_for_physical_point(
                    &window,
                    rect.x + rect.width / 2.0,
                    rect.y + rect.height / 2.0,
                )
            })
            .unwrap_or(1.0)
    }
    #[cfg(not(target_os = "windows"))]
    {
        1.0
    }
}

/// Size, place and show the Flare overlay over `rect` (cursor units).
///
/// `idle` is the pointer outside a recording (`pointer.rs`): it follows the
/// user onto full-screen Spaces, and it gives way to a recording, which may
/// have taken the window between the idle thread deciding to show it and the
/// main thread getting to it.
fn place_cursor_trail_window<R: Runtime>(
    app: &AppHandle<R>,
    rect: &SourceHighlightRectDto,
    point_scale: f64,
    capturable: bool,
    idle: bool,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    let setup_rect = SourceHighlightRectDto {
        x: rect.x / point_scale,
        y: rect.y / point_scale,
        width: rect.width / point_scale,
        height: rect.height / point_scale,
    };
    // Windows places the window in physical pixels, the units of `rect`;
    // `point_scale` only matters to the canvas there.
    #[cfg(target_os = "windows")]
    let setup_rect = {
        let _ = point_scale;
        *rect
    };
    run_on_main_thread_result(app, "show cursor trail", move |app| {
        if idle && RECORDING_OWNS_TRAIL.load(Ordering::SeqCst) {
            return Err("a recording owns the cursor trail".to_string());
        }
        let window = app
            .get_webview_window("cursor-trail")
            .ok_or_else(|| "cursor trail window missing".to_string())?;
        // Windows: the rect is physical pixels, and it is placed as physical
        // pixels. A logical position is converted with the scale of the
        // monitor the window is on NOW, so moving to a display with another
        // scale landed it away from the cursor. Position first, so the DPI
        // change of the move has happened (and resized the window) before the
        // size is set; then position again in case that resize moved it.
        #[cfg(target_os = "windows")]
        {
            use tauri::{PhysicalPosition, PhysicalSize};
            let position = PhysicalPosition::new(
                setup_rect.x.round() as i32,
                setup_rect.y.round() as i32,
            );
            window
                .set_position(position)
                .map_err(|e| format!("cursor trail position: {e}"))?;
            window
                .set_size(PhysicalSize::new(
                    setup_rect.width.round().max(2.0) as u32,
                    setup_rect.height.round().max(2.0) as u32,
                ))
                .map_err(|e| format!("cursor trail size: {e}"))?;
            window
                .set_position(position)
                .map_err(|e| format!("cursor trail position: {e}"))?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            use tauri::{LogicalPosition, LogicalSize};
            window
                .set_size(LogicalSize::new(
                    setup_rect.width.round().max(2.0),
                    setup_rect.height.round().max(2.0),
                ))
                .map_err(|e| format!("cursor trail size: {e}"))?;
            window
                .set_position(LogicalPosition::new(
                    setup_rect.x.round(),
                    setup_rect.y.round(),
                ))
                .map_err(|e| format!("cursor trail position: {e}"))?;
        }
        window.set_focusable(false).map_err(|e| e.to_string())?;
        #[cfg(not(target_os = "linux"))]
        crate::cursor_track::set_ignore_cursor_events(&window, true)
            .map_err(|e| format!("cursor trail cursor events: {e}"))?;
        window
            .set_always_on_top(true)
            .map_err(|e| format!("cursor trail always-on-top: {e}"))?;
        #[cfg(target_os = "macos")]
        {
            if let Ok(ns_window) = window.ns_window() {
                unsafe {
                    if idle {
                        // Pointing at a full-screen presentation is the main
                        // use, and a window on one Space, or one that cannot
                        // join a full-screen Space, would stay behind it.
                        crate::annotation::join_all_spaces_including_fullscreen(ns_window);
                    }
                    crate::annotation::set_window_level_below_controls(ns_window);
                    if capturable {
                        set_window_sharing_readonly(ns_window);
                    } else {
                        set_window_sharing_none(ns_window);
                    }
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = capturable;
        window
            .show()
            .map_err(|e| format!("cursor trail show: {e}"))?;
        #[cfg(target_os = "linux")]
        crate::cursor_track::set_ignore_cursor_events(&window, true)
            .map_err(|e| format!("cursor trail cursor events: {e}"))?;
        Ok(())
    })
}

/// Set while a recording's Flare session has the overlay. The idle pointer
/// never shows or hides the window while it is set.
static RECORDING_OWNS_TRAIL: AtomicBool = AtomicBool::new(false);
/// Moves on every recording show and teardown of the overlay, so the idle
/// pointer can tell its placement was replaced or hidden under it.
static TRAIL_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Where the idle pointer put the overlay, for turning cursor positions into
/// points on its canvas.
#[derive(Clone, Copy, Debug)]
pub(crate) struct IdleTrailPlacement {
    pub rect: SourceHighlightRectDto,
    pub point_scale: f64,
    pub generation: u64,
}

pub(crate) fn recording_owns_cursor_trail() -> bool {
    RECORDING_OWNS_TRAIL.load(Ordering::SeqCst)
}

pub(crate) fn cursor_trail_generation() -> u64 {
    TRAIL_GENERATION.load(Ordering::SeqCst)
}

/// Show the overlay over one display for the pointer outside a recording.
/// It stays capturable: the point is that people watching a shared screen
/// in Meet, Slack or Zoom see it.
pub(crate) fn show_idle_cursor_trail<R: Runtime>(
    app: &AppHandle<R>,
    rect: SourceHighlightRectDto,
) -> Result<IdleTrailPlacement, String> {
    if rect.width < 2.0 || rect.height < 2.0 {
        return Err("display too small".to_string());
    }
    let generation = cursor_trail_generation();
    if recording_owns_cursor_trail() {
        return Err("a recording owns the cursor trail".to_string());
    }
    let point_scale = cursor_trail_point_scale(app, &rect);
    let _ = app.emit_to("cursor-trail", "annotation-clear", ());
    place_cursor_trail_window(app, &rect, point_scale, true, true)?;
    #[cfg(target_os = "windows")]
    raise_cursor_trail(app);
    Ok(IdleTrailPlacement {
        rect,
        point_scale,
        generation,
    })
}

/// Put the idle pointer's overlay away, unless a recording has taken it.
pub(crate) fn hide_idle_cursor_trail<R: Runtime>(app: &AppHandle<R>) {
    let app_for_hide = app.clone();
    let _ = app.run_on_main_thread(move || {
        if RECORDING_OWNS_TRAIL.load(Ordering::SeqCst) {
            return;
        }
        let _ = app_for_hide.emit_to("cursor-trail", "annotation-clear", ());
        if let Some(window) = app_for_hide.get_webview_window("cursor-trail") {
            let _ = crate::cursor_track::set_ignore_cursor_events(&window, true);
            let _ = window.hide();
        }
    });
}

/// Keep the idle pointer above windows raised after it (Windows orders
/// always-on-top windows by which was raised last).
#[cfg(target_os = "windows")]
pub(crate) fn raise_idle_cursor_trail<R: Runtime>(app: &AppHandle<R>) {
    if !recording_owns_cursor_trail() {
        raise_cursor_trail(app);
    }
}

pub(crate) fn show_cursor_trail_overlay<R: tauri::Runtime + 'static>(
    app: &AppHandle<R>,
    rect: SourceHighlightRectDto,
    capturable: bool,
) -> Result<(), String> {
    if rect.width < 2.0 || rect.height < 2.0 {
        return Ok(());
    }
    teardown_cursor_trail_overlay(app);
    CURSOR_TRAIL_ENABLED.store(false, Ordering::SeqCst);
    // From here the window is the recording's; the idle pointer backs off.
    RECORDING_OWNS_TRAIL.store(true, Ordering::SeqCst);
    TRAIL_GENERATION.fetch_add(1, Ordering::SeqCst);

    let point_scale = cursor_trail_point_scale(app, &rect);
    let overlay_origin = (rect.x, rect.y);
    let setup_app = app.clone();
    let _ = app.emit_to("cursor-trail", "annotation-clear", ());
    let _ = app.emit("annotation-mode", false);
    if let Err(err) = place_cursor_trail_window(app, &rect, point_scale, capturable, false) {
        RECORDING_OWNS_TRAIL.store(false, Ordering::SeqCst);
        return Err(err);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = stop.clone();
    let handle = std::thread::Builder::new()
        .name("clipy-cursor-trail".to_string())
        .spawn(move || {
            // Flare: while bare Control is held the pointer paints a trail,
            // pen or no pen. The overlay stays click-through, so this never
            // steals the mouse from the app being recorded; the sidecar
            // records the same Control hold, which is what the key-moment
            // fusion turns into a flare moment.
            let mut control_was_held = false;
            // Set when Control switched the pen on, so releasing Control
            // switches it back off; a pen the user toggled by hand stays.
            let mut control_armed_pen = false;
            #[cfg(target_os = "windows")]
            let mut flare_ticks: u32 = 0;
            while !stop_for_thread.load(Ordering::Relaxed) {
                if CURSOR_TRAIL_ENABLED.load(Ordering::SeqCst)
                    && crate::cursor_track::current_escape_key_active()
                {
                    CURSOR_TRAIL_ENABLED.store(false, Ordering::SeqCst);
                    if let Some(window) = setup_app.get_webview_window("cursor-trail") {
                        let _ = crate::cursor_track::set_ignore_cursor_events(&window, true);
                    }
                    let _ = setup_app.emit("annotation-mode", false);
                }
                let control_held = crate::cursor_track::current_control_key_active();
                // Re-raised as each flare starts and every quarter second
                // while it runs, so a window raised mid-flare cannot hide it.
                #[cfg(target_os = "windows")]
                if control_held || CURSOR_TRAIL_ENABLED.load(Ordering::SeqCst) {
                    if (control_held && !control_was_held) || flare_ticks % 16 == 0 {
                        raise_cursor_trail(&setup_app);
                    }
                    flare_ticks = flare_ticks.wrapping_add(1);
                } else {
                    flare_ticks = 0;
                }
                // Holding Control IS annotating: the pen comes on for the
                // hold (dock shows it, palette colour and width apply) and
                // every mouse move draws, no button needed. The overlay
                // stays click-through so the app underneath keeps the mouse.
                if control_held && !control_was_held {
                    crate::whats_new::mark_tried(&setup_app, "flare");
                }
                if control_held && !control_was_held && !CURSOR_TRAIL_ENABLED.load(Ordering::SeqCst) {
                    CURSOR_TRAIL_ENABLED.store(true, Ordering::SeqCst);
                    control_armed_pen = true;
                    let _ = setup_app.emit("annotation-mode", true);
                }
                if !control_held && control_was_held && control_armed_pen {
                    CURSOR_TRAIL_ENABLED.store(false, Ordering::SeqCst);
                    control_armed_pen = false;
                    let _ = setup_app.emit("annotation-mode", false);
                }
                if control_held {
                    if let Some((x, y)) = crate::cursor_track::current_cursor_position() {
                        let _ = setup_app.emit_to(
                            "cursor-trail",
                            "cursor-trail-point",
                            serde_json::json!({
                                "x": (x as f64 - overlay_origin.0) / point_scale,
                                "y": (y as f64 - overlay_origin.1) / point_scale,
                                "visible": true,
                            }),
                        );
                    }
                } else if control_was_held {
                    // Lift the pen between holds so the next sweep starts a
                    // fresh stroke instead of joining the last one.
                    let _ = setup_app.emit_to(
                        "cursor-trail",
                        "cursor-trail-point",
                        serde_json::json!({ "x": 0, "y": 0, "visible": false }),
                    );
                }
                control_was_held = control_held;
                std::thread::sleep(Duration::from_millis(16));
            }
        })
        .map_err(|e| format!("cursor trail thread: {e}"))?;

    *cursor_trail_session().lock() = Some(CursorTrailSession {
        stop,
        handle: Some(handle),
    });
    Ok(())
}

pub(crate) fn teardown_cursor_trail_overlay<R: tauri::Runtime>(app: &AppHandle<R>) {
    // Hidden below whoever had it, the idle pointer included, so it has to
    // place the window again before its next stroke.
    RECORDING_OWNS_TRAIL.store(false, Ordering::SeqCst);
    TRAIL_GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(mut session) = cursor_trail_session().lock().take() {
        CURSOR_TRAIL_ENABLED.store(false, Ordering::SeqCst);
        session.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = session.handle.take() {
            if handle.join().is_err() {
                tracing::warn!("cursor trail thread panicked while stopping");
            }
        }
    }

    let _ = app.emit("annotation-mode", false);
    let _ = app.emit_to("cursor-trail", "annotation-clear", ());
    let app_for_hide = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = app_for_hide.get_webview_window("cursor-trail") {
            let _ = crate::cursor_track::set_ignore_cursor_events(&window, true);
            let _ = window.hide();
        }
    });
}

/// Keep an overlay window inside the monitor's work area — the region that
/// excludes the macOS Dock and menu bar. Positions derived from the raw
/// monitor/source frame land inside the Dock's strip, and the Dock sits at a
/// higher window level than "always on top", so it covers them — in the
/// recording as well as on screen. Used by the recording controls and the
/// webcam bubble (its default position was half-swallowed by the Dock).
/// Scale factor of the monitor containing a point given in PHYSICAL pixels.
///
/// Windows-only because it exists to translate WGC/Win32 geometry; macOS hands
/// us logical sizes already and never needs the conversion.
#[cfg(target_os = "windows")]
pub(crate) fn monitor_scale_for_physical_point<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    x: f64,
    y: f64,
) -> Option<f64> {
    for monitor in window.available_monitors().ok()? {
        let position = monitor.position();
        let size = monitor.size();
        let (mx, my) = (position.x as f64, position.y as f64);
        let (mw, mh) = (size.width as f64, size.height as f64);
        if x >= mx && x < mx + mw && y >= my && y < my + mh {
            let scale = monitor.scale_factor();
            if scale > 0.0 {
                return Some(scale);
            }
        }
    }
    None
}

/// Bring a capture-source rect into the LOGICAL units that the overlay layout
/// math and `set_position(LogicalPosition)` both speak.
///
/// UNITS DIFFER BY PLATFORM, because the rects do — the same split that
/// `show_source_highlight` documents. Windows source geometry comes from
/// WGC/Win32 (`Monitor::width()`, `GetWindowRect`) and is physical pixels;
/// macOS reports logical sizes and is already correct.
///
/// Feeding the physical rect into the layout math is what hid the camera on
/// scaled displays. Every layout anchored to a FAR edge computes
/// `source.x + source.width - camera_width - margin`, so on a 150% display the
/// Right and Bottom cameras were placed at 1.5x the real screen extent and
/// landed entirely off-screen. Left, Top and a dragged bubble start from the
/// near edge, so they stayed visible and the bug looked layout-specific.
/// Converting once here keeps the whole downstream chain — layout math,
/// remembered drag positions, `clamp_to_work_area` — in one coordinate space.
#[cfg(target_os = "windows")]
fn source_rect_to_logical<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    rect: SourceHighlightRectDto,
) -> SourceHighlightRectDto {
    let scale = monitor_scale_for_physical_point(
        window,
        rect.x + rect.width / 2.0,
        rect.y + rect.height / 2.0,
    )
    .or_else(|| window.scale_factor().ok())
    .unwrap_or(1.0);
    if scale <= 0.0 {
        return rect;
    }
    SourceHighlightRectDto {
        x: rect.x / scale,
        y: rect.y / scale,
        width: rect.width / scale,
        height: rect.height / scale,
    }
}

#[cfg(not(target_os = "windows"))]
fn source_rect_to_logical<R: Runtime>(
    _window: &tauri::WebviewWindow<R>,
    rect: SourceHighlightRectDto,
) -> SourceHighlightRectDto {
    rect
}

/// Breathing room every clamped window keeps from a screen edge.
const EDGE_MARGIN: f64 = 12.0;

fn clamp_to_work_area<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let Ok(monitors) = window.available_monitors() else {
        return (x, y);
    };
    let center_x = x + width / 2.0;
    let center_y = y + height / 2.0;

    let mut fallback = None;
    for monitor in monitors {
        let scale = monitor.scale_factor();
        if scale <= 0.0 {
            continue;
        }
        let frame_x = monitor.position().x as f64 / scale;
        let frame_y = monitor.position().y as f64 / scale;
        let frame_w = monitor.size().width as f64 / scale;
        let frame_h = monitor.size().height as f64 / scale;
        let contains = center_x >= frame_x
            && center_x < frame_x + frame_w
            && center_y >= frame_y
            && center_y < frame_y + frame_h;
        if contains {
            return clamp_into_monitor(&monitor, x, y, width, height, EDGE_MARGIN);
        }
        if fallback.is_none() {
            fallback = Some(monitor);
        }
    }

    // No monitor contains the window's centre, which means it is entirely
    // off-screen — exactly the case that most needs clamping. This used to
    // return the position untouched, so a bad layout produced a camera the user
    // simply could not see, with no error anywhere. Pull it onto a real screen
    // instead; a camera in the wrong corner is recoverable, an invisible one is
    // not.
    let anchor = window
        .primary_monitor()
        .ok()
        .flatten()
        .filter(|monitor| monitor.scale_factor() > 0.0)
        .or(fallback);
    match anchor {
        Some(monitor) => clamp_into_monitor(&monitor, x, y, width, height, EDGE_MARGIN),
        None => (x, y),
    }
}

fn clamp_into_monitor(
    monitor: &tauri::Monitor,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    edge_margin: f64,
) -> (f64, f64) {
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return (x, y);
    }
    let work = monitor.work_area();
    let work_x = work.position.x as f64 / scale;
    let work_y = work.position.y as f64 / scale;
    let work_w = work.size.width as f64 / scale;
    let work_h = work.size.height as f64 / scale;
    let min_x = work_x + edge_margin;
    let max_x = (work_x + work_w - width - edge_margin).max(min_x);
    let min_y = work_y + edge_margin;
    let max_y = (work_y + work_h - height - edge_margin).max(min_y);
    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

pub(crate) fn set_recording_controls_layout_for_rect(
    app: &AppHandle,
    rect: Option<SourceHighlightRectDto>,
    webcam: Option<WebcamCaptureDto>,
) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize, Manager};

    let window = app
        .get_webview_window("stop-controls")
        .ok_or_else(|| "recording controls window missing".to_string())?;

    let (width, height, x, y) =
        if let Some(source) = rect
            .filter(|r| r.width >= 2.0 && r.height >= 2.0)
            .map(|r| source_rect_to_logical(&window, r))
        {
            recording_controls_layout_in_source(source, webcam.as_ref())
        } else if let Ok(Some(monitor)) = window.primary_monitor() {
            let scale = monitor.scale_factor();
            let origin = monitor.position();
            let size = monitor.size();
            let logical_height = size.height as f64 / scale;
            (
                RECORDING_CONTROLS_WIDTH,
                RECORDING_CONTROLS_HEIGHT,
                origin.x as f64 / scale + RECORDING_CONTROLS_MARGIN,
                origin.y as f64 / scale + (logical_height - RECORDING_CONTROLS_HEIGHT) / 2.0,
            )
        } else {
            (
                RECORDING_CONTROLS_WIDTH,
                RECORDING_CONTROLS_HEIGHT,
                80.0,
                80.0,
            )
        };

    let (x, y) = clamp_to_work_area(&window, x, y, width, height);
    crate::recording_controls::forget_notch(app);

    window
        .set_size(LogicalSize::new(width.round(), height))
        .map_err(|e| format!("recording controls size: {e}"))?;
    window
        .set_position(LogicalPosition::new(x.round(), y.round()))
        .map_err(|e| format!("recording controls position: {e}"))?;
    crate::cursor_track::set_ignore_cursor_events(&window, false)
        .map_err(|e| format!("recording controls cursor events: {e}"))?;
    window
        .set_always_on_top(true)
        .map_err(|e| format!("recording controls always-on-top: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns_window) = window.ns_window() {
            // SAFETY: same NSWindow sharing call used by the webcam bubble;
            // this keeps the live stop controls out of display captures.
            unsafe { set_window_sharing_none(ns_window) };
        }
    }
    #[cfg(target_os = "windows")]
    exclude_window_from_capture(&window);
    Ok(())
}

#[tauri::command]
pub fn set_recording_controls_layout(
    app: AppHandle,
    rect: Option<SourceHighlightRectDto>,
    webcam: Option<WebcamCaptureDto>,
) -> Result<(), String> {
    set_recording_controls_layout_for_rect(&app, rect, webcam)
}

// Vertical, left-edge dock. The controls used to
// be a wide horizontal pill along the bottom; a tall narrow column on the
// left costs far less of the recorded frame and is where users now look for
// it. Buttons stay large — fiddly 32px targets made the old pill "very hard
// to drag".
const RECORDING_CONTROLS_MARGIN: f64 = 22.0;
const RECORDING_CONTROLS_GAP: f64 = 10.0;
const RECORDING_CONTROLS_WIDTH: f64 = 64.0;
const RECORDING_CONTROLS_MIN_WIDTH: f64 = 56.0;
const RECORDING_CONTROLS_HEIGHT: f64 = 396.0;

fn recording_controls_layout_in_source(
    source: SourceHighlightRectDto,
    webcam: Option<&WebcamCaptureDto>,
) -> (f64, f64, f64, f64) {
    // The dock's height is FIXED. It holds a non-scrolling stack of
    // controls, so shrinking it to fit a short capture area clipped Stop
    // out of reach — and a small enough area clipped everything. It is
    // excluded from the capture (`set_window_sharing_none`), so overflowing
    // the source costs nothing; `clamp_to_work_area` in the caller is what
    // keeps it on screen.
    let height = RECORDING_CONTROLS_HEIGHT;
    let width = RECORDING_CONTROLS_WIDTH
        .min((source.width - RECORDING_CONTROLS_MARGIN).max(1.0))
        .max(RECORDING_CONTROLS_MIN_WIDTH);

    // Left edge, vertically centered in the recorded source. A camera parked
    // on the left is the only layout that collides with that, so it is the
    // only one that pushes the dock aside — bubble/right/top/bottom cameras
    // never overlap it.
    let camera_on_the_left = webcam
        .filter(|webcam| webcam.enabled && matches!(webcam.layout, WebcamLayoutDto::Left))
        .map(|webcam| webcam_layout_in_source(webcam.layout, webcam.shape, webcam.size, source));
    let x = match camera_on_the_left {
        Some((cam_width, _, cam_x, _)) => cam_x + cam_width + RECORDING_CONTROLS_GAP,
        None => source.x + RECORDING_CONTROLS_MARGIN,
    };
    let y = source.y + (source.height - height) / 2.0;
    (
        width,
        height,
        clamp_to_source_x(source, x, width),
        clamp_to_source_y(source, y, height),
    )
}

fn webcam_layout_in_source(
    layout: WebcamLayoutDto,
    shape: WebcamShapeDto,
    size: WebcamSizeDto,
    source: SourceHighlightRectDto,
) -> (f64, f64, f64, f64) {
    let margin = 28.0;
    let scale = match size {
        WebcamSizeDto::Small => 0.78,
        WebcamSizeDto::Medium => 1.0,
        WebcamSizeDto::Large => 1.25,
    };
    match layout {
        WebcamLayoutDto::Bubble => {
            // Against `base_height` of 300 these are 225 / 300 / 450 points.
            // Medium was 1.25 (375pt) and is the default size, which made the
            // bubble the loudest thing on screen the first time the camera is
            // switched on; a fifth smaller still reads as the middle of the
            // three and sits between Small and Large by a clear margin.
            let scale = match size {
                WebcamSizeDto::Small => 0.75,
                WebcamSizeDto::Medium => 1.0,
                WebcamSizeDto::Large => 1.5,
            };
            let aspect = if shape == WebcamShapeDto::Pill {
                1.45
            } else {
                1.0
            };
            let available = (source.height - margin * 2.0)
                .min((source.width - margin * 2.0) / aspect)
                .max(120.0);
            let base_height = 300.0_f64.min(available / 1.5);
            let height = (base_height * scale).max(120.0).min(available);
            let width = height * aspect;
            (
                width,
                height,
                source.x + source.width - width - margin,
                source.y + source.height - height - margin,
            )
        }
        WebcamLayoutDto::Left => {
            let width = ((source.width * 0.22).clamp(190.0, 320.0) * scale).min(source.width * 0.4);
            let height =
                ((source.height * 0.52).clamp(260.0, 520.0) * scale).min(source.height * 0.82);
            (
                width,
                height,
                source.x + margin,
                source.y + (source.height - height) / 2.0,
            )
        }
        WebcamLayoutDto::Right => {
            let width = ((source.width * 0.22).clamp(190.0, 320.0) * scale).min(source.width * 0.4);
            let height =
                ((source.height * 0.52).clamp(260.0, 520.0) * scale).min(source.height * 0.82);
            (
                width,
                height,
                source.x + source.width - width - margin,
                source.y + (source.height - height) / 2.0,
            )
        }
        WebcamLayoutDto::Top => {
            let width =
                ((source.width * 0.42).clamp(260.0, 560.0) * scale).min(source.width * 0.82);
            let height =
                ((source.height * 0.24).clamp(170.0, 300.0) * scale).min(source.height * 0.4);
            (
                width,
                height,
                source.x + (source.width - width) / 2.0,
                source.y + margin,
            )
        }
        WebcamLayoutDto::Bottom => {
            let width =
                ((source.width * 0.42).clamp(260.0, 560.0) * scale).min(source.width * 0.82);
            let height =
                ((source.height * 0.24).clamp(170.0, 300.0) * scale).min(source.height * 0.4);
            (
                width,
                height,
                source.x + (source.width - width) / 2.0,
                source.y + source.height - height - margin,
            )
        }
    }
}

/// The bubble's live logical size, or `None` before it has one to grow from.
fn current_webcam_box<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Option<(f64, f64)> {
    let scale = window.scale_factor().ok()?;
    if scale <= 0.0 {
        return None;
    }
    let size = window.outer_size().ok()?.to_logical::<f64>(scale);
    (size.width > 0.0 && size.height > 0.0).then_some((size.width, size.height))
}

/// Place a resized bubble so its bottom centre stays put. `previous` is the
/// size it is growing from, and is `None` whenever the old box is not the same
/// layout's box (a dock switch, or the very first placement) — then the
/// remembered top-left is used unchanged, as it was before.
fn anchor_webcam_frame(
    frame: WebcamWindowFrame,
    previous: Option<(f64, f64)>,
    width: f64,
    height: f64,
) -> (f64, f64) {
    match previous {
        Some((previous_width, previous_height)) => (
            frame.x + (previous_width - width) / 2.0,
            frame.y + previous_height - height,
        ),
        None => (frame.x, frame.y),
    }
}

fn clamp_webcam_frame_to_source(
    source: SourceHighlightRectDto,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let margin = 8.0;
    let min_x = source.x + margin;
    let max_x = source.x + source.width - width - margin;
    let min_y = source.y + margin;
    let max_y = source.y + source.height - height - margin;
    let clamped_x = if max_x <= min_x {
        min_x
    } else {
        x.clamp(min_x, max_x)
    };
    let clamped_y = if max_y <= min_y {
        min_y
    } else {
        y.clamp(min_y, max_y)
    };
    (clamped_x, clamped_y)
}

fn clamp_to_source_x(source: SourceHighlightRectDto, x: f64, width: f64) -> f64 {
    let min_x = source.x + RECORDING_CONTROLS_MARGIN;
    let max_x = source.x + source.width - width - RECORDING_CONTROLS_MARGIN;
    if max_x <= min_x {
        min_x
    } else {
        x.clamp(min_x, max_x)
    }
}

fn clamp_to_source_y(source: SourceHighlightRectDto, y: f64, height: f64) -> f64 {
    let min_y = source.y + RECORDING_CONTROLS_MARGIN;
    let max_y = source.y + source.height - height - RECORDING_CONTROLS_MARGIN;
    if max_y <= min_y {
        min_y
    } else {
        y.clamp(min_y, max_y)
    }
}

#[cfg(test)]
mod popover_height_tests {
    use super::*;

    #[test]
    fn the_designed_sheet_is_the_floor() {
        // Nothing the frontend measures may shrink the popover below the size
        // it was drawn at — an under-measurement must not clip the recorder.
        assert_eq!(popover_height_within(0.0, Some(1080.0)), POPOVER_MIN_HEIGHT);
        assert_eq!(
            popover_height_within(POPOVER_MIN_HEIGHT - 50.0, Some(1080.0)),
            POPOVER_MIN_HEIGHT
        );
    }

    #[test]
    fn content_buys_height_up_to_the_static_cap() {
        assert_eq!(popover_height_within(520.4, Some(1080.0)), 520.0);
        assert_eq!(
            popover_height_within(POPOVER_MAX_HEIGHT + 400.0, Some(1080.0)),
            POPOVER_MAX_HEIGHT
        );
    }

    #[test]
    fn a_short_work_area_caps_it_lower() {
        // A laptop running a tall taskbar: the sheet may not grow into space
        // the position clamp then has to take back.
        let applied = popover_height_within(POPOVER_MAX_HEIGHT, Some(600.0));
        assert_eq!(applied, 600.0 - 2.0 * EDGE_MARGIN);
        assert!(applied < POPOVER_MAX_HEIGHT);
    }

    #[test]
    fn a_work_area_shorter_than_the_sheet_still_gets_the_sheet() {
        assert_eq!(popover_height_within(560.0, Some(300.0)), POPOVER_MIN_HEIGHT);
    }

    #[test]
    fn an_unreadable_monitor_falls_back_to_the_static_cap() {
        assert_eq!(popover_height_within(560.0, None), 560.0);
        assert_eq!(
            popover_height_within(POPOVER_MAX_HEIGHT + 1.0, None),
            POPOVER_MAX_HEIGHT
        );
    }
}

#[cfg(test)]
mod recording_controls_tests {
    use super::*;

    #[test]
    fn a_resized_bubble_keeps_its_bottom_centre() {
        // Small (225pt tall) to a larger bubble at the same layout: the hover
        // pill hangs off the bottom edge, so that edge must not move. The
        // numbers here are geometry, not the size table.
        let (x, y) = anchor_webcam_frame(
            WebcamWindowFrame { x: 900.0, y: 500.0 },
            Some((225.0, 225.0)),
            375.0,
            375.0,
        );
        assert_eq!(x, 825.0);
        assert_eq!(y, 350.0);
        assert_eq!(y + 375.0, 500.0 + 225.0);
        assert_eq!(x + 375.0 / 2.0, 900.0 + 225.0 / 2.0);
    }

    #[test]
    fn a_shrinking_bubble_keeps_its_bottom_centre_too() {
        let (x, y) = anchor_webcam_frame(
            WebcamWindowFrame { x: 825.0, y: 350.0 },
            Some((375.0, 375.0)),
            225.0,
            225.0,
        );
        assert_eq!(y + 225.0, 350.0 + 375.0);
        assert_eq!(x + 225.0 / 2.0, 825.0 + 375.0 / 2.0);
    }

    #[test]
    fn an_unchanged_size_leaves_the_bubble_exactly_where_it_was() {
        let (x, y) = anchor_webcam_frame(
            WebcamWindowFrame { x: 900.0, y: 500.0 },
            Some((300.0, 300.0)),
            300.0,
            300.0,
        );
        assert_eq!((x, y), (900.0, 500.0));
    }

    #[test]
    fn a_dock_switch_uses_the_remembered_top_left_unchanged() {
        // No previous box means the old rect belongs to another layout (or the
        // bubble has never been placed) — anchoring to it would misplace it.
        let (x, y) = anchor_webcam_frame(WebcamWindowFrame { x: 40.0, y: 120.0 }, None, 300.0, 520.0);
        assert_eq!((x, y), (40.0, 120.0));
    }

    #[test]
    fn recording_controls_dock_to_source_left_center_without_webcam() {
        let (width, height, x, y) = recording_controls_layout_in_source(
            SourceHighlightRectDto {
                x: 100.0,
                y: 50.0,
                width: 1200.0,
                height: 800.0,
            },
            None,
        );

        assert_eq!(width, RECORDING_CONTROLS_WIDTH);
        assert_eq!(height, 396.0);
        assert_eq!(x, 122.0);
        assert_eq!(y, 252.0);
    }

    #[test]
    fn recording_controls_keep_the_left_edge_next_to_a_webcam_bubble() {
        let (width, height, x, y) = recording_controls_layout_in_source(
            SourceHighlightRectDto {
                x: 0.0,
                y: 0.0,
                width: 1680.0,
                height: 1050.0,
            },
            Some(&WebcamCaptureDto {
                enabled: true,
                layout: WebcamLayoutDto::Bubble,
                shape: WebcamShapeDto::Square,
                size: WebcamSizeDto::Medium,
                device_id: None,
            }),
        );

        assert_eq!(width, RECORDING_CONTROLS_WIDTH);
        assert_eq!(height, 396.0);
        assert_eq!(x, 22.0);
        assert_eq!(y, 327.0);
    }

    #[test]
    fn floating_webcam_shape_and_size_change_the_window_geometry() {
        let source = SourceHighlightRectDto {
            x: 0.0,
            y: 0.0,
            width: 1680.0,
            height: 1050.0,
        };

        let (square_width, square_height, _, _) = webcam_layout_in_source(
            WebcamLayoutDto::Bubble,
            WebcamShapeDto::Square,
            WebcamSizeDto::Medium,
            source,
        );
        let (pill_width, pill_height, _, _) = webcam_layout_in_source(
            WebcamLayoutDto::Bubble,
            WebcamShapeDto::Pill,
            WebcamSizeDto::Medium,
            source,
        );
        let (large_width, large_height, _, _) = webcam_layout_in_source(
            WebcamLayoutDto::Bubble,
            WebcamShapeDto::Circle,
            WebcamSizeDto::Large,
            source,
        );

        assert_eq!((square_width, square_height), (300.0, 300.0));
        assert_eq!((pill_width, pill_height), (435.0, 300.0));
        assert_eq!((large_width, large_height), (450.0, 450.0));
        let (small_width, small_height, _, _) = webcam_layout_in_source(
            WebcamLayoutDto::Bubble,
            WebcamShapeDto::Square,
            WebcamSizeDto::Small,
            source,
        );
        assert_eq!((small_width, small_height), (225.0, 225.0));

        // The default is Medium, and asserting it here is what stops the
        // default and the size table drifting apart: the previous version of
        // this test read `WebcamSizeDto::default()` and called the result
        // "small", so a changed default would have silently rewritten what the
        // test claimed to check.
        let (default_width, default_height, _, _) = webcam_layout_in_source(
            WebcamLayoutDto::Bubble,
            WebcamShapeDto::Square,
            WebcamSizeDto::default(),
            source,
        );
        assert_eq!((default_width, default_height), (300.0, 300.0));
    }

    #[test]
    fn floating_webcam_sizes_remain_distinct_on_small_capture_areas() {
        for height in [360.0, 540.0, 720.0, 1080.0] {
            let source = SourceHighlightRectDto {
                x: 0.0,
                y: 0.0,
                width: 960.0,
                height,
            };
            let heights = [
                WebcamSizeDto::Small,
                WebcamSizeDto::Medium,
                WebcamSizeDto::Large,
            ]
            .map(|size| {
                webcam_layout_in_source(
                    WebcamLayoutDto::Bubble,
                    WebcamShapeDto::Circle,
                    size,
                    source,
                )
                .1
            });
            assert!(
                heights[0] < heights[1] && heights[1] < heights[2],
                "{height}: {heights:?}"
            );
            assert!(heights[0] >= 120.0);
            assert!(heights[2] <= source.height - 56.0);
        }
    }

    /// Every layout must land wholly inside the capture source.
    ///
    /// Right and Bottom are the layouts anchored to a FAR edge
    /// (`source.x + source.width - camera - margin`), which is why they were
    /// the two the user saw vanish: feeding them a Windows PHYSICAL-pixel rect
    /// while positioning the window in LOGICAL units multiplied that far edge
    /// by the display's DPI factor and pushed the camera off-screen. Left and
    /// Top measure from the near edge, so the same bad rect left them visible
    /// and made the fault look layout-specific.
    ///
    /// This pins the invariant the conversion exists to preserve: given a rect
    /// in the units the layout math expects, no layout escapes the source at
    /// any size, on a scaled display or otherwise.
    #[test]
    fn no_webcam_layout_escapes_the_capture_source() {
        // 1920x1080 at 100%, and the same panel's logical size at 125%/150%/175%.
        for (width, height) in [
            (1920.0, 1080.0),
            (1536.0, 864.0),
            (1280.0, 720.0),
            (1097.0, 617.0),
        ] {
            let source = SourceHighlightRectDto {
                x: 0.0,
                y: 0.0,
                width,
                height,
            };
            for layout in [
                WebcamLayoutDto::Bubble,
                WebcamLayoutDto::Left,
                WebcamLayoutDto::Right,
                WebcamLayoutDto::Top,
                WebcamLayoutDto::Bottom,
            ] {
                for size in [
                    WebcamSizeDto::Small,
                    WebcamSizeDto::Medium,
                    WebcamSizeDto::Large,
                ] {
                    let (w, h, x, y) =
                        webcam_layout_in_source(layout, WebcamShapeDto::Circle, size, source);
                    assert!(
                        x >= source.x && y >= source.y,
                        "{layout:?}/{size:?} at {width}x{height}: origin ({x}, {y}) is outside the source"
                    );
                    assert!(
                        x + w <= source.x + source.width + 0.5,
                        "{layout:?}/{size:?} at {width}x{height}: right edge {} exceeds {}",
                        x + w,
                        source.x + source.width
                    );
                    assert!(
                        y + h <= source.y + source.height + 0.5,
                        "{layout:?}/{size:?} at {width}x{height}: bottom edge {} exceeds {}",
                        y + h,
                        source.y + source.height
                    );
                }
            }
        }
    }

    #[test]
    fn only_a_left_webcam_pushes_the_recording_controls_off_the_left_edge() {
        let source = SourceHighlightRectDto {
            x: 0.0,
            y: 0.0,
            width: 1680.0,
            height: 1050.0,
        };

        for (layout, expected_x, expected_y) in [
            (WebcamLayoutDto::Bubble, 22.0, 327.0),
            (WebcamLayoutDto::Left, 358.0, 327.0),
            (WebcamLayoutDto::Right, 22.0, 327.0),
            (WebcamLayoutDto::Top, 22.0, 327.0),
            (WebcamLayoutDto::Bottom, 22.0, 327.0),
        ] {
            let (width, height, x, y) = recording_controls_layout_in_source(
                source,
                Some(&WebcamCaptureDto {
                    enabled: true,
                    layout,
                    shape: WebcamShapeDto::Square,
                    size: WebcamSizeDto::Medium,
                    device_id: None,
                }),
            );

            assert_eq!(width, RECORDING_CONTROLS_WIDTH);
            assert_eq!(height, RECORDING_CONTROLS_HEIGHT);
            assert_eq!((layout, x, y), (layout, expected_x, expected_y));
        }
    }

    #[test]
    fn recording_controls_ignore_disabled_webcam_layout() {
        let (width, height, x, y) = recording_controls_layout_in_source(
            SourceHighlightRectDto {
                x: 0.0,
                y: 0.0,
                width: 1680.0,
                height: 1050.0,
            },
            Some(&WebcamCaptureDto {
                enabled: false,
                layout: WebcamLayoutDto::Left,
                shape: WebcamShapeDto::Square,
                size: WebcamSizeDto::Medium,
                device_id: None,
            }),
        );

        assert_eq!(width, RECORDING_CONTROLS_WIDTH);
        assert_eq!(height, RECORDING_CONTROLS_HEIGHT);
        assert_eq!(x, 22.0);
        assert_eq!(y, 327.0);
    }

    #[test]
    fn recording_controls_keep_full_height_on_short_sources() {
        // A wide, short custom area used to shrink the dock to 156px and
        // clip Stop out of the window. It now keeps full height and
        // overflows the area instead.
        let (width, height, x, y) = recording_controls_layout_in_source(
            SourceHighlightRectDto {
                x: 20.0,
                y: 10.0,
                width: 300.0,
                height: 200.0,
            },
            None,
        );

        assert_eq!(width, RECORDING_CONTROLS_WIDTH);
        assert_eq!(height, RECORDING_CONTROLS_HEIGHT);
        assert_eq!(x, 42.0);
        assert_eq!(y, 32.0);
    }

    #[test]
    fn recording_controls_stay_whole_on_a_tiny_source() {
        let (width, height, ..) = recording_controls_layout_in_source(
            SourceHighlightRectDto {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 40.0,
            },
            None,
        );

        assert_eq!(height, RECORDING_CONTROLS_HEIGHT);
        assert_eq!(width, RECORDING_CONTROLS_WIDTH);
    }

    #[test]
    fn recording_controls_keep_dock_width_for_narrow_sources() {
        let (width, _, x, _) = recording_controls_layout_in_source(
            SourceHighlightRectDto {
                x: 20.0,
                y: 10.0,
                width: 200.0,
                height: 900.0,
            },
            None,
        );

        assert_eq!(width, RECORDING_CONTROLS_WIDTH);
        assert_eq!(x, 42.0);
    }
}

/// Place a window at a rect in PHYSICAL virtual-desktop pixels (Windows).
///
/// Position goes first: moving onto a display with a different DPI makes
/// Windows rescale the window (WM_DPICHANGED), so a size set before the move
/// would be scaled away. Sizing after the move and re-asserting the position
/// leaves the window exactly on the rect on mixed-DPI setups.
#[cfg(target_os = "windows")]
pub(crate) fn place_window_physical<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> tauri::Result<()> {
    use tauri::{PhysicalPosition, PhysicalSize};

    window.set_position(PhysicalPosition::new(x, y))?;
    window.set_size(PhysicalSize::new(width.max(2), height.max(2)))?;
    window.set_position(PhysicalPosition::new(x, y))
}

#[tauri::command]
pub fn show_source_highlight(app: AppHandle, rect: SourceHighlightRectDto) -> Result<(), String> {
    use tauri::Manager;
    #[cfg(not(target_os = "windows"))]
    use tauri::{LogicalPosition, LogicalSize};

    if rect.width < 2.0 || rect.height < 2.0 {
        return Ok(());
    }
    // The recording frame is not the picker's to restyle or move.
    if REGION_FRAME_ACTIVE.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }

    let window = app
        .get_webview_window("source-highlight")
        .ok_or_else(|| "source highlight window missing".to_string())?;
    // The same window doubles as the Custom size frame during a take, which
    // switches it to the quiet recording style; put the picker pulse back.
    let _ = app.emit_to("source-highlight", EVENT_SOURCE_HIGHLIGHT_STYLE, "preview");
    let x = rect.x.round();
    let y = rect.y.round();
    let width = rect.width.round().max(2.0);
    let height = rect.height.round().max(2.0);

    // UNITS DIFFER BY PLATFORM, because the rects do.
    //
    // Windows source geometry comes from WGC/Win32, which are physical pixels
    // (`Monitor::width()`, `GetWindowRect`). Passing those as LOGICAL made
    // Tauri scale them by the display's DPI factor, so on a scaled display the
    // frame was drawn ~1.25-1.5x too large — its right and bottom edges fell
    // off-screen and only the top-left corner was visible.
    //
    // macOS reports logical sizes (`display_logical_size`), so it must keep
    // using logical here.
    #[cfg(target_os = "windows")]
    place_window_physical(&window, x as i32, y as i32, width as u32, height as u32)
        .map_err(|e| format!("highlight placement: {e}"))?;
    #[cfg(not(target_os = "windows"))]
    {
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| format!("highlight size: {e}"))?;
        window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| format!("highlight position: {e}"))?;
    }
    window
        .set_always_on_top(true)
        .map_err(|e| format!("highlight always-on-top: {e}"))?;
    crate::cursor_track::set_ignore_cursor_events(&window, true)
        .map_err(|e| format!("highlight ignore cursor: {e}"))?;
    // `show()` is makeKeyAndOrderFront on macOS. The popover's source
    // highlight follows the popover's focus, so a highlight window that
    // takes key status hides itself, hands focus back, shows again, and
    // flickers at event-loop speed. Never let it become key.
    window
        .set_focusable(false)
        .map_err(|e| format!("highlight focusable: {e}"))?;
    window.show().map_err(|e| format!("highlight show: {e}"))?;
    // The window picker's hover poll calls this from a blocking worker, and
    // AppKit window calls belong on the main thread. Queued behind the
    // `set_always_on_top` above, which would otherwise reset the level.
    #[cfg(target_os = "macos")]
    {
        let level_window = window.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(ns_window) = level_window.ns_window() {
                // SAFETY: live NSWindow owned by Tauri, on the main thread.
                unsafe { raise_above_menu_bar(ns_window) };
            }
        });
    }
    Ok(())
}

/// Width of the menu-bar popover, matching `app.windows[label="main"].width`
/// in tauri.conf.json.
const POPOVER_WIDTH: f64 = 340.0;
/// The height the sheet is authored at, matching that same window entry.
/// `set_popover_height` never goes below it, so the designed sheet is the
/// floor and content only ever buys extra room.
const POPOVER_MIN_HEIGHT: f64 = 503.0;
/// Past this the content column scrolls again rather than the popover
/// swallowing the screen. It was 660 when the sheet was drawn at 87%; 760
/// keeps the same amount of content on screen now that it is drawn 1:1.
const POPOVER_MAX_HEIGHT: f64 = 760.0;

/// The height the popover may actually take, given what the sheet asked for
/// and how much room the work area leaves. `work_height` is `None` when the
/// monitor is unreadable, which falls back to the static cap.
fn popover_height_within(wanted: f64, work_height: Option<f64>) -> f64 {
    let max = work_height
        .map(|h| POPOVER_MAX_HEIGHT.min(h - 2.0 * EDGE_MARGIN))
        .unwrap_or(POPOVER_MAX_HEIGHT)
        // A screen shorter than the sheet still gets the sheet: clipping it is
        // the lesser evil against handing back a stub of a recorder.
        .max(POPOVER_MIN_HEIGHT);
    wanted.clamp(POPOVER_MIN_HEIGHT, max).round()
}

/// Size the menu-bar popover to the height its content actually needs.
///
/// The sheet is authored against macOS font metrics; Windows renders the same
/// markup taller, so a fixed height left the content column scrolling inside a
/// popover that had room to simply be taller.
///
/// Resizing and repositioning are one command on purpose: the popover is
/// clamped into the work area, so a height change without a matching clamp
/// grows the bottom of the sheet behind the taskbar.
///
/// Returns the height actually applied. The caller sizes the sheet from that
/// rather than from what it asked for, so the clamps live in one place.
#[tauri::command]
pub fn set_popover_height(app: AppHandle, height: f64) -> Result<f64, String> {
    use tauri::{LogicalPosition, LogicalSize};

    if !height.is_finite() {
        return Err("popover height must be a finite number".to_string());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;

    // The work area is the real ceiling — a popover taller than the screen
    // cannot be placed anywhere useful.
    let work_height = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .map(|monitor| {
            monitor.work_area().size.height as f64 / monitor.scale_factor().max(f64::EPSILON)
        });

    // Where it is now, before the resize moves the bottom edge.
    let scale = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
    let origin = window
        .outer_position()
        .ok()
        .map(|p| (p.x as f64 / scale, p.y as f64 / scale));

    let applied = popover_height_within(height, work_height);
    window
        .set_size(LogicalSize::new(POPOVER_WIDTH, applied))
        .map_err(|e| format!("popover size: {e}"))?;

    // Clamp where it stands rather than re-anchoring to the tray: the header
    // is a drag region, so the popover is not always under its icon. Under a
    // bottom taskbar this is what keeps a taller sheet from growing behind it
    // — the clamp pins the bottom edge and the top rises instead.
    if let Some((x, y)) = origin {
        let (x, y) = clamp_to_work_area(&window, x, y, POPOVER_WIDTH, applied);
        window
            .set_position(LogicalPosition::new(x.round(), y.round()))
            .map_err(|e| format!("popover position: {e}"))?;
    }
    Ok(applied)
}

#[tauri::command]
pub fn hide_source_highlight(app: AppHandle) -> Result<(), String> {
    // While an area take owns this window as its frame, a late popover
    // effect must not be able to take it down mid-recording. Display and
    // window takes never set the flag, so their preview cleanup still lands
    // even when it arrives after the countdown has started.
    if REGION_FRAME_ACTIVE.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    hide_source_highlight_impl(&app)
}

pub(crate) fn hide_source_highlight_impl<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("source-highlight") {
        window.hide().map_err(|e| format!("highlight hide: {e}"))?;
    }
    Ok(())
}

/// Backend-driven end of a picker session: drop the source-highlight border
/// and the camera preview. The webview does the same on `panel-dismissed`,
/// but a hidden or occluded webview is throttled by macOS and may never run
/// that handler — this is what guarantees the camera light and the border go
/// away with the popover. Idempotent; safe when neither is showing.
pub(crate) fn teardown_picker_session<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Err(err) = hide_source_highlight_impl(app) {
        tracing::warn!("picker teardown: {err}");
    }
    teardown_webcam_bubble(app);
    crate::mic_monitor::stop_any();
}

/// Set while a Rust caller is waiting for the overlay's result instead of the
/// picker. Screenshots need the same drag-to-select gesture, and the chosen
/// rect must go to whoever asked for it — delivering it to the picker as well
/// would silently repoint the next recording at the screenshot's area.
static AREA_SELECT_WAITER: OnceLock<
    parking_lot::Mutex<Option<tokio::sync::oneshot::Sender<Option<SourceHighlightRectDto>>>>,
> = OnceLock::new();

fn area_select_waiter(
) -> &'static parking_lot::Mutex<Option<tokio::sync::oneshot::Sender<Option<SourceHighlightRectDto>>>>
{
    AREA_SELECT_WAITER.get_or_init(|| parking_lot::Mutex::new(None))
}

/// Show the overlay over `rect` and resolve with the area the user drew, or
/// `None` if they cancelled.
pub(crate) async fn request_area_selection(
    app: &AppHandle,
    rect: SourceHighlightRectDto,
    purpose: AreaSelectPurposeDto,
) -> Result<Option<SourceHighlightRectDto>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    *area_select_waiter().lock() = Some(sender);
    if let Err(error) = show_area_select(app.clone(), rect, purpose) {
        *area_select_waiter().lock() = None;
        return Err(error);
    }
    // A dropped sender means the wait was superseded; that is a cancel too.
    Ok(receiver.await.unwrap_or(None))
}

/// Event the `source-highlight` webview listens on to switch between the
/// pulsing picker preview and the quiet frame drawn during a Custom size
/// take. Payload is `"preview"` or `"recording"`.
pub(crate) const EVENT_SOURCE_HIGHLIGHT_STYLE: &str = "source-highlight-style";

/// Set while an area take is using the `source-highlight` window as its
/// recording frame (`recording::show_region_highlight`), cleared when the
/// frame is taken down. The webview's show/hide commands are ignored in
/// between so the picker cannot restyle or remove a frame it does not own.
pub(crate) static REGION_FRAME_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Global cursor position in the same coordinate space as the capture
/// source list (logical points on macOS, physical pixels on Windows), so
/// the popover can open the Custom size overlay on the display the user is
/// looking at instead of whichever display enumerates first.
#[tauri::command]
pub fn cursor_position() -> Option<CursorPositionDto> {
    crate::cursor_track::current_cursor_position().map(|(x, y)| CursorPositionDto {
        x: f64::from(x),
        y: f64::from(y),
    })
}

/// Cover the given display with the interactive area-select overlay so the
/// user can draw, resize and move the exact region to record. Unlike the
/// source highlight, this window receives cursor + keyboard events; the
/// overlay itself reports the chosen rect back to the picker, or cancels.
#[tauri::command]
pub fn show_area_select(
    app: AppHandle,
    rect: SourceHighlightRectDto,
    purpose: AreaSelectPurposeDto,
) -> Result<(), String> {
    use tauri::Manager;
    #[cfg(not(target_os = "windows"))]
    use tauri::{LogicalPosition, LogicalSize};

    tracing::info!(?rect, ?purpose, "area select overlay requested");
    if rect.width < 2.0 || rect.height < 2.0 {
        return Err("display rect too small".to_string());
    }

    let window = app
        .get_webview_window("area-select")
        .ok_or_else(|| "area select window missing".to_string())?;

    // UNITS DIFFER BY PLATFORM, as in `show_source_highlight`: the display
    // rect is physical pixels on Windows (WGC/Win32) and logical on macOS.
    // Placing a physical rect as LOGICAL scaled it by the DPI factor, so on a
    // scaled or secondary display the overlay opened oversized and shifted,
    // partly off the display or on the wrong one.
    #[cfg(target_os = "windows")]
    place_window_physical(
        &window,
        rect.x.round() as i32,
        rect.y.round() as i32,
        rect.width.round() as u32,
        rect.height.round() as u32,
    )
    .map_err(|e| format!("area select placement: {e}"))?;
    #[cfg(not(target_os = "windows"))]
    {
        window
            .set_size(LogicalSize::new(rect.width.round(), rect.height.round()))
            .map_err(|e| format!("area select size: {e}"))?;
        window
            .set_position(LogicalPosition::new(rect.x.round(), rect.y.round()))
            .map_err(|e| format!("area select position: {e}"))?;
    }
    window
        .set_always_on_top(true)
        .map_err(|e| format!("area select always-on-top: {e}"))?;
    crate::cursor_track::set_ignore_cursor_events(&window, false)
        .map_err(|e| format!("area select cursor events: {e}"))?;
    let _ = app.emit_to("area-select", EVENT_AREA_SELECT_PURPOSE, purpose);
    window
        .show()
        .map_err(|e| format!("area select show: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("area select focus: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns_window) = window.ns_window() {
            // SAFETY: same NSWindow sharing call used by the stop controls.
            // Without this the dim overlay bleeds into display thumbnails
            // (CGDisplayCreateImage) and would burn into recordings if a
            // capture ever started while the overlay was up.
            unsafe { set_window_sharing_none(ns_window) };
        }
    }
    #[cfg(target_os = "windows")]
    exclude_window_from_capture(&window);
    Ok(())
}

#[tauri::command]
pub fn hide_area_select(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    tracing::info!("area select overlay hidden");
    if let Some(window) = app.get_webview_window("area-select") {
        window
            .hide()
            .map_err(|e| format!("area select hide: {e}"))?;
    }
    Ok(())
}

/// The overlay reports the drawn rect in its own CSS pixels, relative to the
/// display it covers. Bring it into the display's pixel space, which is what
/// the recorder crops in and what the picker's display rects use.
///
/// Windows: CSS pixels are logical (`webview_scale` pins the WebView2 scale to
/// the display DPI), and capture geometry is physical, so multiply by the
/// overlay's scale factor. The overlay sits on exactly one display, so its
/// own factor is that display's. macOS: both sides are logical already.
#[cfg(target_os = "windows")]
fn area_select_rect_to_display_pixels(
    app: &AppHandle,
    rect: SourceHighlightRectDto,
) -> SourceHighlightRectDto {
    use tauri::Manager;

    let scale = app
        .get_webview_window("area-select")
        .and_then(|window| window.scale_factor().ok())
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(1.0);
    SourceHighlightRectDto {
        x: (rect.x * scale).round(),
        y: (rect.y * scale).round(),
        width: (rect.width * scale).round(),
        height: (rect.height * scale).round(),
    }
}

#[cfg(not(target_os = "windows"))]
fn area_select_rect_to_display_pixels(
    _app: &AppHandle,
    rect: SourceHighlightRectDto,
) -> SourceHighlightRectDto {
    rect
}

#[tauri::command]
pub fn complete_area_select(app: AppHandle, rect: SourceHighlightRectDto) -> Result<(), String> {
    tracing::info!(?rect, "area select completed");
    if rect.width < 2.0 || rect.height < 2.0 {
        return Err("selected area too small".to_string());
    }
    let rect = area_select_rect_to_display_pixels(&app, rect);
    hide_area_select(app.clone())?;
    if let Some(waiter) = area_select_waiter().lock().take() {
        let _ = waiter.send(Some(rect));
        return Ok(());
    }
    app.emit_to("main", "area-select-done", rect)
        .map_err(|e| format!("area select done event: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn cancel_area_select(app: AppHandle) -> Result<(), String> {
    tracing::info!("area select cancelled");
    hide_area_select(app.clone())?;
    if let Some(waiter) = area_select_waiter().lock().take() {
        let _ = waiter.send(None);
        return Ok(());
    }
    app.emit_to("main", "area-select-cancelled", ())
        .map_err(|e| format!("area select cancelled event: {e}"))?;
    Ok(())
}

/// Webview-side crash reporting: window.onerror / unhandledrejection from
/// any of the app's webviews land here. Forwarded to Sentry when the DSN
/// is configured (no-op otherwise); always traced so dev runs surface them
/// in the console. Inputs are truncated — a pathological error loop must
/// not ship megabytes per event.
///
/// `level: "warning"` marks an expected environment condition (no camera,
/// permission denied): it is traced as a warning, which Sentry keeps only
/// as a breadcrumb, and no Sentry event is captured. Omitted means error.
#[tauri::command]
pub fn report_webview_error(
    window_label: String,
    message: String,
    stack: Option<String>,
    source: Option<String>,
    level: Option<String>,
) {
    fn clip(value: String, max: usize) -> String {
        if value.len() > max {
            let mut end = max;
            while end > 0 && !value.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}…[truncated]", &value[..end])
        } else {
            value
        }
    }
    // Local edition: the error is only traced on this machine, never sent.
    let message = clip(message, 4_000);
    let source = source.map(|s| clip(s, 500));
    let _ = (stack, level);

    tracing::warn!(
        surface = "desktop-webview",
        window = %window_label,
        source = source.as_deref().unwrap_or("-"),
        error_message = %message,
        "desktop webview error"
    );
}

// ---------- Phase 2/3 recording commands ----------

/// Capture a single source thumbnail and return it as a `data:image/png;base64,...`
/// URL ready to drop into an `<img src>` tag. Called per-source from the picker
/// so the dialog renders text-first and thumbnails fill in as they arrive.
/// Returns `None` if the source can't be captured (window died, etc.) — UI
/// should fall back to a placeholder.
#[tauri::command]
pub async fn get_source_thumbnail(source: CaptureSourceDto) -> Result<Option<String>, String> {
    if matches!(source, CaptureSourceDto::Camera { .. }) {
        return Ok(None);
    }
    #[cfg(target_os = "macos")]
    {
        if crate::thumbnails::sck_thumbnails_available() {
            // ScreenCaptureKit handles are not `Send`, so the SCK future
            // cannot live inside this command's future; drive it to
            // completion on a blocking thread instead.
            return tokio::task::spawn_blocking(move || {
                tauri::async_runtime::block_on(
                    crate::thumbnails::capture_source_thumbnail_sck(&source),
                )
            })
            .await
            .map_err(|e| format!("thumbnail task panicked: {e}"));
        }
        // Pre-macOS 14: run the legacy FFI on a blocking thread —
        // CGWindowListCreateImage / CGDisplayCreateImage block on the
        // WindowServer and shouldn't run on tokio's async runtime.
        let result = tokio::task::spawn_blocking(move || match source {
            CaptureSourceDto::Display { id } => crate::thumbnails::capture_display_thumbnail(id),
            CaptureSourceDto::Window { id } => crate::thumbnails::capture_window_thumbnail(id),
            CaptureSourceDto::Area { display_id, .. } => {
                crate::thumbnails::capture_display_thumbnail(display_id)
            }
            CaptureSourceDto::Camera { .. } => None,
        })
        .await
        .map_err(|e| format!("thumbnail task panicked: {e}"))?;
        Ok(result)
    }
    #[cfg(target_os = "windows")]
    {
        // GDI calls block; keep them off the async runtime, same as macOS.
        let result = tokio::task::spawn_blocking(move || match source {
            CaptureSourceDto::Window { id } => crate::capture::windows::hwnd_for_source_id(id)
                .and_then(crate::thumbnails_win::capture_window_thumbnail),
            CaptureSourceDto::Display { id } => {
                crate::thumbnails_win::capture_display_thumbnail(id)
            }
            CaptureSourceDto::Area { display_id, .. } => {
                crate::thumbnails_win::capture_display_thumbnail(display_id)
            }
            // Same as macOS: the camera renders its own live preview, so the
            // picker has nothing to thumbnail here.
            CaptureSourceDto::Camera { .. } => None,
        })
        .await
        .map_err(|e| format!("thumbnail task panicked: {e}"))?;
        Ok(result)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = source;
        Ok(None)
    }
}

#[tauri::command]
pub async fn list_capture_sources() -> Result<CaptureSourcesDto, String> {
    #[cfg(target_os = "macos")]
    {
        crate::capture::macos::ScreenCapturer::list_sources()
            .await
            .map_err(|e| format!("{e:#}"))
    }
    #[cfg(target_os = "windows")]
    {
        crate::capture::windows::ScreenCapturer::list_sources()
            .await
            .map_err(|e| format!("{e:#}"))
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        Ok(CaptureSourcesDto {
            displays: vec![],
            windows: vec![],
        })
    }
}

fn window_at_point<'a>(
    windows: &'a [WindowInfoDto],
    front_to_back: &[u32],
    x: f64,
    y: f64,
) -> Option<&'a WindowInfoDto> {
    let contains = |window: &&WindowInfoDto| {
        x >= window.x
            && x < window.x + window.width as f64
            && y >= window.y
            && y < window.y + window.height as f64
    };

    front_to_back
        .iter()
        .filter_map(|id| windows.iter().find(|window| window.id == *id))
        .find(contains)
        .or_else(|| windows.iter().find(contains))
}

#[tauri::command]
pub async fn pick_window_at_click(app: AppHandle) -> Result<Option<u32>, String> {
    // The picker loop itself is platform-neutral: `window_at_point` is pure
    // rect hit-testing, and the cursor/button/escape helpers in `cursor_track`
    // all have Windows implementations via `device_query`. Only the source
    // enumeration differs, so gate that alone rather than the whole body.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let main = app
            .get_webview_window("main")
            .ok_or_else(|| "main window missing".to_string())?;
        hide_source_highlight(app.clone())?;
        main.hide()
            .map_err(|e| format!("hide main window for source selection: {e}"))?;

        tokio::time::sleep(Duration::from_millis(180)).await;
        let pick_result = async {
            #[cfg(target_os = "macos")]
            let sources = crate::capture::macos::ScreenCapturer::list_sources()
                .await
                .map_err(|e| format!("list windows for click selection: {e:#}"))?;
            #[cfg(target_os = "windows")]
            let sources = crate::capture::windows::ScreenCapturer::list_sources()
                .await
                .map_err(|e| format!("list windows for click selection: {e:#}"))?;
            // Empty on Windows, and that is fine: ids there are allocated in
            // `EnumWindows` order, which IS front-to-back, so `window_at_point`
            // already resolves overlaps to the topmost window via its
            // list-order fallback.
            let front_to_back = crate::cursor_track::window_ids_front_to_back();
            let app_for_poll = app.clone();

            tokio::task::spawn_blocking(move || {
                let started = Instant::now();
                let mut last_hovered = None;

                while crate::cursor_track::current_primary_button_active() {
                    if crate::cursor_track::current_escape_key_active() {
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(16));
                }

                while started.elapsed() < Duration::from_secs(60) {
                    if crate::cursor_track::current_escape_key_active() {
                        return None;
                    }
                    let Some((x, y)) = crate::cursor_track::current_cursor_position() else {
                        std::thread::sleep(Duration::from_millis(16));
                        continue;
                    };
                    let hovered =
                        window_at_point(&sources.windows, &front_to_back, x as f64, y as f64);
                    let hovered_id = hovered.map(|window| window.id);
                    if hovered_id != last_hovered {
                        if let Some(window) = hovered {
                            let _ = show_source_highlight(
                                app_for_poll.clone(),
                                SourceHighlightRectDto {
                                    x: window.x,
                                    y: window.y,
                                    width: window.width as f64,
                                    height: window.height as f64,
                                },
                            );
                        } else {
                            let _ = hide_source_highlight(app_for_poll.clone());
                        }
                        last_hovered = hovered_id;
                    }
                    if crate::cursor_track::current_primary_button_active() {
                        return hovered_id;
                    }
                    std::thread::sleep(Duration::from_millis(16));
                }
                None
            })
            .await
            .map_err(|e| format!("window click selection task panicked: {e}"))
        }
        .await;

        let _ = hide_source_highlight(app.clone());
        let show_result = main
            .show()
            .and_then(|_| main.set_focus())
            .map_err(|e| format!("restore main window after source selection: {e}"));
        match (pick_result, show_result) {
            (Ok(selected), Ok(())) => Ok(selected),
            (Err(err), _) => Err(err),
            (Ok(_), Err(err)) => Err(err),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Err("click-to-select windows is not available on this platform".to_string())
    }
}

#[cfg(test)]
mod window_picker_tests {
    use super::window_at_point;
    use crate::types::WindowInfoDto;

    fn window(id: u32, x: f64, y: f64, width: u32, height: u32) -> WindowInfoDto {
        WindowInfoDto {
            id,
            app_name: format!("App {id}"),
            title: format!("Window {id}"),
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn picks_frontmost_overlapping_window() {
        let windows = vec![
            window(10, 0.0, 0.0, 500, 500),
            window(20, 100.0, 100.0, 300, 300),
        ];
        let selected = window_at_point(&windows, &[20, 10], 150.0, 150.0);
        assert_eq!(selected.map(|window| window.id), Some(20));
    }

    #[test]
    fn falls_back_to_shareable_content_order_without_z_order_entry() {
        let windows = vec![window(30, -900.0, 50.0, 700, 500)];
        let selected = window_at_point(&windows, &[], -400.0, 300.0);
        assert_eq!(selected.map(|window| window.id), Some(30));
    }
}

/// Why a start failed, in a shape the webview can render.
///
/// `start_recording` used to reject with a bare string, so the popup showed
/// whatever `{err:#}` produced — including the raw JSON body of the free-quota
/// 403. Now the message is the server's sentence and the classification travels
/// beside it, which is what lets Home.tsx swap the red error line for a real
/// "you've used your free plan" card with an upgrade button.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingError {
    /// Always present and always safe to show a human.
    pub message: String,
    /// e.g. `pro_required`, `upgrade_required`. Absent for local failures
    /// (permissions, disk space, no capture source).
    pub code: Option<String>,
    /// For `pro_required`: `soft` | `hard` | `quota`.
    pub level: Option<String>,
    /// Free-tier usage, passed through from the server verbatim.
    pub quota: Option<serde_json::Value>,
}

impl StartRecordingError {
    fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            level: None,
            quota: None,
        }
    }

    fn from_anyhow(err: &anyhow::Error) -> Self {
        match crate::api_error::refusal_of(err) {
            Some(refusal) => Self {
                message: refusal.message.clone(),
                code: refusal.code.clone(),
                level: refusal.level.clone(),
                quota: refusal.quota.clone(),
            },
            // A failure that knows its cause carries a message written for
            // the user ("Update Windows…"), so show that alone.
            None => match crate::capture::failure::of(err) {
                Some(failure) => Self::message(crate::i18n::localize_message(failure.message())),
                // Otherwise keep the full context chain. These are local
                // failures ("open ffmpeg MP4 encoder: …") where the
                // breadcrumbs are the only diagnostic the user can forward.
                None => Self::message(format!("{err:#}")),
            },
        }
    }
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    auth: State<'_, AuthState>,
    rec: State<'_, RecordingController>,
    source: Option<CaptureSourceDto>,
    audio: Option<AudioOptionsDto>,
    video: Option<VideoOptionsDto>,
    webcam: Option<WebcamCaptureDto>,
    capture_source_metadata: Option<CaptureSourceMetadataDto>,
    // Optional mode flag. `instant` (default) streams to B2 + auto-share.
    // `studio` keeps the recording local for editing; the user exports
    // explicitly from the editor.
    mode: Option<crate::types::RecordingMode>,
    countdown_seconds: Option<u32>,
    // Notes + share scope chosen in the panel before Start. Read back at
    // `/complete`, which is why it is stashed rather than threaded through
    // the capture paths.
    intent: Option<crate::recording_intent::RecordingIntentDto>,
) -> Result<RecordingId, StartRecordingError> {
    let local = mode == Some(crate::types::RecordingMode::Local);
    let token = if local {
        crate::local::preflight_new_recording(&app)
            .await
            .map_err(|e| StartRecordingError::message(e.to_string()))?;
        String::new()
    } else {
        // The local edition records Local takes only: nothing else has
        // anywhere to go.
        {
            let _ = &auth;
            return Err(StartRecordingError::message(
                "Clipy Local records local takes only",
            ));
        }
    };
    // The debug dev session's placeholder bearer is not a real token.
    // Hitting /api/videos/raw-upload/* with that 401s and triggers the
    // auto-sign-out path, bouncing the UI back to Login mid-test. Force
    // Studio mode for the dev session so the recording stays local and
    // the cursor/zoom sidecars get written without an upload attempt.
    let resolved_mode = if crate::edition::is_dev_bypass(&token) {
        crate::types::RecordingMode::Studio
    } else {
        mode.unwrap_or_default()
    };
    let tried_source = match &source {
        Some(CaptureSourceDto::Window { .. }) => Some("window_recording"),
        Some(CaptureSourceDto::Area { .. }) => Some("custom_size"),
        _ => None,
    };
    let recording_id = rec
        .start(
            &app,
            token,
            source,
            audio,
            video,
            webcam,
            capture_source_metadata,
            resolved_mode,
            countdown_seconds.unwrap_or(DEFAULT_COUNTDOWN_SECONDS),
        )
        .await
        .map_err(|e| StartRecordingError::from_anyhow(&e))?;

    // Recorded after the capture has started because the controller mints
    // the id — and it is safe there, since the intent is only read by
    // `/complete`, which cannot run until the user stops. A start that was
    // refused never gets here, so a failed attempt stashes nothing.
    if let Some(intent) = intent {
        crate::recording_intent::remember(&recording_id, intent);
    }
    // Ticks the What's new checklist; written in the background.
    if let Some(feature) = tried_source {
        crate::whats_new::mark_tried(&app, feature);
    }
    if local {
        crate::whats_new::mark_tried(&app, "local_ai");
    }

    Ok(recording_id)
}

/// Enumerate input devices for the pre-record audio picker. Returns
/// cpal device names — feed the chosen `id` back via
/// `start_recording.audio.mic_device_id`.
#[tauri::command]
pub async fn list_audio_input_devices() -> Result<Vec<AudioDeviceDto>, String> {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        let rows = crate::capture::audio::list_input_devices();
        #[cfg(target_os = "windows")]
        let rows = crate::capture::windows::list_input_devices();
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let rows: anyhow::Result<Vec<(String, bool)>> = Ok(vec![]);

        rows.map(|rows| {
            rows.into_iter()
                .map(|(name, is_default)| AudioDeviceDto {
                    id: name.clone(),
                    name,
                    is_default,
                })
                .collect()
        })
        .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("join audio device enumeration: {e}"))?
}

#[tauri::command]
pub async fn check_microphone_input(
    app: AppHandle,
    device_id: Option<String>,
) -> Result<MicSignalCheckDto, String> {
    #[cfg(target_os = "macos")]
    {
        crate::capture::audio::check_input_signal_with_updates(
            device_id.as_deref(),
            std::time::Duration::from_millis(1_200),
            move |level| {
                let _ = app.emit(EVENT_MIC_CHECK_LEVEL, level);
            },
        )
        .await
        .map(|check| MicSignalCheckDto {
            device_name: check.device_name,
            level: check.level,
            has_input: check.has_input,
        })
        .map_err(|e| format!("{e:#}"))
    }
    #[cfg(target_os = "windows")]
    {
        crate::capture::windows::check_input_signal_with_updates(
            device_id.as_deref(),
            std::time::Duration::from_millis(1_200),
            move |level| {
                let _ = app.emit(EVENT_MIC_CHECK_LEVEL, level);
            },
        )
        .await
        .map(|check| MicSignalCheckDto {
            device_name: check.device_name,
            level: check.level,
            has_input: check.has_input,
        })
        .map_err(|e| format!("{e:#}"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, device_id);
        // Linux dev builds have no capture backend; reporting `has_input:
        // true` keeps the shared React preflight from blocking, and is honest
        // in that we genuinely cannot tell.
        Ok(MicSignalCheckDto {
            device_name: "Mic check unavailable on this platform".to_string(),
            level: 0.0,
            has_input: true,
        })
    }
}

/// Keep the popover's mic row live for the whole panel session on ONE input
/// stream. Returns the monitor generation; hand it back to `stop_mic_monitor`.
#[tauri::command]
pub fn start_mic_monitor(app: AppHandle, device_id: Option<String>) -> u64 {
    crate::mic_monitor::start(app, device_id)
}

#[tauri::command]
pub fn stop_mic_monitor(generation: u64) {
    crate::mic_monitor::stop(generation);
}

#[tauri::command]
pub async fn stop_recording(
    app: AppHandle,
    rec: State<'_, RecordingController>,
) -> Result<RecordingMetadata, String> {
    rec.stop(&app).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pause_recording(app: AppHandle, rec: State<'_, RecordingController>) -> Result<(), String> {
    rec.pause(&app).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn resume_recording(app: AppHandle, rec: State<'_, RecordingController>) -> Result<(), String> {
    rec.resume(&app).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn set_mic_muted(rec: State<'_, RecordingController>, muted: bool) -> Result<(), String> {
    rec.set_mic_muted(muted).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn cancel_recording(
    app: AppHandle,
    rec: State<'_, RecordingController>,
) -> Result<(), String> {
    rec.cancel(&app).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn get_recording_state(rec: State<'_, RecordingController>) -> RecordingStateDto {
    rec.dto()
}

#[tauri::command]
pub fn save_webcam_sidecar(
    app: AppHandle,
    rec: State<'_, RecordingController>,
    recording_id: String,
    data_base64: String,
    mime_type: String,
) -> Result<String, String> {
    validate_recording_id(&recording_id)?;
    let extension = if mime_type.contains("mp4") {
        "mp4"
    } else {
        "webm"
    };
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    dir.push("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create recordings dir: {e}"))?;
    let path = dir.join(format!("{recording_id}.camera.{extension}"));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("decode camera sidecar: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write camera sidecar: {e}"))?;
    if let Some(recording) = rec.note_camera_sidecar(&recording_id, path.clone()) {
        let _ = app.emit(EVENT_STUDIO_RECORDING_UPDATED, recording);
    }
    Ok(path.to_string_lossy().to_string())
}

/// Dev-only escape hatch: paste the full clipy:// URL from the web success
/// page into the Tauri WebView console to complete sign-in without needing
/// the URL scheme registered with macOS.
///
/// Usage in browser dev tools console (right-click → Inspect → Console):
///   await window.__TAURI__.core.invoke('handle_deep_link_url', { url: 'clipy://auth?code=...&state=...' })
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn handle_deep_link_url(url: String, app: AppHandle) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    crate::edition::dispatch_deep_link(&app, &parsed)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Dev-only escape hatch: bypass the OAuth dance entirely by injecting a
/// fake desktop session. Used for verifying recording + cursor/zoom
/// sidecar generation locally without needing the `clipy://` scheme
/// registered. Uploads will 401 (the bearer is a static string), but
/// `<id>.cursor.json` + `<id>.zoom.json` get written to the recordings
/// dir, which is what we're testing.

#[cfg(debug_assertions)]
fn create_dev_e2e_camera_sidecar(
    recording: &StudioRecordingDto,
    duration_ms: u64,
) -> Result<std::path::PathBuf, String> {
    let path = recording.local_file_path.with_extension("camera.mp4");
    let path_string = path.to_string_lossy().to_string();
    let duration_s = format!("{:.3}", (duration_ms as f64 / 1000.0).clamp(1.0, 43_200.0));
    let output = std::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30",
            "-t",
            &duration_s,
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            path_string.as_str(),
        ])
        .output()
        .map_err(|e| format!("dev Studio E2E start ffmpeg camera sidecar: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "dev Studio E2E camera sidecar ffmpeg failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let bytes = std::fs::metadata(&path)
        .map_err(|e| format!("dev Studio E2E stat camera sidecar: {e}"))?
        .len();
    if bytes < 1_000 {
        return Err(format!(
            "dev Studio E2E camera sidecar too small: {bytes} bytes"
        ));
    }
    tracing::info!(
        path = %path.display(),
        bytes,
        "dev Studio E2E generated camera sidecar"
    );
    Ok(path)
}

#[cfg(debug_assertions)]
async fn wait_for_physical_webcam_sidecar(
    source_path: &std::path::Path,
    timeout_ms: u64,
) -> Result<std::path::PathBuf, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let mut last_state = "missing".to_string();
    while std::time::Instant::now() < deadline {
        if let Some(path) = camera_sidecar_path_for(source_path) {
            match std::fs::metadata(&path) {
                Ok(meta) if meta.len() > 1_000 => return Ok(path),
                Ok(meta) => {
                    last_state = format!(
                        "{} exists but is too small: {} bytes",
                        path.display(),
                        meta.len()
                    );
                }
                Err(err) => {
                    last_state = format!("{} metadata failed: {err}", path.display());
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }

    Err(format!(
        "physical webcam sidecar was not saved after {timeout_ms}ms ({last_state})"
    ))
}

#[cfg(debug_assertions)]
struct DevE2EStopControlsState {
    visible: bool,
    always_on_top: bool,
    sharing_type: Option<usize>,
}

#[cfg(debug_assertions)]
#[derive(Clone, Copy)]
struct DevE2ECursorTarget {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(debug_assertions)]
fn show_dev_e2e_cursor_target(
    app: &AppHandle,
    capture_width: f64,
    capture_height: f64,
) -> Result<Option<DevE2ECursorTarget>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = capture_width;
        let _ = capture_height;
        return Ok(None);
    }

    #[cfg(target_os = "macos")]
    {
        use tauri::{LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

        if std::env::var("CLIPY_DESKTOP_DEV_E2E_CURSOR_TARGET")
            .ok()
            .as_deref()
            == Some("0")
        {
            return Ok(None);
        }

        let label = "cursor-target";
        if let Some(existing) = app.get_webview_window(label) {
            let _ = existing.close();
        }

        let width = (capture_width - 48.0).clamp(520.0, 720.0);
        let height = (capture_height - 72.0).clamp(250.0, 360.0);
        let x = 24.0;
        let y = 64.0;
        let url = WebviewUrl::App("index.html#cursor-target".into());
        let window = WebviewWindowBuilder::new(app, label, url)
            .title("Clipy Cursor Target")
            .inner_size(width, height)
            .position(x, y)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(true)
            .build()
            .map_err(|e| format!("create cursor target: {e}"))?;
        window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| format!("position cursor target: {e}"))?;
        window
            .set_focus()
            .map_err(|e| format!("focus cursor target: {e}"))?;
        std::thread::sleep(std::time::Duration::from_millis(500));
        Ok(Some(DevE2ECursorTarget {
            x,
            y,
            width,
            height,
        }))
    }
}

#[cfg(debug_assertions)]
async fn wait_for_dev_e2e_stop_controls(
    app: &AppHandle,
    timeout_ms: u64,
) -> Result<DevE2EStopControlsState, String> {
    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);
    let mut last_state = "missing".to_string();

    while started.elapsed() < timeout {
        if let Some(window) = app.get_webview_window("stop-controls") {
            let visible = window
                .is_visible()
                .map_err(|e| format!("dev Studio E2E stop controls visibility: {e}"))?;
            let always_on_top = window
                .is_always_on_top()
                .map_err(|e| format!("dev Studio E2E stop controls z-order: {e}"))?;
            #[cfg(target_os = "macos")]
            let sharing_type = window
                .ns_window()
                .ok()
                .and_then(|ns_window| unsafe { window_sharing_type(ns_window) });
            #[cfg(not(target_os = "macos"))]
            let sharing_type = None;

            if visible && always_on_top && sharing_type.map_or(true, |value| value == 0) {
                return Ok(DevE2EStopControlsState {
                    visible,
                    always_on_top,
                    sharing_type,
                });
            }
            last_state = format!(
                "visible={visible} always_on_top={always_on_top} sharing_type={sharing_type:?}"
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    Err(format!(
        "dev Studio E2E stop controls overlay not ready after {timeout_ms}ms: {last_state}"
    ))
}

#[cfg(debug_assertions)]
fn probe_export(path: &str, expected_duration_ms: u64) -> Result<(Option<f64>, u64), String> {
    let bytes = std::fs::metadata(path)
        .map_err(|e| format!("dev Studio E2E stat export: {e}"))?
        .len();
    if bytes < 1_000 {
        return Err(format!("dev Studio E2E export too small: {bytes} bytes"));
    }
    let output = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height",
            "-of",
            "json",
            path,
        ])
        .output()
        .map_err(|e| format!("dev Studio E2E start ffprobe: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "dev Studio E2E ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("dev Studio E2E parse ffprobe: {e}"))?;
    let duration = json
        .get("format")
        .and_then(|v| v.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| {
            let expected_s = expected_duration_ms as f64 / 1000.0;
            let max_s = expected_s.max(12.0) + 8.0;
            v.is_finite() && *v >= 1.0 && *v <= max_s
        })
        .ok_or_else(|| "dev Studio E2E export missing sane duration".to_string())?;
    let streams = json
        .get("streams")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "dev Studio E2E export missing streams".to_string())?;
    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(|v| v.as_str()) == Some("video"));
    let video = video.ok_or_else(|| "dev Studio E2E export missing video stream".to_string())?;
    let width = video.get("width").and_then(|v| v.as_u64()).unwrap_or(0);
    let height = video.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
    if width < 960 || height < 540 || width % 2 != 0 || height % 2 != 0 {
        return Err(format!(
            "dev Studio E2E export dimensions mismatch: {width}x{height}"
        ));
    }
    Ok((Some(duration), bytes))
}

#[cfg(debug_assertions)]
async fn wait_for_studio_recording(
    rec: &RecordingController,
    recording_id: &str,
    timeout_ms: u64,
) -> Result<StudioRecordingDto, String> {
    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);
    while started.elapsed() <= timeout {
        if let Some(recording) = rec.studio_recording(None) {
            if recording.recording_id == recording_id {
                return Ok(recording);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Err(format!(
        "dev Studio E2E missing Studio recording metadata after {timeout_ms}ms"
    ))
}

#[cfg(debug_assertions)]
struct RemotePlaybackProbe {
    public_id: String,
    share_url: String,
    video_url: String,
    processing_status: String,
    playback_verified: bool,
}

#[cfg(debug_assertions)]
async fn wait_for_remote_playback(
    rec: &RecordingController,
    recording_id: &str,
    bearer: &str,
    project: &serde_json::Value,
    camera_path: Option<&std::path::Path>,
    timeout_ms: u64,
) -> Result<RemotePlaybackProbe, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("create remote playback client: {e}"))?;
    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);
    let mut last_state = "waiting for share link".to_string();

    while started.elapsed() <= timeout {
        if let Some(recording) = rec.studio_recording(None) {
            if recording.recording_id == recording_id {
                if let (Some(public_id), Some(share_url)) = (
                    recording.remote_public_id.clone(),
                    recording.share_url.clone(),
                ) {
                    let status = fetch_remote_share_status(&client, &share_url, &public_id).await?;
                    if status.processing_status == "failed" {
                        return Err(format!("remote processing failed: {}", status.video_url));
                    }
                    if status.processing_status == "ready" && !status.video_url.is_empty() {
                        upload_remote_studio_project(
                            &client,
                            bearer,
                            &share_url,
                            &public_id,
                            project,
                            camera_path,
                        )
                        .await?;
                        let rebaked =
                            wait_for_remote_rebake_ready(&client, &share_url, &public_id, timeout)
                                .await?;
                        verify_remote_media_url(&client, &share_url, &rebaked.video_url).await?;
                        return Ok(RemotePlaybackProbe {
                            public_id,
                            share_url,
                            video_url: rebaked.video_url,
                            processing_status: rebaked.processing_status,
                            playback_verified: true,
                        });
                    }
                    last_state = format!(
                        "remote status={} video_url_present={}",
                        status.processing_status,
                        !status.video_url.is_empty()
                    );
                } else {
                    last_state = "recording exists but remote share link is not ready".to_string();
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }

    Err(format!(
        "remote playback was not ready after {timeout_ms}ms: {last_state}"
    ))
}

#[cfg(debug_assertions)]
struct RemoteShareStatusProbe {
    video_url: String,
    processing_status: String,
}

#[cfg(debug_assertions)]
async fn upload_remote_studio_project(
    client: &reqwest::Client,
    bearer: &str,
    share_url: &str,
    public_id: &str,
    project: &serde_json::Value,
    camera_path: Option<&std::path::Path>,
) -> Result<(), String> {
    let base = reqwest::Url::parse(share_url).map_err(|e| format!("parse share URL: {e}"))?;
    if let Some(path) = camera_path {
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| format!("read remote E2E camera sidecar: {e}"))?;
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("camera.mp4")
            .to_string();
        let mime = if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("mp4"))
            .unwrap_or(false)
        {
            "video/mp4"
        } else {
            "video/webm"
        };
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name)
            .mime_str(mime)
            .map_err(|e| format!("remote E2E camera multipart: {e}"))?;
        let form = reqwest::multipart::Form::new().part("file", part);
        let mut camera_url = base.clone();
        camera_url.set_path(&format!("/api/videos/{public_id}/camera"));
        camera_url.set_query(None);
        let response = client
            .put(camera_url)
            .bearer_auth(bearer)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("remote E2E camera upload request: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "remote E2E camera upload returned {}",
                response.status()
            ));
        }
    } else {
        return Err("remote E2E expected a camera sidecar before rebake".to_string());
    }

    let mut project_url = base.clone();
    project_url.set_path(&format!("/api/videos/{public_id}/project"));
    project_url.set_query(None);
    let response = client
        .put(project_url)
        .bearer_auth(bearer)
        .json(&serde_json::json!({ "project": project }))
        .send()
        .await
        .map_err(|e| format!("remote E2E project upload request: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "remote E2E project upload returned {}",
            response.status()
        ));
    }

    let mut rebake_url = base;
    rebake_url.set_path(&format!("/api/videos/{public_id}/rebake"));
    rebake_url.set_query(None);
    let response = client
        .post(rebake_url)
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(|e| format!("remote E2E rebake request: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("remote E2E rebake returned {}", response.status()));
    }
    Ok(())
}

#[cfg(debug_assertions)]
async fn wait_for_remote_rebake_ready(
    client: &reqwest::Client,
    share_url: &str,
    public_id: &str,
    timeout: std::time::Duration,
) -> Result<RemoteShareStatusProbe, String> {
    let started = std::time::Instant::now();
    let mut last_state = "rebake queued".to_string();
    while started.elapsed() <= timeout {
        let status = fetch_remote_share_status(client, share_url, public_id).await?;
        if status.processing_status == "failed" {
            return Err("remote E2E rebake failed".to_string());
        }
        if status.processing_status == "ready" && !status.video_url.is_empty() {
            return Ok(status);
        }
        last_state = format!(
            "rebake status={} video_url_present={}",
            status.processing_status,
            !status.video_url.is_empty()
        );
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    Err(format!("remote rebake was not ready: {last_state}"))
}

#[cfg(debug_assertions)]
async fn fetch_remote_share_status(
    client: &reqwest::Client,
    share_url: &str,
    public_id: &str,
) -> Result<RemoteShareStatusProbe, String> {
    let mut api_url =
        reqwest::Url::parse(share_url).map_err(|e| format!("parse share URL: {e}"))?;
    api_url.set_path(&format!("/api/videos/{public_id}"));
    api_url.set_query(None);
    let response = client
        .get(api_url)
        .send()
        .await
        .map_err(|e| format!("remote status request: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("remote status returned {}", response.status()));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("parse remote status JSON: {e}"))?;
    Ok(RemoteShareStatusProbe {
        video_url: body
            .get("video_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        processing_status: body
            .get("processing_status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
    })
}

#[cfg(debug_assertions)]
async fn verify_remote_media_url(
    client: &reqwest::Client,
    share_url: &str,
    video_url: &str,
) -> Result<(), String> {
    let url = if video_url.starts_with("http://") || video_url.starts_with("https://") {
        reqwest::Url::parse(video_url).map_err(|e| format!("parse remote media URL: {e}"))?
    } else {
        reqwest::Url::parse(share_url)
            .and_then(|base| base.join(video_url))
            .map_err(|e| format!("resolve remote media URL: {e}"))?
    };
    let response = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-4095")
        .send()
        .await
        .map_err(|e| format!("remote media request: {e}"))?;
    if !(response.status().is_success()
        || response.status() == reqwest::StatusCode::PARTIAL_CONTENT)
    {
        return Err(format!("remote media returned {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("read remote media bytes: {e}"))?;
    if bytes.len() < 512 {
        return Err(format!(
            "remote media response too small: {} bytes",
            bytes.len()
        ));
    }
    Ok(())
}

#[cfg(debug_assertions)]
fn ensure_dev_e2e_cursor_sidecars(
    recording: &mut StudioRecordingDto,
    capture_width: f64,
    capture_height: f64,
    duration_ms: u64,
) -> Result<bool, String> {
    let dir = recording
        .local_file_path
        .parent()
        .ok_or_else(|| "dev Studio E2E recording path has no parent".to_string())?;
    let stem = recording
        .local_file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "dev Studio E2E recording path has no stem".to_string())?;
    let cursor_path = dir.join(format!("{stem}.cursor.json"));
    let zoom_path = dir.join(format!("{stem}.zoom.json"));
    let screen_charm_path = dir.join(format!("{stem}.screencharm.json"));
    if let Some(cursor_json) = read_json_if_exists(&cursor_path) {
        recording.cursor_path = Some(cursor_path.clone());
        recording.cursor_json = Some(cursor_json);
    }
    if let Some(zoom_json) = read_json_if_exists(&zoom_path) {
        recording.zoom_path = Some(zoom_path.clone());
        recording.zoom_json = Some(zoom_json);
    }
    if let Some(screen_charm_json) = read_json_if_exists(&screen_charm_path) {
        recording.screen_charm_path = Some(screen_charm_path.clone());
        recording.screen_charm_json = Some(screen_charm_json);
    }

    let existing_cursor_events = recording
        .cursor_json
        .as_ref()
        .and_then(|v| v.get("events"))
        .and_then(|v| v.as_array())
        .map(|events| events.len())
        .unwrap_or(0);
    let existing_down_events = recording
        .cursor_json
        .as_ref()
        .and_then(|v| v.get("events"))
        .and_then(|v| v.as_array())
        .map(|events| {
            events
                .iter()
                .filter(|event| event.get("kind").and_then(|v| v.as_str()) == Some("down"))
                .count()
        })
        .unwrap_or(0);
    let existing_keyboard_events = recording
        .cursor_json
        .as_ref()
        .and_then(|v| v.get("events"))
        .and_then(|v| v.as_array())
        .map(|events| {
            events
                .iter()
                .filter(|event| {
                    matches!(
                        event.get("kind").and_then(|v| v.as_str()),
                        Some("key_down" | "key_up")
                    )
                })
                .count()
        })
        .unwrap_or(0);
    let existing_scroll_events = recording
        .cursor_json
        .as_ref()
        .and_then(|v| v.get("events"))
        .and_then(|v| v.as_array())
        .map(|events| {
            events
                .iter()
                .filter(|event| event.get("kind").and_then(|v| v.as_str()) == Some("scroll"))
                .count()
        })
        .unwrap_or(0);
    let existing_zoom_segments = recording
        .zoom_json
        .as_ref()
        .and_then(|v| v.as_array())
        .map(|items| items.len())
        .unwrap_or(0);

    let has_core_cursor_evidence = existing_cursor_events >= 8
        && existing_down_events > 0
        && existing_scroll_events > 0
        && existing_zoom_segments > 0;
    let strict_cursor_evidence_requested =
        std::env::var("CLIPY_STUDIO_RECORDING_E2E_REQUIRE_NONDEFAULT_CURSOR")
            .ok()
            .as_deref()
            == Some("1")
            || std::env::var("CLIPY_STUDIO_RECORDING_E2E_REQUIRE_EXTENDED_CURSOR")
                .ok()
                .as_deref()
                == Some("1")
            || std::env::var("CLIPY_STUDIO_RECORDING_E2E_REQUIRE_CURSOR_FAMILIES")
                .ok()
                .as_deref()
                == Some("1");

    if strict_cursor_evidence_requested && existing_cursor_events > 0 {
        return Ok(false);
    }

    if has_core_cursor_evidence
        && (existing_keyboard_events > 0 || strict_cursor_evidence_requested)
    {
        return Ok(false);
    }

    let track = synthetic_dev_e2e_cursor_track(capture_width, capture_height, duration_ms);
    let capture_source_metadata = CaptureSourceMetadataDto {
        source_tab: crate::types::RecordingSourceTab::Area,
        source: None,
        window_app_name: Some("Clipy".to_string()),
        window_title: Some("Synthetic Cursor Track".to_string()),
        controlled_evidence: Some("synthetic-cursor-e2e".to_string()),
        window_capture: None,
    };
    crate::recording::write_cursor_sidecars(
        &recording.local_file_path,
        &track,
        duration_ms,
        None,
        Some(&capture_source_metadata),
        recording.audio.as_ref(),
        recording.webcam.as_ref(),
        recording.camera_path.as_deref(),
        // Studio E2E asserts the zoom sidecar exists below.
        true,
    );
    let cursor_json = read_json_if_exists(&cursor_path)
        .ok_or_else(|| "dev Studio E2E missing synthetic cursor sidecar".to_string())?;
    let zoom_json = read_json_if_exists(&zoom_path)
        .ok_or_else(|| "dev Studio E2E missing synthetic zoom sidecar".to_string())?;
    let screen_charm_json = read_json_if_exists(&screen_charm_path)
        .ok_or_else(|| "dev Studio E2E missing synthetic Screen Charm sidecar".to_string())?;
    let zoom_segments = zoom_json.as_array().map(|items| items.len()).unwrap_or(0);

    recording.cursor_path = Some(cursor_path);
    recording.zoom_path = Some(zoom_path);
    recording.screen_charm_path = Some(screen_charm_path);
    recording.cursor_json = Some(cursor_json);
    recording.zoom_json = Some(zoom_json);
    recording.screen_charm_json = Some(screen_charm_json);
    tracing::info!(
        cursor_events = track.events.len(),
        zoom_segments,
        scroll_events = track
            .events
            .iter()
            .filter(|event| matches!(event, crate::cursor_track::CursorEvent::Scroll { .. }))
            .count(),
        "dev Studio E2E replaced incomplete cursor sidecars"
    );
    Ok(true)
}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn exercise_dev_e2e_cursor_track(
    capture_width: f64,
    capture_height: f64,
    duration_ms: u64,
    cursor_target: Option<DevE2ECursorTarget>,
) {
    if std::env::var("CLIPY_DESKTOP_DEV_E2E_EXERCISE_CURSOR")
        .ok()
        .as_deref()
        == Some("0")
    {
        return;
    }

    let width = capture_width.max(320.0);
    let height = capture_height.max(240.0);
    let end_ms = duration_ms.max(2_500);
    let target_points = cursor_target.map(cursor_target_points);
    std::thread::spawn(move || {
        let fallback_points = [
            (180_u64, 0.18, 0.24, false),
            (360, 0.30, 0.32, false),
            (560, 0.44, 0.44, false),
            (760, 0.58, 0.54, true),
            (1_020, 0.70, 0.58, false),
            (1_300, 0.50, 0.36, false),
            (1_640, 0.32, 0.62, false),
            (2_020, 0.46, 0.50, false),
        ];
        let mut previous_ms = 0;
        if let Some(points) = target_points {
            for (time_ms, x, y, click) in points {
                if time_ms >= end_ms.saturating_sub(180) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(
                    time_ms.saturating_sub(previous_ms),
                ));
                previous_ms = time_ms;
                post_dev_e2e_mouse_move(x, y);
                if click {
                    post_dev_e2e_mouse_click(x, y);
                }
            }
        } else {
            for (time_ms, x, y, click) in fallback_points {
                if time_ms >= end_ms.saturating_sub(180) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(
                    time_ms.saturating_sub(previous_ms),
                ));
                previous_ms = time_ms;
                let point = ((width * x).round(), (height * y).round());
                post_dev_e2e_mouse_move(point.0, point.1);
                if click {
                    post_dev_e2e_mouse_click(point.0, point.1);
                }
            }
        }
        if previous_ms < end_ms.saturating_sub(220) {
            std::thread::sleep(std::time::Duration::from_millis(80));
            previous_ms = previous_ms.saturating_add(80);
            post_dev_e2e_scroll(width * 0.54, height * 0.48, 0, 5);
        }
        if previous_ms < end_ms.saturating_sub(160) {
            std::thread::sleep(std::time::Duration::from_millis(80));
            post_dev_e2e_key_chord(&[55], 40);
        }
    });
}

#[cfg(all(debug_assertions, not(target_os = "macos")))]
fn exercise_dev_e2e_cursor_track(
    _capture_width: f64,
    _capture_height: f64,
    _duration_ms: u64,
    _cursor_target: Option<DevE2ECursorTarget>,
) {
}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn cursor_target_points(target: DevE2ECursorTarget) -> Vec<(u64, f64, f64, bool)> {
    let padding = 10.0;
    let gap = 8.0;
    let cell_w = (target.width - padding * 2.0 - gap * 5.0) / 6.0;
    let cell_h = (target.height - padding * 2.0 - gap * 2.0) / 3.0;
    let center = |col: f64, row: f64| {
        (
            target.x + padding + col * (cell_w + gap) + cell_w / 2.0,
            target.y + padding + row * (cell_h + gap) + cell_h / 2.0,
        )
    };
    let text = center(0.0, 0.0);
    let pointer = center(1.0, 0.0);
    let resize_x = center(2.0, 0.0);
    let resize_y = center(3.0, 0.0);
    let resize_east = center(4.0, 0.0);
    let resize_west = center(5.0, 0.0);
    let resize_north = center(0.0, 1.0);
    let resize_south = center(1.0, 1.0);
    let resize_nwse = center(2.0, 1.0);
    let resize_nesw = center(3.0, 1.0);
    let cross = center(4.0, 1.0);
    let blocked = center(5.0, 1.0);
    let move_zone = center(0.0, 2.0);
    let grab = center(1.0, 2.0);
    let grabbing = center(2.0, 2.0);
    let help = center(3.0, 2.0);
    let zoom = center(4.0, 2.0);
    let zoom_out = center(5.0, 2.0);
    vec![
        (180, text.0, text.1, false),
        (430, pointer.0, pointer.1, true),
        (680, resize_x.0, resize_x.1, false),
        (930, resize_y.0, resize_y.1, false),
        (1_180, resize_east.0, resize_east.1, false),
        (1_430, resize_west.0, resize_west.1, false),
        (1_680, resize_north.0, resize_north.1, false),
        (1_930, resize_south.0, resize_south.1, false),
        (2_180, resize_nwse.0, resize_nwse.1, false),
        (2_430, resize_nesw.0, resize_nesw.1, false),
        (2_680, cross.0, cross.1, false),
        (2_930, blocked.0, blocked.1, false),
        (3_180, move_zone.0, move_zone.1, false),
        (3_430, grab.0, grab.1, false),
        (3_680, grabbing.0, grabbing.1, false),
        (3_930, help.0, help.1, false),
        (4_180, zoom.0, zoom.1, false),
        (4_430, zoom_out.0, zoom_out.1, false),
        (4_620, text.0, text.1, false),
    ]
}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn post_dev_e2e_mouse_move(x: f64, y: f64) {
    post_dev_e2e_mouse_event(5, x, y);
}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn post_dev_e2e_mouse_click(x: f64, y: f64) {
    post_dev_e2e_mouse_event(1, x, y);
    std::thread::sleep(std::time::Duration::from_millis(90));
    post_dev_e2e_mouse_event(2, x, y);
}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn post_dev_e2e_mouse_event(kind: u32, x: f64, y: f64) {
    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventCreateMouseEvent(
            source: *const std::ffi::c_void,
            mouse_type: u32,
            mouse_cursor_position: CGPoint,
            mouse_button: u32,
        ) -> *mut std::ffi::c_void;
        fn CGEventPost(tap: u32, event: *mut std::ffi::c_void);
        fn CFRelease(cf: *const std::ffi::c_void);
    }

    // kCGHIDEventTap = 0, kCGMouseButtonLeft = 0.
    unsafe {
        let event = CGEventCreateMouseEvent(std::ptr::null(), kind, CGPoint { x, y }, 0);
        if !event.is_null() {
            CGEventPost(0, event);
            CFRelease(event.cast_const());
        }
    }
}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn post_dev_e2e_scroll(x: f64, y: f64, delta_x: i32, delta_y: i32) {
    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventCreateScrollWheelEvent2(
            source: *const std::ffi::c_void,
            units: u32,
            wheel_count: u32,
            wheel_1: i32,
            wheel_2: i32,
            wheel_3: i32,
        ) -> *mut std::ffi::c_void;
        fn CGEventSetLocation(event: *mut std::ffi::c_void, location: CGPoint);
        fn CGEventPost(tap: u32, event: *mut std::ffi::c_void);
        fn CFRelease(cf: *const std::ffi::c_void);
    }

    // kCGScrollEventUnitPixel = 0, kCGHIDEventTap = 0.
    unsafe {
        let event = CGEventCreateScrollWheelEvent2(std::ptr::null(), 0, 2, delta_y, delta_x, 0);
        if !event.is_null() {
            CGEventSetLocation(event, CGPoint { x, y });
            CGEventPost(0, event);
            CFRelease(event.cast_const());
        }
    }
}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn post_dev_e2e_key_chord(modifiers: &[u16], key_code: u16) {
    for modifier in modifiers {
        post_dev_e2e_key_event(*modifier, true);
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    post_dev_e2e_key_event(key_code, true);
    std::thread::sleep(std::time::Duration::from_millis(120));
    post_dev_e2e_key_event(key_code, false);
    std::thread::sleep(std::time::Duration::from_millis(40));
    for modifier in modifiers.iter().rev() {
        post_dev_e2e_key_event(*modifier, false);
    }
}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn post_dev_e2e_key_event(key_code: u16, down: bool) {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventCreateKeyboardEvent(
            source: *const std::ffi::c_void,
            virtual_key: u16,
            key_down: bool,
        ) -> *mut std::ffi::c_void;
        fn CGEventPost(tap: u32, event: *mut std::ffi::c_void);
        fn CFRelease(cf: *const std::ffi::c_void);
    }

    // kCGHIDEventTap = 0.
    unsafe {
        let event = CGEventCreateKeyboardEvent(std::ptr::null(), key_code, down);
        if !event.is_null() {
            CGEventPost(0, event);
            CFRelease(event.cast_const());
        }
    }
}

#[cfg(debug_assertions)]
fn synthetic_dev_e2e_cursor_track(
    capture_width: f64,
    capture_height: f64,
    duration_ms: u64,
) -> crate::cursor_track::CursorTrack {
    use crate::cursor_track::{CoordSpace, CursorEvent, CursorTrack};

    let w = capture_width.max(320.0);
    let h = capture_height.max(240.0);
    let end_ms = duration_ms.max(2_500) as f64;
    let click_ms = (end_ms - 1_200.0).clamp(850.0, 1_400.0);
    let points = [
        (80.0, 0.16, 0.22),
        (260.0, 0.24, 0.30),
        (460.0, 0.38, 0.40),
        (680.0, 0.52, 0.48),
        (click_ms - 80.0, 0.66, 0.55),
        (click_ms + 180.0, 0.72, 0.58),
        ((click_ms + 620.0).min(end_ms - 450.0), 0.48, 0.34),
        ((click_ms + 980.0).min(end_ms - 250.0), 0.30, 0.62),
    ];
    let mut events = Vec::with_capacity(points.len() + 6);
    for (time_ms, x, y) in points {
        events.push(CursorEvent::Move {
            time_ms: time_ms.max(1.0).min(end_ms - 100.0),
            x: (w * x).round() as i32,
            y: (h * y).round() as i32,
            cursor_type: Some("cursor".to_string()),
        });
    }
    events.push(CursorEvent::Down {
        time_ms: click_ms,
        button: 1,
        x: (w * 0.66).round() as i32,
        y: (h * 0.55).round() as i32,
        cursor_type: Some("cursor".to_string()),
        render_x: None,
        render_y: None,
    });
    events.push(CursorEvent::Up {
        time_ms: (click_ms + 120.0).min(end_ms - 100.0),
        button: 1,
        x: (w * 0.66).round() as i32,
        y: (h * 0.55).round() as i32,
        cursor_type: Some("cursor".to_string()),
    });
    events.push(CursorEvent::Scroll {
        time_ms: (click_ms + 300.0).min(end_ms - 100.0),
        x: (w * 0.54).round() as i32,
        y: (h * 0.48).round() as i32,
        delta_x: 0,
        delta_y: 5,
        cursor_type: Some("cursor".to_string()),
    });
    let key_ms = (click_ms + 520.0).min(end_ms - 600.0).max(1_450.0);
    events.push(CursorEvent::KeyDown {
        time_ms: key_ms,
        key_code: 55,
    });
    events.push(CursorEvent::KeyDown {
        time_ms: key_ms + 80.0,
        key_code: 40,
    });
    events.push(CursorEvent::KeyUp {
        time_ms: key_ms + 180.0,
        key_code: 40,
    });
    events.push(CursorEvent::KeyUp {
        time_ms: key_ms + 240.0,
        key_code: 55,
    });
    events.sort_by(|a, b| {
        a.time_ms()
            .partial_cmp(&b.time_ms())
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    CursorTrack {
        events,
        sample_hz: 60,
        coord_space: CoordSpace::LogicalMacos,
        capture_source: None,
        click_elements: Vec::new(),
        capture: None,
        capture_timeline: Vec::new(),
    }
}

// ---------- App settings ----------

#[cfg(target_os = "macos")]
pub(crate) const DEFAULT_HOTKEY: &str = "Meta+Alt+KeyR";
#[cfg(not(target_os = "macos"))]
pub(crate) const DEFAULT_HOTKEY: &str = "Control+Alt+KeyR";
pub(crate) const SETTINGS_STORE: &str = "settings.json";
const HOTKEY_DEFAULT_MIGRATION_KEY: &str = "hotkey_default_migration";
const RECORDING_SETTINGS_KEY: &str = "recording_settings";
/// Settings-store key for "open the finished local AREC by itself".
pub(crate) const OPEN_LOCAL_AREC_KEY: &str = "open_local_arec";
/// Settings-store keys for the camera look (Touch up / Auto lighting)
/// and for keeping the bubble where the user last dragged it.
const TOUCH_UP_ENABLED_KEY: &str = "camera_touch_up_enabled";
const TOUCH_UP_STRENGTH_KEY: &str = "camera_touch_up_strength";
const AUTO_LIGHTING_KEY: &str = "camera_auto_lighting";
const PERSIST_WEBCAM_POSITION_KEY: &str = "persist_webcam_position";
const WEBCAM_WINDOW_FRAMES_KEY: &str = "webcam_window_frames";
/// Event the webcam window listens on for live look changes.
pub(crate) const EVENT_CAMERA_LOOK_CHANGED: &str = "camera-look-changed";

pub(crate) fn parse_hotkey(s: &str) -> Option<Shortcut> {
    let parts: Vec<&str> = s.split('+').collect();
    if parts.len() < 2 {
        return None;
    }
    let key_str = parts.last()?;
    let mut mods = Modifiers::empty();
    for part in &parts[..parts.len() - 1] {
        match *part {
            "Meta" | "Super" | "Cmd" => mods |= Modifiers::META,
            "Ctrl" | "Control" => mods |= Modifiers::CONTROL,
            "Alt" | "Option" => mods |= Modifiers::ALT,
            "Shift" => mods |= Modifiers::SHIFT,
            _ => return None,
        }
    }
    let code = parse_code(key_str)?;
    Some(Shortcut::new(Some(mods), code))
}

pub(crate) fn current_hotkey_after_default_migration(app: &AppHandle) -> String {
    let default_hotkey = DEFAULT_HOTKEY.to_string();
    let Ok(store) = app.store(SETTINGS_STORE) else {
        return default_hotkey;
    };

    let migration = store
        .get(HOTKEY_DEFAULT_MIGRATION_KEY)
        .and_then(|value| value.as_str().map(String::from));
    if migration.as_deref() != Some(DEFAULT_HOTKEY) {
        store.set("hotkey", serde_json::json!(DEFAULT_HOTKEY));
        store.set(
            HOTKEY_DEFAULT_MIGRATION_KEY,
            serde_json::json!(DEFAULT_HOTKEY),
        );
        if let Err(err) = store.save() {
            tracing::warn!("failed to persist hotkey default migration: {err:#}");
        }
        return default_hotkey;
    }

    store
        .get("hotkey")
        .and_then(|value| value.as_str().map(String::from))
        .unwrap_or(default_hotkey)
}

fn parse_code(s: &str) -> Option<Code> {
    match s {
        "KeyA" => Some(Code::KeyA),
        "KeyB" => Some(Code::KeyB),
        "KeyC" => Some(Code::KeyC),
        "KeyD" => Some(Code::KeyD),
        "KeyE" => Some(Code::KeyE),
        "KeyF" => Some(Code::KeyF),
        "KeyG" => Some(Code::KeyG),
        "KeyH" => Some(Code::KeyH),
        "KeyI" => Some(Code::KeyI),
        "KeyJ" => Some(Code::KeyJ),
        "KeyK" => Some(Code::KeyK),
        "KeyL" => Some(Code::KeyL),
        "KeyM" => Some(Code::KeyM),
        "KeyN" => Some(Code::KeyN),
        "KeyO" => Some(Code::KeyO),
        "KeyP" => Some(Code::KeyP),
        "KeyQ" => Some(Code::KeyQ),
        "KeyR" => Some(Code::KeyR),
        "KeyS" => Some(Code::KeyS),
        "KeyT" => Some(Code::KeyT),
        "KeyU" => Some(Code::KeyU),
        "KeyV" => Some(Code::KeyV),
        "KeyW" => Some(Code::KeyW),
        "KeyX" => Some(Code::KeyX),
        "KeyY" => Some(Code::KeyY),
        "KeyZ" => Some(Code::KeyZ),
        "Digit0" => Some(Code::Digit0),
        "Digit1" => Some(Code::Digit1),
        "Digit2" => Some(Code::Digit2),
        "Digit3" => Some(Code::Digit3),
        "Digit4" => Some(Code::Digit4),
        "Digit5" => Some(Code::Digit5),
        "Digit6" => Some(Code::Digit6),
        "Digit7" => Some(Code::Digit7),
        "Digit8" => Some(Code::Digit8),
        "Digit9" => Some(Code::Digit9),
        "F1" => Some(Code::F1),
        "F2" => Some(Code::F2),
        "F3" => Some(Code::F3),
        "F4" => Some(Code::F4),
        "F5" => Some(Code::F5),
        "F6" => Some(Code::F6),
        "F7" => Some(Code::F7),
        "F8" => Some(Code::F8),
        "F9" => Some(Code::F9),
        "F10" => Some(Code::F10),
        "F11" => Some(Code::F11),
        "F12" => Some(Code::F12),
        "Space" => Some(Code::Space),
        "Minus" => Some(Code::Minus),
        "Equal" => Some(Code::Equal),
        "BracketLeft" => Some(Code::BracketLeft),
        "BracketRight" => Some(Code::BracketRight),
        "Backslash" => Some(Code::Backslash),
        "Semicolon" => Some(Code::Semicolon),
        "Quote" => Some(Code::Quote),
        "Backquote" => Some(Code::Backquote),
        "Comma" => Some(Code::Comma),
        "Period" => Some(Code::Period),
        "Slash" => Some(Code::Slash),
        _ => None,
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Dock presence. On = app shows in the Dock (Regular activation
    /// policy); off = menu-bar-only (Accessory). macOS-only; inert on
    /// other platforms.
    pub show_in_dock: bool,
    pub hotkey: String,
    /// Floating recording pill on/off. Off = record invisibly (the user
    /// may be screen-sharing their real screen in a meeting); stop via
    /// hotkey, tray, or the main window.
    pub show_recording_controls: bool,
    /// Whether a finished local AREC opens itself in the viewer. Off = no
    /// window; the path is copied to the clipboard either way.
    pub open_local_arec: bool,
    /// Camera look: skin smoothing and exposure, applied by the bubble.
    /// Both off by default.
    #[serde(flatten)]
    pub camera_look: CameraLookDto,
    /// Keep the camera bubble where the user last dragged it, across
    /// launches. On by default.
    pub persist_webcam_position: bool,
    /// Open a screenshot in the annotation window before copying or sharing
    /// it. On by default.
    pub screenshot_editor: bool,
}

/// What the bubble draws with: `touch_up_strength` is 0..1 and only counts
/// while `touch_up_enabled`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraLookDto {
    pub touch_up_enabled: bool,
    pub touch_up_strength: f64,
    pub auto_lighting: bool,
}

impl Default for CameraLookDto {
    fn default() -> Self {
        Self {
            touch_up_enabled: false,
            touch_up_strength: 0.5,
            auto_lighting: false,
        }
    }
}

pub(crate) fn camera_look<R: tauri::Runtime>(app: &AppHandle<R>) -> CameraLookDto {
    let defaults = CameraLookDto::default();
    let Ok(store) = app.store(SETTINGS_STORE) else {
        return defaults;
    };
    let flag = |key: &str, default: bool| {
        store.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
    };
    CameraLookDto {
        touch_up_enabled: flag(TOUCH_UP_ENABLED_KEY, defaults.touch_up_enabled),
        touch_up_strength: store
            .get(TOUCH_UP_STRENGTH_KEY)
            .and_then(|v| v.as_f64())
            .map(|v| v.clamp(0.0, 1.0))
            .unwrap_or(defaults.touch_up_strength),
        auto_lighting: flag(AUTO_LIGHTING_KEY, defaults.auto_lighting),
    }
}

impl CameraLookDto {
    fn processor_look(self) -> crate::camera_effects::Look {
        crate::camera_effects::Look {
            touch_up: if self.touch_up_enabled { self.touch_up_strength as f32 } else { 0.0 },
            auto_lighting: self.auto_lighting,
        }
    }
}

/// Hand the saved look to the native processor at launch.
pub(crate) fn sync_camera_look<R: tauri::Runtime>(app: &AppHandle<R>) {
    crate::camera_effects::set_look(camera_look(app).processor_look());
}

/// Persists the camera look and applies it: the native processor (macOS
/// preview and camera-only recordings) picks it up on its next frame, and
/// the bubble webview (Windows) is told by event.
#[tauri::command]
pub fn update_camera_look(app: AppHandle, look: CameraLookDto) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    let look = CameraLookDto {
        touch_up_strength: look.touch_up_strength.clamp(0.0, 1.0),
        ..look
    };
    store.set(TOUCH_UP_ENABLED_KEY, serde_json::json!(look.touch_up_enabled));
    store.set(TOUCH_UP_STRENGTH_KEY, serde_json::json!(look.touch_up_strength));
    store.set(AUTO_LIGHTING_KEY, serde_json::json!(look.auto_lighting));
    store.save().map_err(|e| e.to_string())?;
    crate::camera_effects::set_look(look.processor_look());
    let _ = app.emit(EVENT_CAMERA_LOOK_CHANGED, look);
    Ok(())
}

pub(crate) fn persist_webcam_position_enabled<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|s| s.get(PERSIST_WEBCAM_POSITION_KEY))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Persists the "leave the bubble where I put it" preference. Turning it
/// off forgets every remembered position at once, so the next show lands
/// on the default spot rather than a stale one.
#[tauri::command]
pub fn update_persist_webcam_position(app: AppHandle, enabled: bool) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    store.set(PERSIST_WEBCAM_POSITION_KEY, serde_json::json!(enabled));
    if !enabled {
        webcam_window_frames().lock().clear();
        webcam_restored_layouts().lock().clear();
        store.delete(WEBCAM_WINDOW_FRAMES_KEY);
    }
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Bring the remembered bubble positions back from disk at launch, when the
/// user asked for them to persist.
pub(crate) fn load_webcam_window_frames<R: tauri::Runtime>(app: &AppHandle<R>) {
    if !persist_webcam_position_enabled(app) {
        return;
    }
    let Ok(store) = app.store(SETTINGS_STORE) else {
        return;
    };
    let Some(saved) = store
        .get(WEBCAM_WINDOW_FRAMES_KEY)
        .and_then(|v| serde_json::from_value::<HashMap<WebcamLayoutDto, WebcamWindowFrame>>(v).ok())
    else {
        return;
    };
    webcam_restored_layouts().lock().extend(saved.keys().copied());
    webcam_window_frames().lock().extend(saved);
}

/// When the debounced position save is due. Every move pushes it out; one
/// worker sleeps until it stops moving.
static WEBCAM_FRAME_SAVE_DUE: OnceLock<parking_lot::Mutex<Option<Instant>>> = OnceLock::new();
/// Whether that worker is alive, so a drag never spawns a second one.
static WEBCAM_FRAME_SAVE_WORKER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const WEBCAM_FRAME_SAVE_DEBOUNCE: Duration = Duration::from_millis(400);

fn webcam_frame_save_due() -> &'static parking_lot::Mutex<Option<Instant>> {
    WEBCAM_FRAME_SAVE_DUE.get_or_init(|| parking_lot::Mutex::new(None))
}

/// A drag fires `Moved` many times a second; writing the settings file on
/// each one would put disk I/O on the window-event path. The in-memory frame
/// is already current, so the file only needs the position once the drag
/// settles: each move pushes the due time out, and a single worker waits it
/// out and writes once.
fn save_webcam_window_frames_debounced<R: tauri::Runtime>(app: &AppHandle<R>) {
    use std::sync::atomic::Ordering;
    *webcam_frame_save_due().lock() = Some(Instant::now() + WEBCAM_FRAME_SAVE_DEBOUNCE);
    if WEBCAM_FRAME_SAVE_WORKER.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            let due = *webcam_frame_save_due().lock();
            match due {
                Some(at) if at > Instant::now() => std::thread::sleep(at - Instant::now()),
                _ => break,
            }
        }
        // Cleared before the write: a move landing during the write finds
        // no worker and starts the next one, and the frame it recorded is
        // already in memory for this write anyway.
        WEBCAM_FRAME_SAVE_WORKER.store(false, Ordering::SeqCst);
        let Ok(store) = app.store(SETTINGS_STORE) else {
            return;
        };
        let frames = webcam_window_frames().lock().clone();
        if let Ok(value) = serde_json::to_value(frames) {
            store.set(WEBCAM_WINDOW_FRAMES_KEY, value);
            let _ = store.save();
        }
    });
}

pub(crate) fn show_recording_controls_enabled(app: &AppHandle) -> bool {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|s| s.get("show_recording_controls"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Whether a finished local AREC opens its viewer window by itself.
/// Defaults to `true` — the first local recording should show the user what
/// an AREC is. Generic over the runtime because local processing runs on its
/// own thread with a generic handle, not the concrete app one.
pub(crate) fn open_local_arec_enabled<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|s| s.get(OPEN_LOCAL_AREC_KEY))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Whether the app should appear in the Dock. Defaults to `true` so
/// settings files predating this key (and fresh installs) show in the Dock.
pub(crate) fn show_in_dock_enabled(app: &AppHandle) -> bool {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|s| s.get("show_in_dock"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

#[tauri::command]
pub fn get_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    Ok(AppSettings {
        show_in_dock: show_in_dock_enabled(&app),
        hotkey: current_hotkey_after_default_migration(&app),
        show_recording_controls: show_recording_controls_enabled(&app),
        open_local_arec: open_local_arec_enabled(&app),
        camera_look: camera_look(&app),
        persist_webcam_position: persist_webcam_position_enabled(&app),
        screenshot_editor: crate::screenshot::screenshot_editor_enabled(&app),
    })
}

/// Persists the floating-recording-controls preference. Applies from the
/// next recording (the visibility listener consults it on every phase
/// change).
#[tauri::command]
pub fn update_show_recording_controls(app: AppHandle, enabled: bool) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    store.set("show_recording_controls", serde_json::json!(enabled));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Persists the auto-open preference. Read at the end of local processing,
/// so a change applies to the next recording that finishes — including one
/// already being transcribed.
#[tauri::command]
pub fn update_open_local_arec(app: AppHandle, enabled: bool) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    store.set(OPEN_LOCAL_AREC_KEY, serde_json::json!(enabled));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_recording_settings(app: AppHandle) -> Result<RecordingSettingsDto, String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    let settings = store
        .get(RECORDING_SETTINGS_KEY)
        .and_then(|value| serde_json::from_value::<RecordingSettingsDto>(value.clone()).ok())
        .unwrap_or_default()
        .normalized();
    // Mirrored so an upload with no per-recording intent — a recovered
    // orphan, an agent/tray/hotkey start — still honours the user's standing
    // sharing preference instead of silently falling back to public.
    crate::recording_intent::set_default_sharing(settings.share_scope, settings.share_domains.clone());
    Ok(settings)
}

/// Read the persisted share scope into the process-wide fallback without
/// going through the command layer. Called at startup so a recording begun
/// before the panel is ever opened (the agent bridge) still honours it.
pub fn warm_default_sharing(app: &AppHandle) -> Result<(), String> {
    get_recording_settings(app.clone()).map(|_| ())
}

#[tauri::command]
pub fn update_recording_settings(
    app: AppHandle,
    settings: RecordingSettingsDto,
) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    let settings = settings.normalized();
    crate::recording_intent::set_default_sharing(settings.share_scope, settings.share_domains.clone());
    store.set(RECORDING_SETTINGS_KEY, serde_json::json!(settings));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_hotkey(app: AppHandle, hotkey: String) -> Result<(), String> {
    let new_sc = parse_hotkey(&hotkey).ok_or_else(|| format!("invalid hotkey: {hotkey}"))?;
    if crate::recorder_actions::reserved_for(&app, new_sc) { return Err("This shortcut is used by a recording control".into()); }

    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    let old_hotkey = store
        .get("hotkey")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string());

    let old_sc = parse_hotkey(&old_hotkey);
    if old_sc == Some(new_sc) && app.global_shortcut().is_registered(new_sc) {
        crate::recorder_actions::init(&app, &hotkey);
        return Ok(());
    }
    app.global_shortcut()
        .register(new_sc)
        .map_err(|e| format!("failed to register shortcut: {e}"))?;
    store.set("hotkey", serde_json::json!(hotkey));
    if let Err(error) = store.save() {
        store.set("hotkey", serde_json::json!(old_hotkey));
        let _ = app.global_shortcut().unregister(new_sc);
        return Err(error.to_string());
    }
    if let Some(old_sc) = old_sc.filter(|old| *old != new_sc) {
        let _ = app.global_shortcut().unregister(old_sc);
    }
    crate::recorder_actions::init(&app, &hotkey);
    Ok(())
}

/// Persists the "show in Dock" preference and applies it immediately.
/// `enabled` true => Dock icon visible (Regular activation policy); false =>
/// menu-bar-only (Accessory). The runtime activation-policy change is
/// macOS-only; on other platforms this just persists the flag.
#[tauri::command]
pub fn update_show_in_dock(app: AppHandle, enabled: bool) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    store.set("show_in_dock", serde_json::json!(enabled));
    store.save().map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    app.set_activation_policy(if enabled {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    })
    .map_err(|e| format!("failed to set activation policy: {e}"))?;

    Ok(())
}

/// Regression cover for the intermittent
/// `failed to initiate COM: HRESULT(0x80010106)` on camera enumeration.
///
/// The real trigger is thread reuse: `list_webcam_devices` runs on a tokio
/// blocking-pool thread, and cpal's WASAPI backend leaves every thread it
/// touches in a single-threaded apartment. Listing microphones and then cameras
/// can therefore land the camera path on a thread that is already STA, and the
/// MTA request comes back `RPC_E_CHANGED_MODE`.
///
/// Waiting for that race is not a test, so this creates the condition directly:
/// a thread that has explicitly joined an STA, which is exactly the state a
/// recycled cpal thread is in.
#[cfg(all(test, target_os = "windows"))]
mod windows_camera_enumeration_tests {
    use super::*;

    #[test]
    fn enumerating_cameras_survives_a_thread_that_is_already_in_an_sta() {
        use windows::Win32::System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
        };

        let outcome = std::thread::spawn(|| {
            // SAFETY: Category 8 — FFI contract. This thread joins an STA and
            // leaves it before returning; nothing else runs on it.
            unsafe {
                let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                assert!(
                    hr.is_ok(),
                    "test setup could not put the thread into an STA: {hr:?}"
                );
            }
            let result = list_webcam_devices_impl();
            // SAFETY: balances the successful `CoInitializeEx` above.
            unsafe { CoUninitialize() };
            result
        })
        .join()
        .expect("enumeration thread panicked");

        // A machine with no camera legitimately returns an empty list, and a CI
        // box may refuse Media Foundation entirely. The one outcome this must
        // never produce is the COM-apartment bail-out, which is a bug in us
        // rather than a fact about the hardware.
        if let Err(message) = &outcome {
            assert!(
                !message.contains("failed to initialize COM"),
                "STA thread was rejected instead of accepted: {message}"
            );
        }
    }
}
