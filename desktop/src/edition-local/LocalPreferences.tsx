import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { Icon, InlineSelect, Notice, SectionTitle, SettingRow } from "../components/recorder/ui";
import { LOCAL_PROJECT_URL } from "../lib/edition";
import { useLanguageChoice } from "../lib/i18n";
import { useDesktopT } from "../lib/messages";
import { deviceName, isWindows } from "../lib/platform";
import { formatBytes } from "../vendor/i18n/format";
import {
  downloadLocalModel,
  getLocalSettings,
  localModelStatus,
  onLocalModelProgress,
  saveLocalSettings,
  type KeyUpdate,
  type LocalModelId,
  type LocalModelProgressDto,
  type LocalModelStatusDto,
  type LocalSettingsDto,
  type ModelPreset,
  type TranscriptionKind,
} from "./settings-api";

/**
 * Settings → Preferences in the local edition, in place of the official
 * app's account, library, updates and sign-in rows: who picks spoken cues,
 * how recordings are transcribed, and where this build comes from.
 *
 * API keys are typed into password fields, sent once to Rust and never read
 * back: after a save the field shows "Saved" with a Replace button.
 */

const FULL_CLIPY_URL = "https://clipy.online/download";

interface ProviderPreset {
  value: ModelPreset;
  label: string;
  /** Needs a key to run. */
  key: "required" | "optional" | "none";
  /** Shown as the model field's placeholder; empty means the user must type one. */
  defaultModel: string;
  /** Shown as the URL field's placeholder; empty means the user must type one. */
  defaultUrl: string;
  /** The URL field is offered (always for custom, to point at another host for the rest). */
  url: boolean;
}

// Same presets and defaults as the CLI (packages/config/src/presets.ts),
// so the app and `clipy-local` agree.
const PROVIDERS: ProviderPreset[] = [
  { value: "none", label: "Rules only", key: "none", defaultModel: "", defaultUrl: "", url: false },
  { value: "openrouter", label: "OpenRouter", key: "required", defaultModel: "google/gemini-3.1-flash-lite", defaultUrl: "https://openrouter.ai/api/v1", url: false },
  { value: "openai", label: "OpenAI", key: "required", defaultModel: "gpt-4.1-mini", defaultUrl: "https://api.openai.com/v1", url: false },
  { value: "gemini", label: "Gemini", key: "required", defaultModel: "gemini-2.5-flash", defaultUrl: "https://generativelanguage.googleapis.com/v1beta/openai", url: false },
  { value: "groq", label: "Groq", key: "required", defaultModel: "llama-3.3-70b-versatile", defaultUrl: "https://api.groq.com/openai/v1", url: false },
  { value: "ollama", label: "Ollama", key: "none", defaultModel: "", defaultUrl: "http://127.0.0.1:11434/v1", url: true },
  { value: "lmstudio", label: "LM Studio", key: "none", defaultModel: "", defaultUrl: "http://127.0.0.1:1234/v1", url: true },
  { value: "custom", label: "Custom URL", key: "optional", defaultModel: "", defaultUrl: "", url: true },
];

/** The transcription picker's value: a kind, or a downloadable model. */
type TranscriptionChoice = Exclude<TranscriptionKind, "local"> | `local:${LocalModelId}`;

interface TranscriptionOption {
  value: TranscriptionChoice;
  label: string;
  /** Name in the privacy line and key field; empty for on-device choices. */
  provider: string;
}

const MAC_TRANSCRIPTION: TranscriptionOption[] = [
  { value: "apple", label: "On this Mac (Apple Speech)", provider: "" },
];

const WINDOWS_TRANSCRIPTION: TranscriptionOption[] = [
  { value: "local:english-fast", label: "English, fast (download, about 104 MB)", provider: "" },
  { value: "local:multilingual", label: "All languages (download, about 161 MB)", provider: "" },
  { value: "openai", label: "OpenAI (your key)", provider: "OpenAI" },
  { value: "groq", label: "Groq (your key)", provider: "Groq" },
  { value: "deepgram", label: "Deepgram (your key)", provider: "Deepgram" },
  { value: "assemblyai", label: "AssemblyAI (your key)", provider: "AssemblyAI" },
  { value: "elevenlabs", label: "ElevenLabs (your key)", provider: "ElevenLabs" },
  { value: "gemini", label: "Gemini (your key)", provider: "Gemini" },
];

