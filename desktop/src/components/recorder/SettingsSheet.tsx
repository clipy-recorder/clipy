import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { useTranslations } from "use-intl";
import {
  getClipboardHistoryEnabled,
  getClipboardKeyClash,
  getLoginItemStatus,
  getRecorderShortcuts,
  setClipboardHistoryEnabled,
  setLaunchAtLogin,
  type AudioDeviceDto,
  type AudioOptionsDto,
  type CameraLookDto,
  type DesktopUser,
  type LoginItemStatus,
  type RecorderShortcutDto,
  type VideoOptionsDto,
  type WebcamDeviceDto,
  type WebcamLayoutDto,
  type WebcamShapeDto,
  type WebcamSizeDto,
  type WindowCaptureModeDto,
} from "../../lib/bridge";
import { formatHotkey } from "../../lib/hotkey";
import { showWhatsNewWindow } from "../../lib/whatsNew";
import { deviceName, isWindows } from "../../lib/platform";
import { LOCALES, LOCALE_INFO, useLanguageChoice, type LanguageChoice } from "../../lib/i18n";
import LocalModePanel from "../LocalModePanel";
import { PlanRow } from "../UpgradePrompt";
import { LOCAL_EDITION } from "../../lib/edition";
import { LocalPreferences } from "../../edition-local/LocalPreferences";
import { CameraLookRows } from "./CameraLookRows";
import { CameraViewRows } from "./CameraViewRows";
import { ShortcutsEditor } from "./ShortcutsEditor";
import { TalkSettings } from "./TalkSettings";
import { WindowCaptureChoice } from "./WindowCaptureChoice";
import { Icon, InlineSelect, PrimaryButton, ScreenHeader, SectionTitle, SettingRow, Switch, Tabs } from "./ui";

type SettingsTab = "enhance" | "video" | "preferences";

export interface SettingsSheetProps {
  onBack: () => void;
  initialTab?: SettingsTab;
  user: DesktopUser | null;
  version: string | null;
  // Enhance
  cameraLook: CameraLookDto;
  onCameraLook: (look: CameraLookDto) => void;
  // Video & audio
  resolution: number;
  resolutionOptions: Array<{ value: number; label: string; pro: boolean }>;
  isPro: boolean;
  onResolution: (maxHeight: number | null) => void;
  onUpgrade: () => void;
  /** The account's real plan; `isPro` above is the resolution gate, which
   *  local recordings also lift. */
  accountIsPro: boolean;
  onUpgradePlan: () => void;
  countdownSeconds: number;
  onCountdown: (seconds: number) => void;
  webcamMirrored: boolean;
  onMirror: (mirrored: boolean) => void;
  webcamLayout: WebcamLayoutDto;
  webcamShape: WebcamShapeDto;
  webcamSize: WebcamSizeDto;
  onWebcamLayout: (layout: WebcamLayoutDto) => void;
  onWebcamShape: (shape: WebcamShapeDto) => void;
  onWebcamSize: (size: WebcamSizeDto) => void;
  persistWebcamPosition: boolean;
  onPersistWebcamPosition: (enabled: boolean) => Promise<void>;
  audioOptions: AudioOptionsDto;
  onAudioOptions: (next: AudioOptionsDto) => void;
  audioDevices: AudioDeviceDto[];
  webcamDevices: WebcamDeviceDto[];
  webcamDeviceId: string | null;
  onWebcamDevice: (id: string | null) => void;
  onRefreshDevices: () => void;
  devicesRefreshing: boolean;
  videoOptions: VideoOptionsDto;
  onWindowCapture: (mode: WindowCaptureModeDto) => void;
  cameraOnly: boolean;
  // Preferences
  showRecordingControls: boolean;
  onShowRecordingControls: (enabled: boolean) => Promise<void>;
  hotkey: string;
  onHotkeyChange: (hotkey: string) => Promise<void>;
  showInDock: boolean;
  onShowInDock: (enabled: boolean) => Promise<void>;
  openLocalArec: boolean;
  onOpenLocalArec: (enabled: boolean) => Promise<void>;
  screenshotEditor: boolean;
  onScreenshotEditor: (enabled: boolean) => Promise<void>;
  onOpenRecordings: () => void;
  onSetupGuide: () => void;
  onCheckForUpdates: () => void;
  onSignOut: () => void;
  onSignIn: () => void;
  busy: boolean;
}

