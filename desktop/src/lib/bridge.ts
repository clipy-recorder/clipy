import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LOCAL_EDITION } from "./edition";

/**
 * Typed wrappers around Rust-side `#[tauri::command]` handlers.
 * Keep 1:1 with src-tauri/src/commands.rs and src-tauri/src/types.rs.
 */

/** What a wrapper for an official-app command answers in the local edition,
 *  whose binary does not register those commands (no Clipy account, upload,
 *  updater or Studio). Callers already treat a rejection as "unavailable". */
function cloudOnly(): Promise<never> {
  return Promise.reject(new Error("Not part of the local edition"));
}

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function listenIfAvailable<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<T>(event, handler);
}

export interface DesktopUser {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
}

export interface AuthStateDto {
  signed_in: boolean;
  user: DesktopUser | null;
}

export type RecordingPhase =
  | "idle"
  | "countdown"
  | "recording"
  | "paused"
  | "stopping"
  | "uploading";

export interface RecordingStateDto {
  phase: RecordingPhase;
  recording_id: string | null;
  elapsed_ms: number | null;
  bytes_written: number | null;
  mic_level: number | null;
  mic_muted: boolean;
  mic_active: boolean;
  mic_silence_warning: string | null;
}

export type UploadStatus =
  | "idle"
  | "uploading"
  | "completing"
  | "completed"
  | "failed"
  | "aborted";

export interface UploadProgressDto {
  recording_id: string;
  parts_uploaded: number;
  bytes_uploaded: number;
  status: UploadStatus;
  error: string | null;
}

export interface ShareLinkDto {
  video_id: string;
  public_id: string;
  url: string;
}

export interface RecoverableRecordingDto {
  recording_id: string;
  bytes: number;
  updated_at_ms: number;
  expires_at_ms: number;
}

export interface StudioRecordingDto {
  recording_id: string;
  public_id: string;
  remote_public_id: string | null;
  video_id: string | null;
  share_url: string | null;
  local_file_path: string;
  cursor_path: string | null;
  zoom_path: string | null;
  camera_path: string | null;
  project_path: string | null;
  screen_charm_path: string | null;
  cursor_json: unknown | null;
  zoom_json: unknown | null;
  project_json: unknown | null;
  screen_charm_json: unknown | null;
  webcam: WebcamCaptureDto | null;
  audio?: AudioOptionsDto | null;
  bytes: number;
  duration_ms: number;
}

export interface NativeStudioBackgroundsDto {
  dir: string;
}

export interface RecordingMetadata {
  recording_id: string;
  file_path: string;
  bytes: number;
  duration_ms: number;
}

export function getNativeStudioBackgroundsDir(): Promise<NativeStudioBackgroundsDto> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<NativeStudioBackgroundsDto>("get_native_studio_backgrounds_dir");
}

export function requestCameraPermission(): Promise<void> {
  return invoke<void>("request_camera_permission");
}

export function listWebcamDevices(): Promise<WebcamDeviceDto[]> {
  return invoke<WebcamDeviceDto[]>("list_webcam_devices");
}

export interface DisplayInfoDto {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfoDto {
  id: number;
  app_name: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureSourcesDto {
  displays: DisplayInfoDto[];
  windows: WindowInfoDto[];
}

export type CaptureSourceDto =
  | { type: "camera"; device_id: string }
  | { type: "display"; id: number }
  | { type: "window"; id: number }
  | {
      type: "area";
      display_id: number;
      x: number;
      y: number;
      width: number;
      height: number;
    };

export type WebcamLayoutDto = "bubble" | "left" | "right" | "top" | "bottom";
export type WebcamShapeDto = "square" | "pill" | "circle";
export type WebcamSizeDto = "small" | "medium" | "large";

export interface WebcamCaptureDto {
  enabled: boolean;
  layout: WebcamLayoutDto;
  shape: WebcamShapeDto;
  size: WebcamSizeDto;
  deviceId: string | null;
}

export interface WebcamDeviceDto {
  id: string;
  name: string;
  source?: "webview" | "native";
}

export interface SourceHighlightRectDto {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AudioDeviceDto {
  id: string;
  name: string;
  is_default: boolean;
}

export interface AudioOptionsDto {
  includeSystemAudio: boolean;
  includeMic: boolean;
  micDeviceId: string | null;
  /** Run the microphone through the recorder's background-noise filter.
   *  Opt-in: a settings file written before this existed reads as false, so an
   *  update never silently changes how somebody's microphone sounds. */
  reduceNoise: boolean;
}

export interface MicSignalCheckDto {
  device_name: string;
  level: number;
  has_input: boolean;
}

export interface VideoOptionsDto {
  /** null = native source resolution (no scaling). */
  maxHeight: number | null;
  /** How a "Specific window" source is recorded (macOS). */
  windowCapture: WindowCaptureModeDto;
}

/**
 * `window`: only the selected window's own pixels, even under other windows,
 * following it when it moves. No camera bubble or Flare.
 * `area`: the screen rectangle under the window at Start, with camera and
 * Flare, and anything else that enters it. Windows always records `area`.
 */
export type WindowCaptureModeDto = "window" | "area";

export type RecordingSourceTabDto = "display" | "window" | "area";

/** Who can watch the finished recording. Same literals as the server's
 *  `videos.access_mode`. */
export type ShareScopeDto = "public" | "restricted" | "private";

export interface RecordingSettingsDto {
  sourceTab: RecordingSourceTabDto;
  source: CaptureSourceDto | null;
  windowAppName: string | null;
  windowTitle: string | null;
  /** The connected displays when `source` was saved (`displayLayoutKey`). */
  displayLayout?: string | null;
  audio: AudioOptionsDto;
  video: VideoOptionsDto;
  webcam: WebcamCaptureDto;
  recordingMode: RecordingModeDto;
  countdownSeconds: number;
  shareScope: ShareScopeDto;
  shareDomains: string[];
}

/** Per-recording intent captured in the panel before Start: the Notes
 *  sheet's title/description and the Public sheet's share scope. Title and
 *  description become the recording's name and description at `/complete`. */
export interface RecordingIntentDto {
  title: string | null;
  description: string | null;
  shareScope: ShareScopeDto;
  shareDomains: string[];
}

export interface CaptureSourceMetadataDto {
  sourceTab: RecordingSourceTabDto;
  source: CaptureSourceDto | null;
  windowAppName: string | null;
  windowTitle: string | null;
  controlledEvidence?: string | null;
  /** Filled in by the recorder for window sources; never sent by the picker. */
  windowCapture?: WindowCaptureModeDto | null;
}

export function ping(): Promise<string> {
  return invoke<string>("ping");
}

export function getAuthState(): Promise<AuthStateDto> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<AuthStateDto>("get_auth_state");
}

export function beginSignIn(): Promise<void> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<void>("begin_sign_in");
}

/**
 * Dev-only escape hatch. The Rust command is gated on
 * `#[cfg(debug_assertions)]`, so this throws on release builds. The dev
 * Login UI exposes it as a "Paste sign-in URL" input because the dev
 * binary isn't registered with LaunchServices for the `clipy://` scheme.
 */
export function handleDeepLinkUrl(url: string): Promise<void> {
  return invoke<void>("handle_deep_link_url", { url });
}

/**
 * Dev-only: inject a fake desktop session so the app moves past the
 * Login screen. Lets us verify recording + cursor/zoom sidecar
 * generation without the OAuth flow. Uploads will 401 — that's expected.
 */
export function devInjectSession(): Promise<void> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<void>("dev_inject_session");
}

