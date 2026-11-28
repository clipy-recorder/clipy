import { displayContaining } from "../lib/areaSelectGeometry";
import {
  displayLayoutKey,
  fallbackSourceForTab,
  savedDisplayLayoutMatches,
  sourceMatchesTab,
} from "../lib/captureSelection";
import { cancelWindowPicker, pickWindowInteractively } from "../lib/windowPicker";
import { SelectDesktopSheet } from "../components/recorder/SelectDesktopSheet";
import { DEFAULT_CAMERA_LOOK } from "../lib/cameraLook";
import { normalizeWebcamAppearance } from "../lib/cameraView";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { useTranslations } from "use-intl";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { focusReArmsHighlight, shouldShowSourceHighlight } from "../lib/sourceHighlight";
import {
  disconnectedMicDeviceId,
  resolveAudioOptions,
} from "../lib/micSelection";
import {
  cancelRecording,
  checkForUpdates,
  checkDesktopPermissions,
  probeScreenCapture,
  describeStartError,
  discardRecoverableRecording,
  getAppSettings,
  getEntitlement,
  type EntitlementDto,
  getRecordingGate,
  getReadyUpdate,
  getRecordingSettings,
  getRecordingState,
  getWebcamBubbleState,
  getSourceThumbnail,
  getCursorPosition,
  hideAreaSelect,
  hideSourceHighlight,
  hideWebcamBubble,
  installUpdateAndRelaunch,
  deniedPermission,
  isPermissionDeniedError,
  listNativeStudioRecordings,
  listRecoverableRecordings,
  listAudioInputDevices,
  listCaptureSources,
  listLocalRecordings,
  listWebcamDevices,
  onAreaSelectCancelled,
  onAreaSelectDone,
  onCountdownTick,
  onLocalRecordingProgress,
  onMicMonitorLevel,
  onWebcamLayoutChanged,
  onRecordingAudioWarning,
  onRecordingStateChanged,
  onRequestSourcePicker,
  onShareLinkReady,
  onUpdateReady,
  onUpdateRequired,
  onUploadProgress,
  requestCameraPermission,
  restartToApplyUpdate,
  retryRecoverableRecording,
  setPopoverHeight,
  setRecordingControlsLayout,
  setWebcamLayout,
  startMicMonitor,
  stopMicMonitor,
  showAreaSelect,
  showLocalViewer,
  showSourceHighlight,
  showWebcamBubble,
  onPanelDismissed,
  onPanelRestored,
  signOut,
  beginSignIn,
  stageUpdateInBackground,
  startRecording,
  stopRecording,
  updateHotkey,
  updateOpenLocalArec,
  updateCameraLook,
  updatePersistWebcamPosition,
  type CameraLookDto,
  updateShowInDock,
  updateShowRecordingControls,
  updateRecordingSettings,
  updateWebcamAppearance,
  type AppSettings,
  type AudioDeviceDto,
  type AudioOptionsDto,
  type CaptureSourceDto,
  type CaptureSourcesDto,
  type DesktopUser,
  type LocalRecordingProgressDto,
  type RecordingGateDto,
  type RecordingModeDto,
  type RecoverableRecordingDto,
  type RecordingSettingsDto,
  type RecordingIntentDto,
  type RecordingSourceTabDto,
  type ShareScopeDto,
  type RecordingStateDto,
  type SourceHighlightRectDto,
  type UpdateInfo,
  type UpdateRequiredDto,
  type UploadProgressDto,
  type VideoOptionsDto,
  type WebcamDeviceDto,
  type WebcamLayoutDto,
  type WebcamShapeDto,
  type WebcamSizeDto,
} from "../lib/bridge";
import { preferredWebcamDeviceId } from "../lib/webcamDevices";
import { DEFAULT_WEBCAM_SHAPE, DEFAULT_WEBCAM_SIZE } from "../lib/webcamAppearance";
import { deviceName, isWindows } from "../lib/platform";
import { applyRecorderGlass, clearRecorderGlass, recorderLook, setRecorderLookAttribute } from "../lib/recorderLook";
import { ClipyWordmark } from "../components/ClipyWordmark";
import ProGateCard from "./ProGateCard";
import { UpgradeBanner, upgradeUrl } from "../components/UpgradePrompt";
import { nativeCameraId, type CameraDevice } from "../lib/windowsCamera";
import { WhatsNewCard } from "../components/WhatsNewCard";
import { captureScreenshot, getRecorderShortcuts, onScreenshotFinished, onScreenshotShortcut, revealScreenshot, SCREENSHOT_EDITOR_BUSY, offerOnboardingWindow, showNotesWindow, showOnboardingWindow, showScreenshotPanel, updateScreenshotEditor, type ScreenshotDto, type ScreenshotModeDto } from "../lib/bridge";
import { hotkeyKeycaps } from "../lib/hotkey";
import { recoveryErrorMessage } from "../lib/recoveryError";
import { EffectsSheet } from "../components/recorder/EffectsSheet";
import LocalModePanel from "../components/LocalModePanel";
import { SettingsSheet } from "../components/recorder/SettingsSheet";
import { AccountMenu } from "../components/recorder/AccountMenu";
import { isWindowOnlyCapture, windowOnlyCameraNote, windowSourceHint, windowSourceNote } from "../lib/windowCapture";
import { useDesktopT, type DesktopT } from "../lib/messages";
import { Icon, Menu, OnOffPill, PrimaryButton, Row, ScreenHeader, type MenuItem, SectionTitle } from "../components/recorder/ui";
import { APP_NAME, LOCAL_EDITION, LOCAL_PROJECT_URL } from "../lib/edition";
import { LocalDestination } from "../edition-local/LocalDestination";

type ThumbnailMap = Record<string, string | null>;
type AreaCaptureSource = Extract<CaptureSourceDto, { type: "area" }>;

/* The popover sheet is 340x503 and drawn 1:1 — see `.popover-shell` in
   styles.css, which owns those numbers. Height is the only one this file
   changes: `fitPopoverToContent` measures what the content column actually
   needs and buys the window that much room. */
const POPOVER_AUTHORED_HEIGHT = 503;
/** Matches POPOVER_MAX_HEIGHT in commands.rs, which clamps for real. */
const POPOVER_MAX_AUTHORED_HEIGHT = 760;
/** `app.windows[label="main"].height` in tauri.conf.json. */
const POPOVER_BASE_WINDOW_HEIGHT = 503;

const LOCAL_ACTIVE_STAGES = new Set(["recording", "transcribing", "selecting", "extracting"]);

function localStageLabel(status: LocalRecordingProgressDto, t: DesktopT): string {
  switch (status.stage) {
    case "recording":
      return t("home.localStage.recording");
    case "transcribing":
      return isWindows ? t("home.localStage.transcribingWindows") : t("home.localStage.transcribingMac");
    case "selecting":
      return t("home.localStage.selecting");
    case "extracting":
      return t("home.localStage.extracting");
    case "ready":
      // The copy is the part the user cannot see happen, so the line says it
      // happened only when it did.
      return status.arec_copied ? t("home.localStage.readyCopied") : t("home.localStage.ready");
    case "failed":
      return status.message || t("home.localStage.failed");
    default:
      return status.message;
  }
}

function thumbnailKey(source: { type: "display" | "window"; id: number }): string {
  return `${source.type}:${source.id}`;
}


/** "There is no camera on this Mac right now" (docked MacBook with the lid
 *  closed, Mac mini, camera unplugged) — a benign state that should read as
 *  a hint, never as a red error banner. WebKit surfaces it as
 *  NotAllowedError/NotFoundError with a "No AVVideoCaptureSource device"
 *  style message. */
function isNoCameraAvailableError(err: unknown): boolean {
  const name = err instanceof DOMException ? err.name.toLowerCase() : "";
  const text = String(
    (err as { message?: string })?.message ?? err,
  ).toLowerCase();
  return (
    name === "notfounderror" ||
    text.includes("notfounderror") ||
    text.includes("no avvideocapturesource") ||
    text.includes("devices not found") ||
    text.includes("no camera")
  );
}

/**
 * Camera list for Windows, keyed by the browser's own `deviceId`.
 *
 * Falls back to the native list if enumeration fails or returns nothing, so a
 * webview hiccup degrades to "names but no switching" rather than an empty
 * picker.
 */
async function browserWebcamDevices(
  nativeDevices: Array<{ id: string; name: string; source: "native" }>,
): Promise<Array<{ id: string; name: string; source: "native" }>> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const cameras = all.filter((d) => d.kind === "videoinput" && d.deviceId);
    if (cameras.length === 0) return nativeDevices;
    const browserDevices = cameras.map((camera) => ({ id: camera.deviceId, name: camera.label }));
    return cameras.map((camera, index) => {
      // The browser and Media Foundation enumerate independently, so their
      // array positions do not identify the same physical camera. Reuse a
      // native name only when the device matcher can establish identity.
      const nativeId = nativeCameraId(camera.deviceId, browserDevices, nativeDevices);
      return {
        id: camera.deviceId,
        name: camera.label || nativeDevices.find((device) => device.id === nativeId)?.name || `Camera ${index + 1}`,
        source: "native" as const,
      };
    });
  } catch {
    return nativeDevices;
  }
}

function sourceHighlightRect(
  sources: CaptureSourcesDto | null,
  source: CaptureSourceDto | null,
): SourceHighlightRectDto | null {
  if (!sources || !source || source.type === "camera") return null;
  if (source.type === "display") {
    const display = sources.displays.find((d) => d.id === source.id);
    return display
      ? {
          x: display.x,
          y: display.y,
          width: display.width,
          height: display.height,
        }
      : null;
  }

  if (source.type === "area") {
    const display = sources.displays.find((d) => d.id === source.display_id);
    if (!display) return null;
    return {
      x: display.x + source.x,
      y: display.y + source.y,
      width: source.width,
      height: source.height,
    };
  }

  const window = sources.windows.find((w) => w.id === source.id);
  return window
    ? {
        x: window.x,
        y: window.y,
        width: window.width,
        height: window.height,
      }
    : null;
}

function clampAreaToDisplay(
  area: AreaCaptureSource,
  display: CaptureSourcesDto["displays"][number],
): AreaCaptureSource {
  const x = Math.max(0, Math.min(display.width - 2, Math.round(area.x)));
  const y = Math.max(0, Math.min(display.height - 2, Math.round(area.y)));
  return {
    type: "area",
    display_id: display.id,
    x,
    y,
    width: Math.max(2, Math.min(display.width - x, Math.round(area.width))),
    height: Math.max(2, Math.min(display.height - y, Math.round(area.height))),
  };
}

function sourceExists(source: CaptureSourceDto, sources: CaptureSourcesDto): boolean {
  return (
    (source.type === "display" && sources.displays.some((d) => d.id === source.id)) ||
    (source.type === "window" && sources.windows.some((w) => w.id === source.id)) ||
    (source.type === "area" &&
      sources.displays.some((d) => d.id === source.display_id))
  );
}

function restoreSourceFromSettings(
  settings: RecordingSettingsDto | null,
  sources: CaptureSourcesDto,
): CaptureSourceDto | null {
  const saved = settings?.source;
  if (!saved) return null;
  if (saved.type === "camera") return null;
  // A display or area belongs to the monitor setup it was picked on. On a
  // different setup the picker starts again from the first display.
  if (saved.type === "display") {
    if (!savedDisplayLayoutMatches(settings.displayLayout, sources.displays)) return null;
    return sources.displays.some((d) => d.id === saved.id) ? saved : null;
  }
  if (saved.type === "area") {
    if (!savedDisplayLayoutMatches(settings.displayLayout, sources.displays)) return null;
    const display =
      sources.displays.find((d) => d.id === saved.display_id) ?? sources.displays[0];
    return display ? clampAreaToDisplay(saved, display) : null;
  }
  const exact = sources.windows.find((w) => w.id === saved.id);
  if (exact) return saved;
  const appName = settings?.windowAppName?.trim();
  const title = settings?.windowTitle?.trim();
  const matched = sources.windows.find(
    (w) =>
      (!appName || w.app_name === appName) &&
      (!title || w.title === title),
  );
  return matched ? { type: "window", id: matched.id } : null;
}

// Ids go to Rust VERBATIM. Two earlier versions of this both silently
// downgraded the user's camera choice to "whatever enumerates first":
//   1. it nulled every native id (a leftover from when the webview's
//      getUserMedia rendered the bubble and only understood WebKit ids), and
//   2. it nulled ids that weren't in `webcamDevices` — but that list is loaded
//      by a fire-and-forget refresh, so a recording started before it resolved
//      dropped a perfectly valid id.
// Rust's `select_camera` already falls back safely when an id doesn't resolve,
// so gating here can only destroy information. On a machine whose first camera
// is a virtual one (OBS, Continuity), losing the id opens the wrong device.
function selectableWebcamDeviceId(
  _devices: WebcamDeviceDto[],
  deviceId: string | null,
): string | null {
  return deviceId;
}

function windowMetadata(
  sources: CaptureSourcesDto | null,
  source: CaptureSourceDto | null,
): Pick<RecordingSettingsDto, "windowAppName" | "windowTitle"> {
  if (!sources || source?.type !== "window") {
    return { windowAppName: null, windowTitle: null };
  }
  const window = sources.windows.find((w) => w.id === source.id);
  return {
    windowAppName: window?.app_name ?? null,
    windowTitle: window?.title ?? null,
  };
}

interface Props {
  user: DesktopUser | null;
  onCloud?: () => void;
  initialLocal?: boolean;
}

const RECORDING_NOTES_KEY = "recording_notes";
const settingsStore = new LazyStore("settings.json");
const CLIPY_HOME_URL = LOCAL_EDITION ? LOCAL_PROJECT_URL : "https://clipy.online";
/** How often opening the popover may trigger an update check. */
/** How long the popover must stay unfocused before the source highlight
 * follows it down. Longer than AppKit's key-window bounce, shorter than a
 * deliberate click into another app registers as anything but instant. */
const PANEL_BLUR_SETTLE_MS = 180;
const UPDATE_PROBE_THROTTLE_MS = 5 * 60 * 1000;

interface RefreshSourcesOptions {
  tab?: SourceTab;
  resetSelection?: boolean;
  restoreSavedSource?: boolean;
}

interface OpenPickerOptions extends RefreshSourcesOptions {
  preferredTab?: SourceTab;
}

const IDLE_STATE: RecordingStateDto = {
  phase: "idle",
  recording_id: null,
  elapsed_ms: null,
  bytes_written: null,
  mic_level: null,
  mic_muted: false,
  mic_active: false,
  mic_silence_warning: null,
};