const TRANSCRIPTION_OPTIONS = isWindows ? WINDOWS_TRANSCRIPTION : MAC_TRANSCRIPTION;

function choiceOf(settings: LocalSettingsDto["transcription"]): TranscriptionChoice {
  if (settings.kind === "local") return `local:${settings.localModel ?? "english-fast"}`;
  return settings.kind;
}

function splitChoice(choice: TranscriptionChoice): { kind: TranscriptionKind; localModel: LocalModelId | null } {
  if (choice.startsWith("local:")) return { kind: "local", localModel: choice.slice("local:".length) as LocalModelId };
  return { kind: choice as TranscriptionKind, localModel: null };
}

function keyUpdate(draft: string, replacing: boolean): KeyUpdate {
  const value = draft.trim();
  if (value) return { action: "set", value };
  return replacing ? { action: "clear" } : { action: "keep" };
}

const FIELD =
  "w-full rounded-xl bg-row px-3 py-2 text-[14px] text-ink-text placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-flash-500/50";
const SMALL_BUTTON =
  "rounded-lg bg-row px-2.5 py-1 text-[12px] font-medium text-ink-text hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flash-500 disabled:opacity-50";
const SAVE_BUTTON =
  "rounded-lg bg-flash-500 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-flash-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flash-500 focus-visible:ring-offset-1 disabled:opacity-50";

/** A key field that never shows a stored key: "Saved" plus Replace and Remove. */
function KeyField({
  label,
  hasKey,
  draft,
  replacing,
  onDraft,
  onReplace,
  optional,
}: {
  label: string;
  hasKey: boolean;
  draft: string;
  replacing: boolean;
  onDraft: (value: string) => void;
  onReplace: (replacing: boolean) => void;
  optional?: boolean;
}) {
  const t = useDesktopT();
  const helpId = `key-help-${label.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`;
  if (hasKey && !replacing) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-ink-secondary" aria-label={t("local.preferences.saved", { label })}>
          <Icon name="check" size={14} className="shrink-0 text-status-ok" />
          {t("local.preferences.saved", { label })}
        </span>
        <button type="button" aria-label={t("local.preferences.replaceAria", { label })} className={SMALL_BUTTON} onClick={() => onReplace(true)}>
          {t("local.preferences.replace")}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        aria-describedby={hasKey ? helpId : undefined}
        placeholder={optional ? t("local.preferences.apiKeyOptional", { label }) : label}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        className={FIELD}
      />
      {hasKey && (
        <div id={helpId} className="flex items-center gap-3 text-[12px]">
          <button
            type="button"
            className="font-medium text-sheet-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flash-500/50 rounded"
            onClick={() => { onDraft(""); onReplace(false); }}
          >
            {t("local.preferences.keepKey")}
          </button>
          <span className="text-ink-secondary">{t("local.preferences.removeKeyHelp")}</span>
        </div>
      )}
    </div>
  );
}