export function signOut(): Promise<void> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<void>("sign_out");
}

export function listCaptureSources(): Promise<CaptureSourcesDto> {
  return invoke<CaptureSourcesDto>("list_capture_sources");
}

/**
 * Capture a thumbnail for a single source. Returns a `data:image/png;base64,...`
 * URL or null if the source can't be captured. Called per-source so the picker
 * dialog renders text-first and thumbnails stream in as they finish.
 */
export function getSourceThumbnail(
  source: CaptureSourceDto,
): Promise<string | null> {
  return invoke<string | null>("get_source_thumbnail", { source });
}

export function listAudioInputDevices(): Promise<AudioDeviceDto[]> {
  return invoke<AudioDeviceDto[]>("list_audio_input_devices");
}

export function checkMicrophoneInput(
  deviceId?: string | null,
): Promise<MicSignalCheckDto> {
  return invoke<MicSignalCheckDto>("check_microphone_input", {
    deviceId: deviceId ?? null,
  });
}

export function onMicCheckLevel(
  handler: (level: number) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<number>("mic-check-level", (event) =>
    handler(Number(event.payload) || 0),
  );
}

/** Open the mic once for the popover's level meter and keep it open until
 *  `stopMicMonitor`. Resolves with the monitor generation; a stop for any
 *  other generation is ignored, so a superseded effect cannot stop the
 *  monitor that replaced it. */
export function startMicMonitor(deviceId?: string | null): Promise<number> {
  return invoke<number>("start_mic_monitor", { deviceId: deviceId ?? null });
}

export function stopMicMonitor(generation: number): Promise<void> {
  return invoke<void>("stop_mic_monitor", { generation });
}

export function onMicMonitorLevel(
  handler: (level: number) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<number>("mic-monitor-level", (event) =>
    handler(Number(event.payload) || 0),
  );
}

/** Recording mode — `instant` streams to the cloud + auto-shares;
 *  `studio` records/uploads, then opens the native Mac Studio editor on stop.
 *  Matches the Rust `RecordingMode` enum (camelCase serde). */
export type RecordingModeDto = "instant" | "studio" | "local";

export function startRecording(
  source?: CaptureSourceDto,
  audio?: AudioOptionsDto,
  video?: VideoOptionsDto,
  webcam?: WebcamCaptureDto,
  mode?: RecordingModeDto,
  countdownSeconds?: number,
  captureSourceMetadata?: CaptureSourceMetadataDto | null,
  intent?: RecordingIntentDto | null,
): Promise<string> {
  return invoke<string>("start_recording", {
    source: source ?? null,
    audio: audio ?? null,
    video: video ?? null,
    webcam: webcam ?? null,
    mode: mode ?? null,
    countdownSeconds: countdownSeconds ?? null,
    captureSourceMetadata: captureSourceMetadata ?? null,
    intent: intent ?? null,
  });
}

/** Open the native Studio editor for a recording in a dedicated WebView. */
export function openEditor(publicId: string): Promise<void> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<void>("open_editor", { publicId });
}

export function getStudioRecording(
  publicId?: string,
): Promise<StudioRecordingDto | null> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<StudioRecordingDto | null>("get_studio_recording", {
    publicId: publicId ?? null,
  });
}

export function listNativeStudioRecordings(
  limit?: number,
): Promise<StudioRecordingDto[]> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<StudioRecordingDto[]>("list_native_studio_recordings", {
    limit: limit ?? null,
  });
}

export function listRecoverableRecordings(): Promise<RecoverableRecordingDto[]> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<RecoverableRecordingDto[]>("list_recoverable_recordings");
}

export function retryRecoverableRecording(
  recordingId: string,
): Promise<ShareLinkDto> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<ShareLinkDto>("retry_recoverable_recording", { recordingId });
}

export function discardRecoverableRecording(recordingId: string): Promise<boolean> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<boolean>("discard_recoverable_recording", { recordingId });
}

export function saveNativeStudioProject(
  publicId: string,
  project: unknown,
): Promise<string> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<string>("save_native_studio_project", { publicId, project });
}

export interface StudioRebakeDto {
  shareUrl: string;
  queued: boolean;
  ready: boolean;
}

export interface NativeStudioExportDto {
  outputPath: string;
}

export type NativeStudioExportFormat = "mp4" | "gif";

export interface NativeStudioCleanupSuggestionDto {
  kind: "speed";
  start_s: number;
  end_s: number;
  speed: number;
  reason: string;
  original_duration_s: number;
  saved_s: number;
}

export interface NativeStudioCleanupDto {
  duration_s: number | null;
  suggestions: NativeStudioCleanupSuggestionDto[];
}

export interface StudioShareStatusDto {
  shareUrl: string;
  videoUrl: string | null;
  processingStatus: string | null;
  processingError: string | null;
  ready: boolean;
}

export function shareNativeStudioProject(
  publicId: string,
  project: unknown,
  cursorJson?: unknown | null,
): Promise<StudioRebakeDto> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<StudioRebakeDto>("share_native_studio_project", {
    publicId,
    project,
    cursorJson: cursorJson ?? null,
  });
}

export function exportNativeStudioProject(
  publicId: string,
  project: unknown,
  outputPath?: string | null,
  format: NativeStudioExportFormat = "mp4",
  cursorJson?: unknown | null,
): Promise<NativeStudioExportDto> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<NativeStudioExportDto>("export_native_studio_project", {
    publicId,
    project,
    outputPath: outputPath ?? null,
    format,
    cursorJson: cursorJson ?? null,
  });
}

export function analyzeNativeStudioCleanup(
  publicId: string,
): Promise<NativeStudioCleanupDto> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<NativeStudioCleanupDto>("analyze_native_studio_cleanup", { publicId });
}

export function getNativeStudioShareStatus(
  publicId: string,
): Promise<StudioShareStatusDto> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<StudioShareStatusDto>("get_native_studio_share_status", { publicId });
}

