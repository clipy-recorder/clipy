#![recursion_limit = "256"]
// The local edition (no `cloud` feature) still compiles shared helpers whose
// only callers are official-app code paths.
#![allow(dead_code)]

// The `cloud` feature builds the official Clipy app (account, upload,
// updates). Its sources are not part of this repository.
#[cfg(feature = "cloud")]
compile_error!("The cloud feature is the official Clipy app and is not part of this repository. Build without it (the default).");

// The local edition replaces Clipy's servers with the `local` feature's
// crates (moment planner, settings, Windows transcription).
#[cfg(not(feature = "local"))]
compile_error!(
    "Enable the `local` feature: `cargo build --features local` builds Clipy Local."
);

mod api_error;
// Local edition: small stand-ins in `edition_local/` that expose only what
// shared code names (no account, no plan, no upload).
#[path = "edition_local/auth.rs"]
mod auth;
mod commands;
mod config;
mod capture_health;
mod edition;
#[path = "edition_local/entitlement.rs"]
mod entitlement;
mod i18n;
mod keychain;
mod login_item;
mod notes_window;
mod clipboard_history;
mod onboarding;
mod whats_new;
#[cfg(target_os = "macos")]
mod repeat_error;
mod screenshot;
#[cfg(target_os = "windows")]
mod screenshot_win;
#[cfg(target_os = "windows")]
mod windows_privacy;
mod native_webcam;
mod webcam_controls;
mod mic_monitor;
mod mp4_boxes;
mod shutdown;
mod telemetry;
mod tray;
mod types;

// Phase 2 — capture, encoding, recording state machine.
// Encoding goes through `encoder` (ffmpeg-next + h264_videotoolbox on macOS,
// libx264 on Windows + AAC on both). The previous AVAssetWriter-based
// `av_writer.rs` was retired after the ffmpeg path proved out; see commits
// `9dc8c9c` and `7811b1b` for history.
//
// On Windows, capture uses the Windows Graphics Capture API (WGC) via
// `windows-capture`; system audio loopback runs through cpal's WASAPI
// backend. Mic capture is already cross-platform via cpal.
mod capture;
// Windows only (the tests run everywhere): when hiding an overlay from
// capture would draw it as a black box instead.
#[cfg(any(target_os = "windows", test))]
mod capture_exclusion;
mod denoise;
mod encoder;
mod recording;
mod recording_health;
mod recording_intent;
mod recording_controls;
mod annotation;
mod camera_effects;
#[cfg(target_os = "macos")]
mod camera_preview_ws;
mod recorder_actions;
mod window_picker;
mod thumbnails;
#[cfg(target_os = "windows")]
mod thumbnails_win;
mod webview_scale;

// Phase 3 — streaming upload + share link
#[path = "edition_local/upload.rs"]
mod upload;
mod recording_files;
mod local;

// Phase 5 polish — cursor + click track sidecar (for click
// auto-zoom). `cursor_track` does the live capture, `zoom_segments`
// turns the captured clicks into JSON the editor/export pipeline can
// render.
mod cursor_track;
mod zoom_segments;
// Flare outside a recording: hold Control+Shift, or "Show Pointer" in the
// tray menu, to point at something on a shared screen.
mod pointer;
// Talk to your agent: hold a key, talk and point, let go, and the words and
// the Local AREC path are pasted where you were typing.
mod talk;

// Agent bridge — local AI agents (Claude Code via @clipy/cli) trigger real
// recordings through a Unix-socket control surface. See agent_bridge.rs for
// the security model (UDS + token + consent dialog + max-duration rail).
// Both editions: Clipy Local's agent takes are Local takes.
mod agent_bridge;