function formatElapsed(ms: number | null): string {
  if (ms === null) return "00:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}


function formatRecoveryAge(updatedAtMs: number, t: DesktopT): string {
  const minutes = Math.max(1, Math.round((Date.now() - updatedAtMs) / 60_000));
  if (minutes < 60) return t("home.recoveryAge.minutes", { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("home.recoveryAge.hours", { hours });
  return t("home.recoveryAge.days", { days: Math.round(hours / 24) });
}

function formatRecoveryExpiry(expiresAtMs: number, t: DesktopT): string {
  const hours = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 3_600_000));
  if (hours < 48) return t("home.recoveryExpiry.hours", { hours });
  return t("home.recoveryExpiry.days", { days: Math.ceil(hours / 24) });
}

function isActiveRecordingPhase(phase: RecordingStateDto["phase"]): boolean {
  return phase === "countdown" || phase === "recording" || phase === "paused";
}

function isRecordingMediaPhase(phase: RecordingStateDto["phase"]): boolean {
  return phase === "recording" || phase === "paused";
}

type SourceTab = "display" | "window" | "area";

// Studio is shelved for now: the mode toggle stays
// as a "coming soon" teaser and the Recent Studio list is hidden. Flip this
// when Studio ships — the code paths underneath are kept alive on purpose.
const STUDIO_ENABLED = false;
const PREVIOUS_RECORDINGS_URL = "https://clipy.online/videos";
const LOCAL_GUIDE_URL = LOCAL_EDITION ? `${LOCAL_PROJECT_URL}#readme` : "https://clipy.online/docs/local-recording";

// Resolution tiers. Uploads are stored as encoded, with no server-side
// re-compression, so resolution directly bounds storage; tiers marked `pro`
// need an upgraded account. `value: 0` = Native (no downscale).
const RESOLUTION_OPTIONS: Array<{ value: number; label: string; pro: boolean }> = [
  { value: 720, label: "720p", pro: false },
  { value: 1080, label: "1080p", pro: false },
  { value: 1440, label: "1440p", pro: true },
  { value: 2160, label: "4K", pro: true },
  { value: 0, label: "Native", pro: true },
];
const FREE_MAX_HEIGHT = 1080;

/** What the picker shows as selected: free users with a saved Pro-tier
 * resolution (pre-gate settings) record at the clamped 1080p, so display
 * that — the saved preference itself is preserved for a later upgrade. */
function effectiveResolutionValue(maxHeight: number | null, isPro: boolean): number {
  const value = maxHeight ?? 0;
  if (isPro) return value;
  return value === 0 || value > FREE_MAX_HEIGHT ? FREE_MAX_HEIGHT : value;
}

function isPrimaryPointer(event: ReactPointerEvent<HTMLButtonElement>): boolean {
  return event.button === 0;
}

function isActivationKey(event: ReactKeyboardEvent<HTMLButtonElement>): boolean {
  return event.key === "Enter" || event.key === " ";
}

/** The panel's action row. Each opens one sheet over the
 *  popover; only one can be open at a time. Effects opens the app's existing
 *  camera-controls window rather than a second copy of that UI. */
type PanelKey = "effects" | "public" | "library";

/** Client-side twin of the Rust `normalize_share_domains` cleanup, so the
 *  chip the user sees is the value that actually gets persisted and sent. */
const MAX_SHARE_DOMAINS = 10;

function normalizeShareDomain(input: string): string | null {
  const cleaned = input
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .toLowerCase();
  return cleaned.includes(".") ? cleaned : null;
}

type SourceChoice = SourceTab | "camera";
/** The source row's label: `home.source.<choice>`. */
const sourceChoiceLabel = (choice: SourceChoice, t: DesktopT): string => t(`home.source.${choice}`);
// Source menu: the row switches mode, the hover-revealed "Select" opens
// that mode's chooser (desktop thumbnails, the hover window picker, or the
// drawing overlay). Camera only has nothing to choose.
const sourceChoiceItems = (windowCapture: VideoOptionsDto["windowCapture"], t: DesktopT): MenuItem<SourceChoice>[] => [
  { value: "display", label: sourceChoiceLabel("display", t), hint: t("home.source.displayHint"), icon: "monitor", action: t("home.source.select") },
  // The break is deliberate. Unbroken, this hint sat right at the wrap point:
  // a scrollbar appearing while the popover refit itself pushed "window" onto
  // a second line, the row grew, the refit removed the scrollbar, the text
  // unwrapped, and the menu bounced up and down. Two lines, always, in both
  // window modes (`windowSourceHint`).
  { value: "window", label: sourceChoiceLabel("window", t), hint: windowSourceHint(windowCapture, isWindows, t), icon: "window", action: t("home.source.select") },
  { value: "area", label: sourceChoiceLabel("area", t), hint: t("home.source.areaHint"), icon: "region", action: t("home.source.select") },
  { value: "camera", label: sourceChoiceLabel("camera", t), icon: "camera", more: true },
];

/** Start refusals by permission, keyed by the name in `permission_denied: <name>`.
 *  Anything else is the screen-recording refusal. */
function permissionBlockedMessage(permission: ReturnType<typeof deniedPermission>, t: DesktopT): string {
  if (permission === "camera") return t("home.permission.camera");
  if (permission === "microphone") return t("home.permission.microphone");
  return t("home.permission.screen");
}

function SetupCard({ onOpen }: { onOpen: () => void }) {
  const t = useDesktopT();
  return (
    <div className="flex flex-col gap-3 pt-1">
      <div className="rounded-2xl bg-row p-4">
        <p className="text-[16px] font-semibold text-ink-text">{t("home.setupCard.title")}</p>
        <p className="mt-1 text-[13px] leading-snug text-ink-secondary">
          {t("home.setupCard.body")}
        </p>
      </div>
      <PrimaryButton onClick={onOpen}>{t("home.setupCard.open")}</PrimaryButton>
    </div>
  );
}

/** Labels are `home.access.<value>`. */
const ACCESS_OPTIONS: Array<{ value: ShareScopeDto; icon: "globe" | "unlock" | "lock" }> = [
  { value: "public", icon: "globe" },
  { value: "restricted", icon: "unlock" },
  { value: "private", icon: "lock" },
];

/** The "Change video access" card, popping up over the strip. */
function AccessPopover({
  open,
  scope,
  onClose,
  onSelect,
}: {
  open: boolean;
  scope: ShareScopeDto;
  onClose: () => void;
  onSelect: (scope: ShareScopeDto) => void;
}) {
  const tr = useDesktopT();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={tr("home.access.title")}
      className="absolute bottom-full right-0 z-50 mb-2 w-[236px] rounded-2xl bg-surface px-2 pb-2 pt-3 shadow-pop animate-pop-in"
    >
      <p className="px-3 pb-2 text-[16px] font-bold text-ink-text">{tr("home.access.title")}</p>
      {ACCESS_OPTIONS.map((option) => {
        const selected = option.value === scope;
        return (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            onClick={() => onSelect(option.value)}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-ink-text transition-colors hover:bg-row"
          >
            <Icon name={option.icon} size={24} />
            <span className="flex-1 text-[16px]">{tr(`home.access.${option.value}`)}</span>
            {selected && <Icon name="check" size={20} />}
          </button>
        );
      })}
    </div>
  );
}

function StripButton({
  icon,
  label,
  active,
  marked,
  onClick,
}: {
  icon: "effects" | "notes" | "library" | "globe" | "lock" | "unlock" | "more";
  label: string;
  active: boolean;
  marked: boolean;
  onClick: () => void;
}) {
  const t = useDesktopT();
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={marked ? t("home.strip.customized", { label }) : undefined}
      onClick={onClick}
      className={`relative flex min-w-0 max-w-[84px] flex-1 basis-0 flex-col items-center gap-1 rounded-xl py-1 text-ink-text transition-colors hover:bg-row ${active ? "bg-row" : ""}`}
    >
      <span className="relative">
        <Icon name={icon} size={26} />
        {marked && <span aria-hidden className="absolute -right-1.5 -top-1 h-2.5 w-2.5 rounded-full bg-flash-500" />}
      </span>
      <span className="w-full text-center text-[12px] leading-tight text-ink-secondary">{label}</span>
    </button>
  );
}



/** One-line "what am I about to record" readout under the source row. */
function sourceSummary(
  tab: SourceTab,
  source: CaptureSourceDto | null,
  sources: CaptureSourcesDto | null,
  t: DesktopT,
): string {
  if (tab === "area") {
    return source?.type === "area"
      ? t("home.summary.region", { width: Math.round(source.width), height: Math.round(source.height) })
      : t("home.summary.dragRegion");
  }
  if (tab === "window") {
    if (source?.type !== "window") return t("home.summary.noWindow");
    const window = sources?.windows.find((w) => w.id === source.id);
    if (!window) return t("home.summary.window");
    return window.title ? `${window.app_name} · ${window.title}` : window.app_name;
  }
  if (source?.type !== "display") return t("home.summary.noDisplay");
  const display = sources?.displays.find((d) => d.id === source.id);
  return display ? `${display.name} · ${display.width}×${display.height}` : t("home.summary.display");
}