export function onStudioRecordingUpdated(
  handler: (recording: StudioRecordingDto) => void,
): Promise<UnlistenFn> {
  if (LOCAL_EDITION) return Promise.resolve(() => {});
  return listenIfAvailable<StudioRecordingDto>("studio-recording-updated", (event) =>
    handler(event.payload),
  );
}

export function stopRecording(): Promise<RecordingMetadata> {
  return invoke<RecordingMetadata>("stop_recording");
}

export function cancelRecording(): Promise<void> {
  return invoke<void>("cancel_recording");
}

export function pauseRecording(): Promise<void> {
  return invoke<void>("pause_recording");
}

export function resumeRecording(): Promise<void> {
  return invoke<void>("resume_recording");
}

export function setMicMuted(muted: boolean): Promise<void> {
  return invoke<void>("set_mic_muted", { muted });
}

export function getRecordingState(): Promise<RecordingStateDto> {
  return invoke<RecordingStateDto>("get_recording_state");
}

export function saveWebcamSidecar(
  recordingId: string,
  dataBase64: string,
  mimeType: string,
): Promise<string> {
  return invoke<string>("save_webcam_sidecar", {
    recordingId,
    dataBase64,
    mimeType,
  });
}

export function getLastShareLink(): Promise<ShareLinkDto | null> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<ShareLinkDto | null>("get_last_share_link");
}

export function onAuthStateChanged(
  handler: (state: AuthStateDto) => void
): Promise<UnlistenFn> {
  if (LOCAL_EDITION) return Promise.resolve(() => {});
  return listenIfAvailable<AuthStateDto>("auth-state-changed", (event) => handler(event.payload));
}

export function onRecordingStateChanged(
  handler: (state: RecordingStateDto) => void
): Promise<UnlistenFn> {
  return listenIfAvailable<RecordingStateDto>("recording-state-changed", (event) =>
    handler(event.payload)
  );
}

export function onUploadProgress(
  handler: (progress: UploadProgressDto) => void
): Promise<UnlistenFn> {
  if (LOCAL_EDITION) return Promise.resolve(() => {});
  return listenIfAvailable<UploadProgressDto>("upload-progress", (event) => handler(event.payload));
}

export function onShareLinkReady(
  handler: (link: ShareLinkDto) => void
): Promise<UnlistenFn> {
  if (LOCAL_EDITION) return Promise.resolve(() => {});
  return listenIfAvailable<ShareLinkDto>("share-link-ready", (event) => handler(event.payload));
}

export function onRecordingAudioWarning(
  handler: (warning: { message: string }) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<{ message: string }>("recording-audio-warning", (event) =>
    handler(event.payload),
  );
}

export function onCountdownTick(
  handler: (n: number) => void
): Promise<UnlistenFn> {
  return listenIfAvailable<number>("countdown-tick", (event) => handler(event.payload));
}

// Mirrors `local::Status` in Rust — the same shape `status.json` holds on disk.
export interface LocalRecordingProgressDto {
  id: string;
  stage: string;
  message: string;
  directory: string;
  arec_path: string | null;
  updated_at_ms?: number;
  /** Set on `ready` when the AREC path actually reached the clipboard.
   * Optional so an absent value reads as "not copied" rather than claiming
   * a paste that is not there. */
  arec_copied?: boolean;
}

export function onLocalRecordingProgress(
  handler: (status: LocalRecordingProgressDto) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<LocalRecordingProgressDto>("local-recording-progress", (event) =>
    handler(event.payload),
  );
}

export function listLocalRecordings(): Promise<LocalRecordingProgressDto[]> {
  return invoke<LocalRecordingProgressDto[]>("list_local_recordings");
}

export function onWebcamStart(handler: (deviceId: string | null) => void): Promise<UnlistenFn> {
  return listenIfAvailable<string | null>("webcam-start", (event) => handler(event.payload ?? null));
}

export function onWebcamStop(handler: () => void): Promise<UnlistenFn> {
  return listenIfAvailable<void>("webcam-stop", () => handler());
}

/** macOS: URL of the local socket that carries raw camera frames to the
 *  bubble (see `lib/cameraPreviewSocket.ts`). `null` elsewhere. */
export function getCameraPreviewUrl(): Promise<string | null> {
  return invoke<string | null>("camera_preview_url");
}

/** A JPEG preview frame from the Windows camera recorder. macOS no longer
 *  sends these; its frames arrive over the preview socket. */
export interface NativeWebcamFrameDto {
  dataUrl: string;
  width: number;
  height: number;
}

export function onNativeWebcamStart(handler: () => void): Promise<UnlistenFn> {
  return listenIfAvailable<void>("native-webcam-start", () => handler());
}

export function onNativeWebcamStop(handler: () => void): Promise<UnlistenFn> {
  return listenIfAvailable<void>("native-webcam-stop", () => handler());
}

export function onNativeWebcamFrame(
  handler: (frame: NativeWebcamFrameDto) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<NativeWebcamFrameDto>("native-webcam-frame", (event) =>
    handler(event.payload),
  );
}

export function onRequestSourcePicker(
  handler: () => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<void>("request-source-picker", () => handler());
}

export interface EntitlementDto {
  is_pro: boolean;
  /** False when `is_pro` is only the free-tier fallback (offline, no cache). */
  known: boolean;
}

/** Pro flag for the resolution gate. Cached Rust-side (~5 min); resolves
 * to free tier on any failure so the picker always opens. `refresh` skips
 * the cache. */
export function getEntitlement(refresh = false): Promise<EntitlementDto> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<EntitlementDto>("get_entitlement", { refresh });
}

/** Gate levels the server can report. `quota` is the free tier's own limit
 *  (seven-day trial from signup, or 3 recordings / 120 minutes, whichever
 *  comes first); `soft`/`hard` are admin-set. */
export type RecordingGateLevel = "soft" | "hard" | "quota";

export interface QuotaDimension {
  used: number;
  limit: number;
}

/** Narrow mirror of the web app's FreeQuotaSummary — only what the Mac gate
 *  card draws. Structural on purpose: the desktop app ships on its own release
 *  cadence and must survive the server adding fields it has never seen. */
export interface RecordingQuota {
  trialExpired?: boolean;
  recordings: QuotaDimension;
  minutes: QuotaDimension;
}

/** An upgrade discount assigned to the account. Display fields only; the
 *  discount itself is applied server-side at checkout. */
export interface RecordingOffer {
  code: string;
  label: string;
  description: string | null;
  expiresAt: string | null;
}

export interface RecordingGateDto {
  gate: RecordingGateLevel | null;
  quota: RecordingQuota | null;
  offer: RecordingOffer | null;
}

function isGateLevel(value: unknown): value is RecordingGateLevel {
  return value === "soft" || value === "hard" || value === "quota";
}