function ModelProviderSection({ settings, onSaved }: { settings: LocalSettingsDto; onSaved: (next: LocalSettingsDto) => void }) {
  const t = useDesktopT();
  const stored = settings.model;
  const [preset, setPreset] = useState<ModelPreset>(stored.preset);
  const [model, setModel] = useState(stored.model ?? "");
  const [baseUrl, setBaseUrl] = useState(stored.baseUrl ?? "");
  const [keyDraft, setKeyDraft] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const info = PROVIDERS.find((p) => p.value === preset) ?? PROVIDERS[0];
  // A stored key belongs to the stored provider; a newly picked one starts empty.
  const hasKey = stored.hasApiKey && preset === stored.preset;

  const choose = (next: ModelPreset) => {
    setPreset(next);
    setMessage(null);
    setKeyDraft("");
    setReplacingKey(false);
    if (next !== stored.preset) {
      setModel("");
      setBaseUrl("");
    } else {
      setModel(stored.model ?? "");
      setBaseUrl(stored.baseUrl ?? "");
    }
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const next = await saveLocalSettings({
        model: {
          preset,
          model: preset === "none" ? null : model.trim() || null,
          baseUrl: preset === "none" || !info.url ? null : baseUrl.trim() || null,
          // A stored key is the stored provider's; never hand it to another one.
          apiKey:
            preset === "none" || info.key === "none" || (preset !== stored.preset && !keyDraft.trim())
              ? { action: "clear" }
              : keyUpdate(keyDraft, replacingKey),
        },
      });
      setKeyDraft("");
      setReplacingKey(false);
      onSaved(next);
      setMessage({
        tone: "ok",
        text: preset === "none" ? t("local.preferences.savedRulesOnly") : t("local.preferences.savedSpokenCues", { provider: info.label }),
      });
    } catch (err) {
      setMessage({ tone: "error", text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("local.preferences.momentSelection")}
      subtitle={t("local.preferences.momentSelectionSubtitle")}
      trailing={
        <InlineSelect<ModelPreset>
          ariaLabel={t("local.preferences.momentSelection")}
          value={preset}
          onChange={choose}
          items={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
        />
      }
    >
      <div className="space-y-2">
        {preset !== "none" && info.key !== "none" && (
          <KeyField
            label={t("local.preferences.apiKey")}
            hasKey={hasKey}
            draft={keyDraft}
            replacing={replacingKey}
            onDraft={setKeyDraft}
            onReplace={setReplacingKey}
            optional={info.key === "optional"}
          />
        )}
        {preset !== "none" && (
          <input
            type="text"
            spellCheck={false}
            aria-label={t("local.preferences.model")}
            placeholder={info.defaultModel ? t("local.preferences.modelDefault", { defaultModel: info.defaultModel }) : t("local.preferences.modelName")}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className={FIELD}
          />
        )}
        {preset !== "none" && info.url && (
          <input
            type="url"
            spellCheck={false}
            aria-label={t("local.preferences.baseUrl")}
            placeholder={info.defaultUrl ? t("local.preferences.baseUrlDefault", { defaultUrl: info.defaultUrl }) : t("local.preferences.baseUrlExample")}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className={FIELD}
          />
        )}
        <div className="flex items-center justify-end gap-3">
          {message && (
            <span
              role={message.tone === "error" ? "alert" : "status"}
              aria-live={message.tone === "error" ? "assertive" : "polite"}
              className={`min-w-0 flex-1 text-[12px] leading-snug ${message.tone === "error" ? "text-status-error" : "text-status-ok"}`}
            >
              {message.text}
            </span>
          )}
          <button type="button" className={SAVE_BUTTON} disabled={saving} onClick={() => void save()}>
            {saving ? t("local.preferences.saving") : t("local.preferences.save")}
          </button>
        </div>
      </div>
    </SettingRow>
  );
}

function ModelDownload({
  status,
  progress,
  onDownload,
}: {
  status: LocalModelStatusDto | undefined;
  progress: LocalModelProgressDto | null;
  onDownload: () => void;
}) {
  const t = useDesktopT();
  const { locale } = useLanguageChoice();
  if (!status) return null;
  if (status.installed) {
    return (
      <p className="flex items-center gap-1.5 text-[13px] text-ink-secondary" aria-label={t("local.preferences.downloaded", { device: deviceName })}>
        <Icon name="check" size={14} className="shrink-0 text-status-ok" />
        {t("local.preferences.downloaded", { device: deviceName })}
      </p>
    );
  }
  const running = status.downloading || progress?.stage === "downloading" || progress?.stage === "verifying";
  if (running) {
    const total = progress?.totalBytes || status.sizeBytes;
    const received = progress?.receivedBytes ?? 0;
    const ratio = total > 0 ? Math.min(1, received / total) : 0;
    const percent = Math.round(ratio * 100);
    const label = progress?.stage === "verifying" ? t("local.preferences.checkingDownload") : t("local.preferences.downloadingProgress", { received: formatBytes(locale, received), total: formatBytes(locale, total), percent });
    return (
      <div
        className="space-y-1.5"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={label}
      >
        <div className="h-1.5 overflow-hidden rounded-full bg-row">
          <div className="h-full rounded-full bg-flash-500 transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <p className="text-[12px] text-ink-secondary">{label}</p>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-[13px] text-ink-secondary">
        {progress?.stage === "failed" && progress.error ? progress.error : t("local.preferences.notDownloadedYet", { size: formatBytes(locale, status.sizeBytes) })}
      </span>
      <button
        type="button"
        aria-label={t("local.preferences.downloadAria", { label: status.label, size: formatBytes(locale, status.sizeBytes) })}
        className={SAVE_BUTTON}
        onClick={onDownload}
      >
        {t("local.preferences.download")}
      </button>
    </div>
  );
}

function TranscriptionSection({ settings, onSaved }: { settings: LocalSettingsDto; onSaved: (next: LocalSettingsDto) => void }) {
  const t = useDesktopT();
  const stored = settings.transcription;
  const [choice, setChoice] = useState<TranscriptionChoice>(choiceOf(stored));
  const [model, setModel] = useState(stored.model ?? "");
  const [keyDraft, setKeyDraft] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [models, setModels] = useState<LocalModelStatusDto[]>([]);
  const [progress, setProgress] = useState<LocalModelProgressDto | null>(null);
  const option = TRANSCRIPTION_OPTIONS.find((o) => o.value === choice) ?? TRANSCRIPTION_OPTIONS[0];
  const { kind, localModel } = splitChoice(choice);
  const keyed = option.provider !== "";
  const hasKey = stored.hasApiKey && choiceOf(stored) === choice;
  const dirty = choice !== choiceOf(stored) || (keyed && (keyDraft.trim() !== "" || replacingKey || model.trim() !== (stored.model ?? "")));

  const refreshModels = useCallback(() => {
    if (!isWindows) return;
    localModelStatus().then(setModels).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isWindows) return;
    refreshModels();
    let disposed = false;
    let off: (() => void) | undefined;
    onLocalModelProgress((next) => {
      setProgress(next);
      if (next.stage === "installed" || next.stage === "failed") refreshModels();
    })
      .then((fn) => {
        if (disposed) fn();
        else off = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      off?.();
    };
  }, [refreshModels]);

  const choose = (next: TranscriptionChoice) => {
    setChoice(next);
    setMessage(null);
    setKeyDraft("");
    setReplacingKey(false);
    setModel(next === choiceOf(stored) ? stored.model ?? "" : "");
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const next = await saveLocalSettings({
        transcription: {
          kind,
          localModel,
          model: keyed ? model.trim() || null : null,
          apiKey: keyed ? keyUpdate(keyDraft, replacingKey) : { action: "keep" },
        },
      });
      setKeyDraft("");
      setReplacingKey(false);
      onSaved(next);
      setMessage({ tone: "ok", text: t("local.preferences.transcriptionSaved") });
    } catch (err) {
      setMessage({ tone: "error", text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const download = (id: LocalModelId) => {
    setMessage(null);
    setProgress({ model: id, stage: "downloading", receivedBytes: 0, totalBytes: models.find((m) => m.id === id)?.sizeBytes ?? 0, error: null });
    downloadLocalModel(id)
      .then(refreshModels)
      .catch((err) => {
        setProgress({ model: id, stage: "failed", receivedBytes: 0, totalBytes: 0, error: String(err) });
        refreshModels();
      });
  };

  if (!isWindows) {
    return (
      <SettingRow
        title={t("local.preferences.transcription")}
        subtitle={t("local.preferences.transcriptionSubtitleMac")}
      />
    );
  }

  return (
    <SettingRow
      title={t("local.preferences.transcription")}
      subtitle={t("local.preferences.transcriptionSubtitleWindows")}
      trailing={
        <InlineSelect<TranscriptionChoice>
          ariaLabel={t("local.preferences.transcription")}
          value={choice}
          onChange={choose}
          items={TRANSCRIPTION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
      }
    >
      <div className="space-y-2">
        <p className="text-[13px] font-medium text-ink-text">{option.label}</p>
        {kind === "local" && localModel && (
          <ModelDownload
            status={models.find((m) => m.id === localModel)}
            progress={progress?.model === localModel ? progress : null}
            onDownload={() => download(localModel)}
          />
        )}
        {keyed && (
          <KeyField
            label={t("local.preferences.apiKeyForProvider", { provider: option.provider })}
            hasKey={hasKey}
            draft={keyDraft}
            replacing={replacingKey}
            onDraft={setKeyDraft}
            onReplace={setReplacingKey}
          />
        )}
        {keyed && (
          <input
            type="text"
            spellCheck={false}
            aria-label={t("local.preferences.transcriptionModel")}
            placeholder={t("local.preferences.transcriptionModelPlaceholder")}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className={FIELD}
          />
        )}
        <div className="flex items-center justify-end gap-3">
          {message && (
            <span
              role={message.tone === "error" ? "alert" : "status"}
              aria-live={message.tone === "error" ? "assertive" : "polite"}
              className={`min-w-0 flex-1 text-[12px] leading-snug ${message.tone === "error" ? "text-status-error" : "text-status-ok"}`}
            >
              {message.text}
            </span>
          )}
          <button type="button" className={SAVE_BUTTON} disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? t("local.preferences.saving") : t("local.preferences.save")}
          </button>
        </div>
      </div>
    </SettingRow>
  );
}

function LinkRow({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${hint}`}
      className="flex w-full items-center gap-3 border-b border-subtle px-5 py-3 text-left hover:bg-row focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-flash-500"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-ink-text">{label}</span>
        <span className="block text-[12px] text-ink-secondary">{hint}</span>
      </span>
      <Icon name="external" size={18} className="text-ink-secondary" />
    </button>
  );
}

export function LocalPreferences({ version, onWhatsNew }: { version: string | null; onWhatsNew: () => void }) {
  const t = useDesktopT();
  const [settings, setSettings] = useState<LocalSettingsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(version);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    getLocalSettings()
      .then((next) => mounted.current && setSettings(next))
      .catch((err) => mounted.current && setLoadError(String(err)));
    // `getVersion` from @tauri-apps/api/app, without that module's import side effects.
    if (!version) invoke<string>("plugin:app|version").then((v) => mounted.current && setAppVersion(v)).catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, [version]);

  const openUrl = (url: string) => void open(url).catch(() => {});

  return (
    <>
      <SectionTitle>{t("local.preferences.aiAndTranscription")}</SectionTitle>
      {settings ? (
        <>
          <ModelProviderSection settings={settings} onSaved={setSettings} />
          <TranscriptionSection settings={settings} onSaved={setSettings} />
        </>
      ) : (
        <p className="px-5 py-3 text-[12px] text-ink-secondary">{loadError ?? t("local.preferences.loadingSettings")}</p>
      )}
      <div className="px-5 pt-3">
        <Notice tone="info">
          {t("local.preferences.privacyNotice", {
            transcriptionFallback: isWindows
              ? t("local.preferences.downloadedTranscriptionModel")
              : t("local.preferences.appleSpeech"),
            device: deviceName,
          })}
        </Notice>
      </div>

      <SectionTitle>{t("local.preferences.about")}</SectionTitle>
      <LinkRow
        label={t("local.preferences.clipyLocal")}
        hint={appVersion ? t("local.preferences.versionNotes", { version: appVersion }) : t("local.preferences.setupNotes")}
        onClick={() => openUrl(LOCAL_PROJECT_URL)}
      />
      <LinkRow
        label={t("local.preferences.whatsNew")}
        hint={t("local.preferences.whatsNewHint")}
        onClick={onWhatsNew}
      />
      <LinkRow
        label={t("local.preferences.releases")}
        hint={t("local.preferences.releasesHint")}
        onClick={() => openUrl(`${LOCAL_PROJECT_URL}/releases`)}
      />
      <p className="px-5 pt-3 text-[12px] leading-snug text-ink-secondary">
        {/* The full app's name is a value, so the local edition's brand swap leaves it as Clipy. */}
        {t("local.fullApp.pitch", { fullApp: "Clipy" })}{" "}
        <button
          type="button"
          className="font-medium text-sheet-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flash-500/50 rounded"
          onClick={() => openUrl(FULL_CLIPY_URL)}
        >
          {t("local.fullApp.button", { fullApp: "Clipy" })}
        </button>
      </p>
    </>
  );
}