use tauri::{Emitter, Listener, Manager, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_store::StoreExt;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Loaded before the builder so plain, dependency-free state can be
    // managed up front (see the `.manage()` calls below).
    let cfg = config::Config::load();

    let builder = tauri::Builder::default()
        // Managed on the builder, not in `.setup()`: Tauri creates the
        // config windows BEFORE running the setup hook, so on Windows the
        // webview can invoke a command (e.g. `get_last_share_link` on mount)
        // while setup is still running. A command whose state was only
        // managed in setup then rejects with "state not managed for field
        // `rec`". None of these need the app handle.
        .manage(recording::RecordingController::new(cfg.api_base.clone()))
        .manage(local::LocalState::default())
        .manage(entitlement::EntitlementState::default())
        .manage(cfg)
        // Single-instance must come first so a second launch (e.g. via the
        // OS handing us a clipy:// URL) is forwarded to the running process
        // instead of starting a duplicate that holds an empty pending map.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            tracing::info!("second instance args: {:?}", args);
            // On Windows/Linux a clipy:// URL arrives as an argv entry. The
            // single-instance "deep-link" feature already hands those args to
            // the deep-link plugin, which fires the `on_open_url` handler
            // registered in setup. Dispatching them here as well ran every
            // callback twice: two concurrent sign-in exchanges racing for one
            // PKCE state and two viewer opens for a
            // clipy://local link. So this callback only surfaces the window.
            tray::show_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init());
    builder
        .plugin(tauri_plugin_process::init())
        .plugin(webview_scale::init())
        .on_window_event(|window, event| {
            #[cfg(target_os = "windows")]
            if let WindowEvent::ScaleFactorChanged { scale_factor, .. } = event {
                if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                    let scale = *scale_factor;
                    let _ = webview.with_webview(move |platform| {
                        webview_scale::pin_to_display_scale(platform, scale)
                    });
                }
            }
            if window.label() == "stop-controls" && matches!(event, WindowEvent::Moved(_)) {
                if let Some(hint) = window.app_handle().get_webview_window("recording-hint") {
                    let _ = hint.hide();
                }
            }
            if window.label() == "webcam" {
                if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                    commands::remember_webcam_window_frame(window);
                    if let Err(err) =
                        commands::sync_webcam_controls_to_bubble(window.app_handle())
                    {
                        tracing::warn!("webcam controls position sync failed: {err}");
                    }
                }
                return;
            }

            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // Dismiss, not a bare hide: a bare hide leaves the picker
                // session (source highlight, camera preview) running behind
                // the hidden popover.
                tray::dismiss_main(window.app_handle());
            }
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if recorder_actions::handle(app, shortcut) { return; }
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let rec = app.state::<recording::RecordingController>();
                        let phase = rec.dto().phase;
                        match phase {
                            crate::types::RecordingPhase::Idle => {
                                if !edition::can_start_recording(&app) {
                                    tray::show_main(&app);
                                    return;
                                }
                                tray::request_source_picker(&app).await;
                            }
                            crate::types::RecordingPhase::Recording
                            | crate::types::RecordingPhase::Paused => {
                                if let Err(err) = rec.stop(&app).await {
                                    tracing::warn!("hotkey stop failed: {err:#}");
                                }
                            }
                            // Other phases (countdown / stopping / uploading) — ignore
                            // the toggle; user shouldn't be able to interrupt those
                            // mid-flight via a global hotkey.
                            _ => {}
                        }
                    });
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            edition::get_edition,
            annotation::get_annotation_color,
            annotation::set_annotation_color,
            annotation::clear_annotations,
            annotation::get_annotation_width,
            annotation::set_annotation_width,
            camera_effects::get_camera_effects,
            camera_effects::set_camera_effects,
            camera_effects::import_camera_background,
            #[cfg(target_os = "windows")]
            camera_effects::read_camera_background,
            recorder_actions::get_recorder_shortcuts,
            recorder_actions::set_recorder_shortcut,
            recorder_actions::show_screenshot_panel,
            notes_window::show_notes_window,
            clipboard_history::get_clipboard_history,
            clipboard_history::paste_clipboard_entry,
            clipboard_history::clipboard_image_thumbnail,
            clipboard_history::clipboard_image,
            clipboard_history::copy_clipboard_entry,
            clipboard_history::set_clipboard_entry_favorite,
            clipboard_history::edit_clipboard_entry,
            clipboard_history::delete_clipboard_entry,
            clipboard_history::clear_clipboard_history,
            clipboard_history::hide_clipboard_history,
            clipboard_history::get_clipboard_history_enabled,
            talk::get_talk_settings,
            talk::set_talk_settings,
            clipboard_history::get_clipboard_key_clash,
            clipboard_history::set_clipboard_history_enabled,
            notes_window::hide_notes_window,
            notes_window::toggle_notes_window,
            notes_window::notes_window_visible,
            onboarding::show_onboarding_window,
            onboarding::finish_onboarding,
            onboarding::offer_onboarding_window,
            onboarding::relaunch_into_setup,
            onboarding::open_tray_settings,
            whats_new::get_whats_new_state,
            whats_new::acknowledge_whats_new,
            whats_new::snooze_whats_new,
            whats_new::mark_feature_tried,
            whats_new::show_whats_new_window,
            whats_new::show_recorder_from_whats_new,
            screenshot::capture_screenshot,
            screenshot::reveal_screenshot,
            screenshot::screenshot_editor_pending,
            screenshot::screenshot_editor_source,
            screenshot::finish_screenshot,
            screenshot::stage_screenshot_scene,
            screenshot::discard_screenshot,
            screenshot::close_screenshot_editor,
            screenshot::update_screenshot_editor,
            window_picker::pick_window_interactively,
            window_picker::get_window_picker_snapshot,
            window_picker::complete_window_picker,
            window_picker::cancel_window_picker,
            i18n::set_ui_locale,
            i18n::get_account_locale,
            i18n::save_account_locale,
            commands::toggle_recording_webcam,
            commands::get_recording_webcam_visible,
            commands::set_cursor_trail_enabled,
            commands::get_cursor_trail_enabled,
            commands::get_cursor_trail_available,
            commands::update_show_recording_controls,
            commands::list_capture_sources,
            commands::get_source_thumbnail,
            commands::list_audio_input_devices,
            commands::check_microphone_input,
            commands::start_mic_monitor,
            commands::stop_mic_monitor,
            commands::start_recording,
            local::local_setup,
            local::list_local_recordings,
            local::retry_local_recording,
            local::open_local_recording,
            local::viewer::read_local_recording,
            local::viewer::show_local_viewer,
            local::viewer::reveal_local_recording_file,
            local::delete_local_recording,
            local::set_local_recording_kept,
            local::settings::get_local_settings,
            local::settings::save_local_settings,
            local::settings::local_model_status,
            local::settings::download_local_model,
            local::settings::cancel_local_model_download,
            commands::stop_recording,
            commands::pause_recording,
            commands::resume_recording,
            commands::set_mic_muted,
            commands::cancel_recording,
            commands::get_recording_state,
            commands::save_webcam_sidecar,
            commands::check_desktop_permissions,
            commands::request_desktop_permission,
            commands::open_privacy_settings,
            commands::relaunch_app,
            commands::request_camera_permission,
            commands::list_webcam_devices,
            commands::show_webcam_bubble,
            commands::get_webcam_bubble_state,
            commands::camera_preview_url,
            commands::hide_webcam_bubble,
            commands::set_webcam_layout,
            commands::update_webcam_appearance,
            commands::set_recording_controls_layout,
            recording_controls::set_recording_controls_size,
            recording_controls::set_recording_controls_hint,
            recording_controls::get_recording_controls_hint,
            recording_controls::set_recording_hint_bounds,
            commands::set_popover_height,
            commands::show_source_highlight,
            commands::hide_source_highlight,
            commands::pick_window_at_click,
            commands::show_area_select,
            commands::cursor_position,
            commands::hide_area_select,
            commands::complete_area_select,
            commands::cancel_area_select,
            commands::report_webview_error,
            commands::get_app_settings,
            login_item::get_login_item_status,
            login_item::set_launch_at_login,
            commands::get_recording_settings,
            commands::update_recording_settings,
            commands::update_hotkey,
            commands::update_show_in_dock,
            commands::update_open_local_arec,
            commands::update_camera_look,
            commands::update_persist_webcam_position,
            commands::probe_screen_capture,
            #[cfg(debug_assertions)]
            commands::handle_deep_link_url,
        ])
        .setup(|app| {
            let cfg = app.state::<config::Config>().inner().clone();
            let pending_path = app
                .path()
                .app_config_dir()
                .ok()
                .map(|d| d.join("pending-auth.json"));
            let session_path = app
                .path()
                .app_data_dir()
                .ok()
                .map(|d| d.join("session.json"));
            app.manage(auth::AuthState::new(
                cfg.api_base.clone(),
                pending_path,
                session_path,
            ));
            // The camera hover pill is shown and hidden from the native
            // pointer position, not from webview hover events.
            webcam_controls::ensure_running(app.handle());
            // RecordingController and LocalState are managed on the builder.
            // Expire stale local recordings once per launch, not only while the
            // Local panel happens to be open.
            local::sweep_on_launch(app.handle());
            // Agent bridge (UDS control surface for @clipy/cli). Spawned
            // after RecordingController + AuthState are managed — the
            // bridge resolves both from the app handle per request.
            if let Err(error) = camera_effects::init(app.handle()) { tracing::warn!("Camera settings unavailable: {error}"); }
            commands::sync_camera_look(app.handle());
            // The Windows webcam bubble loads its segmentation runtime from resources.
            #[cfg(target_os = "windows")]
            if let Err(error) = app
                .path()
                .resource_dir()
                .map_err(|e| e.to_string())
                .and_then(|dir| {
                    app.asset_protocol_scope()
                        .allow_directory(dir.join("segmentation"), false)
                        .map_err(|e| e.to_string())
                })
            {
                tracing::warn!("camera segmentation assets unavailable: {error}");
            }
            // Warm the standing share-scope preference from the settings
            // store. A recording started before the panel is ever opened
            // (the agent bridge) would otherwise publish a library whose
            // owner set "only me".
            if let Err(error) = commands::warm_default_sharing(app.handle()) {
                tracing::warn!("could not read the saved share scope: {error}");
            }
            agent_bridge::spawn(app.handle().clone());

            // Before the tray: its first menu is built in the saved language.
            i18n::load_persisted(app.handle());
            tray::init(app.handle())?;
            recording_controls::init(app.handle())?;
            window_picker::init(app.handle());
            commands::load_webcam_window_frames(app.handle());
            init_recording_controls_overlay(app.handle().clone());
            init_main_window_recording_visibility(app.handle().clone());
            if let Err(err) =
                commands::set_recording_controls_layout_for_rect(app.handle(), None, None)
            {
                tracing::warn!("recording controls default layout failed: {err:#}");
            }

            // Load persisted settings (non-fatal if the store can't be opened)
            if let Err(err) = login_item::initialize(app.handle()) {
                tracing::warn!("launch at login setup failed: {err}");
            }

            let (show_in_dock, saved_hotkey) = match app.store(commands::SETTINGS_STORE) {
                Ok(store) => {
                    let sid = store
                        .get("show_in_dock")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    let hk = commands::current_hotkey_after_default_migration(app.handle());
                    (sid, hk)
                }
                Err(e) => {
                    tracing::warn!("could not open settings store: {e:#}");
                    (true, commands::DEFAULT_HOTKEY.to_string())
                }
            };

            // Apply Dock visibility: Regular shows the icon (default),
            // Accessory hides it for menu-bar-only users. macOS-only.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(if show_in_dock {
                tauri::ActivationPolicy::Regular
            } else {
                tauri::ActivationPolicy::Accessory
            });
            #[cfg(not(target_os = "macos"))]
            let _ = show_in_dock;

            let toggle_shortcut = commands::parse_hotkey(&saved_hotkey).unwrap_or_else(|| {
                // Platform-default modifier: Cmd on Mac, Ctrl on Windows
                // (matches commands::DEFAULT_HOTKEY).
                #[cfg(target_os = "macos")]
                let mods = Modifiers::META | Modifiers::ALT;
                #[cfg(not(target_os = "macos"))]
                let mods = Modifiers::CONTROL | Modifiers::ALT;
                Shortcut::new(Some(mods), Code::KeyR)
            });
            if let Err(err) = app.global_shortcut().register(toggle_shortcut) {
                tracing::warn!("failed to register global hotkey (may be in use): {err:#}");
            }

            clipboard_history::init(app.handle());
            whats_new::init(app.handle());
            pointer::init(app.handle());
            talk::init(app.handle());
            recorder_actions::init(app.handle(), &saved_hotkey);

            // Register clipy:// with the OS at runtime.
            // On macOS production: the scheme is also in Info.plist, but
            // calling register() here makes it work in `tauri dev` without
            // a full install (LaunchServices doesn't auto-scan the temp bundle).
            // On Windows / Linux: this is the only registration mechanism.
            // Non-fatal — log and continue if registration fails.
            if let Err(e) = app.deep_link().register(edition::DEEP_LINK_SCHEME) {
                tracing::warn!("deep link registration failed (non-fatal): {e:#}");
            }

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(err) = edition::dispatch_deep_link(&handle, &url).await {
                            if auth::is_offline_error(&err) {
                                // The browser half of sign-in succeeded but
                                // this machine could not reach Clipy for the
                                // exchange. The user can retry; not a bug.
                                tracing::warn!("deep link handler failed (network): {:#}", err);
                            } else {
                                tracing::error!("deep link handler failed: {:#}", err);
                            }
                        }
                    });
                }
            });

            // Menu-bar app: main window is hidden on first launch. Show it
            // via the tray "Open Clipy" item (or left-click the tray icon).
            // In dev, show it after the event loop starts so E2E tests don't
            // have to find the tray icon first.
            // Dev builds skip the launch-time setup gate;
            // CLIPY_DESKTOP_ONBOARDING=1 opens it.
            #[cfg(debug_assertions)]
            let debug_setup =
                std::env::var("CLIPY_DESKTOP_ONBOARDING").ok().as_deref() == Some("1");
            #[cfg(debug_assertions)]
            if !debug_setup {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    if handle.get_webview_window("main").is_some() {
                        tray::show_main(&handle);
                        tracing::info!("debug main window shown");
                    } else {
                        tracing::warn!("debug main window missing");
                    }
                });
            }
            // Like release, setup replaces the popover rather than sitting
            // under it.
            #[cfg(debug_assertions)]
            if debug_setup {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = onboarding::show_onboarding_window(handle).await {
                        tracing::warn!("debug setup window: {err}");
                    }
                });
            }
            #[cfg(not(debug_assertions))]
            {
                let signed_in = edition::can_start_recording(app.handle());
                // Until setup's last step is completed, every launch opens
                // the setup window instead of a bare popover under an icon
                // the user has not found yet.
                let surface = onboarding::on_launch(app.handle());
                let show_popover = match surface {
                    onboarding::LaunchSurface::Setup => false,
                    onboarding::LaunchSurface::Usual => !signed_in,
                };
                if !show_popover {
                    // Dismiss, not a bare hide: the webview may already have
                    // opened a picker session (source highlight, camera
                    // preview) behind the hidden window, and only the dismiss
                    // event tells it to tear that session down. A bare hide
                    // used to strand the red source-highlight border on
                    // screen until the app restarted.
                    tray::dismiss_main(app.handle());
                } else {
                    tray::show_main(app.handle());
                }
            }

            // Ask macOS for notification authorization once at startup —
            // without it, UNUserNotificationCenter silently drops every
            // notification we post (share-link ready, mic switched). The
            // prompt may block on user input, so keep it off the setup path.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    use tauri_plugin_notification::NotificationExt;
                    match handle.notification().request_permission() {
                        Ok(state) => tracing::info!(?state, "notification permission"),
                        Err(err) => {
                            tracing::warn!("notification permission request failed: {err:#}")
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Clipy desktop")
        .run(|app, event| {
            // Both quit routes land here — the tray's Quit item calls
            // `AppHandle::exit`, which raises ExitRequested just like Cmd-Q.
            // Quitting mid-capture or mid-upload takes the uploader's retry
            // loop down with the process, so this is the last chance to say so.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                if shutdown::report_exit_with_work_in_flight(app, *code) {
                    api.prevent_exit();
                }
            }
            // macOS sends Reopen when the user clicks the dock icon. We always
            // surface the main window, even when other Clipy windows (the webcam
            // bubble or the stop-controls overlay) are visible — otherwise
            // `has_visible_windows` is true, the dock click is a no-op while the
            // main window stays hidden, and the only way back in is the tray icon.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main(app);
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if let Err(err) = local::viewer::show_path(app, &path) {
                            tracing::warn!("open recording from Finder failed: {err:#}");
                        }
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}

/// The popover must not sit on top of the thing being recorded. It goes
/// away the moment a recording flow starts and comes back afterwards only
/// if the user actually had it open — starting from the hotkey or the tray
/// menu should not pop a window at the end.
fn init_main_window_recording_visibility(app: tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let was_visible = Arc::new(AtomicBool::new(false));
    let hidden_by_us = Arc::new(AtomicBool::new(false));
    let app_for_listener = app.clone();

    app.listen_any(types::EVENT_RECORDING_STATE_CHANGED, move |event| {
        let state: types::RecordingStateDto = match serde_json::from_str(event.payload()) {
            Ok(state) => state,
            Err(err) => {
                tracing::warn!("failed to parse recording state for main window: {err:#}");
                return;
            }
        };
        let Some(window) = app_for_listener.get_webview_window("main") else {
            return;
        };
        let capturing = matches!(
            state.phase,
            types::RecordingPhase::Countdown
                | types::RecordingPhase::Recording
                | types::RecordingPhase::Paused
        );

        if capturing {
            // Only the FIRST capturing event records whether the user had
            // the popover open, but every one of them re-hides it. The
            // ticker fires ~4x a second, so this is also the backstop that
            // closes any window that slipped back on screen mid-take.
            if !hidden_by_us.swap(true, Ordering::SeqCst) {
                was_visible.store(window.is_visible().unwrap_or(false), Ordering::SeqCst);
            }
            if window.is_visible().unwrap_or(false) {
                tray::dismiss_main(&app_for_listener);
            }
            return;
        }

        if hidden_by_us.swap(false, Ordering::SeqCst) && was_visible.swap(false, Ordering::SeqCst) {
            // Stopping/uploading progress and any failure banner live in the
            // popover, so bring it back for the tail of the flow. Tell the
            // frontend first: this is not the user opening a picker, so the
            // source highlight must not come back with it.
            let _ = app_for_listener.emit(types::EVENT_PANEL_RESTORED, ());
            // Raw: the user had the popover open; setup must not take its place.
            tray::show_main_raw(&app_for_listener);
        }
    });
}

fn init_recording_controls_overlay(app: tauri::AppHandle) {
    let app_for_listener = app.clone();
    app.listen_any(types::EVENT_RECORDING_STATE_CHANGED, move |event| {
        let state: types::RecordingStateDto = match serde_json::from_str(event.payload()) {
            Ok(state) => state,
            Err(err) => {
                tracing::warn!("failed to parse recording state for controls overlay: {err:#}");
                return;
            }
        };
        let visible = state.phase == types::RecordingPhase::Countdown
            || state.phase == types::RecordingPhase::Recording
            || state.phase == types::RecordingPhase::Paused;
        if let Err(err) = set_recording_controls_visible(&app_for_listener, visible) {
            tracing::warn!("recording controls visibility update failed: {err:#}");
        }
    });
}

fn set_recording_controls_visible(app: &tauri::AppHandle, visible: bool) -> anyhow::Result<()> {
    let Some(window) = app.get_webview_window("stop-controls") else {
        return Ok(());
    };

    // Owner setting: record invisibly (e.g. screen-sharing the real screen
    // in a meeting). Stop via hotkey, tray, or the main window.
    if !visible || !commands::show_recording_controls_enabled(app) {
        let _ = window.hide();
        if let Some(hint) = app.get_webview_window("recording-hint") {
            let _ = hint.hide();
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        window.set_visible_on_all_workspaces(true)?;
        if let Ok(ns_window) = window.ns_window() {
            unsafe { commands::set_window_sharing_none(ns_window) };
        }
    }
    #[cfg(target_os = "windows")]
    commands::exclude_window_from_capture(&window);
    crate::cursor_track::set_ignore_cursor_events(&window, false)?;
    window.set_always_on_top(true)?;
    window.show()?;
    Ok(())
}