function coerceDimension(value: unknown): QuotaDimension | null {
  if (!value || typeof value !== "object") return null;
  const { used, limit } = value as { used?: unknown; limit?: unknown };
  if (typeof used !== "number" || typeof limit !== "number") return null;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  return { used: Math.max(0, used), limit };
}

export function coerceQuota(value: unknown): RecordingQuota | null {
  if (!value || typeof value !== "object") return null;
  const { recordings, minutes, breach } = value as Record<string, unknown>;
  const r = coerceDimension(recordings);
  const m = coerceDimension(minutes);
  return r && m ? { recordings: r, minutes: m, ...(breach === "trial" ? { trialExpired: true } : {}) } : null;
}

export function coerceOffer(value: unknown): RecordingOffer | null {
  if (!value || typeof value !== "object") return null;
  const { code, label, description, expiresAt } = value as Record<
    string,
    unknown
  >;
  if (typeof code !== "string" || typeof label !== "string") return null;
  if (!code.trim() || !label.trim()) return null;
  return {
    code,
    label,
    description: typeof description === "string" ? description : null,
    expiresAt: typeof expiresAt === "string" ? expiresAt : null,
  };
}

/**
 * The recording gate for the signed-in account, so a gated user sees the card
 * before picking a source instead of after the countdown.
 *
 * FAIL-OPEN: the Rust side swallows every lookup failure and answers "not
 * gated". `/raw-upload/initiate` is the real enforcement, and
 * its refusal carries the same numbers — so a failed lookup costs a nicer first
 * paint, never correctness.
 */
export async function getRecordingGate(): Promise<RecordingGateDto> {
  if (LOCAL_EDITION) return cloudOnly();
  const raw = await invoke<{
    gate?: unknown;
    quota?: unknown;
    offer?: unknown;
  }>("get_recording_gate");
  return {
    gate: isGateLevel(raw?.gate) ? raw.gate : null,
    quota: coerceQuota(raw?.quota),
    offer: coerceOffer(raw?.offer),
  };
}

/**
 * A start failure, normalized.
 *
 * `start_recording` rejects with a `StartRecordingError` object (message +
 * code/level/quota). Older builds rejected with a bare
 * string that, for the free-quota 403, was the server's entire JSON body —
 * which is what ended up printed under the Start button. Both
 * shapes are handled here so a webview/binary version skew degrades to plain
 * text rather than "[object Object]".
 */
export interface StartRecordingFailure {
  message: string;
  code: string | null;
  level: RecordingGateLevel | null;
  quota: RecordingQuota | null;
}

export function describeStartError(err: unknown): StartRecordingFailure {
  if (err && typeof err === "object" && !(err instanceof Error)) {
    const { message, code, level, quota } = err as Record<string, unknown>;
    if (typeof message === "string" && message.trim()) {
      return {
        message,
        code: typeof code === "string" ? code : null,
        level: isGateLevel(level) ? level : null,
        quota: coerceQuota(quota),
      };
    }
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    code: null,
    level: null,
    quota: null,
  };
}

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
}

/** Fired by the Rust policy watch when this version is below the server's
 * minimum supported version — the UI must show a blocking update dialog. */
export interface UpdateRequiredDto {
  currentVersion: string;
  minSupportedVersion: string;
  latestVersion: string | null;
  message: string | null;
}

export function onUpdateRequired(
  handler: (info: UpdateRequiredDto) => void,
): Promise<UnlistenFn> {
  if (LOCAL_EDITION) return Promise.resolve(() => {});
  return listenIfAvailable<UpdateRequiredDto>("update-required", (event) =>
    handler(event.payload),
  );
}

/** Mic supervisor changed the input state mid-recording.
 *
 * `paused: false` is a swap — the HUD shows the new device name transiently.
 * `paused: true` means the explicitly-selected device disconnected and capture
 * is muted until that exact device returns; it is never substituted. That state
 * persists, so the HUD must hold it rather than fading it out, and it clears on
 * the next `paused: false` event. */
export interface MicSwitchedDto {
  device: string;
  paused: boolean;
}

export function onMicSwitched(
  handler: (info: MicSwitchedDto) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<MicSwitchedDto>("mic-switched", (event) =>
    handler({ device: event.payload.device, paused: Boolean(event.payload.paused) }),
  );
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<UpdateInfo>("check_for_updates");
}

/** Version of an update already downloaded + staged on disk (background
 * watch), or null. A restart applies it. */
export function getReadyUpdate(): Promise<string | null> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<string | null>("get_ready_update");
}

/** Rust put the popover away (tray toggle, recording start). The window is
 * already hidden — the handler should only end the picker session. */
export function onPanelDismissed(handler: () => void): Promise<UnlistenFn> {
  return listenIfAvailable<null>("panel-dismissed", () => handler());
}

/** Rust brought the popover back on its own after a recording (stopping /
 * uploading tail). Not a user-opened picker: keep the source highlight down
 * until the user interacts with the picker again. */
export function onPanelRestored(handler: () => void): Promise<UnlistenFn> {
  return listenIfAvailable<null>("panel-restored", () => handler());
}

/** Nudge the background watch to check + download now instead of waiting
 * out its poll interval. Silent: no dialog, no error surface. */
export function stageUpdateInBackground(): Promise<void> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<void>("stage_update_in_background");
}

/** Background update watch finished staging a new bundle on disk. */
export function onUpdateReady(
  handler: (version: string) => void,
): Promise<UnlistenFn> {
  if (LOCAL_EDITION) return Promise.resolve(() => {});
  return listenIfAvailable<{ version: string }>("update-ready", (event) =>
    handler(event.payload.version),
  );
}

/** The first-launch update screen: a fresh install moving to the newest
 * release before sign-in. `phase` is `downloading` or `installing`; null
 * means there is nothing to show. */
export interface FirstLaunchUpdateDto {
  phase: "downloading" | "installing";
  version: string;
  percent: number | null;
}

/** Current first-launch update state, for a window that mounts after the
 * event fired. */
export async function getFirstLaunchUpdate(): Promise<FirstLaunchUpdateDto | null> {
  if (LOCAL_EDITION) return null;
  try {
    return await invoke<FirstLaunchUpdateDto | null>("get_first_launch_update");
  } catch {
    // An older binary without the command: nothing to show.
    return null;
  }
}

export function onFirstLaunchUpdate(
  handler: (info: FirstLaunchUpdateDto | null) => void,
): Promise<UnlistenFn> {
  if (LOCAL_EDITION) return Promise.resolve(() => {});
  return listenIfAvailable<FirstLaunchUpdateDto | null>("first-launch-update", (event) =>
    handler(event.payload ?? null),
  );
}

/** Install the staged update and restart. Rejects (with a human-readable
 * reason) if a recording or upload is still running — the gate is
 * authoritative in Rust, the UI only mirrors it. */