export default function Home({ user, onCloud, initialLocal = false }: Props) {
  const t = useDesktopT();
  const tHome = useTranslations("desktop.home");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<RecordingStateDto>(IDLE_STATE);
  const [upload, setUpload] = useState<UploadProgressDto | null>(null);
  const [localJob, setLocalJob] = useState<LocalRecordingProgressDto | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<CaptureSourcesDto | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recordingMode, setRecordingMode] = useState<RecordingModeDto>(user && !initialLocal ? "instant" : "local");
  // Day and night glass: the sheet follows the destination, light for Cloud
  // and dark for Local AI. The macOS blur behind it is applied once.
  useEffect(() => {
    setRecorderLookAttribute(document.documentElement, recorderLook(recordingMode));
    void applyRecorderGlass();
  }, [recordingMode]);
  useEffect(() => () => clearRecorderGlass(), []);
  const [pendingSelection, setPendingSelection] = useState<CaptureSourceDto | null>(null);
  const [sourceTab, setSourceTabState] = useState<SourceTab>("display");
  const sourceTabRef = useRef<SourceTab>("display");
  const setSourceTab = useCallback((next: SourceTab) => {
    sourceTabRef.current = next;
    setSourceTabState(next);
  }, []);
  const [countdownSeconds, setCountdownSeconds] = useState(3);
  const [countdownTick, setCountdownTick] = useState<number | null>(null);
  const [permissionSetupComplete, setPermissionSetupComplete] = useState(false);
  const [recordingSettingsLoaded, setRecordingSettingsLoaded] = useState(false);
  const [cameraOnly, setCameraOnly] = useState(false);
  const cameraOnlyRef = useRef(false);
  cameraOnlyRef.current = cameraOnly;
  const captureSetupComplete = cameraOnly || permissionSetupComplete;
  const [audioDevices, setAudioDevices] = useState<AudioDeviceDto[]>([]);
  const [audioOptions, setAudioOptions] = useState<AudioOptionsDto>({
    includeSystemAudio: true,
    includeMic: true,
    micDeviceId: null,
    reduceNoise: false,
  });
  const [micChecking] = useState(false);
  const [micCheckError, setMicCheckError] = useState<string | null>(null);
  const [videoOptions, setVideoOptions] = useState<VideoOptionsDto>({
    maxHeight: 720,
    windowCapture: "window",
  });
  // A Mac window recorded by itself: the camera bubble and Flare are other
  // windows and cannot be in it, so the picker parks the camera.
  const windowOnly = isWindowOnlyCapture({
    isWindows,
    cameraOnly,
    sourceTab,
    windowCapture: videoOptions.windowCapture,
  });
  /** The camera was on when a window-only source took it away; it comes
   *  back when the source changes, and the saved preference stays "on". */
  const cameraParkedForWindowRef = useRef(false);
  // Pro gate for 1440p/4K/Native. Starts false (free-tier limits are the
  // safe default); refreshed on mount and every picker open. Selection
  // state is never clamped here — a Pro user's saved 4K survives the
  // pre-fetch window, and Rust clamps at record time for free users.
  const [isPro, setIsPro] = useState(false);
  // Pro is unknown until the first entitlement answer; the upgrade prompt
  // waits for it so a paying user never sees it flash.
  const [entitlementKnown, setEntitlementKnown] = useState(false);
  const applyEntitlement = useCallback((e: EntitlementDto) => {
    setIsPro(e.is_pro);
    setEntitlementKnown(e.known);
  }, []);
  // Set when an upgrade button opens pricing; the next time the panel comes
  // back the plan is re-read past Rust's five-minute cache.
  const upgradeOpenedRef = useRef(false);
  // Recording gate (free-tier quota or an admin marker). Populated two ways:
  // preflighted on mount/picker-open so a gated user sees the card instead of
  // walking through the picker, and applied straight from a refused start.
  // FAIL-OPEN: null while unknown and null if the lookup failed — the server
  // still refuses at /raw-upload/initiate.
  const [gate, setGate] = useState<RecordingGateDto | null>(null);
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const [gateRechecking, setGateRechecking] = useState(false);
  const [gateStillOn, setGateStillOn] = useState(false);
  // The gate replaces the picker AND the Start button. Declared here rather
  // than beside the other derived values further down because the picker's
  // auto-open effect reads it — a `const` below that effect would be in the
  // temporal dead zone when its dependency array is evaluated.
  // Permission setup comes first: an upgrade prompt over an app that cannot
  // capture yet helps nobody.
  const gated =
    state.phase === "idle" && captureSetupComplete && !!gate?.gate;
  const [webcamOn, setWebcamOn] = useState(false);
  const [webcamLayout, setWebcamLayoutState] = useState<WebcamLayoutDto>("bubble");
  const [webcamShape, setWebcamShape] = useState<WebcamShapeDto>(DEFAULT_WEBCAM_SHAPE);
  const [webcamSize, setWebcamSize] = useState<WebcamSizeDto>(DEFAULT_WEBCAM_SIZE);
  const [webcamMirrored, setWebcamMirrored] = useState(true);
  const mirrorBusyRef = useRef(false);
  const [webcamDeviceId, setWebcamDeviceId] = useState<string | null>(null);
  const webcamDeviceIdRef = useRef<string | null>(null);
  webcamDeviceIdRef.current = webcamDeviceId;
  // Windows: Media Foundation's camera list, for the native camera-only recorder.
  const nativeWebcamDevicesRef = useRef<CameraDevice[]>([]);
  const [webcamDevices, setWebcamDevices] = useState<WebcamDeviceDto[]>([]);
  const [webcamBusy, setWebcamBusy] = useState(false);
  const [webcamError, setWebcamError] = useState<string | null>(null);
  const [thumbnails, setThumbnails] = useState<ThumbnailMap>({});
  const [updatePrompt, setUpdatePrompt] = useState<UpdateInfo | null>(null);
  // Background update watch staged a new bundle on disk; a restart applies
  // it. Prompt is idle-gated so it never interrupts a recording flow.
  const [readyUpdateVersion, setReadyUpdateVersion] = useState<string | null>(null);
  const [updateRestartDismissed, setUpdateRestartDismissed] = useState(false);
  // Server policy says this version is below the supported minimum: the
  // update dialog becomes blocking (no "Later") and recording is refused
  // Rust-side until the update installs.
  const [forcedUpdate, setForcedUpdate] = useState<UpdateRequiredDto | null>(null);
  const [installing, setInstalling] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<PanelKey | null>(null);
  // The Local library sheet only exists in Local AI mode; leaving the mode
  // must not leave an invisible panel hiding the recorder.
  useEffect(() => {
    if (!LOCAL_EDITION && recordingMode !== "local") setActivePanel((p) => (p === "library" ? null : p));
  }, [recordingMode]);
  // The "Select desktop" sheet. It chooses the Full screen source, or,
  // for Custom size, the display the drawing overlay opens on.
  const [desktopChooser, setDesktopChooser] = useState<"display" | "area" | null>(null);
  const [shareScope, setShareScope] = useState<ShareScopeDto>("public");
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [shareDomains, setShareDomains] = useState<string[]>([]);
  const [domainDraft, setDomainDraft] = useState("");
  // The sticky note lives in its own window (a teleprompter, excluded from
  // capture). The panel only needs to know whether there is anything on it.
  const [notes, setNotes] = useState("");
  useEffect(() => {
    let disposed = false;
    settingsStore
      .get<string>(RECORDING_NOTES_KEY)
      .then((value) => {
        if (!disposed && typeof value === "string") setNotes(value);
      })
      .catch(() => {});
    const off = settingsStore.onKeyChange<string>(RECORDING_NOTES_KEY, (value) => {
      if (!disposed) setNotes(typeof value === "string" ? value : "");
    });
    return () => {
      disposed = true;
      void off.then((fn) => fn());
    };
  }, []);
  const [settingsTab, setSettingsTab] = useState<"enhance" | "video" | "preferences">("enhance");
  // The second mode: screenshots. Full screen or a drag-selected area,
  // captured natively on macOS and Windows; copied, saved, and shared when signed in.
  const [captureMode, setCaptureMode] = useState<"video" | "screenshot">("video");
  const [shotMode, setShotMode] = useState<ScreenshotModeDto>("display");
  const [shotBusy, setShotBusy] = useState(false);
  const [lastShot, setLastShot] = useState<ScreenshotDto | null>(null);
  // A plain function, not a callback: `showToast` is declared further down,
  // so it may only be read when a screenshot actually reports.
  const reportShot = (shot: ScreenshotDto, fromEditor = false) => {
    setLastShot(shot);
    showToast(
      shot.clipboard === "link"
        ? t("home.shot.uploaded")
        : shot.clipboard === "image"
          ? t("home.shot.copied")
          : t("home.shot.saved"),
      5000,
    );
    // The annotation window reports its own upload failures.
    if (shot.uploadError && !fromEditor) setError(t("home.shot.shareFailed", { device: isWindows ? "PC" : "Mac", error: shot.uploadError }));
  };
  const reportShotRef = useRef(reportShot);
  reportShotRef.current = reportShot;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void onScreenshotFinished((shot) => {
      if (shot) reportShotRef.current(shot, true);
      else setLastShot(null);
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  const takeScreenshot = async (mode: ScreenshotModeDto = shotMode, fromShortcut = false) => {
    if (shotBusy) return;
    setShotMode(mode);
    setShotBusy(true);
    setError(null);
    setLastShot(null);
    hideSourceHighlight().catch(() => {});
    const displayId = fromShortcut
      ? null
      : pendingSelection?.type === "display"
        ? pendingSelection.id
        : pendingSelection?.type === "area"
          ? pendingSelection.display_id
          : null;
    try {
      const shot = await captureScreenshot(mode, recordingMode !== "local" && Boolean(user), displayId);
      // Opened in the annotation window: the result arrives through
      // `onScreenshotFinished` when the user presses Done there.
      if (shot.editing) return;
      reportShot(shot);
    } catch (err) {
      if (String(err).includes("cancelled")) return;
      // The annotation window is open; Rust brought it to the front.
      if (String(err).includes(SCREENSHOT_EDITOR_BUSY)) {
        setError(t("home.shot.closeEditorFirst"));
        return;
      }
      setError(t("home.shot.failed", { error: String(err) }));
    } finally {
      setShotBusy(false);
    }
  };
  // ⌘⇧2 (and any full-screen key) from anywhere. Rust only sends this while idle; a capture
  // that cannot run yet opens the popover on the screenshot tab instead.
  const screenshotShortcutRef = useRef<(mode: ScreenshotModeDto) => void>(() => {});
  screenshotShortcutRef.current = (mode) => {
    if (state.phase === "idle" && captureSetupComplete && !gated) {
      void takeScreenshot(mode, true);
    } else {
      setCaptureMode("screenshot");
      setShotMode(mode);
      showScreenshotPanel().catch(() => {});
    }
  };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void onScreenshotShortcut((mode) => screenshotShortcutRef.current(mode)).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  const [shotKeys, setShotKeys] = useState<Record<ScreenshotModeDto, string>>({ area: "", display: "" });
  useEffect(() => {
    if (captureMode !== "screenshot" || activePanel !== null) return;
    getRecorderShortcuts()
      .then((rows) =>
        setShotKeys({
          area: rows.find((row) => row.action === "screenshot_area")?.hotkey ?? "",
          display: rows.find((row) => row.action === "screenshot_display")?.hotkey ?? "",
        }),
      )
      .catch(() => {});
  }, [captureMode, activePanel]);
  const openSettings = (tab: "enhance" | "video" | "preferences" = "enhance") => {
    setActivePanel(null);
    setDesktopChooser(null);
    setSettingsTab(tab);
    setSettingsOpen(true);
    // These were read once at mount, and the AREC viewer can switch
    // auto-open off from its own window. The panel is hidden rather than
    // unmounted between recordings, so without this re-read Settings would
    // show a switch that disagrees with what the app just did.
    getAppSettings().then(setAppSettings).catch(() => {});
  };
  // Live mic level for the microphone row while the panel is open: the
  // native check samples for 1.2s and reports levels; loop it while idle.
  const [idleMicLevel, setIdleMicLevel] = useState(0);

  // The sheet and the column whose overflow decides how tall it has to be.
  const shellRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** Window height last asked for, seeded with the one tauri.conf.json set. */
  const popoverHeightRef = useRef(POPOVER_BASE_WINDOW_HEIGHT);

  // Whether the popover is actually on screen. Tauri has no "window shown"
  // event, so this tracks the two transitions we cause ourselves: dismissing
  // it, and it regaining focus when Rust brings it back. Starts false and is
  // corrected from the real window state on mount: in release builds a
  // signed-in launch keeps the popover hidden while the webview still mounts
  // behind it, and an optimistic `true` here used to auto-open a picker
  // session against that hidden window — painting the red source-highlight
  // border on a display with no visible UI anywhere.
  const [panelVisible, setPanelVisible] = useState(false);
  // Read inside window-event handlers, which would otherwise close over the
  // value from the render that registered them.
  const panelVisibleRef = useRef(false);
  panelVisibleRef.current = panelVisible;
  // Whether the popover has keyboard focus. The source highlight follows it
  // (see `shouldShowSourceHighlight`): the border is always-on-top, so a
  // popover buried behind another app must not keep it painted.
  const [panelFocused, setPanelFocused] = useState(false);
  // Re-read the plan whenever the panel comes back, so someone returning from
  // checkout loses the upgrade prompt without restarting the app.
  useEffect(() => {
    if (LOCAL_EDITION) return;
    if (!panelVisible || !panelFocused) return;
    getEntitlement(upgradeOpenedRef.current)
      .then((e) => {
        applyEntitlement(e);
        if (e.known && e.is_pro) upgradeOpenedRef.current = false;
      })
      .catch(() => {});
  }, [panelVisible, panelFocused, applyEntitlement]);
  // Cleared when Rust re-shows the popover after a recording; set again by
  // any user interaction with the picker. Keeps the post-recording reshow
  // from repainting the border over the display that was just recorded.
  const [highlightArmed, setHighlightArmed] = useState(true);
  // A start is in flight: the phase is still `idle` but the picker must not
  // reopen. Cleared on failure, and whenever the phase actually moves.
  const [startingRecording, setStartingRecording] = useState(false);
  // Mirror of `startingRecording` + the phase for the panel-dismiss path,
  // which runs from a window event and must see the current values.
  const recordingFlowActiveRef = useRef(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [recoverableRecordings, setRecoverableRecordings] = useState<RecoverableRecordingDto[]>([]);
  const [recoveryExpanded, setRecoveryExpanded] = useState(false);
  const [recoveryBusyId, setRecoveryBusyId] = useState<string | null>(null);
  const finishPermissionSetup = useCallback(() => {
    setPermissionSetupComplete(true);
    setError((prev) =>
      prev === permissionBlockedMessage(null, t) || prev === permissionBlockedMessage("camera", t) || prev === permissionBlockedMessage("microphone", t)
        ? null
        : prev,
    );
  }, [t]);
  const onboardingOpenedRef = useRef(false);
  useEffect(() => {
    if (state.phase !== "idle" || !panelVisible || !recordingSettingsLoaded || captureSetupComplete) return;
    if (onboardingOpenedRef.current) return;
    onboardingOpenedRef.current = true;
    // Ask before opening. `permissionSetupComplete` is still false here on a
    // cold start (the check below runs after settings load) and after a
    // camera-only launch, and setup never closes itself, so opening it
    // without checking would put it up on launches where nothing is missing.
    // If we cannot read the permissions, offer setup.
    //
    // This must include the deep probe the setup screen applies: macOS
    // reports a stale TCC grant as `ready` while ScreenCaptureKit still
    // refuses, and skipping setup on `ready` alone drops the user into a
    // recorder where every capture dies with SCK -3801. Unlike setup, this
    // probe fails open on a transient non-permission SCK error, so a healthy
    // user is never blocked from recording by a hiccup; setup is stricter
    // because it is the one that declares the machine ready.
    //
    // `offer`, not `show`: closing setup unfinished brings this popover up,
    // and reopening setup from here would make that close not stick. The
    // Setup card below stays as the way back in.
    void checkDesktopPermissions()
      .then(async (perm) => {
        if (!perm.ready) return offerOnboardingWindow();
        if (!(await probeScreenCapture())) return offerOnboardingWindow();
        finishPermissionSetup();
      })
      .catch(() => offerOnboardingWindow())
      .catch(() => {});
  }, [state.phase, panelVisible, recordingSettingsLoaded, captureSetupComplete, finishPermissionSetup]);
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    listen("onboarding-complete", () => {
      if (!disposed) finishPermissionSetup();
    }).then((fn) => {
      if (disposed) fn();
      else off = fn;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [finishPermissionSetup]);
  const previousPhaseRef = useRef<RecordingStateDto["phase"]>(IDLE_STATE.phase);
  const webcamTeardownRef = useRef(false);
  const webcamRequestRef = useRef(0);
  const activeRecordingModeRef = useRef<RecordingModeDto>("instant");
  const recordingSettingsRef = useRef<RecordingSettingsDto | null>(null);
  const shouldRestoreSourceRef = useRef(true);
  /** The display layout of the last source list, so a display or area picked
   *  on one monitor setup is not kept after the setup changes mid-session. */
  const displayLayoutRef = useRef<string | null>(null);
  const pickerOpeningRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const webcamDeviceIdForCapture = useCallback(
    (deviceId: string | null) => selectableWebcamDeviceId(webcamDevices, deviceId),
    [webcamDevices],
  );
  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback((message: string, durationMs = 4000) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, durationMs);
  }, []);
  const refreshReadyUpdate = useCallback(async () => {
    if (LOCAL_EDITION) return;
    const version = await getReadyUpdate().catch(() => null);
    setReadyUpdateVersion(version);
  }, []);
  // `audioOptions` is the saved PREFERENCE and is never rewritten because a
  // device is unplugged (Cap keeps its `micName` the same way). This is the
  // value a recording actually uses: the preferred mic when connected, else
  // system default for that recording only.
  const resolvedAudioOptions = useCallback(
    () => resolveAudioOptions(audioOptions, audioDevices),
    [audioDevices, audioOptions],
  );
  const disconnectedMic = disconnectedMicDeviceId(audioOptions, audioDevices);

  useEffect(() => {
    setMicCheckError(null);
  }, [audioOptions.includeMic, audioOptions.micDeviceId]);

  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = state.phase;
    if (state.phase !== "countdown") {
      setCountdownTick(null);
    }
    if (state.phase !== previousPhase && (state.phase === "stopping" || state.phase === "uploading" || state.phase === "idle")) {
      webcamTeardownRef.current = true;
      webcamRequestRef.current += 1;
      setWebcamBusy(false);
      setWebcamOn(false);
      setWebcamError(null);
    }
  }, [state.phase]);

  useEffect(() => {
    // Consume the teardown flag before any early return so it can never
    // go stale across commits.
    const idleTeardown = webcamTeardownRef.current;
    webcamTeardownRef.current = false;
    if (!webcamOn || (cameraOnly && recordingFlowActiveRef.current)) return;
    const activeRecordingPhase = isActiveRecordingPhase(state.phase);
    // Only (re)show the bubble in a genuine idle preview state (picker
    // open, user switching device/layout). "stopping"/"uploading" and the
    // idle-transition commit are teardown territory: a show issued there
    // races the backend's stop_native_webcam and can leave an orphaned
    // camera session running behind a hidden bubble window.
    if (state.phase === "idle" && !idleTeardown && panelVisible && pickerOpen && !startingRecording) {
      showWebcamBubble(webcamDeviceIdForCapture(webcamDeviceId)).catch((err) => {
        console.warn("webcam device switch failed", err);
      });
    }
    setWebcamLayout(
      webcamLayout,
      webcamShape,
      webcamSize,
      sourceHighlightRect(sources, pendingSelection),
    ).catch((err) => {
      console.warn("webcam layout failed", err);
    });
    if (activeRecordingPhase) {
      setRecordingControlsLayout(sourceHighlightRect(sources, pendingSelection), {
        enabled: true,
        layout: webcamLayout,
        shape: webcamShape,
        size: webcamSize,
        deviceId: webcamDeviceId,
      }).catch((err) => {
        console.warn("recording controls webcam relayout failed", err);
      });
    }
  }, [webcamOn, webcamDeviceId, webcamDeviceIdForCapture, webcamLayout, webcamShape, webcamSize, sources, pendingSelection, state.phase, cameraOnly, panelVisible, pickerOpen, startingRecording]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onWebcamLayoutChanged((appearance) => {
      if (disposed) return;
      const normalized = normalizeWebcamAppearance(appearance.layout, appearance.shape);
      setWebcamLayoutState(normalized.layout);
      setWebcamShape(normalized.shape);
      setWebcamSize(appearance.size);
      setWebcamMirrored(appearance.mirrored);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const toggleWebcam = async (enabled: boolean) => {
    if (webcamBusy || !panelVisibleRef.current || recordingFlowActiveRef.current) return;
    const request = ++webcamRequestRef.current;
    const isCurrent = () => request === webcamRequestRef.current && panelVisibleRef.current;
    setError(null);
    setWebcamError(null);
    setWebcamBusy(true);
    try {
      if (enabled) {
        const selectedDeviceId = await refreshWebcamDevices(true);
        if (!isCurrent()) return;
        await showWebcamBubble(selectedDeviceId);
        if (!isCurrent()) return;
        await setWebcamLayout(
          webcamLayout,
          webcamShape,
          webcamSize,
          sourceHighlightRect(sources, pendingSelection),
        );
      } else {
        await hideWebcamBubble();
      }
      if (isCurrent()) setWebcamOn(enabled);
    } catch (err) {
      if (!isCurrent()) return;
      console.warn("webcam toggle failed", err);
      setWebcamOn(false);
      const message = isPermissionDeniedError(err)
        ? t("home.camera.permissionBubble")
        : isNoCameraAvailableError(err)
          ? t("home.camera.noCamera")
          : t("home.camera.failedToStart", { error: String(err) });
      setWebcamError(message);
    } finally {
      if (isCurrent()) setWebcamBusy(false);
    }
  };

  const changeCaptureMode = async (value: string) => {
    const onlyCamera = value === "camera";
    cameraOnlyRef.current = onlyCamera;
    setCameraOnly(onlyCamera);
    setDesktopChooser(null);
    if (onlyCamera) {
      void hideSourceHighlight();
      setAreaSelecting(false);
      void hideAreaSelect();
    }
    await toggleWebcam(value !== "screen");
    if (!onlyCamera && permissionSetupComplete) refreshSources();
  };

  // Touch up / auto lighting are app settings the bubble reads live; the
  // popover keeps its copy in `appSettings` so both sheets show one truth.
  const cameraLook: CameraLookDto = appSettings
    ? {
        touchUpEnabled: appSettings.touchUpEnabled,
        touchUpStrength: appSettings.touchUpStrength,
        autoLighting: appSettings.autoLighting,
      }
    : DEFAULT_CAMERA_LOOK;
  const changeCameraLook = async (look: CameraLookDto) => {
    setAppSettings((prev) => (prev ? { ...prev, ...look } : prev));
    try {
      await updateCameraLook(look);
    } catch (err) {
      setWebcamError(t("home.camera.settingsUnavailable", { error: String(err) }));
    }
  };

  const changeCameraMirror = async (mirrored: boolean) => {
    if (mirrorBusyRef.current) return;
    mirrorBusyRef.current = true;
    try {
      setWebcamError(null);
      const appearance = await getWebcamBubbleState();
      await updateWebcamAppearance(appearance.shape, appearance.size, mirrored);
      setWebcamMirrored(mirrored);
    } catch (err) {
      setWebcamError(t("home.camera.settingsUnavailable", { error: String(err) }));
    } finally {
      mirrorBusyRef.current = false;
    }
  };

  // Device listing is AVFoundation-only, on purpose. The webview must never
  // open the camera: capture is native (cap_camera/AVFoundation), so the
  // WKWebView `getUserMedia` that used to run here — solely to unlock
  // `enumerateDevices` labels — was vestigial, and it grabbed the SAME
  // physical device moments before Rust did.
  //
  // LEADING HYPOTHESIS, not a proven root cause: that double-open is the most
  // credible explanation for the app hard-aborting the instant the user clicks
  // "Camera bubble" (tester report; entitlements and
  // usage descriptions on the shipped DMG were verified fine). It has not been
  // reproduced locally and no crash log has been symbolicated yet — if the
  // tester's .ips points elsewhere (e.g. inside the native capture callback),
  // keep looking. Removing the redundant open is correct regardless.
  //
  // The native list already carries both the uniqueID and the localized name,
  // so nothing is lost, and ids now reach `select_camera` intact.
  const refreshWebcamDevices = useCallback(async (requestPermission = false): Promise<string | null> => {
    try {
      if (requestPermission) {
        await requestCameraPermission();
      }
      const nativeDevices = (await listWebcamDevices()).map((device) => ({
        ...device,
        source: "native" as const,
      }));
      nativeWebcamDevicesRef.current = nativeDevices;
      // On Windows the bubble opens the camera through `getUserMedia`, so the
      // DEVICE IDENTITY has to be the browser's. Media Foundation ids are
      // symbolic links and can never match an opaque, origin-scoped
      // `MediaDeviceInfo.deviceId` — so `{deviceId: {exact}}` always failed and
      // `openWebcamStream` silently fell back to the default camera. Cameras
      // listed; switching did nothing.
      //
      // Use the browser's ids, keeping Media Foundation's friendly names for
      // any entry whose label is still blank (labels stay empty until camera
      // permission has been granted at least once).
      const devices = isWindows
        ? await browserWebcamDevices(nativeDevices)
        : nativeDevices;
      setWebcamDevices(devices);
      const selectedDeviceId = preferredWebcamDeviceId(devices, webcamDeviceIdRef.current);
      setWebcamDeviceId(selectedDeviceId);
      return selectableWebcamDeviceId(devices, selectedDeviceId);
    } catch (err) {
      // Keep the last known list. A denied permission prompt lands here, and
      // wiping would throw away names AVFoundation hands us without any grant
      // at all — collapsing the picker to "System default" and discarding the
      // user's saved camera on the next start.
      if (requestPermission && !isNoCameraAvailableError(err)) {
        const message = isPermissionDeniedError(err)
          ? t("home.camera.permissionList")
          : t("home.camera.listFailed", { error: String(err) });
        setWebcamError(message);
      }
      return webcamDeviceId;
    }
  }, [webcamDeviceId, t]);

  const refreshRecentStudio = useCallback(() => {
    if (!STUDIO_ENABLED) return;
    listNativeStudioRecordings(4).catch(() => undefined);
  }, []);

  const refreshRecoverableRecordings = useCallback(() => {
    if (LOCAL_EDITION) return;
    listRecoverableRecordings()
      .then((recordings) => {
        setRecoverableRecordings(recordings);
        if (recordings.length === 0) setRecoveryExpanded(false);
      })
      .catch(() => {
        setRecoverableRecordings([]);
        setRecoveryExpanded(false);
      });
  }, []);

  const applyRecordingState = useCallback((next: RecordingStateDto) => {
    setState(next);
    if (next.phase === "idle") {
      // Keep a terminal failure visible after the recorder resets — clearing
      // it here erased the only trace of a dead upload before anyone saw it.
      setUpload((prev) => (prev?.status === "failed" ? prev : null));
      refreshRecentStudio();
      refreshRecoverableRecordings();
    }
    if (next.phase === "countdown") {
      // Fresh recording session: drop any stale failure from the last one so
      // its banner can't bleed into this recording's progress UI.
      setUpload(null);
    }
  }, [refreshRecentStudio, refreshRecoverableRecordings]);

  useEffect(() => {
    if (state.phase === "idle") {
      refreshRecoverableRecordings();
    }
  }, [state.phase, refreshRecoverableRecordings]);

  // Mirror terminal upload failures into the persistent error line, which
  // renders in every phase — the phase-scoped sections unmount on reset, so
  // on their own the failure could flash for a frame and vanish.
  useEffect(() => {
    if (upload?.status === "failed") {
      setError(
        upload.error
          ? t("home.upload.failedSavedError", { error: upload.error })
          : t("home.upload.failedSaved"),
      );
    }
  }, [upload?.status, upload?.error, t]);

  const refreshSources = (options: RefreshSourcesOptions = {}) => {
    if (cameraOnlyRef.current) {
      void refreshWebcamDevices(false);
      void listAudioInputDevices().then(setAudioDevices).catch(() => {});
      return;
    }
    setLoadingSources(true);
    setSourcesError(null);
    // Stale-while-revalidate: keep the previous sources + thumbnails on
    // screen while fresh ones load — every tile swaps in place as its new
    // screenshot lands. Clearing them here made every picker open feel
    // like a cold start.
    const requestedTab = options.tab ?? sourceTabRef.current;
    listCaptureSources()
      .then((s) => {
        if (cameraOnlyRef.current) return;
        setSources(s);
        // The saved source is restored once, by whichever enumeration lands
        // first after the settings load (several can be in flight at
        // startup). Until then a selection is only a placeholder, so the
        // saved source wins over it.
        const initialRestore =
          shouldRestoreSourceRef.current && recordingSettingsRef.current !== null;
        if (initialRestore) shouldRestoreSourceRef.current = false;
        const restoredInitial = initialRestore
          ? restoreSourceFromSettings(recordingSettingsRef.current, s)
          : null;
        const layout = displayLayoutKey(s.displays);
        const layoutChanged = displayLayoutRef.current !== null && displayLayoutRef.current !== layout;
        displayLayoutRef.current = layout;
        setPendingSelection((prev) => {
          // Enumeration can finish after a mode change. Resolve against the
          // current mode so a delayed result cannot widen the capture scope.
          const activeTab = sourceTabRef.current;
          if (sourceMatchesTab(restoredInitial, activeTab)) return restoredInitial;
          // A display or area belongs to the setup it was picked on.
          const keepPrev = !(layoutChanged && (prev?.type === "display" || prev?.type === "area"));
          if (!options.resetSelection && keepPrev && sourceMatchesTab(prev, activeTab) && sourceExists(prev, s)) {
            if (prev.type !== "area") return prev;
            const display = s.displays.find((d) => d.id === prev.display_id);
            return display ? clampAreaToDisplay(prev, display) : null;
          }
          if (options.restoreSavedSource && requestedTab === activeTab) {
            const restored = restoreSourceFromSettings(recordingSettingsRef.current, s);
            if (sourceMatchesTab(restored, activeTab)) return restored;
          }
          return fallbackSourceForTab(activeTab, s);
        });

        // Fire the display thumbnail requests in parallel; each tile on the
        // "Select desktop" sheet fades in as its result lands. Windows are
        // picked by hovering them on screen, so they need no thumbnail.
        // Failures fall back to a text-only tile via the `null` sentinel.
        const all: { type: "display"; id: number }[] = s.displays.map((d) => ({
          type: "display" as const,
          id: d.id,
        }));
        for (const src of all) {
          getSourceThumbnail(src)
            .then((url) => {
              setThumbnails((prev) => ({ ...prev, [thumbnailKey(src)]: url }));
            })
            .catch(() => {
              setThumbnails((prev) => ({ ...prev, [thumbnailKey(src)]: null }));
            });
        }
      })
      .catch((err) => {
        if (cameraOnlyRef.current) return;
        if (isPermissionDeniedError(err)) {
          // macOS is refusing screen capture (revoked, or a stale TCC
          // grant where the preflight passed but SCK returns -3801).
          // Route to the permissions screen — its deep probe explains
          // the toggle-off-and-on + restart path — instead of dumping
          // the raw SCK error string into the picker.
          setPickerOpen(false);
          setPermissionSetupComplete(false);
          return;
        }
        setSourcesError(String(err));
      })
      .finally(() => {
        setLoadingSources(false);
      });

    // Refresh mic device list alongside displays/windows so the picker
    // reflects what's currently connected (e.g. user just plugged in a
    // headset). Failure is non-fatal — leaves the dropdown empty / on
    // "System default".
    listAudioInputDevices()
      .then(setAudioDevices)
      .catch(() => setAudioDevices([]));
    refreshWebcamDevices(false);
  };

  const [devicesRefreshing, setDevicesRefreshing] = useState(false);

  /**
   * Re-enumerate cameras AND microphones on demand.
   *
   * `requestPermission: true` matters on Windows: `enumerateDevices()` returns
   * blank ids until camera access has been granted at least once, so without
   * the prompt a refresh would keep returning an unusable list.
   */
  const refreshDevices = useCallback(async () => {
    setDevicesRefreshing(true);
    try {
      await refreshWebcamDevices(true);
      const devices = await listAudioInputDevices().catch(() => []);
      // Refresh the LIST only. `audioOptions.micDeviceId` is the user's
      // preference and must survive a device going away — `resolveAudioOptions`
      // substitutes the system default per recording instead. Rewriting it here
      // is what used to lose a saved mic permanently after one unplugged
      // session.
      setAudioDevices(devices);
    } finally {
      setDevicesRefreshing(false);
    }
  }, [refreshWebcamDevices]);

  const previewSource = (source: CaptureSourceDto | null) => {
    const rect = sourceHighlightRect(sources, source);
    if (rect) {
      showSourceHighlight(rect).catch(() => {});
    } else {
      hideSourceHighlight().catch(() => {});
    }
  };

  // On-screen area selection session: the fullscreen overlay is up and
  // owns the display until the user draws a rect or hits Esc. The orange
  // source highlight is suppressed meanwhile — both windows are
  // always-on-top and would fight for the front slot.
  const [areaSelecting, setAreaSelecting] = useState(false);
  const [windowSelecting, setWindowSelecting] = useState(false);
  const areaSelectDisplayRef = useRef<number | null>(null);

  const launchAreaSelect = useCallback(
    (displayId?: number | null) => {
      setAreaSelecting(true);
      // A display chosen on the "Select desktop" sheet wins. Without one
      // (a single display, or a relaunch from the summary line) the overlay
      // goes where the user is looking: the display under the cursor, then
      // the first enumerated display as the fallback of last resort.
      // Displays are fetched here when the picker's own load has not landed
      // yet, so a quick click right after opening the list still works.
      Promise.all([
        getCursorPosition().catch(() => null),
        sources?.displays.length
          ? Promise.resolve(sources.displays)
          : listCaptureSources().then((fresh) => fresh.displays),
      ])
        .then(([cursor, all]) => {
          const first = all[0];
          if (!first) throw new Error("no display to draw on");
          const display =
            all.find((d) => d.id === displayId) ?? displayContaining(all, cursor) ?? first;
          areaSelectDisplayRef.current = display.id;
          return showAreaSelect({
            x: display.x,
            y: display.y,
            width: display.width,
            height: display.height,
          });
        })
        .then(() => {
          // Re-assert after the window is actually up: switching displays
          // re-launches the overlay, and the OLD session's blur-cancel can
          // land in between and clear the flag for the fresh session.
          setAreaSelecting(true);
        })
        .catch((err) => {
          console.warn("area select overlay failed", err);
          setAreaSelecting(false);
        });
    },
    [sources],
  );

  const launchWindowSelect = async () => {
    if (windowSelecting) return;
    setWindowSelecting(true);
    setSourceTab("window");
    hideSourceHighlight().catch(() => {});
    try {
      const windowId = await pickWindowInteractively();
      if (windowId !== null) {
        setHighlightArmed(true);
        setPendingSelection({ type: "window", id: windowId });
        refreshSources({ tab: "window" });
      }
    } catch (err) {
      setSourcesError(String(err));
    } finally {
      setWindowSelecting(false);
      // The pick overlay may have taken focus; bring it back so the
      // highlight for the chosen window can show. Not when the popover was
      // dismissed mid-pick: `setFocus` would order a hidden window back on.
      const popover = getCurrentWindow();
      popover
        .isVisible()
        .then((visible) => (visible ? popover.setFocus() : undefined))
        .catch(() => {});
    }
  };

  // The popover is the key window during a pick (Rust lifts it above the
  // overlays), so Esc lands here rather than on an overlay.
  useEffect(() => {
    if (!windowSelecting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelWindowPicker().catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [windowSelecting]);

  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    onAreaSelectDone((rect) => {
      setAreaSelecting(false);
      // The fullscreen overlay took focus; the drawn area is the user's
      // choice, so bring focus back and let its highlight show.
      getCurrentWindow().setFocus().catch(() => {});
      const displayId = areaSelectDisplayRef.current;
      if (displayId === null) return;
      setHighlightArmed(true);
      // The overlay covers the display exactly, so the rect is already
      // display-local and inside bounds, in the same units as the display
      // rects (logical on macOS; physical on Windows, converted by
      // `complete_area_select`).
      setPendingSelection({
        type: "area",
        display_id: displayId,
        x: rect.x,
        y: rect.y,
        width: Math.max(2, rect.width),
        height: Math.max(2, rect.height),
      });
    }).then((fn) => {
      if (disposed) fn();
      else unlistens.push(fn);
    });
    onAreaSelectCancelled(() => {
      setAreaSelecting(false);
      getCurrentWindow().setFocus().catch(() => {});
    }).then((fn) => {
      if (disposed) fn();
      else unlistens.push(fn);
    });
    return () => {
      disposed = true;
      unlistens.forEach((fn) => fn());
    };
  }, []);

  // Microphone row level while the panel is open, on one input stream for
  // the whole panel session. Looping the 1.2 s probe here opened and closed
  // the mic every ~1.5 s, which macOS showed as the orange indicator blinking
  // while nothing was recording.
  useEffect(() => {
    const live =
      state.phase === "idle" &&
      panelVisible &&
      pickerOpen &&
      audioOptions.includeMic &&
      !micChecking &&
      !startingRecording &&
      !settingsOpen;
    if (!live) {
      setIdleMicLevel(0);
      return;
    }
    let disposed = false;
    let smoothed = 0;
    const offLevel = onMicMonitorLevel((level) => {
      if (disposed) return;
      const clamped = Math.max(0, Math.min(1, level));
      smoothed = clamped > smoothed ? smoothed + (clamped - smoothed) * 0.5 : smoothed + (clamped - smoothed) * 0.15;
      setIdleMicLevel(smoothed);
    });
    // Same device resolution as the recording: null follows the OS default
    // instead of pinning its current name, which would have the supervisor
    // re-enumerate devices every poll for the whole session.
    const started = startMicMonitor(resolvedAudioOptions().micDeviceId).catch(() => null);
    return () => {
      disposed = true;
      void offLevel.then((off) => off());
      void started.then((generation) => (generation === null ? undefined : stopMicMonitor(generation))).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, panelVisible, pickerOpen, audioOptions.includeMic, audioOptions.micDeviceId, micChecking, startingRecording, settingsOpen]);

  // Camera on by default: the first time the picker opens for a
  // screen recording, show the bubble unless the user turned it off last time.
  const cameraAutoRef = useRef(false);
  useEffect(() => {
    if (cameraAutoRef.current) return;
    // A window-only source cannot show the camera; the default applies once
    // the user picks a source that can.
    if (state.phase !== "idle" || !panelVisible || !pickerOpen || !recordingSettingsLoaded || cameraOnly || windowOnly || webcamOn || webcamBusy) return;
    cameraAutoRef.current = true;
    if (recordingSettingsRef.current?.webcam.enabled === false) return;
    void toggleWebcam(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, panelVisible, pickerOpen, recordingSettingsLoaded, cameraOnly, windowOnly, webcamOn, webcamBusy]);

  // Park the camera while a window-only source is chosen, and bring it back
  // when the source (or the Settings choice) changes to one that records it.
  useEffect(() => {
    if (state.phase !== "idle" || webcamBusy || startingRecording) return;
    // A camera back on by any route (camera-only, the user's own toggle) is
    // no longer parked; a stale flag would turn it on again after the user
    // switches it off, and keep saving it as on.
    if (!windowOnly && webcamOn) cameraParkedForWindowRef.current = false;
    if (windowOnly && webcamOn) {
      cameraParkedForWindowRef.current = true;
      void toggleWebcam(false);
    } else if (!windowOnly && cameraParkedForWindowRef.current && !webcamOn && !cameraOnly && panelVisible && pickerOpen) {
      cameraParkedForWindowRef.current = false;
      void toggleWebcam(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowOnly, webcamOn, webcamBusy, startingRecording, state.phase, panelVisible, pickerOpen, cameraOnly]);

  const highlightVisible = !cameraOnly && shouldShowSourceHighlight({
    pickerOpen,
    panelFocused,
    armed: highlightArmed,
    areaSelecting,
    windowSelecting,
  });
  useEffect(() => {
    if (!highlightVisible) {
      hideSourceHighlight().catch(() => {});
      if (!pickerOpen && areaSelecting) {
        // Picker closed mid-selection — don't strand a fullscreen overlay.
        setAreaSelecting(false);
        hideAreaSelect().catch(() => {});
      }
      return;
    }
    previewSource(pendingSelection);
    return () => {
      hideSourceHighlight().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightVisible, pickerOpen, pendingSelection, sources, areaSelecting]);

  useEffect(() => {
    getAppSettings().then(setAppSettings).catch(() => {});
    if (!LOCAL_EDITION) getEntitlement()
      .then(applyEntitlement)
      .catch(() => {});
    if (!LOCAL_EDITION) getRecordingGate()
      .then(setGate)
      .catch(() => {});
    getRecordingSettings()
      .then((settings) => {
        recordingSettingsRef.current = settings;
        shouldRestoreSourceRef.current = true;
        // Studio is gated "coming soon" — clamp a persisted studio
        // preference back to instant so the disabled option can't be the
        // active one.
        setRecordingMode(
          !user || initialLocal ? "local" : settings.recordingMode === "studio" ? "instant" : settings.recordingMode
        );
        activeRecordingModeRef.current =
          !user || initialLocal ? "local" : settings.recordingMode === "studio" ? "instant" : settings.recordingMode;
        setSourceTab(settings.sourceTab);
        cameraOnlyRef.current = settings.source?.type === "camera";
        setCameraOnly(cameraOnlyRef.current);
        // A saved display or area waits for the source list: it is restored
        // only on the monitor setup it was picked on (restoreSourceFromSettings).
        setPendingSelection(settings.source?.type === "window" ? settings.source : null);
        setAudioOptions(settings.audio);
        setVideoOptions(settings.video);
        setWebcamOn(false);
        // A camera saved as on while a window-only source is restored is
        // parked, not off: it stays the preference and comes back with a
        // source that records it. Parking owns that return, so the first-open
        // default does not also switch it on.
        cameraParkedForWindowRef.current =
          settings.webcam.enabled &&
          isWindowOnlyCapture({
            isWindows,
            cameraOnly: cameraOnlyRef.current,
            sourceTab: settings.sourceTab,
            windowCapture: settings.video.windowCapture,
          });
        if (cameraParkedForWindowRef.current) cameraAutoRef.current = true;
        const normalized = normalizeWebcamAppearance(settings.webcam.layout, settings.webcam.shape);
        setWebcamLayoutState(normalized.layout);
        setWebcamShape(normalized.shape);
        setWebcamSize(settings.webcam.size);
        webcamDeviceIdRef.current = settings.source?.type === "camera"
          ? settings.source.device_id
          : settings.webcam.deviceId ?? null;
        setWebcamDeviceId(webcamDeviceIdRef.current);
        setCountdownSeconds(settings.countdownSeconds);
        setShareScope(settings.shareScope ?? "public");
        setShareDomains(settings.shareDomains ?? []);
      })
      .catch(() => {})
      .finally(() => {
        setRecordingSettingsLoaded(true);
        // Windows has no capture permissions, so setup is complete in the
        // same render; otherwise the setup window opens before the check.
        if (isWindows) setPermissionSetupComplete(true);
        if (cameraOnlyRef.current) {
          void refreshWebcamDevices(false);
          void listAudioInputDevices().then(setAudioDevices).catch(() => {});
          return;
        }
        // Prefetch sources + thumbnails so the picker opens warm instead
        // of showing "Loading sources…" on every first open. Chained
        // after settings load so the saved-source restore flag is
        // consumed with the settings actually in hand.
        //
        // `ready` alone is not enough: macOS reports a stale TCC grant (common
        // after an app update changes the code signature) as ready while
        // ScreenCaptureKit still refuses. Trusting it here marked setup done
        // before the panel was first shown, so the setup window's own deep
        // probe never ran and Start failed on every click. Apply the same
        // test the setup window applies.
        checkDesktopPermissions()
          .then(async (perm) => {
            const ready = perm.ready && (await probeScreenCapture());
            setPermissionSetupComplete(ready);
            if (ready && !cameraOnlyRef.current) refreshSources();
          })
          .catch(() => {});
      });
    getRecordingState().then(applyRecordingState).catch(() => {});
    getWebcamBubbleState().then((appearance) => setWebcamMirrored(appearance.mirrored)).catch(() => {});
    refreshRecentStudio();

    let offState: (() => void) | undefined;
    let offUpload: (() => void) | undefined;
    let offShare: (() => void) | undefined;
    let offAudioWarning: (() => void) | undefined;
    let offPickerReq: (() => void) | undefined;
    let offCountdown: (() => void) | undefined;
    let offUpdateRequired: (() => void) | undefined;
    let offUpdateReady: (() => void) | undefined;
    let offLocalProgress: (() => void) | undefined;

    if (!LOCAL_EDITION) onUpdateRequired((info) => setForcedUpdate(info)).then((fn) => {
      offUpdateRequired = fn;
    });

    // Local AI processing outlives the recording; the viewer opens itself on
    // `ready` from Rust, this line just keeps the panel honest meanwhile.
    onLocalRecordingProgress((status) => {
      setLocalJob(status);
      const linger = status.stage === "ready" ? 10_000 : status.stage === "failed" ? 15_000 : 0;
      if (linger > 0) {
        window.setTimeout(() => {
          setLocalJob((current) => (current?.id === status.id && current.stage === status.stage ? null : current));
        }, linger);
      }
    }).then((fn) => {
      offLocalProgress = fn;
    });
    // The panel may open mid-processing; pick up a job already under way.
    listLocalRecordings()
      .then((rows) => {
        const active = rows.find((row) => LOCAL_ACTIVE_STAGES.has(row.stage));
        if (active) setLocalJob((current) => current ?? active);
      })
      .catch(() => {});

    // Background-downloaded update staged on disk. Listener registers
    // first, then the mount query — the other order can drop an event
    // that fires in between. The event covers bundles staged while the
    // window is open; the query covers ones staged while it was closed.
    if (!LOCAL_EDITION) onUpdateReady((version) => {
      setReadyUpdateVersion(version);
      setUpdateRestartDismissed(false);
    }).then((fn) => {
      offUpdateReady = fn;
      getReadyUpdate()
        .then((version) => {
          if (version) setReadyUpdateVersion(version);
        })
        .catch(() => {});
    });

    onRecordingStateChanged(applyRecordingState).then((fn) => {
      offState = fn;
    });

    if (!LOCAL_EDITION) onUploadProgress((p) => setUpload(p)).then((fn) => {
      offUpload = fn;
    });

    onCountdownTick((value) => setCountdownTick(value)).then((fn) => {
      offCountdown = fn;
    });

    if (!LOCAL_EDITION) onShareLinkReady(() => {
      const mode = activeRecordingModeRef.current;
      setToast(mode === "studio" ? t("home.toast.openingStudio") : t("home.toast.openingBrowser"));
      window.setTimeout(() => setToast(null), 4000);
    }).then((fn) => {
      offShare = fn;
    });

    onRecordingAudioWarning(({ message }) => {
      setError(message);
      setToast(message);
      window.setTimeout(() => setToast(null), 7000);
    }).then((fn) => {
      offAudioWarning = fn;
    });

    onRequestSourcePicker(() => {
      setHighlightArmed(true);
      // Tray and shortcut open on Full screen, keeping the display already
      // chosen (or saved for this monitor setup) rather than the first one.
      void openPicker({
        preferredTab: "display",
        restoreSavedSource: true,
      });
    }).then((fn) => {
      offPickerReq = fn;
    });

    return () => {
      offState?.();
      offUpload?.();
      offShare?.();
      offAudioWarning?.();
      offPickerReq?.();
      offCountdown?.();
      offUpdateRequired?.();
      offUpdateReady?.();
      offLocalProgress?.();
    };
  }, [applyRecordingState, refreshRecentStudio]);

  useEffect(() => {
    if (!isRecordingMediaPhase(state.phase)) return;
    let disposed = false;
    const poll = () => {
      getRecordingState()
        .then((next) => {
          if (!disposed) applyRecordingState(next);
        })
        .catch(() => {});
    };
    const id = window.setInterval(poll, 1000);
    poll();
    return () => {
      disposed = true;
      window.clearInterval(id);
    };
  }, [state.phase, applyRecordingState]);

  const handleSignOut = async () => {
    if (LOCAL_EDITION) return;
    setBusy(true);
    try {
      await signOut();
    } catch (err) {
      setError(String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  // Sign out, then go straight to the browser sign-in so the next person (a
  // QA teammate on a shared Mac) lands in their own account in one step.
  const handleSwitchAccount = async () => {
    await handleSignOut();
    await beginSignIn().catch(() => {});
  };

  const handleCheckForUpdates = async () => {
    if (LOCAL_EDITION) return;
    setBusy(true);
    try {
      const result = await checkForUpdates();
      if (result.available) {
        // Surface a persistent dialog with an Install button — a 4s
        // toast wasn't enough to act on the offer.
        setUpdatePrompt(result);
      } else {
        setToast(t("home.toast.upToDate", { version: result.currentVersion }));
        window.setTimeout(() => setToast(null), 4000);
      }
    } catch (err) {
      setError(t("home.errors.updateCheck", { error: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenPreviousRecordings = async () => {
    if (LOCAL_EDITION) return;
    setError(null);
    try {
      await open(PREVIOUS_RECORDINGS_URL);
    } catch (err) {
      setError(t("home.errors.openRecordings", { error: String(err) }));
    }
  };

  const handleUpgrade = async (surface: string) => {
    if (LOCAL_EDITION) return;
    setError(null);
    upgradeOpenedRef.current = true;
    try {
      await open(upgradeUrl(surface));
    } catch (err) {
      setError(t("home.errors.openUpgrade", { error: String(err) }));
    }
  };

  /** Re-ask the server whether this account is still gated. Used by the card's
   *  "Already upgraded?" link. A cleared gate unmounts the card. */
  const recheckGate = async () => {
    if (LOCAL_EDITION) return;
    setGateRechecking(true);
    setGateStillOn(false);
    try {
      const next = await getRecordingGate();
      setGate(next);
      if (next.gate) {
        setGateStillOn(true);
      } else {
        setGateMessage(null);
        // The Pro flag decides the resolution tiers; an upgrade that cleared
        // the gate almost certainly changed it too.
        getEntitlement(true)
          .then(applyEntitlement)
          .catch(() => {});
      }
    } catch {
      // Fail-open, same as the preflight.
      setGate(null);
      setGateMessage(null);
    } finally {
      setGateRechecking(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (LOCAL_EDITION) return;
    setInstalling(true);
    setError(null);
    try {
      // Resolves only on failure; on success the process restarts and
      // the renderer is torn down before this await returns.
      await installUpdateAndRelaunch();
    } catch (err) {
      setError(t("home.errors.installUpdate", { error: String(err) }));
      setInstalling(false);
      await refreshReadyUpdate();
    }
  };

  const currentRecordingSettings = useCallback((): RecordingSettingsDto => {
    // Until the source list loads, a saved display or area has not been
    // restored yet; saving null then would forget it.
    const saved = recordingSettingsRef.current;
    const keepSavedSource =
      !cameraOnly && !sources && !pendingSelection && saved?.source?.type !== "camera";
    const source: CaptureSourceDto | null = cameraOnly
      ? { type: "camera", device_id: webcamDeviceId ?? "" }
      : keepSavedSource
        ? saved?.source ?? null
        : pendingSelection;
    return {
      sourceTab: sourceTab as RecordingSourceTabDto,
      source,
      ...(keepSavedSource
        ? { windowAppName: saved?.windowAppName ?? null, windowTitle: saved?.windowTitle ?? null }
        : windowMetadata(sources, source)),
      displayLayout: sources
        ? displayLayoutKey(sources.displays)
        : recordingSettingsRef.current?.displayLayout ?? null,
      // The preference, so an unplugged mic is selected again when it is back.
      audio: audioOptions,
      video: videoOptions,
      webcam: {
        // A camera parked for a window-only source is still the preference.
        enabled: webcamOn || cameraParkedForWindowRef.current,
        layout: webcamLayout,
        shape: webcamShape,
        size: webcamSize,
        deviceId: webcamDeviceId,
      },
      // Signed out, Home is pinned to Local; keep the saved choice so Cloud
      // comes back after signing in.
      recordingMode: user ? recordingMode : recordingSettingsRef.current?.recordingMode ?? recordingMode,
      countdownSeconds,
      shareScope,
      shareDomains,
    };
  }, [
    audioOptions,
    cameraOnly,
    countdownSeconds,
    shareDomains,
    shareScope,
    pendingSelection,
    recordingMode,
    sourceTab,
    sources,
    videoOptions,
    webcamDeviceId,
    webcamLayout,
    webcamShape,
    webcamSize,
    webcamOn,
    user,
  ]);

  /** What `start_recording` stashes for `/complete`. Empty notes stay empty
   *  rather than becoming empty strings, so the server keeps its own
   *  generated name instead of storing a blank one. */
  const currentRecordingIntent = useCallback((): RecordingIntentDto => {
    return {
      title: null,
      description: null,
      shareScope,
      shareDomains,
    };
  }, [shareDomains, shareScope]);

  const persistCurrentRecordingSettings = useCallback(async () => {
    const settings = currentRecordingSettings();
    recordingSettingsRef.current = settings;
    // Before any source list has loaded the saved source is still pending.
    if (sources) shouldRestoreSourceRef.current = false;
    await updateRecordingSettings(settings);
  }, [currentRecordingSettings, sources]);

  const openPicker = async (options: OpenPickerOptions = {}) => {
    const webcamRequest = webcamRequestRef.current;
    const preferredTab = options.preferredTab ?? options.tab;
    if (preferredTab) {
      setSourceTab(preferredTab);
    }
    if (options.resetSelection) {
      setPendingSelection(
        sources && preferredTab ? fallbackSourceForTab(preferredTab, sources) : null,
      );
    }
    if (pickerOpen) {
      refreshSources({
        tab: preferredTab,
        resetSelection: options.resetSelection,
        restoreSavedSource: options.restoreSavedSource,
      });
      return;
    }
    if (pickerOpeningRef.current) return;
    pickerOpeningRef.current = true;
    try {
      setError(null);
        setMicCheckError(null);
      setPickerOpen(true);
      refreshWebcamDevices(false);
      getEntitlement()
        .then(applyEntitlement)
        .catch(() => {});
      getRecordingGate()
        .then(setGate)
        .catch(() => {});
      let granted = cameraOnlyRef.current;
      try {
        if (!cameraOnlyRef.current) granted = (await checkDesktopPermissions()).ready;
      } catch {
        granted = false;
      }
      if (!granted) {
        setPickerOpen(false);
        setPermissionSetupComplete(false);
        return;
      }
      refreshSources({
        tab: preferredTab,
        resetSelection: options.resetSelection,
        restoreSavedSource: options.restoreSavedSource,
      });
      if (webcamOn && panelVisibleRef.current && webcamRequest === webcamRequestRef.current) {
        try {
          await showWebcamBubble(webcamDeviceIdForCapture(webcamDeviceId));
          if (webcamRequest !== webcamRequestRef.current || !panelVisibleRef.current) return;
          await setWebcamLayout(
            webcamLayout,
            webcamShape,
            webcamSize,
            sourceHighlightRect(sources, pendingSelection),
          );
        } catch (err) {
          if (webcamRequest !== webcamRequestRef.current) return;
          setWebcamOn(false);
          setWebcamError(String(err));
        }
      }
    } finally {
      pickerOpeningRef.current = false;
    }
  };

  const closePicker = () => {
    persistCurrentRecordingSettings().catch(() => {});
    hideSourceHighlight().catch(() => {});
    setPickerOpen(false);
    // Rust also dismisses the popover when a recording starts; the camera
    // bubble then belongs to the recording and must stay up.
    //
    // The guard reads the recording PHASE rather than `recordingFlowActiveRef`.
    // That ref tracks a start-a-recording flow the user is driving, so it is
    // false on the paths that merely put the popover away — including the one
    // that runs when the main window is closed. `webcamOn` is no better: it
    // drifts out of step with the bubble window, which Rust can also show.
    // Keying on the phase covers every dismissal while still leaving a live
    // recording's bubble alone, which is the direction that must not regress.
    if (!isActiveRecordingPhase(state.phase)) {
      webcamRequestRef.current += 1;
      setWebcamBusy(false);
      setWebcamOn(false);
      setWebcamError(null);
      hideWebcamBubble().catch(() => {});
    }
  };
  // `endPanelSession` is registered once as a window-event handler, so it
  // must reach the CURRENT `closePicker`. Calling the one from the first
  // render used to see `webcamOn === false` forever and never stopped the
  // camera preview when the popover was put away.
  const closePickerRef = useRef(closePicker);
  closePickerRef.current = closePicker;

  // Everything that ends a picker session, minus the hide itself: settings
  // are persisted, the source highlight and camera preview stop. Rust hides
  // the window on its own for the tray toggle and for recording start, so
  // this has to be callable without hiding again.
  const endPanelSession = useCallback(() => {
    setSettingsOpen(false);
    panelVisibleRef.current = false;
    setPanelVisible(false);
    // A fresh session next time is a user-opened one.
    setHighlightArmed(true);
    closePickerRef.current();
  }, []);

  // Menu-bar popover: putting it away ends the picker session exactly like
  // closing the old modal did. Reopening from the tray starts a fresh one.
  const dismissPanel = () => {
    endPanelSession();
    getCurrentWindow()
      .close()
      .catch((err) => console.warn("close popover failed", err));
  };

  // Rust put the panel away (tray toggle, or a recording starting). The
  // window is already hidden — run the cleanup only, or the source
  // highlight and camera preview keep running behind a hidden window.
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    onPanelDismissed(() => endPanelSession()).then((fn) => {
      if (disposed) fn();
      else unlistens.push(fn);
    });
    onPanelRestored(() => setHighlightArmed(false)).then((fn) => {
      if (disposed) fn();
      else unlistens.push(fn);
    });
    return () => {
      disposed = true;
      unlistens.forEach((fn) => fn());
    };
  }, [endPanelSession]);

  // Rust hides the popover for the whole capture flow — including recordings
  // started from the agent bridge, which never showed it in the first place.
  useEffect(() => {
    if (state.phase !== "idle") setStartingRecording(false);
    if (isActiveRecordingPhase(state.phase)) setPanelVisible(false);
  }, [state.phase]);

  useEffect(() => {
    recordingFlowActiveRef.current = startingRecording || state.phase !== "idle";
  }, [startingRecording, state.phase]);

  // Rust hides this window while a recording runs and shows it again through
  // the tray/hotkey, so focus is how the webview learns it is back on
  // screen. Without this the auto-open effect below would restart the picker
  // session (source highlight, camera preview) on a hidden window.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // `panelVisible` starts false; ask the real window whether the popover is
    // actually on screen (dev builds and signed-out launches show it at
    // startup, signed-in release launches keep it hidden in the menu bar).
    getCurrentWindow()
      .isVisible()
      .then((visible) => {
        if (!disposed && visible) setPanelVisible(true);
      })
      .catch(() => {});
    getCurrentWindow()
      .isFocused()
      .then((focused) => {
        if (!disposed) setPanelFocused(focused);
      })
      .catch(() => {});
    // Focus loss is debounced: AppKit bounces key status for a few ms when a
    // sibling window is ordered front (the highlight itself, the camera
    // bubble, show_main's always-on-top toggle). Reacting to every blur made
    // the highlight hide and re-show in a loop, which read as flicker.
    let blurTimer: number | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          if (blurTimer !== undefined) {
            window.clearTimeout(blurTimer);
            blurTimer = undefined;
          }
          setPanelFocused(true);
          if (focusReArmsHighlight({ wasVisible: panelVisibleRef.current, focused })) {
            setHighlightArmed(true);
          }
          setPanelVisible(true);
          return;
        }
        if (blurTimer === undefined) {
          blurTimer = window.setTimeout(() => {
            blurTimer = undefined;
            if (!disposed) setPanelFocused(false);
          }, PANEL_BLUR_SETTLE_MS);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (blurTimer !== undefined) window.clearTimeout(blurTimer);
      unlisten?.();
    };
  }, []);

  // Opening the popover is the moment to look for a new release: the app
  // usually sits in the menu bar for days between uses, and the background
  // watch's poll interval would otherwise decide how stale it is. Throttled
  // because focus fires on every alt-tab back. The download is silent and
  // still never installs itself — that stays behind the gated Restart
  // button below.
  const lastUpdateProbeRef = useRef(0);
  useEffect(() => {
    if (LOCAL_EDITION) return;
    if (!panelVisible) return;
    const now = Date.now();
    if (now - lastUpdateProbeRef.current < UPDATE_PROBE_THROTTLE_MS) return;
    lastUpdateProbeRef.current = now;
    stageUpdateInBackground().catch(() => {});
  }, [panelVisible]);

  // The popover IS the picker now; there is no separate
  // "Start Recording → now choose a source" step. Opening a session here
  // keeps every existing effect (source highlight, camera preview,
  // entitlement refresh) working off the same `pickerOpen` flag.
  useEffect(() => {
    if (
      !panelVisible ||
      startingRecording ||
      state.phase !== "idle" ||
      !captureSetupComplete ||
      pickerOpen ||
      // A gated account shows the upgrade card instead of the picker. Without
      // this the session would still open underneath it — enumerating sources
      // and painting the source-highlight overlay for a recording that cannot
      // start.
      gated
    ) {
      return;
    }
    void openPicker();
    // openPicker is recreated every render; the guards above are what stop
    // this from re-entering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelVisible, startingRecording, state.phase, captureSetupComplete, pickerOpen, gated]);

  const handleConfirmAndStart = async () => {
    setError(null);
    setMicCheckError(null);
    if (!cameraOnlyRef.current && !sourceMatchesTab(pendingSelection, sourceTabRef.current)) {
      setError(t("home.errors.chooseSource"));
      return;
    }
    activeRecordingModeRef.current = recordingMode;
    // Closes the auto-open race: `setPickerOpen(false)` below lands while
    // the phase is still `idle` and the panel is still visible, so without
    // this the auto-open effect reopens the picker during the awaited
    // layout/webcam calls — restarting the camera preview and the source
    // highlight underneath the recording that is about to start.
    setStartingRecording(true);
    recordingFlowActiveRef.current = true;
    try {
      // Resolved for this recording only; the saved settings keep the
      // preference.
      const audioForRecording = { ...resolvedAudioOptions(), ...(cameraOnly ? { includeSystemAudio: false } : {}) };
      if (cameraOnly && !webcamDeviceId) {
        throw new Error(t("home.camera.chooseConnected"));
      }
      hideSourceHighlight().catch(() => {});
      const settings = currentRecordingSettings();
      recordingSettingsRef.current = settings;
      shouldRestoreSourceRef.current = false;
      await updateRecordingSettings(settings);
      setPickerOpen(false);
      // Window-only takes never contain the bubble; Rust drops it too.
      const webcamEnabledForRecording = webcamOn && !cameraOnly && !windowOnly;
      const captureWebcamDeviceId = webcamDeviceIdForCapture(webcamDeviceId);
      if (windowOnly && webcamOn) {
        cameraParkedForWindowRef.current = true;
        await hideWebcamBubble();
        setWebcamOn(false);
      }
      if (cameraOnly) {
        // Windows keeps the preview up through the countdown; the native
        // recorder takes the camera over from it without closing the bubble.
        if (!isWindows) await hideWebcamBubble();
        setWebcamOn(false);
      }
      await setRecordingControlsLayout(
        sourceHighlightRect(sources, pendingSelection),
        {
          enabled: webcamEnabledForRecording,
          layout: webcamLayout,
          shape: webcamShape,
          size: webcamSize,
          deviceId: captureWebcamDeviceId,
        },
      );
      if (webcamEnabledForRecording) {
        await showWebcamBubble(captureWebcamDeviceId);
        await setWebcamLayout(
          webcamLayout,
          webcamShape,
          webcamSize,
          sourceHighlightRect(sources, pendingSelection),
        );
        await setRecordingControlsLayout(
          sourceHighlightRect(sources, pendingSelection),
          {
            enabled: true,
            layout: webcamLayout,
            shape: webcamShape,
            size: webcamSize,
            deviceId: captureWebcamDeviceId,
          },
        );
      }
      // Windows records camera-only natively, which needs the Media
      // Foundation id; the saved settings keep the webview's id.
      let recordingSource = settings.source;
      if (isWindows && recordingSource?.type === "camera") {
        const deviceId = nativeCameraId(recordingSource.device_id, webcamDevices, nativeWebcamDevicesRef.current);
        if (deviceId === null) {
          throw new Error(t("home.camera.notFound"));
        }
        recordingSource = { type: "camera", device_id: deviceId };
      }
      await startRecording(
        recordingSource ?? undefined,
        audioForRecording,
        videoOptions,
        {
          enabled: webcamEnabledForRecording,
          layout: webcamLayout,
          shape: webcamShape,
          size: webcamSize,
          deviceId: captureWebcamDeviceId,
        },
        recordingMode,
        countdownSeconds,
        settings,
        // Local recordings never reach /complete, so there is nothing for an
        // intent to be read by. Passing null keeps that explicit rather than
        // stashing a value nothing will ever look at.
        recordingMode === "local" ? null : currentRecordingIntent(),
      );
      // Bring the teleprompter up for the take when there is something on it.
      // Unfocused, so it never takes the keyboard from the app being recorded.
      if (notes.trim()) void showNotesWindow({ focus: false }).catch(() => {});
      setActivePanel(null);
    } catch (err) {
      // Only the failure path clears the flag: on success the phase leaves
      // idle, which is what keeps the picker closed from then on. Clearing
      // it here on success would reopen the picker for the tick between
      // startRecording resolving and the state event arriving.
      setStartingRecording(false);
      if (webcamOn) {
        setWebcamOn(false);
        hideWebcamBubble().catch(() => {});
      }
      if (isPermissionDeniedError(err) && !cameraOnly) {
        // Never fail silently here. The picker is swapped for the setup card,
        // which on its own reads like nothing happened; say which permission
        // macOS refused and open the setup window. A camera or mic refusal
        // from the webcam/mic preflight must not be reported as a broken
        // screen grant, or the user is told to remove a grant that works.
        setPickerOpen(false);
        setPermissionSetupComplete(false);
        setError(permissionBlockedMessage(deniedPermission(err), t));
        void showOnboardingWindow().catch(() => {});
        return;
      }
      // A refusal the preflight missed (marker set mid-session, quota crossed
      // by this very recording, stale gate): swap the picker for the gate card
      // instead of printing the server's sentence as a red error line.
      const failure = describeStartError(err);
      if (!LOCAL_EDITION && failure.code === "pro_required") {
        setGate({
          gate: failure.level ?? "soft",
          quota: failure.quota,
          // The 403 body carries no offer — top it up in the background so the
          // card can show the discount without a second refusal.
          offer: gate?.offer ?? null,
        });
        setGateMessage(failure.message);
        setPickerOpen(false);
        getRecordingGate()
          .then((next) => {
            if (next.gate) setGate(next);
          })
          .catch(() => {});
        return;
      }
      showToast(failure.message, 7000);
    }
  };

  const handleCancel = async () => {
    setError(null);
    try {
      await cancelRecording();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleStop = async () => {
    if (busy || stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await stopRecording();
    } catch (err) {
      setError(String(err));
    } finally {
      stopRequestedRef.current = false;
      setBusy(false);
    }
  };

  const handleStopPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isPrimaryPointer(event)) return;
    event.preventDefault();
    void handleStop();
  };

  const handleStopKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!isActivationKey(event)) return;
    event.preventDefault();
    void handleStop();
  };


  const handleRecoverRecording = async (recording: RecoverableRecordingDto) => {
    if (LOCAL_EDITION) return;
    if (recoveryBusyId !== null) return;
    setRecoveryBusyId(recording.recording_id);
    setError(null);
    try {
      await retryRecoverableRecording(recording.recording_id);
      setRecoverableRecordings((current) =>
        current.filter((item) => item.recording_id !== recording.recording_id),
      );
      showToast(t("home.toast.recovered"), 5000);
    } catch (err) {
      setError(recoveryErrorMessage(err, t));
    } finally {
      setRecoveryBusyId(null);
      refreshRecoverableRecordings();
    }
  };

  const handleDiscardRecording = async (recording: RecoverableRecordingDto) => {
    if (LOCAL_EDITION) return;
    setError(null);
    try {
      const discarded = await discardRecoverableRecording(recording.recording_id);
      if (!discarded) return;
      setRecoverableRecordings((current) =>
        current.filter((item) => item.recording_id !== recording.recording_id),
      );
    } catch (err) {
      setError(t("home.errors.discard", { error: String(err) }));
    }
  };

  const phase = state.phase;
  // Signed-in free accounts that can still record. Signed-out users have no
  // plan to upgrade, and a gated account already has ProGateCard.
  const showUpgrade =
    !LOCAL_EDITION && Boolean(user) && entitlementKnown && !isPro && phase === "idle" && captureSetupComplete && !gated;
  const showCancel = phase === "countdown" || phase === "uploading";
  const uploadTotalBytes = Math.max(
    state.bytes_written ?? 0,
    upload?.bytes_uploaded ?? 0,
  );
  const uploadRatio = (() => {
    if (!upload || uploadTotalBytes <= 0) return 0;
    return Math.min(1, upload.bytes_uploaded / uploadTotalBytes);
  })();
  const uploadPercent = Math.round(uploadRatio * 100);
  const uploadStatusText = (() => {
    if (!upload) return t("home.upload.preparing");
    const uploaded = formatBytes(upload.bytes_uploaded);
    if (uploadTotalBytes > 0) {
      return t("home.upload.progress", { uploaded, total: formatBytes(uploadTotalBytes) });
    }
    return uploaded;
  })();
  const isStudioFlow = activeRecordingModeRef.current === "studio";
  const startLabel = recordingMode === "local" ? t("home.startLocal") : t("home.start");
  const localJobActive = !!localJob && LOCAL_ACTIVE_STAGES.has(localJob.stage);
  // One local job at a time: Rust refuses a second start while processing.
  const localStartBlocked = recordingMode === "local" && localJobActive;

  const displays = sources?.displays ?? [];
  const windows = sources?.windows ?? [];
  const [rowMenu, setRowMenu] = useState<"source" | "camera" | "mic" | null>(null);
  const sourceChoice: SourceChoice = cameraOnly ? "camera" : sourceTab;
  const cameraArmed = cameraOnly || webcamOn;
  const cameraLabel =
    (webcamDeviceId && webcamDevices.find((d) => d.id === webcamDeviceId)?.name) ||
    (webcamDevices[0]?.name ?? t("home.camera.systemDefault"));
  const micLabel = !audioOptions.includeMic
    ? t("home.mic.off")
    : (resolvedAudioOptions().micDeviceId && audioDevices.find((d) => d.id === resolvedAudioOptions().micDeviceId)?.name) ||
      (audioDevices.find((d) => d.is_default)?.name ?? t("home.mic.systemDefault"));
  /** `openChooser` is the menu's "Select" link: the row alone only switches
   *  mode for Full screen, while Specific window and Custom size always go
   *  on screen to pick. */
  const chooseSource = async (choice: SourceChoice, openChooser = false) => {
    if (choice === "camera") {
      await changeCaptureMode("camera");
      return;
    }
    if (cameraOnly) {
      // Leaving camera-only keeps the camera as an overlay, on by default.
      await changeCaptureMode("screen-camera");
    }
    selectSourceTab(choice, openChooser);
  };
  const defaultAudioDevice = audioDevices.find((device) => device.is_default);
  // A source picked by hand: the user is engaging the picker, so the
  // highlight may show again even after a post-recording reshow.
  const selectSource = (source: CaptureSourceDto) => {
    setHighlightArmed(true);
    setPendingSelection(source);
  };

  /** The three choosers. Full screen and Custom size open the "Select
   *  desktop" sheet when there is more than one display; with one display
   *  Full screen just takes it and Custom size goes straight to drawing. */
  const openSourceChooser = (tab: SourceTab) => {
    setHighlightArmed(true);
    if (tab === "window") {
      void launchWindowSelect();
      return;
    }
    if (displays.length > 1) {
      setDesktopChooser(tab);
      return;
    }
    if (tab === "display") {
      if (displays[0]) selectSource({ type: "display", id: displays[0].id });
      return;
    }
    launchAreaSelect(displays[0]?.id ?? null);
  };

  const selectSourceTab = (next: SourceTab, openChooser = false) => {
    setHighlightArmed(true);
    setSourceTab(next);
    if (next === "display") {
      if (pendingSelection?.type !== "display") {
        setPendingSelection(displays[0] ? { type: "display", id: displays[0].id } : null);
      }
      if (openChooser) openSourceChooser("display");
      return;
    }
    if (next === "window") {
      // A window is chosen on screen; nothing is preseeded here because the
      // hover picker is the whole interaction.
      if (pendingSelection?.type !== "window") setPendingSelection(null);
      openSourceChooser("window");
      return;
    }
    // No preseeded rect: the recorded size is exactly what the user draws,
    // so a stale display/window selection must not stay recordable here.
    if (pendingSelection?.type !== "area") {
      setPendingSelection(null);
    }
    openSourceChooser("area");
  };

  // The sheet is authored against macOS font metrics. Windows renders the same
  // markup taller, so the content column ended up scrolling inside a popover
  // that could simply have been taller — a scrollbar down the middle of a
  // four-row recorder. Measure what the column needs and buy the window that
  // much height instead.
  //
  // Measurement always starts from the authored height, never from whatever
  // the sheet currently is, so this shrinks back when the content does —
  // switching to screenshot mode, or a status line clearing.
  const fitPopoverToContent = useCallback(() => {
    const shell = shellRef.current;
    const column = contentRef.current;
    if (!shell || !column) return;

    const onScreen = shell.style.height;
    shell.style.height = `${POPOVER_AUTHORED_HEIGHT}px`;
    // Reading scrollHeight forces the reflow the measurement needs. Nothing
    // paints between the two writes, so the baseline is never shown.
    const overflow = Math.max(0, column.scrollHeight - column.clientHeight);
    shell.style.height = onScreen;

    const wanted = Math.ceil(
      Math.min(POPOVER_AUTHORED_HEIGHT + overflow, POPOVER_MAX_AUTHORED_HEIGHT),
    );
    const previous = popoverHeightRef.current;
    if (wanted === previous) return;
    popoverHeightRef.current = wanted;

    const fitShell = (applied: number) => {
      // Size the sheet from what Rust applied, not from what we asked for:
      // it clamps against the work area, and a sheet taller than its window
      // puts a second scrollbar on the body.
      shell.style.height = `${applied}px`;
    };
    const resized = setPopoverHeight(wanted).then(fitShell);
    // Grow the window before the sheet, shrink it after, so the sheet is never
    // momentarily larger than the window it lives in.
    if (wanted < previous) fitShell(wanted);
    void resized.catch(() => {
      // Sizing is a nicety. A failure here leaves the column scrolling, which
      // is exactly how the sheet behaved before, and must never break a take.
      shell.style.height = onScreen;
      popoverHeightRef.current = previous;
    });
  }, []);

  // Coalesced to one measurement per frame. The effect below has no dependency
  // array — any render can change what the column holds — and the mic meter
  // re-renders this component at audio-chunk rate, so measuring inline would
  // force a synchronous reflow dozens of times a second.
  const fitFrameRef = useRef<number | null>(null);
  const scheduleFit = useCallback(() => {
    if (fitFrameRef.current !== null) return;
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      fitPopoverToContent();
    });
  }, [fitPopoverToContent]);

  useEffect(scheduleFit);

  useEffect(() => {
    // Web fonts settle after the first paint and take the row heights with
    // them, without a render to hang a measurement off.
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (!disposed) scheduleFit();
    });
    return () => {
      disposed = true;
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
    };
  }, [scheduleFit]);

  // Hand the window back at its designed size when the recorder goes away: the
  // sign-in screen is authored for that height, not for whatever the recorder
  // last needed.
  useEffect(
    () => () => {
      void setPopoverHeight(POPOVER_BASE_WINDOW_HEIGHT).catch(() => {});
    },
    [],
  );


  return (
    <main
      ref={shellRef}
      className="popover-shell relative flex h-full min-h-0 flex-col overflow-hidden text-ink-text"
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="app-grid" />
      </div>

      {/* z-30 beats the content column and footer (both z-10). `relative
          z-*` makes this header its own stacking context, so the menu's
          z-50 is scoped to it — at an equal z-10 the later-in-DOM content
          painted over the open menu AND swallowed its clicks. */}
      <header
        data-tauri-drag-region
        className="relative z-30 flex flex-shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-3.5"
      >
        <button
          type="button"
          onClick={() => void open(CLIPY_HOME_URL).catch((err) => setError(String(err)))}
          title={LOCAL_EDITION ? "Open the Clipy Local project" : t("home.openSite")}
          aria-label={LOCAL_EDITION ? "Open the Clipy Local project" : t("home.openSite")}
          className="flex h-9 items-center justify-center rounded-xl px-1 text-ink-text transition-transform hover:scale-105"
        >
          <ClipyWordmark size={18} />
        </button>
        {phase === "idle" && captureSetupComplete ? (
          <div className="flex rounded-2xl bg-row p-1" role="tablist" aria-label={t("home.captureMode")}>
            {(
              [
                { value: "video", icon: "video", label: t("home.recordVideo") },
                { value: "screenshot", icon: "photo", label: t("home.takeScreenshot") },
              ] as const
            ).map((m) => (
              <button
                key={m.value}
                type="button"
                role="tab"
                aria-selected={captureMode === m.value}
                aria-label={m.label}
                title={m.label}
                onClick={() => setCaptureMode(m.value)}
                className={`flex h-9 w-12 items-center justify-center rounded-xl text-ink-text transition-all ${
                  captureMode === m.value ? "bg-surface shadow-pop" : "opacity-60 hover:opacity-100"
                }`}
              >
                <Icon name={m.icon} size={22} />
              </button>
            ))}
          </div>
        ) : (
          <span data-tauri-drag-region className="text-[12px] font-medium text-ink-secondary">{APP_NAME}</span>
        )}
        {false ? (
          <div className="flex rounded-2xl bg-row p-1" role="radiogroup" aria-label="Recording destination">
            {(
              [
                { value: "instant", label: "Cloud", hint: "Record → share link" },
                { value: "local", label: "Local AI", hint: `Save video and AREC on this ${deviceName}` },
              ] as Array<{ value: RecordingModeDto; label: string; hint: string }>
            ).map((mode) => (
              <button
                key={mode.value}
                type="button"
                role="radio"
                aria-checked={recordingMode === mode.value}
                title={mode.hint}
                onClick={() => {
                  if (mode.value === "instant" && !user) { onCloud?.(); return; }
                  setRecordingMode(mode.value);
                  activeRecordingModeRef.current = mode.value;
                }}
                className={`h-8 rounded-xl px-3 text-[12px] font-semibold transition-all ${
                  recordingMode === mode.value ? "bg-surface text-ink-text shadow-pop" : "text-ink-secondary hover:text-ink-text"
                }`}
              >
                {mode.label}
              </button>
            ))}
            <button
              type="button"
              aria-label="Where local recordings live"
              title="Where local recordings live"
              onClick={() => openSettings("preferences")}
              className="flex h-8 w-7 items-center justify-center rounded-xl text-ink-secondary hover:text-ink-text"
            >
              <Icon name="info" size={16} />
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-1">
        {!LOCAL_EDITION && user && phase === "idle" && (
          <AccountMenu
            user={user}
            isPro={isPro}
            onOpenRecordings={() => void handleOpenPreviousRecordings()}
            onEditAccount={() => void open("https://clipy.online/profile").catch((err) => setError(String(err)))}
            onSignOut={handleSignOut}
            onSwitchAccount={handleSwitchAccount}
          />
        )}
        <button
          type="button"
          onClick={dismissPanel}
          aria-label={t("home.close")}
          className="flex h-9 w-9 items-center justify-center rounded-full text-ink-text hover:bg-row"
        >
          <Icon name="close" size={22} />
        </button>
        </div>
      </header>

      <div ref={contentRef} className="relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto">

        {!LOCAL_EDITION && phase === "idle" && recoverableRecordings.length > 0 && !recoveryExpanded && (
          <div className="flex-shrink-0 px-3.5 pt-2.5">
            <button
              type="button"
              aria-expanded="false"
              onClick={() => setRecoveryExpanded(true)}
              className="group flex w-full items-center justify-between rounded-full border border-flash-500/35 bg-flash-500/10 px-4 py-2.5 text-left shadow-modal transition hover:border-flash-400/60 hover:bg-flash-500/15"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <svg className="shrink-0 text-flash-600" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                </svg>
                <span className="truncate text-sm font-semibold text-ink-text">
                  {t("home.recovery.pending")}
                </span>
              </span>
              <span className="ml-3 flex shrink-0 items-center gap-1 text-xs font-medium text-flash-600">
                {t("home.recovery.expand")}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </span>
            </button>
          </div>
        )}

        {!LOCAL_EDITION && phase === "idle" && recoverableRecordings.length > 0 && recoveryExpanded && (
          <div className="flex-shrink-0 px-3.5 pt-2.5">
            <section className="w-full space-y-2 rounded-lg border border-flash-500/35 bg-flash-500/10 p-4 shadow-modal">
              <div className="flex items-start gap-3">
                <svg className="mt-0.5 shrink-0 text-flash-600" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                </svg>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-text">{t("home.recovery.available")}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-secondary">
                    {t("home.recovery.body")}
                  </p>
                </div>
                <button
                  type="button"
                  aria-expanded="true"
                  onClick={() => setRecoveryExpanded(false)}
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-secondary transition hover:bg-row hover:text-ink-text"
                >
                  {t("home.recovery.collapse")}
                </button>
              </div>
              <div className="space-y-2 pt-1">
                {recoverableRecordings.map((recording) => (
                  <div key={recording.recording_id} className="flex items-center justify-between gap-3 rounded-md border border-subtle bg-row px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-ink-text">
                        {t("home.recovery.from", { age: formatRecoveryAge(recording.updated_at_ms, t) })}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-secondary">
                        {t("home.recovery.sizeExpiry", { size: formatBytes(recording.bytes), expiry: formatRecoveryExpiry(recording.expires_at_ms, t) })}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={recoveryBusyId !== null}
                        onClick={() => void handleRecoverRecording(recording)}
                        className="rounded-lg bg-flash-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-flash-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {recoveryBusyId === recording.recording_id ? t("home.recovery.recovering") : t("home.recovery.recover")}
                      </button>
                      <button
                        type="button"
                        disabled={recoveryBusyId !== null}
                        onClick={() => void handleDiscardRecording(recording)}
                        className="rounded-md border border-subtle px-3 py-1.5 text-xs font-medium text-ink-secondary transition hover:border-red-500/50 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {t("home.recovery.discard")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* A gated account gets the card in place of the picker. Scoped to the
            idle phase so an in-flight recording keeps its Stop control — the
            gate only ever blocks STARTING a new one. */}
        {!LOCAL_EDITION && gated && gate?.gate && (
          <ProGateCard
            level={gate.gate}
            quota={gate.quota}
            offer={gate.offer}
            fallbackMessage={gateMessage}
            onUpgrade={() => void handleUpgrade("gate")}
            onRecheck={() => void recheckGate()}
            rechecking={gateRechecking}
            stillGated={gateStillOn}
          />
        )}

        {/* After an update: one card, idle only, above the controls so the
            Start button stays exactly where it was. */}
        {phase === "idle" && captureSetupComplete && !gated && !startingRecording && activePanel === null && (
          <WhatsNewCard onError={setError} onLayoutChange={scheduleFit} />
        )}

        {phase === "idle" && captureSetupComplete && !gated && captureMode === "video" && (
          <div className="flex items-center gap-1 px-4 pb-2.5 pt-0.5">
            {/* Full width with an icon and a hint on each side, so the
                destination is obvious before Start. The sheet itself also
                changes look per mode (lib/recorderLook.ts): light for Cloud,
                dark for Local AI. */}
            {LOCAL_EDITION ? <LocalDestination /> : <div
              className="grid min-w-0 flex-1 grid-cols-2 gap-[3px] rounded-[14px] bg-row p-[3px]"
              role="radiogroup"
              aria-label={t("home.destination.label")}
            >
              {(
                [
                  { value: "instant", label: t("home.destination.cloud"), short: t("home.destination.cloudShort"), icon: "cloudUpload", hint: t("home.destination.cloudHint") },
                  { value: "local", label: t("home.destination.local"), short: t("home.destination.localShort", { device: deviceName }), icon: "laptop", hint: t("home.destination.localHint", { device: deviceName }) },
                ] as Array<{ value: RecordingModeDto; label: string; short: string; icon: "cloudUpload" | "laptop"; hint: string }>
              ).map((mode) => {
                const selected = recordingMode === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    title={mode.hint}
                    onClick={() => {
                      if (mode.value === "instant" && !user) { onCloud?.(); return; }
                      setRecordingMode(mode.value);
                      activeRecordingModeRef.current = mode.value;
                    }}
                    className={`flex min-w-0 items-center gap-2 rounded-[11px] px-2.5 py-1.5 text-left transition-all ${
                      selected ? "bg-surface text-ink-text shadow-pop" : "text-ink-secondary hover:text-ink-text"
                    }`}
                  >
                    <Icon name={mode.icon} size={17} className={`shrink-0 ${selected ? "text-flash-500" : ""}`} />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-bold leading-tight">{mode.label}</span>
                      <span className="block truncate text-[11px] font-medium leading-tight opacity-80">{mode.short}</span>
                    </span>
                  </button>
                );
              })}
            </div>}
            {/* Sits beside the toggle, not across the row: it explains the
                option next to it, and a lone icon at the far edge reads as
                unrelated to either mode. */}
            <button
              type="button"
              aria-label={t("home.destination.whatLocal")}
              title={t("home.destination.whatLocal")}
              onClick={() => void open(LOCAL_GUIDE_URL).catch((err) => setError(String(err)))}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-row hover:text-ink-text"
            >
              <Icon name="info" size={16} />
            </button>
            {/* A gear, not a second "i": this one goes to Preferences, and
                two identical info icons in one row say nothing about which
                does what. */}
            <button
              type="button"
              aria-label={t("home.destination.preferences")}
              title={t("home.destination.preferences")}
              onClick={() => openSettings("preferences")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-row hover:text-ink-text"
            >
              <Icon name="settings" size={16} />
            </button>
          </div>
        )}

        {phase === "idle" && !captureSetupComplete && !gated && captureMode === "screenshot" && (
          <div className="px-4 pb-3">
            <SetupCard onOpen={() => void showOnboardingWindow().catch((err) => setError(String(err)))} />
          </div>
        )}
        {phase === "idle" && captureSetupComplete && !gated && captureMode === "screenshot" && (
          <div className="flex flex-col gap-1.5 px-4 pb-2 pt-1">
            {([
              { value: "area", label: t("home.shot.area"), icon: "region" },
              { value: "display", label: t("home.shot.display"), icon: "monitor" },
            ] as const).map((option) => {
              const busy = shotBusy && shotMode === option.value;
              const caps = hotkeyKeycaps(shotKeys[option.value]);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => void takeScreenshot(option.value)}
                  disabled={shotBusy}
                  className="flex h-12 w-full items-center gap-3 rounded-2xl bg-row px-3.5 text-left transition-colors hover:bg-row-hover disabled:opacity-60"
                >
                  <Icon name={option.icon} size={20} className="shrink-0 text-ink-text" />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink-text">
                    {busy ? t("home.shot.capturing") : option.label}
                  </span>
                  {caps.length > 0 && (
                    <span className="flex shrink-0 items-center gap-0.5" aria-label={t("home.shot.shortcut", { keys: caps.join(" ") })}>
                      {caps.map((cap, i) => (
                        <kbd
                          key={`${cap}-${i}`}
                          className="inline-flex h-6 min-w-[22px] items-center justify-center rounded-md border border-strong bg-surface px-1 font-sans text-[11px] font-semibold text-ink-secondary"
                        >
                          {cap}
                        </kbd>
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
            {lastShot ? (
              <div className="rounded-xl bg-row px-3 py-2 text-[12px] text-ink-text">
                {lastShot.shareUrl ? (
                  <button type="button" onClick={() => void open(lastShot.shareUrl!).catch(() => {})} className="block w-full truncate text-left font-medium text-sheet-link hover:underline">
                    {lastShot.shareUrl}
                  </button>
                ) : (
                  <button type="button" onClick={() => void revealScreenshot(lastShot.path).catch(() => {})} className="font-medium text-sheet-link hover:underline">
                    {isWindows ? t("home.shot.showInFolder") : t("home.shot.showInFinder")}
                  </button>
                )}
              </div>
            ) : (
              (shotKeys.area || shotKeys.display) && (
                <p className="px-1 pt-0.5 text-[12px] leading-snug text-ink-secondary">
                  {t("home.shot.shortcutsHint")}
                </p>
              )
            )}
          </div>
        )}

        {phase === "idle" && !gated && captureMode === "video" && (
          <div className="flex flex-col gap-2 px-4 pb-2 pt-1">
            <div className="relative">
              <Row
                icon={sourceChoice === "camera" ? "camera" : sourceChoice === "window" ? "window" : sourceChoice === "area" ? "region" : "monitor"}
                label={sourceChoiceLabel(sourceChoice, t)}
                onClick={() => setRowMenu("source")}
                trailing={<Icon name="chevronDown" size={20} className="text-ink-secondary" />}
              />
              <Menu<SourceChoice>
                open={rowMenu === "source"}
                onClose={() => setRowMenu(null)}
                items={sourceChoiceItems(videoOptions.windowCapture, t)}
                value={sourceChoice}
                onSelect={(choice) => void chooseSource(choice)}
                onAction={(choice) => void chooseSource(choice, true)}
                ariaLabel={t("home.whatToRecord")}
              />
            </div>
            {sourceChoice !== "camera" && (
              <div className="flex items-center gap-2 px-1">
                <p className="min-w-0 flex-1 truncate text-[12px] text-ink-secondary">
                  {windowSelecting ? t("home.hoverWindow") : loadingSources && !sources ? t("home.loadingSources") : sourceSummary(sourceTab, pendingSelection, sources, t)}
                </p>
                {!windowSelecting && (sourceTab !== "display" || displays.length > 1) && (
                  <button type="button" onClick={() => openSourceChooser(sourceTab)} className="shrink-0 text-[12px] font-medium text-sheet-link hover:underline">
                    {t("home.change")}
                  </button>
                )}
              </div>
            )}
            {sourceChoice === "window" && !isWindows && (
              <div className="flex items-start gap-2 px-1">
                <Icon name={videoOptions.windowCapture === "window" ? "lock" : "region"} size={14} className="mt-[1px] shrink-0 text-ink-secondary" />
                <p className="min-w-0 flex-1 text-[12px] leading-snug text-ink-secondary">{windowSourceNote(videoOptions.windowCapture, t)}</p>
                <button type="button" onClick={() => openSettings("video")} className="shrink-0 text-[12px] font-medium text-sheet-link hover:underline">
                  {t("home.settings")}
                </button>
              </div>
            )}
            {sourceChoice === "window" && !windowSelecting && !loadingSources && windows.length === 0 && (
              <p className="px-1 text-[12px] text-ink-secondary">{t("home.noWindows")}</p>
            )}
            {sourcesError && <p className="px-1 text-[12px] text-flash-600">{sourcesError}</p>}

            {/* Screen access is asked for in a separate window; the source
                row stays so Camera only remains reachable without it. */}
            {!captureSetupComplete && <SetupCard onOpen={() => void showOnboardingWindow().catch((err) => setError(String(err)))} />}
            {captureSetupComplete && (<>
            <div className="relative">
              <Row
                icon={cameraArmed ? "camera" : "cameraOff"}
                label={cameraLabel}
                onClick={() => setRowMenu("camera")}
                title={t("home.camera.choose")}
                trailing={
                  cameraOnly ? (
                    <Icon name="chevronDown" size={20} className="text-ink-secondary" />
                  ) : (
                    <OnOffPill
                      on={webcamOn && !windowOnly}
                      disabled={windowOnly || webcamBusy || startingRecording || !recordingSettingsLoaded}
                      onClick={() => void toggleWebcam(!webcamOn)}
                      label={windowOnly ? windowOnlyCameraNote(t) : webcamOn ? t("home.camera.turnOff") : t("home.camera.turnOn")}
                    />
                  )
                }
              />
              <Menu<string>
                open={rowMenu === "camera"}
                onClose={() => setRowMenu(null)}
                items={[{ value: "", label: t("home.camera.systemDefault"), icon: "camera" }, ...webcamDevices.map((d) => ({ value: d.id, label: d.name }))]}
                value={webcamDeviceId ?? ""}
                onSelect={(v) => setWebcamDeviceId(v || (cameraOnly ? preferredWebcamDeviceId(webcamDevices, null) : null))}
                ariaLabel={t("home.camera.menuLabel")}
              />
            </div>
            {webcamError && <p className="px-1 text-[12px] leading-snug text-flash-600">{webcamError}</p>}

            <div className="relative">
              <Row
                icon={audioOptions.includeMic ? "mic" : "micOff"}
                label={micLabel}
                onClick={() => setRowMenu("mic")}
                title={t("home.mic.choose")}
                trailing={
                  <OnOffPill
                    on={audioOptions.includeMic}
                    onClick={() =>
                      setAudioOptions((prev) =>
                        prev.includeMic ? { ...prev, includeMic: false } : { ...prev, includeMic: true },
                      )
                    }
                    label={audioOptions.includeMic ? t("home.mic.turnOff") : t("home.mic.turnOn")}
                  />
                }
              >
                {audioOptions.includeMic && (
                  <div className="clipy-water" style={{ height: `${Math.round(8 + idleMicLevel * 92)}%` }} aria-hidden />
                )}
              </Row>
              <Menu<string>
                open={rowMenu === "mic"}
                onClose={() => setRowMenu(null)}
                items={[
                  { value: "", label: defaultAudioDevice ? t("home.mic.systemDefaultNamed", { name: defaultAudioDevice.name }) : t("home.mic.systemDefaultMenu"), icon: "mic" },
                  ...audioDevices.map((d) => ({ value: d.id, label: d.name })),
                ]}
                value={resolvedAudioOptions().micDeviceId ?? ""}
                onSelect={(v) => setAudioOptions((prev) => ({ ...prev, includeMic: true, micDeviceId: v || null }))}
                ariaLabel={t("home.mic.menuLabel")}
              />
            </div>
            {disconnectedMic && (
              <p className="px-1 text-[11px] leading-snug text-ink-secondary">{t("home.mic.disconnected", { name: disconnectedMic })}</p>
            )}
            {micCheckError && <p className="px-1 text-[12px] leading-snug text-flash-600">{micCheckError}</p>}

            <div className="pt-1">
              <PrimaryButton
                onClick={() => void handleConfirmAndStart()}
                disabled={(cameraOnly ? !webcamDeviceId : !pendingSelection) || micChecking || webcamBusy || startingRecording || localStartBlocked}
              >
                {startingRecording ? t("home.starting") : countdownSeconds > 0 ? t("home.startWithCountdown", { label: startLabel, seconds: countdownSeconds }) : startLabel}
              </PrimaryButton>
            </div>
            {(!localJob || localJob.stage === "recording") && (
              <p className="flex items-center justify-center gap-1.5 px-1 pt-2 text-[11px] text-ink-secondary">
                <Icon name={recordingMode === "local" ? "lock" : "cloudUpload"} size={12} className="shrink-0" />
                {recordingMode === "local"
                  ? t("home.videoStays", { device: deviceName })
                  : t("home.uploadsWhileRecording")}
              </p>
            )}
            {localJob && localJob.stage !== "recording" && (
              <div className="flex items-center gap-2 px-1 pt-2">
                {localJobActive ? (
                  <span
                    className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-subtle border-t-flash-500"
                    aria-hidden
                  />
                ) : (
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${localJob.stage === "failed" ? "bg-flash-500" : "bg-emerald-500"}`}
                    aria-hidden
                  />
                )}
                <p
                  className={`min-w-0 flex-1 truncate text-[12px] ${localJob.stage === "failed" ? "text-flash-600" : "text-ink-secondary"}`}
                  title={localJob.message}
                >
                  {localStageLabel(localJob, t)}
                </p>
                {localJob.stage === "ready" && (
                  <button
                    type="button"
                    onClick={() => void showLocalViewer(localJob.id)}
                    className="shrink-0 text-[12px] font-medium text-sheet-link hover:underline"
                  >
                    {t("home.open")}
                  </button>
                )}
              </div>
            )}
            </>)}
          </div>
        )}

        {phase === "countdown" && (
          <section className="flex flex-1 flex-col items-center justify-center gap-2 p-7 text-center">
            <p className="text-xs uppercase tracking-wider text-ink-secondary">
              {t("home.startingIn")}
            </p>
            <p className="text-5xl font-semibold tabular-nums">
              {countdownTick ?? countdownSeconds}…
            </p>
          </section>
        )}

        {(phase === "recording" || phase === "paused") && (
          <section className="recording-live flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-xs uppercase text-flash-600">
              {phase === "paused" ? t("home.paused") : t("home.recording")}
            </p>
            <p className="text-5xl font-semibold tabular-nums">
              {formatElapsed(state.elapsed_ms)}
            </p>
            <p className="text-[11px] text-ink-secondary">
              {t("home.written", { size: formatBytes(state.bytes_written) })}
            </p>
            {state.mic_silence_warning && (
              <p className="w-full rounded-lg border border-flash-500/30 bg-flash-500/10 px-3 py-2 text-left text-[11px] leading-relaxed text-flash-600">
                {state.mic_silence_warning}
              </p>
            )}
            {upload?.status === "failed" && (
              <p className="w-full rounded-md border border-flash-500/30 bg-flash-500/10 px-3 py-2 text-left text-[11px] leading-relaxed text-flash-600">
                {upload.error
                  ? t("home.upload.liveStoppedError", { error: upload.error })
                  : t("home.upload.liveStopped")}
              </p>
            )}
            <button
              type="button"
              onPointerDown={handleStopPointerDown}
              onKeyDown={handleStopKeyDown}
              disabled={busy}
              className="relative mt-1 inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-full bg-flash-500 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-flash-600 disabled:cursor-not-allowed disabled:opacity-70"
            >
              <span className="relative h-3 w-3 rounded-[3px] bg-white" aria-hidden />
              <span className="relative">
                {busy ? t("home.stopping") : t("home.stopRecording", { elapsed: formatElapsed(state.elapsed_ms) })}
              </span>
            </button>
            <p className="text-[11px] leading-relaxed text-ink-secondary">
              {t("home.dockHint")}
            </p>
          </section>
        )}

        {phase === "stopping" && (
          <section className="flex flex-1 flex-col items-center justify-center gap-3 p-7 text-center">
            <div className="processing-stack" aria-hidden>
              <span />
              <span />
              <span />
            </div>
            <p className="text-xs uppercase text-ink-secondary">
              {t("home.finalizing")}
            </p>
            <p className="text-sm text-ink-secondary">{t("home.wrappingUp")}</p>
          </section>
        )}

        {phase === "uploading" && (
          <section className="flex flex-1 flex-col items-center justify-center gap-3 p-7 text-center">
            <div
              className="upload-ring"
              style={{
                background: `conic-gradient(#ff4d29 ${uploadPercent * 3.6}deg, rgb(var(--rc-subtle)) 0deg)`,
              }}
              aria-hidden
            >
              <span>{uploadPercent}%</span>
            </div>
            <p className="text-xs uppercase text-ink-secondary">
              {isStudioFlow ? t("home.upload.preparingStudio") : uploadPercent >= 100 ? t("home.upload.finishing") : t("home.upload.uploading")}
            </p>
            <div className="upload-track h-1.5 w-48 overflow-hidden rounded-full bg-row-hover">
              <div
                className="upload-fill h-full transition-[width] duration-200"
                style={{ width: `${uploadPercent}%` }}
              />
            </div>
            <p className="text-xs tabular-nums text-ink-secondary">
              {isStudioFlow
                ? t("home.upload.studioOpens", { status: uploadStatusText })
                : uploadPercent >= 100
                  ? t("home.upload.creatingLink")
                  : uploadStatusText}
            </p>
            {upload?.status === "failed" && (
              <p className="w-full rounded-md border border-flash-500/30 bg-flash-500/10 px-3 py-2 text-left text-[11px] leading-relaxed text-flash-600">
                {upload.error
                  ? t("home.upload.failedNotLostError", { error: upload.error })
                  : t("home.upload.failedNotLost")}
              </p>
            )}
          </section>
        )}

        {showCancel && (
          <button
            type="button"
            onClick={handleCancel}
            className="pb-4 text-xs text-ink-secondary underline underline-offset-4 hover:text-ink-secondary"
          >
            {phase === "uploading" ? t("home.upload.cancelUpload") : t("home.upload.cancel")}
          </button>
        )}

        {error && (
          <p className="w-full min-w-0 px-4 pb-3 text-center text-[11px] text-flash-600 [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
      </div>

      {showUpgrade && !settingsOpen && (
        <UpgradeBanner onUpgrade={() => void handleUpgrade("banner")} />
      )}

      {phase === "idle" && captureSetupComplete && !gated && (
        <nav className="relative z-10 flex flex-shrink-0 items-start justify-around px-1 pb-2 pt-0" aria-label={t("home.strip.label")}>
          <StripButton icon="effects" label={t("home.strip.effects")} active={activePanel === "effects"} marked={false} onClick={() => setActivePanel((p) => (p === "effects" ? null : "effects"))} />
          <StripButton icon="notes" label={t("home.strip.notes")} active={false} marked={Boolean(notes.trim())} onClick={() => void showNotesWindow().catch((err) => setError(String(err)))} />
          {LOCAL_EDITION || recordingMode === "local" ? (
            <StripButton icon="library" label={t("home.strip.localLibrary")} active={activePanel === "library"} marked={false} onClick={() => setActivePanel((p) => (p === "library" ? null : "library"))} />
          ) : (
            <StripButton icon="library" label={t("home.strip.library")} active={false} marked={false} onClick={() => void handleOpenPreviousRecordings()} />
          )}
          {!LOCAL_EDITION && recordingMode !== "local" && (
            <div className="relative flex min-w-0 max-w-[84px] flex-1 basis-0">
              <StripButton
                icon={shareScope === "private" ? "lock" : shareScope === "restricted" ? "unlock" : "globe"}
                label={t(`home.access.${shareScope}`)}
                active={accessMenuOpen}
                marked={shareScope !== "public"}
                onClick={() => setAccessMenuOpen((open) => !open)}
              />
              <AccessPopover
                open={accessMenuOpen}
                scope={shareScope}
                onClose={() => setAccessMenuOpen(false)}
                onSelect={(scope) => {
                  setShareScope(scope);
                  setAccessMenuOpen(false);
                  // Restricted needs the domain list, which lives on its own sheet.
                  if (scope === "restricted") setActivePanel("public");
                }}
              />
            </div>
          )}
          <StripButton icon="more" label={t("home.strip.more")} active={settingsOpen} marked={recoverableRecordings.length > 0} onClick={() => openSettings("enhance")} />
        </nav>
      )}

      {!LOCAL_EDITION && ((forcedUpdate && recordingMode !== "local") || updatePrompt) && (
        <UpdateDialog
          info={
            updatePrompt ?? {
              available: true,
              currentVersion: forcedUpdate?.currentVersion ?? "",
              latestVersion: forcedUpdate?.latestVersion ?? null,
              notes: null,
            }
          }
          forced={Boolean(forcedUpdate) && recordingMode !== "local"}
          forcedMessage={forcedUpdate?.message ?? null}
          installing={installing}
          onInstall={handleInstallUpdate}
          onDismiss={() => setUpdatePrompt(null)}
          onLocal={() => { setUpdatePrompt(null); setRecordingMode("local"); }}
        />
      )}

      {toast && (
        // z-[60] keeps the toast above every in-window layer (picker and
        // settings sit at z-50) — "You're up to date" was getting buried.
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md bg-row px-3 py-1.5 text-center text-xs text-ink-text shadow-lg [overflow-wrap:anywhere]">
          {toast}
        </div>
      )}

      {!LOCAL_EDITION && state.phase === "idle" &&
        readyUpdateVersion &&
        !updateRestartDismissed &&
        !updatePrompt &&
        !forcedUpdate && (
          // `absolute` inside the popover shell, not `fixed`: the shell is
          // `relative` + `overflow-hidden`, so the card is laid out against
          // the panel and cannot escape it. As a viewport-fixed box pinned
          // with `right-4` and capped by `100vw`, it sat in a subtree the
          // shell then scaled with a zoom, its two `shrink-0` buttons
          // overflowed that cap, and the card spilled past the panel edge.
          // Pinned to both insets with the buttons on their own row, the
          // width comes from the panel and the long version string wraps.
          <div className="absolute bottom-3 left-3 right-3 z-[55] flex flex-col gap-2 rounded-xl border border-subtle bg-row p-3 shadow-lg">
            <p className="text-[11px] leading-snug text-ink-secondary [overflow-wrap:anywhere]">
              {t("home.updateReady", { version: readyUpdateVersion })}
            </p>
            <div className="flex items-center gap-2">
              {/* Same brand fill as `PrimaryButton`'s "Start recording"
                  (`bg-flash-500` / `hover:bg-flash-600`). It used to be the
                  pink-to-purple `bg-gradient-flash` with `shadow-glow` and a
                  hover lift, which matched nothing else in the recorder. */}
              <button
                type="button"
                onClick={() => {
                  restartToApplyUpdate().catch(async (err) => {
                    await refreshReadyUpdate();
                    showToast(String(err));
                  });
                }}
                className="min-w-0 flex-1 rounded-lg bg-flash-500 px-3 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-flash-600 focus:outline-none focus:ring-2 focus:ring-flash-500/60"
              >
                {t("home.restartNow")}
              </button>
              <button
                type="button"
                onClick={() => setUpdateRestartDismissed(true)}
                className="shrink-0 rounded-lg border border-subtle px-3 py-2 text-[12px] font-medium text-ink-secondary transition-colors hover:text-ink-text focus:outline-none focus:ring-2 focus:ring-white/20"
              >
                {t("home.later")}
              </button>
            </div>
          </div>
        )}

      {phase === "idle" && activePanel === "effects" && (
        <EffectsSheet
          onBack={() => setActivePanel(null)}
          cameraOn={webcamOn || cameraOnly}
          layout={webcamLayout}
          shape={webcamShape}
          size={webcamSize}
          mirrored={webcamMirrored}
          look={cameraLook}
          onLayout={setWebcamLayoutState}
          onShape={setWebcamShape}
          onSize={setWebcamSize}
          onMirror={(v) => void changeCameraMirror(v)}
          onLook={(look) => void changeCameraLook(look)}
        />
      )}
      {phase === "idle" && desktopChooser && (
        <SelectDesktopSheet
          displays={displays}
          thumbnails={thumbnails}
          selectedId={
            desktopChooser === "display"
              ? pendingSelection?.type === "display"
                ? pendingSelection.id
                : null
              : pendingSelection?.type === "area"
                ? pendingSelection.display_id
                : null
          }
          onBack={() => setDesktopChooser(null)}
          onSelect={(displayId) => {
            const purpose = desktopChooser;
            setDesktopChooser(null);
            if (purpose === "display") {
              selectSource({ type: "display", id: displayId });
              return;
            }
            launchAreaSelect(displayId);
          }}
        />
      )}
      {phase === "idle" && windowSelecting && (
        <div className="clipy-sheet">
          <ScreenHeader title={t("home.selectWindow")} onBack={() => void cancelWindowPicker().catch(() => {})} />
          <div className="px-4 pb-4 pt-1">
            <div className="rounded-2xl border border-subtle px-4 py-5 text-center">
              <p className="text-[15px] font-medium text-ink-text">{t("home.hoverToSelect")}</p>
              <p className="mt-2 text-[13px] text-ink-secondary">
                {tHome.rich("escToCancel", {
                  key: (chunks) => (
                    <kbd className="rounded-md bg-row px-1.5 py-0.5 font-sans text-[11px] font-semibold text-ink-text">{chunks}</kbd>
                  ),
                })}
              </p>
            </div>
          </div>
        </div>
      )}
      {phase === "idle" && (LOCAL_EDITION || recordingMode === "local") && activePanel === "library" && (
        <div className="clipy-sheet">
          <ScreenHeader title={t("home.strip.localLibrary")} onBack={() => setActivePanel(null)} />
          <div className="clipy-scroll px-4 pb-4 [&>section]:mx-0 [&>section]:mt-0">
            <LocalModePanel signedIn={LOCAL_EDITION || Boolean(user)} listAll />
          </div>
        </div>
      )}
      {!LOCAL_EDITION && phase === "idle" && recordingMode !== "local" && activePanel === "public" && (
        <div className="clipy-sheet">
          <ScreenHeader title={t("home.access.title")} onBack={() => setActivePanel(null)} />
          <div className="clipy-scroll px-4 pb-4">
            <PublicPanel
              scope={shareScope}
              domains={shareDomains}
              draft={domainDraft}
              onScopeChange={setShareScope}
              onDraftChange={setDomainDraft}
              onAddDomain={() => {
                const cleaned = normalizeShareDomain(domainDraft);
                if (!cleaned || shareDomains.includes(cleaned)) {
                  setDomainDraft("");
                  return;
                }
                setShareDomains((prev) => [...prev, cleaned].slice(0, MAX_SHARE_DOMAINS));
                setDomainDraft("");
              }}
              onRemoveDomain={(domain) => setShareDomains((prev) => prev.filter((d) => d !== domain))}
            />
          </div>
        </div>
      )}

      {settingsOpen && appSettings && (
        <SettingsSheet
          onBack={() => setSettingsOpen(false)}
          initialTab={settingsTab}
          user={user}
          version={null}
          showRecordingControls={appSettings.showRecordingControls}
          onShowRecordingControls={async (enabled) => {
            await updateShowRecordingControls(enabled);
            setAppSettings((prev) => (prev ? { ...prev, showRecordingControls: enabled } : prev));
          }}
          cameraLook={cameraLook}
          onCameraLook={(look) => void changeCameraLook(look)}
          webcamLayout={webcamLayout}
          webcamShape={webcamShape}
          webcamSize={webcamSize}
          onWebcamLayout={setWebcamLayoutState}
          onWebcamShape={setWebcamShape}
          onWebcamSize={setWebcamSize}
          persistWebcamPosition={appSettings.persistWebcamPosition}
          onPersistWebcamPosition={async (enabled) => {
            await updatePersistWebcamPosition(enabled);
            setAppSettings((prev) => (prev ? { ...prev, persistWebcamPosition: enabled } : prev));
          }}
          resolution={effectiveResolutionValue(videoOptions.maxHeight, isPro || recordingMode === "local")}
          resolutionOptions={RESOLUTION_OPTIONS.filter((option) => recordingMode === "local" || isPro || !option.pro || true)}
          isPro={isPro || recordingMode === "local"}
          onResolution={(maxHeight) => setVideoOptions((prev) => ({ ...prev, maxHeight }))}
          onUpgrade={() => void handleUpgrade("resolution")}
          onUpgradePlan={() => void handleUpgrade("settings")}
          accountIsPro={isPro}
          countdownSeconds={countdownSeconds}
          onCountdown={setCountdownSeconds}
          webcamMirrored={webcamMirrored}
          onMirror={(v) => void changeCameraMirror(v)}
          audioOptions={audioOptions}
          onAudioOptions={setAudioOptions}
          audioDevices={audioDevices}
          webcamDevices={webcamDevices}
          webcamDeviceId={webcamDeviceId}
          onWebcamDevice={(id) => setWebcamDeviceId(id || (cameraOnly ? preferredWebcamDeviceId(webcamDevices, null) : null))}
          onRefreshDevices={() => void refreshDevices()}
          devicesRefreshing={devicesRefreshing}
          videoOptions={videoOptions}
          onWindowCapture={(windowCapture) => setVideoOptions((prev) => ({ ...prev, windowCapture }))}
          cameraOnly={cameraOnly}
          hotkey={appSettings.hotkey}
          onHotkeyChange={async (hotkey) => {
            await updateHotkey(hotkey);
            setAppSettings((prev) => (prev ? { ...prev, hotkey } : prev));
          }}
          showInDock={appSettings.showInDock}
          onShowInDock={async (enabled) => {
            await updateShowInDock(enabled);
            setAppSettings((prev) => (prev ? { ...prev, showInDock: enabled } : prev));
          }}
          openLocalArec={appSettings.openLocalArec}
          onOpenLocalArec={async (enabled) => {
            await updateOpenLocalArec(enabled);
            setAppSettings((prev) => (prev ? { ...prev, openLocalArec: enabled } : prev));
          }}
          screenshotEditor={appSettings.screenshotEditor}
          onScreenshotEditor={async (enabled) => {
            await updateScreenshotEditor(enabled);
            setAppSettings((prev) => (prev ? { ...prev, screenshotEditor: enabled } : prev));
          }}
          onOpenRecordings={() => void handleOpenPreviousRecordings()}
          onSetupGuide={() => void showOnboardingWindow().catch((err) => setError(String(err)))}
          onCheckForUpdates={() => void handleCheckForUpdates()}
          onSignOut={() => void handleSignOut().catch(() => {})}
          onSignIn={() => { onCloud?.(); }}
          busy={busy}
        />
      )}
    </main>
  );
}







interface PublicPanelProps {
  scope: ShareScopeDto;
  domains: string[];
  draft: string;
  onScopeChange: (scope: ShareScopeDto) => void;
  onDraftChange: (value: string) => void;
  onAddDomain: () => void;
  onRemoveDomain: (domain: string) => void;
}

function PublicPanel({
  scope,
  domains,
  draft,
  onScopeChange,
  onDraftChange,
  onAddDomain,
  onRemoveDomain,
}: PublicPanelProps) {
  const t = useDesktopT();
  const options: Array<{ value: ShareScopeDto; label: string; icon: "globe" | "unlock" | "lock" }> = [
    { value: "public", label: t("home.access.anyone"), icon: "globe" },
    { value: "restricted", label: t("home.access.domains"), icon: "unlock" },
    { value: "private", label: t("home.access.onlyMe"), icon: "lock" },
  ];
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={t("home.access.title")} className="overflow-hidden rounded-2xl bg-row">
        {options.map((option) => {
          const selected = scope === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onScopeChange(option.value)}
              className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${
                selected ? "bg-sheet-link-soft text-sheet-link" : "text-ink-text hover:bg-row-hover"
              }`}
            >
              <Icon name={option.icon} size={24} />
              <span className="min-w-0 flex-1 truncate text-[16px] font-medium">{option.label}</span>
              {selected && (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#2f5fd0] text-white">
                  <Icon name="check" size={14} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {scope === "restricted" && (
        <div className="space-y-2">
          <SectionTitle>{t("home.access.allowedDomains")}</SectionTitle>
          <div className="flex items-center gap-2 rounded-2xl bg-row px-4 py-2">
            <span className="text-[16px] text-ink-secondary">@</span>
            <input
              type="text"
              value={draft}
              placeholder="company.com"
              aria-label={t("home.access.emailDomain")}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAddDomain();
                }
              }}
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] text-ink-text placeholder:text-ink-muted focus:outline-none"
            />
            <button
              type="button"
              onClick={onAddDomain}
              disabled={domains.length >= MAX_SHARE_DOMAINS || !draft.trim()}
              className="shrink-0 rounded-full bg-ink-text px-3.5 py-1.5 text-[13px] font-semibold text-white transition-opacity disabled:opacity-30"
            >
              {t("home.access.add")}
            </button>
          </div>
          {domains.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1 pt-1">
              {domains.map((domain) => (
                <button
                  key={domain}
                  type="button"
                  onClick={() => onRemoveDomain(domain)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-row px-3 py-1.5 text-[13px] font-medium text-ink-text transition-colors hover:bg-row-hover"
                >
                  {domain}
                  <span aria-hidden className="text-ink-secondary">×</span>
                  <span className="sr-only">{t("home.access.remove", { domain })}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}






interface UpdateDialogProps {
  info: UpdateInfo;
  installing: boolean;
  /** Server policy gate: this version can't record anymore. No "Later". */
  forced?: boolean;
  forcedMessage?: string | null;
  onInstall: () => void;
  onDismiss: () => void;
  onLocal: () => void;
}

function UpdateDialog({
  info,
  installing,
  forced = false,
  forcedMessage = null,
  onInstall,
  onDismiss,
  onLocal,
}: UpdateDialogProps) {
  const t = useTranslations("desktop.home.update");
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center popover-radius bg-ink-950/30 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-modal">
        <h2 className="text-[19px] font-bold tracking-tight text-ink-text">
          {forced ? t("required") : t("available")}
        </h2>
        <p className="mt-2 text-[13px] leading-snug text-ink-secondary">
          {forced ? (
            forcedMessage ??
            t("outOfDate", { version: info.currentVersion })
          ) : (
            t.rich("ready", {
              latest: info.latestVersion ?? t("unknown"),
              current: info.currentVersion,
              strong: (chunks) => <span className="font-medium text-ink-text">{chunks}</span>,
            })
          )}
        </p>
        {info.notes && (
          <pre className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-xl bg-row p-3 text-[12px] leading-relaxed text-ink-text">
            {info.notes}
          </pre>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          {forced && (
            <button type="button" onClick={onLocal} disabled={installing}
              className="rounded-xl px-3 py-2 text-[14px] font-medium text-ink-secondary hover:bg-row hover:text-ink-text disabled:opacity-40">
              {t("recordLocally")}
            </button>
          )}
          {!forced && (
            <button
              type="button"
              onClick={onDismiss}
              disabled={installing}
              className="rounded-xl px-3 py-2 text-[14px] font-medium text-ink-secondary hover:bg-row hover:text-ink-text disabled:opacity-50"
            >
              {t("later")}
            </button>
          )}
          <button
            type="button"
            onClick={onInstall}
            disabled={installing}
            // Pin a min-width so the button doesn't shrink when the
            // label changes from "Install & Relaunch" to "Installing…"
            // — width animation under `transition-all` left a ghost-text
            // artifact during the swap. Animate colours only.
            className="inline-flex min-w-[148px] items-center justify-center gap-1.5 rounded-xl bg-flash-500 px-4 py-2 text-[14px] font-semibold text-white transition-colors hover:bg-flash-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {installing && (
              <span
                aria-hidden
                className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-white/40 border-t-white"
              />
            )}
            {installing ? t("installing") : t("install")}
          </button>
        </div>
      </div>
    </div>
  );
}