/**
 * Settings in three tabs. Everything here already existed in the
 * app; the sheet is the reorganisation, plus the shortcut editor and the
 * local-recordings home.
 */
/** Same as RETENTION_DAYS in LocalModePanel: how long unkept local recordings stay. */
const LOCAL_RETENTION_DAYS = 14;

export function SettingsSheet(p: SettingsSheetProps) {
  const t = useTranslations("desktop.settings");
  const language = useLanguageChoice();
  const [tab, setTab] = useState<SettingsTab>(p.initialTab ?? "enhance");
  const [loginItem, setLoginItem] = useState<LoginItemStatus | null>(null);
  const [loginItemError, setLoginItemError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [clipboardHistory, setClipboardHistory] = useState<boolean | null>(null);
  const [clipboardError, setClipboardError] = useState<string | null>(null);

  // The subtitle names the key that actually opens the picker right now.
  const [clipboardKey, setClipboardKey] = useState<RecorderShortcutDto | null>(null);
  const [clipboardClash, setClipboardClash] = useState<string | null>(null);
  const onShortcutsChange = useCallback((rows: RecorderShortcutDto[]) => {
    setClipboardKey(rows.find((row) => row.action === "clipboard_history") ?? null);
    getClipboardKeyClash().then(setClipboardClash).catch(() => setClipboardClash(null));
  }, []);
  const refreshClipboardKey = useCallback(() => {
    getRecorderShortcuts().then(onShortcutsChange).catch(() => {});
  }, [onShortcutsChange]);

  useEffect(() => {
    getClipboardHistoryEnabled().then(setClipboardHistory).catch((err) => setClipboardError(String(err)));
    refreshClipboardKey();
  }, [refreshClipboardKey]);

  const toggleClipboardHistory = async (enabled: boolean) => {
    setSaving("clipboard");
    setClipboardError(null);
    try {
      await setClipboardHistoryEnabled(enabled);
      setClipboardHistory(enabled);
    } catch (err) {
      setClipboardError(String(err));
      // A partial failure (off, but the file could not be deleted) still
      // changed the state, so show what it is now.
      getClipboardHistoryEnabled().then(setClipboardHistory).catch(() => {});
    } finally {
      setSaving(null);
      refreshClipboardKey();
    }
  };

  const clipboardSubtitle = !clipboardHistory
    ? t("clipboardSubtitle.off", { device: deviceName })
    : clipboardKey?.registered
      ? t("clipboardSubtitle.registered", { hotkey: formatHotkey(clipboardKey.hotkey), device: deviceName })
      : clipboardKey?.hotkey
        ? t("clipboardSubtitle.unavailable", { hotkey: formatHotkey(clipboardKey.hotkey) })
        : t("clipboardSubtitle.noKey");

  useEffect(() => {
    if (isWindows) return;
    let active = true;
    const refresh = () => {
      getLoginItemStatus()
        .then((status) => {
          if (active) setLoginItem(status);
        })
        .catch((err) => {
          if (active) setLoginItemError(String(err));
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const guarded = async (key: string, action: () => Promise<void>) => {
    setSaving(key);
    try {
      await action();
    } catch (err) {
      setLoginItemError(String(err));
    } finally {
      setSaving(null);
    }
  };

  const initials = (p.user?.name ?? p.user?.email ?? "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("") || "·";

  return (
    <div className="clipy-sheet">
      <ScreenHeader title={t("title")} onBack={p.onBack} />
      <Tabs
        tabs={[
          { value: "enhance", label: t("tabs.enhance") },
          { value: "video", label: t("tabs.video") },
          { value: "preferences", label: t("tabs.preferences") },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="clipy-scroll">
        {tab === "enhance" && (
          <div key="enhance" className="clipy-fade-in">
            {/* This switch was decorative: permanently on, disabled, wired to
                nothing, under the claim that noise suppression "runs on every
                recording". None ran — the Mac recorder had no noise processing
                at all — so the app was showing a filter as on that did not
                exist. It is now the real control, and like every filter here it
                is off until the user turns it on. */}
            <SettingRow
              icon="noise"
              title={t("reduceNoise.title")}
              subtitle={
                p.audioOptions.includeMic
                  ? t("reduceNoise.subtitle")
                  : t("reduceNoise.needsMic")
              }
              trailing={
                <Switch
                  checked={p.audioOptions.includeMic && p.audioOptions.reduceNoise}
                  disabled={!p.audioOptions.includeMic}
                  onChange={(v) => p.onAudioOptions({ ...p.audioOptions, reduceNoise: v })}
                  label={t("reduceNoise.title")}
                />
              }
            />
            <CameraLookRows look={p.cameraLook} onChange={p.onCameraLook} />
            <SettingRow
              icon="effects"
              title={t("cameraEffects.title")}
              subtitle={t("cameraEffects.subtitle")}
            />
          </div>
        )}

        {tab === "video" && (
          <div key="video" className="clipy-fade-in">
            <SettingRow
              title={t("resolution.title")}
              subtitle={p.isPro ? t("resolution.pro") : t("resolution.free")}
              trailing={
                <InlineSelect<string>
                  ariaLabel={t("resolution.title")}
                  value={String(p.resolution)}
                  onChange={(v) => {
                    const option = p.resolutionOptions.find((o) => String(o.value) === v);
                    if (!option) return;
                    if (option.pro && !p.isPro) {
                      p.onUpgrade();
                      return;
                    }
                    p.onResolution(option.value === 0 ? null : option.value);
                  }}
                  items={p.resolutionOptions.map((o) => ({ value: String(o.value), label: o.pro && !p.isPro ? t("resolution.proSuffix", { label: o.label }) : o.label }))}
                />
              }
            />
            {/* The Windows app always records a window as a fixed area. */}
            {!isWindows && (
              <SettingRow
                title={t("windowRecording.title")}
                subtitle={t("windowRecording.subtitle")}
              >
                <WindowCaptureChoice value={p.videoOptions.windowCapture} onChange={p.onWindowCapture} />
              </SettingRow>
            )}
            <SettingRow
              title={t("countdown.title")}
              subtitle={t("countdown.subtitle")}
              trailing={
                <InlineSelect<string>
                  ariaLabel={t("countdown.label")}
                  value={String(p.countdownSeconds)}
                  onChange={(v) => p.onCountdown(Number(v))}
                  items={[
                    { value: "0", label: t("countdown.off") },
                    ...[3, 5, 10].map((seconds) => ({ value: String(seconds), label: t("countdown.seconds", { seconds }) })),
                  ]}
                />
              }
            />
            <CameraViewRows
              layout={p.webcamLayout}
              shape={p.webcamShape}
              size={p.webcamSize}
              onLayout={p.onWebcamLayout}
              onShape={p.onWebcamShape}
              onSize={p.onWebcamSize}
            />
            <SettingRow
              title={t("flip.title")}
              subtitle={t("flip.subtitle")}
              trailing={<Switch checked={p.webcamMirrored} onChange={p.onMirror} label={t("flip.title")} />}
            />
            <SettingRow
              title={t("persistBubble.title")}
              subtitle={t("persistBubble.subtitle")}
              trailing={
                <Switch
                  checked={p.persistWebcamPosition}
                  disabled={saving === "bubble-position"}
                  onChange={(v) => void guarded("bubble-position", () => p.onPersistWebcamPosition(v))}
                  label={t("persistBubble.title")}
                />
              }
            />
            <SettingRow
              title={t("systemAudio.title")}
              subtitle={p.cameraOnly ? t("systemAudio.cameraOnly") : t("systemAudio.subtitle")}
              trailing={
                <Switch
                  checked={!p.cameraOnly && p.audioOptions.includeSystemAudio}
                  disabled={p.cameraOnly}
                  onChange={(v) => p.onAudioOptions({ ...p.audioOptions, includeSystemAudio: v })}
                  label={t("systemAudio.title")}
                />
              }
            />
            <SettingRow
              title={t("camera.title")}
              subtitle={p.webcamDevices.length === 0 ? t("camera.none") : t("camera.found", { count: p.webcamDevices.length })}
              trailing={
                <InlineSelect<string>
                  ariaLabel={t("camera.title")}
                  value={p.webcamDeviceId ?? ""}
                  onChange={(v) => p.onWebcamDevice(v || null)}
                  items={[{ value: "", label: t("systemDefault") }, ...p.webcamDevices.map((d) => ({ value: d.id, label: d.name }))]}
                />
              }
            />
            <SettingRow
              title={t("microphone.title")}
              trailing={
                <InlineSelect<string>
                  ariaLabel={t("microphone.title")}
                  value={p.audioOptions.includeMic ? p.audioOptions.micDeviceId ?? "" : "off"}
                  onChange={(v) =>
                    p.onAudioOptions(
                      v === "off"
                        ? { ...p.audioOptions, includeMic: false, micDeviceId: null }
                        : { ...p.audioOptions, includeMic: true, micDeviceId: v || null },
                    )
                  }
                  items={[
                    { value: "", label: t("systemDefault") },
                    ...p.audioDevices.map((d) => ({ value: d.id, label: d.name })),
                    { value: "off", label: t("microphone.none") },
                  ]}
                />
              }
            >
              <button type="button" onClick={p.onRefreshDevices} disabled={p.devicesRefreshing} className="text-[12px] font-medium text-sheet-link hover:underline disabled:opacity-50">
                {p.devicesRefreshing ? t("refreshing") : t("refreshDevices")}
              </button>
            </SettingRow>
            <SettingRow
              title={t("setup.title")}
              subtitle={t("setup.subtitle", { os: isWindows ? "Windows" : "macOS" })}
            >
              <button type="button" onClick={p.onSetupGuide} className="rounded-lg bg-row px-2.5 py-1 text-[12px] font-medium text-ink-text hover:bg-row-hover">
                {t("setup.open")}
              </button>
            </SettingRow>
          </div>
        )}

        {tab === "preferences" && (
          <div key="preferences" className="clipy-fade-in pb-4">
            {!LOCAL_EDITION && <div className="flex items-center gap-4 px-5 pt-5">
              {/* Pro looks like the website's avatar: a brand-gradient ring and a
                  crown dot (components/ProfileAvatar.tsx). */}
              <span className="relative inline-flex shrink-0" title={p.user && p.accountIsPro ? "Clipy Pro" : undefined /* product name */}>
                {p.user && p.accountIsPro && <span aria-hidden className="absolute -inset-1 rounded-full bg-gradient-flash" />}
                {p.user?.avatar_url ? (
                  <img src={p.user.avatar_url} alt="" className={`h-[64px] w-[64px] shrink-0 rounded-full object-cover ${p.user && p.accountIsPro ? "relative ring-2 ring-sheet-bg" : ""}`} />
                ) : (
                  <span className={`flex h-[64px] w-[64px] shrink-0 items-center justify-center rounded-full bg-flash-500 text-[22px] font-bold text-white ${p.user && p.accountIsPro ? "relative ring-2 ring-sheet-bg" : ""}`}>{initials}</span>
                )}
                {p.user && p.accountIsPro && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-spark-500 text-ink-text ring-2 ring-sheet-bg">
                    <Icon name="crown" size={13} />
                  </span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[16px] font-semibold text-ink-text">{p.user?.name ?? p.user?.email ?? t("notSignedIn")}</div>
                <div className="truncate text-[14px] text-ink-secondary">{p.user ? p.user.email : t("signInToCloud")}</div>
              </div>
              {/* Sign out sits beside the account it signs out of, not only at
                  the foot of this long tab where QA teams could not find it. */}
              {p.user && (
                <button
                  type="button"
                  onClick={p.onSignOut}
                  disabled={p.busy}
                  className="shrink-0 rounded-full border border-strong px-3.5 py-1.5 text-[13px] font-semibold text-ink-text transition-colors hover:border-flash-500/50 hover:bg-flash-500/10 hover:text-flash-600 disabled:opacity-50"
                >
                  {t("signOut")}
                </button>
              )}
            </div>}
            {!LOCAL_EDITION && p.user && !p.accountIsPro && <PlanRow onUpgrade={p.onUpgradePlan} />}

            <SectionTitle>{t("sections.language")}</SectionTitle>
            <SettingRow
              title={t("language.title")}
              subtitle={t("language.subtitle", { os: isWindows ? "Windows" : "macOS" })}
              trailing={
                <InlineSelect<string>
                  ariaLabel={t("language.label")}
                  value={language.choice}
                  onChange={(v) => language.setChoice(v as LanguageChoice)}
                  items={[
                    { value: "system", label: t("systemDefault") },
                    // Each language in its own name, so anyone can find theirs.
                    ...LOCALES.map((locale) => ({ value: locale, label: LOCALE_INFO[locale].nativeName })),
                  ]}
                />
              }
            />

            <SectionTitle>{t("sections.system")}</SectionTitle>
            {!isWindows && (
              <SettingRow
                title={t("launchAtLogin.title")}
                subtitle={
                  loginItem === "requiresApproval"
                    ? t("launchAtLogin.approval")
                    : loginItem === "unavailable"
                      ? t("launchAtLogin.unavailable")
                      : t("launchAtLogin.subtitle")
                }
                trailing={
                  <Switch
                    checked={loginItem === "enabled" || loginItem === "requiresApproval"}
                    disabled={loginItem === null || loginItem === "unavailable" || saving === "login"}
                    onChange={(v) => void guarded("login", async () => setLoginItem(await setLaunchAtLogin(v)))}
                    label={t("launchAtLogin.title")}
                  />
                }
              />
            )}
            <SettingRow
              title={t("showInDock.title")}
              subtitle={t("showInDock.subtitle")}
              trailing={<Switch checked={p.showInDock} disabled={saving === "dock"} onChange={(v) => void guarded("dock", () => p.onShowInDock(v))} label={t("showInDock.title")} />}
            />
            {loginItemError && <p className="px-5 pt-2 text-[12px] text-flash-600">{loginItemError}</p>}

            <SectionTitle>{t("sections.recording")}</SectionTitle>
            <SettingRow
              title={t("recordingControls.title")}
              subtitle={t("recordingControls.subtitle")}
              trailing={
                <Switch
                  checked={p.showRecordingControls}
                  disabled={saving === "controls"}
                  onChange={(v) => void guarded("controls", () => p.onShowRecordingControls(v))}
                  label={t("recordingControls.title")}
                />
              }
            />

            <SectionTitle>{t("sections.screenshots")}</SectionTitle>
            <SettingRow
              title={t("annotate.title")}
              subtitle={t("annotate.subtitle")}
              trailing={
                <Switch
                  checked={p.screenshotEditor}
                  disabled={saving === "screenshot-editor"}
                  onChange={(v) => void guarded("screenshot-editor", () => p.onScreenshotEditor(v))}
                  label={t("annotate.title")}
                />
              }
            />

            <SectionTitle>{t("sections.clipboard")}</SectionTitle>
            <SettingRow
              title={t("clipboardHistory")}
              subtitle={clipboardSubtitle}
              trailing={
                <Switch
                  checked={clipboardHistory ?? false}
                  disabled={clipboardHistory === null || saving === "clipboard"}
                  onChange={(v) => void toggleClipboardHistory(v)}
                  label={t("clipboardHistory")}
                />
              }
            />
            {clipboardHistory && clipboardKey?.hotkey && clipboardClash && (
              <p className="px-5 pt-2 text-[12px] leading-snug text-flash-600">
                {t("clipboardClash", { app: clipboardClash, hotkey: formatHotkey(clipboardKey.hotkey) })}
              </p>
            )}
            {clipboardError && <p className="px-5 pt-2 text-[12px] text-flash-600">{clipboardError}</p>}

            <SectionTitle>{t("sections.shortcuts")}</SectionTitle>
            <p className="px-5 pb-1 text-[12px] leading-snug text-ink-secondary">{t("shortcutsHint")}</p>
            <ShortcutsEditor stopHotkey={p.hotkey} onStopHotkeyChange={p.onHotkeyChange} onChange={onShortcutsChange} />
            <TalkSettings />

            <SectionTitle>{t("sections.recordingsOnDevice", { device: deviceName })}</SectionTitle>
            <div className="flex gap-3 px-5 pb-2">
              <span className="mt-0.5 shrink-0 text-ink-secondary">
                <Icon name="info" size={18} />
              </span>
              <p className="text-[12px] leading-snug text-ink-secondary">
                {LOCAL_EDITION
                  ? `Local recordings and their AREC context stay in Clipy's folder on this ${deviceName} and clear after ${LOCAL_RETENTION_DAYS} days unless kept.`
                  : t("localInfo", { device: deviceName, days: LOCAL_RETENTION_DAYS })}
                {!LOCAL_EDITION && isWindows && ` ${t("localInfoWindows")}`}
              </p>
            </div>
            <SettingRow
              title={t("openArec.title")}
              subtitle={t("openArec.subtitle")}
              trailing={
                <Switch
                  checked={p.openLocalArec}
                  disabled={saving === "arec"}
                  onChange={(v) => void guarded("arec", () => p.onOpenLocalArec(v))}
                  label={t("openArec.title")}
                />
              }
            />
            <div className="[&>section]:mx-5 [&>section]:mt-0">
              <LocalModePanel signedIn={LOCAL_EDITION || Boolean(p.user)} />
            </div>

            {LOCAL_EDITION ? <LocalPreferences version={p.version} onWhatsNew={() => void showWhatsNewWindow().catch(() => {})} /> : <SectionTitle>{t("sections.clipy")}</SectionTitle>}
            {!LOCAL_EDITION && <LinkRow label={t("links.recordings")} hint={t("links.recordingsHint")} onClick={p.onOpenRecordings} />}
            {!LOCAL_EDITION && <LinkRow label={t("links.whatsNew")} hint={t("links.whatsNewHint")} onClick={() => void showWhatsNewWindow().catch(() => {})} />}
            {!LOCAL_EDITION && <LinkRow label={t("links.updates")} hint={p.version ? t("links.version", { version: p.version }) : t("links.latest")} onClick={p.onCheckForUpdates} />}
            {!LOCAL_EDITION && <LinkRow label={t("links.privacy")} hint={t("links.privacyHint")} onClick={() => void open("https://clipy.online/privacy").catch(() => {})} />}

            {!LOCAL_EDITION && <div className="flex gap-3 px-5 pt-5">
              {p.user ? (
                <>
                  <button type="button" onClick={p.onSignOut} disabled={p.busy} className="flex-1 rounded-full border border-strong py-2.5 text-[15px] font-semibold text-ink-text hover:bg-row disabled:opacity-50">
                    {t("signOut")}
                  </button>
                  <button type="button" onClick={() => void open("https://clipy.online/profile").catch(() => {})} className="flex-1 rounded-full bg-flash-500 py-2.5 text-[15px] font-semibold text-white hover:bg-flash-600">
                    {t("editAccount")}
                  </button>
                </>
              ) : (
                <div className="flex-1">
                  <PrimaryButton onClick={p.onSignIn} disabled={p.busy}>{t("signIn")}</PrimaryButton>
                </div>
              )}
            </div>}
          </div>
        )}
      </div>
    </div>
  );
}

function LinkRow({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 border-b border-subtle px-5 py-3 text-left hover:bg-row">
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-ink-text">{label}</span>
        <span className="block text-[12px] text-ink-secondary">{hint}</span>
      </span>
      <Icon name="external" size={18} className="text-ink-secondary" />
    </button>
  );
}