export function restartToApplyUpdate(): Promise<void> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<void>("restart_to_apply_update");
}

/** Download + install pending update, then relaunch the app. The promise
 * resolves only on failure; on success the process terminates before
 * resolution. */
export async function installUpdateAndRelaunch(): Promise<void> {
  if (LOCAL_EDITION) return cloudOnly();
  return invoke<void>("install_update_and_relaunch");
}

export type PermissionStatus =
  | "granted"
  | "denied"
  | "notDetermined"
  | "notNeeded";

export type DesktopPermission =
  | "screen"
  | "accessibility"
  | "microphone"
  | "camera";

export interface DesktopPermissionsDto {
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
  microphone: PermissionStatus;
  camera: PermissionStatus;
  ready: boolean;
}

export function checkDesktopPermissions(): Promise<DesktopPermissionsDto> {
  return invoke<DesktopPermissionsDto>("check_desktop_permissions");
}

/** Deep probe: whether ScreenCaptureKit will actually serve content. Can be
 * false while the preflight says granted (stale TCC grant — the -3801 case).
 * Fails open so an IPC hiccup never locks the user out of the recorder. */
export function probeScreenCapture(): Promise<boolean> {
  return invoke<boolean>("probe_screen_capture").catch(() => true);
}

/** The same probe without the fail-open: a non-permission ScreenCaptureKit
 * failure or an IPC error rejects. Setup uses it because it treats "no
 * answer" as "not confirmed", never as fine. */
export function probeScreenCaptureStrict(): Promise<boolean> {
  return invoke<boolean>("probe_screen_capture", { strict: true });
}

export function requestDesktopPermission(
  permission: DesktopPermission,
): Promise<boolean> {
  return invoke<boolean>("request_desktop_permission", { permission });
}

export function openPrivacySettings(
  pane: DesktopPermission,
): Promise<void> {
  return invoke<void>("open_privacy_settings", { pane });
}

export function relaunchApp(): Promise<void> {
  return invoke<void>("relaunch_app");
}

export function showWebcamBubble(deviceId?: string | null): Promise<void> {
  return invoke<void>("show_webcam_bubble", { deviceId: deviceId ?? null });
}

export interface WebcamBubbleStateDto {
  active: boolean;
  deviceId: string | null;
  native: boolean;
  cameraOnly: boolean;
  /** False during a window-only recording, which cannot contain the bubble. */
  recordable: boolean;
  layout: WebcamLayoutDto;
  shape: WebcamShapeDto;
  size: WebcamSizeDto;
  mirrored: boolean;
}

export function updateWebcamAppearance(
  shape: WebcamShapeDto,
  size: WebcamSizeDto,
  mirrored: boolean,
): Promise<void> {
  return invoke<void>("update_webcam_appearance", { shape, size, mirrored });
}

export function getWebcamBubbleState(): Promise<WebcamBubbleStateDto> {
  return invoke<WebcamBubbleStateDto>("get_webcam_bubble_state");
}

export function hideWebcamBubble(): Promise<void> {
  return invoke<void>("hide_webcam_bubble");
}

export function setWebcamLayout(
  layout: WebcamLayoutDto,
  shape: WebcamShapeDto,
  size: WebcamSizeDto,
  rect?: SourceHighlightRectDto | null,
): Promise<void> {
  return invoke<void>("set_webcam_layout", { layout, shape, size, rect: rect ?? null });
}

export function setRecordingControlsLayout(
  rect?: SourceHighlightRectDto | null,
  webcam?: WebcamCaptureDto | null,
): Promise<void> {
  return invoke<void>("set_recording_controls_layout", {
    rect: rect ?? null,
    webcam: webcam ?? null,
  });
}

export function onWebcamLayoutChanged(
  handler: (appearance: Pick<WebcamBubbleStateDto, "layout" | "shape" | "size" | "mirrored">) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<Pick<WebcamBubbleStateDto, "layout" | "shape" | "size" | "mirrored">>("webcam-layout-changed", (event) =>
    handler(event.payload),
  );
}

/** Resize the menu-bar popover and clamp it back inside the work area. Rust
 * bounds the height by the sheet's designed floor and the room the screen has,
 * and answers with the height it actually applied. */
export function setPopoverHeight(height: number): Promise<number> {
  return invoke<number>("set_popover_height", { height });
}

export function showSourceHighlight(rect: SourceHighlightRectDto): Promise<void> {
  return invoke<void>("show_source_highlight", { rect });
}

export function hideSourceHighlight(): Promise<void> {
  return invoke<void>("hide_source_highlight");
}

export function pickWindowAtClick(): Promise<number | null> {
  return invoke<number | null>("pick_window_at_click");
}

/** Rect the user drew in the area-select overlay, in display-local logical
 *  pixels (the overlay window covers the target display exactly, so
 *  window-local pointer coordinates ARE display-local coordinates). */
export interface AreaSelectResultDto {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const EVENT_AREA_SELECT_DONE = "area-select-done";
export const EVENT_AREA_SELECT_CANCELLED = "area-select-cancelled";

/** Cover `displayRect` (global logical coords) with the interactive
 *  drag-to-select overlay. The result arrives via onAreaSelectDone. */
/** Why the area-select overlay is open: it serves recording AND screenshots. */
export type AreaSelectPurpose = "video" | "screenshot";

export function showAreaSelect(
  displayRect: SourceHighlightRectDto,
  purpose: AreaSelectPurpose = "video"
): Promise<void> {
  return invoke<void>("show_area_select", { rect: displayRect, purpose });
}

/** Fires on every show; the overlay's webview mounts once, so this is the only
 * way it learns the current mode. */
export function onAreaSelectPurpose(
  handler: (purpose: AreaSelectPurpose) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<AreaSelectPurpose>("area-select-purpose", (event) =>
    handler(event.payload),
  );
}

export function hideAreaSelect(): Promise<void> {
  return invoke<void>("hide_area_select");
}

export function completeAreaSelect(rect: AreaSelectResultDto): Promise<void> {
  return invoke<void>("complete_area_select", { rect });
}

export function cancelAreaSelect(): Promise<void> {
  return invoke<void>("cancel_area_select");
}

export function onAreaSelectDone(
  handler: (rect: AreaSelectResultDto) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<AreaSelectResultDto>(EVENT_AREA_SELECT_DONE, (event) =>
    handler(event.payload),
  );
}

export function onAreaSelectCancelled(handler: () => void): Promise<UnlistenFn> {
  return listenIfAvailable<null>(EVENT_AREA_SELECT_CANCELLED, () => handler());
}

export interface CursorPositionDto {
  x: number;
  y: number;
}

/** Global cursor position in the capture-source coordinate space, or null
 *  when the OS will not say (no screen-recording permission yet, headless). */
export function getCursorPosition(): Promise<CursorPositionDto | null> {
  return invoke<CursorPositionDto | null>("cursor_position");
}

export type SourceHighlightStyle = "preview" | "recording";
export const EVENT_SOURCE_HIGHLIGHT_STYLE = "source-highlight-style";

/** Rust switches the source-highlight window between the pulsing picker
 *  preview and the quiet frame it draws for the whole of a Custom size take. */
export function onSourceHighlightStyle(
  handler: (style: SourceHighlightStyle) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<SourceHighlightStyle>(EVENT_SOURCE_HIGHLIGHT_STYLE, (event) =>
    handler(event.payload),
  );
}

let webviewErrorReports = 0;
let lastWebviewErrorMessage = "";

/** Forward an unhandled webview error to Rust (→ Sentry when the DSN is
 *  configured, tracing always). Bounded per session and deduped against
 *  the immediately preceding message so an error loop can't flood.
 *  `level: "warning"` is for expected environment conditions (no camera,
 *  permission denied): traced and kept as a breadcrumb, never a Sentry
 *  issue of its own. */
export function reportWebviewError(
  message: string,
  stack?: string | null,
  source?: string | null,
  level: "error" | "warning" = "error",
): void {
  if (!hasTauriRuntime()) return;
  if (webviewErrorReports >= 50 || message === lastWebviewErrorMessage) return;
  webviewErrorReports += 1;
  lastWebviewErrorMessage = message;
  invoke<void>("report_webview_error", {
    windowLabel: window.location.hash || "main",
    message,
    stack: stack ?? null,
    source: source ?? null,
    level,
  }).catch(() => {});
}

/** Install window-level error + unhandledrejection forwarding. Call once
 *  per webview (App.tsx does). */
export function installWebviewErrorReporting(): () => void {
  const onError = (event: ErrorEvent) => {
    reportWebviewError(
      event.message || "unknown error",
      event.error instanceof Error ? event.error.stack : null,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : null,
    );
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? `unhandled rejection: ${reason.message}`
        : `unhandled rejection: ${String(reason)}`;
    reportWebviewError(message, reason instanceof Error ? reason.stack : null, null);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

function errorText(err: unknown): string {
  // Commands that reject with a structured error (start_recording) would
  // stringify to "[object Object]" and never match — read `.message` first.
  return typeof err === "string"
    ? err
    : err instanceof Error
      ? err.message
      : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
        ? ((err as { message: string }).message)
        : String(err);
}

/** Detects the typed permission_denied prefix returned from Rust. */
export function isPermissionDeniedError(err: unknown): boolean {
  return errorText(err).toLowerCase().includes("permission_denied");
}

/**
 * The permission named by a `permission_denied: <name>` error: the capture
 * path uses `screen_recording`, the camera/mic preflight uses `camera` and
 * `microphone`. Null when the error is not a permission refusal.
 */
export function deniedPermission(err: unknown): "screen_recording" | "camera" | "microphone" | "other" | null {
  const match = /permission_denied:?\s*([a-z_]+)?/.exec(errorText(err).toLowerCase());
  if (!match) return null;
  const name = match[1];
  return name === "screen_recording" || name === "camera" || name === "microphone" ? name : "other";
}

export interface AppSettings {
  /** Whether the app appears in the macOS Dock. Off = menu-bar only. */
  showInDock: boolean;
  hotkey: string;
  /** Floating recording pill on/off. Off = record invisibly (screen-share
   * in a meeting); stop via hotkey, tray, or the main window. */
  showRecordingControls: boolean;
  /** Whether a finished local AREC opens itself in the viewer. Off = no
   * window; the path is copied to the clipboard either way. */
  openLocalArec: boolean;
  /** Camera look (flattened from Rust's `CameraLookDto`). */
  touchUpEnabled: boolean;
  touchUpStrength: number;
  autoLighting: boolean;
  /** Keep the camera bubble where it was last dragged, across launches. */
  persistWebcamPosition: boolean;
  /** Open a screenshot in the annotation window before copying it. */
  screenshotEditor: boolean;
}

/** What the bubble draws with. `touchUpStrength` is 0..1 and only counts
 * while `touchUpEnabled`. Both effects are off by default. */
export interface CameraLookDto {
  touchUpEnabled: boolean;
  touchUpStrength: number;
  autoLighting: boolean;
}

export function updateCameraLook(look: CameraLookDto): Promise<void> {
  return invoke<void>("update_camera_look", { look });
}

/** The bubble redraws with the new look on its next frame. */
export function onCameraLookChanged(handler: (look: CameraLookDto) => void): Promise<UnlistenFn> {
  return listenIfAvailable<CameraLookDto>("camera-look-changed", (event) => handler(event.payload));
}

/** Turning this off also forgets every remembered bubble position. */
export function updatePersistWebcamPosition(enabled: boolean): Promise<void> {
  return invoke<void>("update_persist_webcam_position", { enabled });
}

export type LoginItemStatus = "disabled" | "enabled" | "requiresApproval" | "unavailable";

export function getLoginItemStatus(): Promise<LoginItemStatus> {
  return invoke<LoginItemStatus>("get_login_item_status");
}

export function setLaunchAtLogin(enabled: boolean): Promise<LoginItemStatus> {
  return invoke<LoginItemStatus>("set_launch_at_login", { enabled });
}

export function updateShowRecordingControls(enabled: boolean): Promise<void> {
  return invoke<void>("update_show_recording_controls", { enabled });
}

/** HUD camera toggle — show/hide the webcam bubble mid-recording (instant
 * mode composites it into the captured pixels). Resolves to the new state. */
export function toggleRecordingWebcam(): Promise<boolean> {
  return invoke<boolean>("toggle_recording_webcam");
}

export function getRecordingWebcamVisible(): Promise<boolean> {
  return invoke<boolean>("get_recording_webcam_visible");
}

export function setCursorTrailEnabled(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_cursor_trail_enabled", { enabled });
}

export function getCursorTrailEnabled(): Promise<boolean> {
  return invoke<boolean>("get_cursor_trail_enabled");
}

export function getCursorTrailAvailable(): Promise<boolean> {
  return invoke<boolean>("get_cursor_trail_available");
}

export function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

/** Resolves to the screen edge the collapsed dock is notched against. */
export function setRecordingControlsSize(
  height: number,
  width?: number,
  collapsed = false,
): Promise<"left" | "right" | null> {
  return invoke<"left" | "right" | null>("set_recording_controls_size", { height, width, collapsed });
}

export interface RecordingControlsHint {
  text: string;
  y: number;
}

export function setRecordingControlsHint(hint: RecordingControlsHint | null): Promise<void> {
  return invoke<void>("set_recording_controls_hint", { hint });
}

export function getRecordingControlsHint(): Promise<RecordingControlsHint | null> {
  return invoke<RecordingControlsHint | null>("get_recording_controls_hint");
}

/** The hint bubble's box in its window, in CSS pixels. */
export function setRecordingHintBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
  return invoke<void>("set_recording_hint_bounds", { bounds });
}

export function getRecordingSettings(): Promise<RecordingSettingsDto> {
  return invoke<RecordingSettingsDto>("get_recording_settings");
}

export function updateRecordingSettings(
  settings: RecordingSettingsDto,
): Promise<void> {
  return invoke<void>("update_recording_settings", { settings });
}

export function updateHotkey(hotkey: string): Promise<void> {
  return invoke<void>("update_hotkey", { hotkey });
}

/** Persists the "show in Dock" preference and applies it immediately (macOS). */
export function updateShowInDock(enabled: boolean): Promise<void> {
  return invoke<void>("update_show_in_dock", { enabled });
}

/** Persists whether a finished local AREC opens itself. Applies to the next
 * recording that finishes. */
export function updateOpenLocalArec(enabled: boolean): Promise<void> {
  return invoke<void>("update_open_local_arec", { enabled });
}

// ─── Recorder shortcuts (Preferences → Shortcuts) ─────────────────────────────

export type RecorderShortcutAction =
  | "pause"
  | "mic"
  | "camera"
  | "annotation"
  | "screenshot_area"
  | "screenshot_display"
  | "clipboard_history";

export interface RecorderShortcutDto {
  action: RecorderShortcutAction;
  /** Empty when the action is switched off. */
  hotkey: string;
  registered: boolean;
}

export function getRecorderShortcuts(): Promise<RecorderShortcutDto[]> {
  return invoke<RecorderShortcutDto[]>("get_recorder_shortcuts");
}

/** Rebind one recording-time action; an empty hotkey switches it off. */
export function setRecorderShortcut(action: RecorderShortcutAction, hotkey: string): Promise<void> {
  return invoke<void>("set_recorder_shortcut", { action, hotkey });
}

// ─── Talk to your agent ─────────────────────────────────────────────────────

export type TalkKey = "off" | "fn" | "right_option";
export type TalkPaste = "words_and_path" | "path" | "words";
/** What macOS does on a Fn press; anything but "nothing" opens over a Fn take. */
export type FnUsage = "nothing" | "input_source" | "emoji" | "dictation";

export interface TalkSettingsDto {
  /** False where talk is not built yet (everything but macOS). */
  supported: boolean;
  key: TalkKey;
  paste: TalkPaste;
  fnUsage: FnUsage | null;
}

export function getTalkSettings(): Promise<TalkSettingsDto> {
  return invoke<TalkSettingsDto>("get_talk_settings");
}

export function setTalkSettings(change: { key?: TalkKey; paste?: TalkPaste }): Promise<void> {
  return invoke<void>("set_talk_settings", { key: change.key ?? null, paste: change.paste ?? null });
}

// ─── Clipboard history ───────────────────────────────────────────────────────

export interface ClipImageDto {
  /** Identifies the picture: the same image copied twice has the same hash. */
  hash: string;
  /** Pixels. */
  width: number;
  height: number;
  /** Size of the stored PNG. */
  bytes: number;
}

export interface ClipEntryDto {
  id: number;
  /** For an image item, the text copied with it (often empty). */
  text: string;
  image?: ClipImageDto;
  /** Kept at the top, past the history's cap and Clear all. */
  favorite?: boolean;
  /** Unix milliseconds. */
  copiedAt: number;
}

export function getClipboardHistory(): Promise<ClipEntryDto[]> {
  return invoke<ClipEntryDto[]>("get_clipboard_history");
}

/** The row preview for an image item, as PNG bytes. */
export function readClipboardImageThumbnail(id: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("clipboard_image_thumbnail", { id });
}

/** The full stored PNG of an image item, for the picker's preview pane. */
export function readClipboardImage(id: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("clipboard_image", { id });
}

/** Copies the item and pastes it into the app that was frontmost before the
 *  picker opened. `pasted` is false when it could only be copied. */
export function pasteClipboardEntry(id: number): Promise<{ pasted: boolean }> {
  return invoke<{ pasted: boolean }>("paste_clipboard_entry", { id });
}

/** Puts the item on the clipboard without pasting it, then hands focus back
 *  to the app the picker opened over. */
export function copyClipboardEntry(id: number): Promise<void> {
  return invoke<void>("copy_clipboard_entry", { id });
}

export function setClipboardEntryFavorite(id: number, favorite: boolean): Promise<void> {
  return invoke<void>("set_clipboard_entry_favorite", { id, favorite });
}

/** Replaces a text item's text. Image items cannot be edited. */
export function editClipboardEntry(id: number, text: string): Promise<void> {
  return invoke<void>("edit_clipboard_entry", { id, text });
}

export function deleteClipboardEntry(id: number): Promise<void> {
  return invoke<void>("delete_clipboard_entry", { id });
}

export function clearClipboardHistory(): Promise<void> {
  return invoke<void>("clear_clipboard_history");
}

export function hideClipboardHistory(): Promise<void> {
  return invoke<void>("hide_clipboard_history");
}

export function getClipboardHistoryEnabled(): Promise<boolean> {
  return invoke<boolean>("get_clipboard_history_enabled");
}

/** The running app that also opens on the clipboard key (macOS), or null. */
export function getClipboardKeyClash(): Promise<string | null> {
  return invoke<string | null>("get_clipboard_key_clash");
}

/** Off also clears the saved history and releases the shortcut. */
export function setClipboardHistoryEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_clipboard_history_enabled", { enabled });
}

export function onClipboardHistoryChanged(handler: () => void): Promise<UnlistenFn> {
  return listenIfAvailable<null>("clipboard-history-changed", () => handler());
}

export function onClipboardHistoryOpened(handler: () => void): Promise<UnlistenFn> {
  return listenIfAvailable<null>("clipboard-history-opened", () => handler());
}

// ─── Screenshots ─────────────────────────────────────────────────────────────

export type ScreenshotModeDto = "display" | "area";

export interface ScreenshotDto {
  path: string;
  shareUrl: string | null;
  clipboard: "image" | "link" | "none";
  uploadError: string | null;
  /** The upload replaced the image behind this screenshot's existing link. */
  shareUpdated: boolean;
  /** The capture opened in the annotation window instead: nothing was copied
   * yet, and `onScreenshotFinished` reports what Done or Delete did. */
  editing: boolean;
}

/** Rejects with "cancelled" when the user presses Esc during an area selection.
 * `displayId` picks the display on Windows; without one, Rust takes the
 * display under the cursor. macOS ignores it. */
export function captureScreenshot(
  mode: ScreenshotModeDto,
  upload: boolean,
  displayId: number | null = null,
): Promise<ScreenshotDto> {
  return invoke<ScreenshotDto>("capture_screenshot", { mode, upload, displayId });
}

export function revealScreenshot(path: string): Promise<void> {
  return invoke<void>("reveal_screenshot", { path });
}

/** A screenshot shortcut (⌘⇧2 by default) was pressed while idle. */
export function onScreenshotShortcut(
  handler: (mode: ScreenshotModeDto) => void,
): Promise<UnlistenFn> {
  return listenIfAvailable<ScreenshotModeDto>("screenshot-shortcut", (event) => handler(event.payload));
}

/** Shows the popover after a screenshot shortcut that could not capture. */
export function showScreenshotPanel(): Promise<void> {
  return invoke<void>("show_screenshot_panel");
}

/** Persists whether a screenshot opens in the annotation window first. */
export function updateScreenshotEditor(enabled: boolean): Promise<void> {
  return invoke<void>("update_screenshot_editor", { enabled });
}

/** An edited screenshot was copied or shared (the result), or deleted (null). */
export function onScreenshotFinished(
  handler: (shot: ScreenshotDto | null) => void
): Promise<UnlistenFn> {
  return listenIfAvailable<ScreenshotDto | null>("screenshot-finished", (event) => handler(event.payload));
}

// ─── Screenshot annotation window ────────────────────────────────────────────

export interface PendingScreenshotDto {
  id: number;
  /** ⌘↵ uploads (signed in, cloud mode) rather than copying the image. */
  uploadByDefault: boolean;
  /** Whether Upload is offered at all: false when signed out. */
  canUpload: boolean;
  /** Already copied or shared, so closing just closes. */
  delivered: boolean;
  /** Has a link; Upload updates it. */
  linked: boolean;
  /** An edit was written over the file, so an empty scene still exports. */
  editWritten: boolean;
  /** The annotations last staged, to reopen with after a reload. */
  scene: string | null;
}

/** Copy image never creates a share link; Upload shares and copies the link. */
export type ScreenshotFinishAction = "copy" | "upload";

/** What the annotation window should show; null when nothing is waiting. */
export function getPendingScreenshot(): Promise<PendingScreenshotDto | null> {
  return invoke<PendingScreenshotDto | null>("screenshot_editor_pending");
}

/** The pending capture's PNG as taken, as raw bytes. */
export function readPendingScreenshot(id: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("screenshot_editor_source", { id });
}

/**
 * Copy image or Upload: saves `png` over the capture (or keeps the capture as
 * it is when `png` is null), then copies or shares it. The window stays open.
 * The first upload creates the link and opens it in the browser; later ones
 * update the image behind that same link.
 * The bytes travel as a raw body, so the id and action go in headers.
 */
export function finishScreenshot(
  id: number,
  png: Uint8Array | null,
  action: ScreenshotFinishAction,
): Promise<ScreenshotDto> {
  return invoke<ScreenshotDto>("finish_screenshot", png ?? new Uint8Array(0), {
    headers: { "x-clipy-screenshot-id": String(id), "x-clipy-screenshot-action": action },
  });
}

/** The annotations behind the next Copy or Upload: sent with an upload so the
 * share stays editable on the web, and kept so a reloaded window reopens with
 * them. Separate from `finishScreenshot`, whose body is the PNG. */
export function stageScreenshotScene(id: number, scene: string): Promise<void> {
  return invoke<void>("stage_screenshot_scene", { id, scene });
}

/** Delete: removes the capture from Pictures without copying or sharing it. */
export function discardScreenshot(id: number): Promise<void> {
  return invoke<void>("discard_screenshot", { id });
}

/** Closes the annotation window when there is no drawing to hand back. Rust
 * copies a capture that was never copied or shared as it was captured first,
 * since closing counts as Copy image. */
export function closeScreenshotEditor(): Promise<void> {
  return invoke<void>("close_screenshot_editor");
}

/** `captureScreenshot`'s rejection while the annotation window is open. */
export const SCREENSHOT_EDITOR_BUSY = "screenshot-editor-open";

// ─── First-run setup window ──────────────────────────────────────────────────

export function showOnboardingWindow(): Promise<void> {
  return invoke<void>("show_onboarding_window");
}

/** Home's automatic prompt: opens setup unless the user just closed it
 * unfinished. Resolves to whether it opened. */
export function offerOnboardingWindow(): Promise<boolean> {
  return invoke<boolean>("offer_onboarding_window");
}

/** Setup's last step: remember it is done (so launch stops reopening it),
 * tell the recorder, then close setup and open the recorder popover. */
export function finishOnboarding(): Promise<void> {
  return invoke<void>("finish_onboarding");
}

/** Setup's restart buttons: restart so macOS applies a Screen Recording
 * change, and reopen setup afterwards. */
export function relaunchIntoSetup(): Promise<void> {
  return invoke<void>("relaunch_into_setup");
}

/** Windows only: opens Settings > Personalization > Taskbar, where "Other
 * system tray icons" keeps Clipy out of the `^` overflow. */
export function openTraySettings(): Promise<void> {
  return invoke<void>("open_tray_settings");
}

// ─── Sticky-note teleprompter window ─────────────────────────────────────────

export function showNotesWindow(options: { focus?: boolean } = {}): Promise<void> {
  return invoke<void>("show_notes_window", { focus: options.focus ?? true });
}

export function hideNotesWindow(): Promise<void> {
  return invoke<void>("hide_notes_window");
}

export function toggleNotesWindow(): Promise<boolean> {
  return invoke<boolean>("toggle_notes_window");
}

export function notesWindowVisible(): Promise<boolean> {
  return invoke<boolean>("notes_window_visible");
}

// ─── Local recording viewer ──────────────────────────────────────────────────

export interface LocalTranscriptSegmentDto {
  startMs: number;
  endMs: number;
  text: string;
}

export interface LocalFrameDto {
  timestampMs: number;
  frameTimeMs: number;
  reason: string;
  path: string;
}

export interface LocalRecordingDto {
  id: string;
  directory: string;
  videoPath: string;
  arecPath: string;
  durationMs: number;
  recordedAtMs: number;
  stage: string;
  message: string;
  segments: LocalTranscriptSegmentDto[];
  frames: LocalFrameDto[];
  clickCount: number;
}

export function readLocalRecording(id: string): Promise<LocalRecordingDto> {
  return invoke<LocalRecordingDto>("read_local_recording", { id });
}

export function showLocalViewer(id: string): Promise<void> {
  return invoke<void>("show_local_viewer", { id });
}

export function revealLocalRecordingFile(path: string): Promise<void> {
  return invoke<void>("reveal_local_recording_file", { path });
}
