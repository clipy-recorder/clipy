import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { Icon, InlineSelect, Notice, SectionTitle, SettingRow } from "../components/recorder/ui";
import { LOCAL_PROJECT_URL } from "../lib/edition";
import { useDesktopT, type DesktopT } from "../lib/messages";
import { deviceName, isWindows } from "../lib/platform";
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

function providerLabel(provider: ProviderPreset, t: DesktopT): string {
  if (provider.value === "none") return t("local.preferences.providers.none");
  if (provider.value === "custom") return t("local.preferences.providers.custom");
  return provider.label;
}

function transcriptionLabel(option: TranscriptionOption, t: DesktopT): string {
  if (option.value === "apple") return t("local.preferences.transcription.apple");
  if (option.value === "local:english-fast") return t("local.preferences.transcription.englishFast");
  if (option.value === "local:multilingual") return t("local.preferences.transcription.multilingual");
  return t("local.preferences.transcription.withKey", { provider: option.provider });
}

function formatMegabytes(bytes: number, t: DesktopT): string {
  return t("local.preferences.megabytes", { mb: Math.max(1, Math.round(bytes / 1e6)) });
}

const FIELD =
  "w-full rounded-xl bg-row px-3 py-2 text-[14px] text-ink-text placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-flash-500/50";
const SMALL_BUTTON =
  "rounded-lg bg-row px-2.5 py-1 text-[12px] font-medium text-ink-text hover:bg-row-hover disabled:opacity-50";
const SAVE_BUTTON =
  "rounded-lg bg-flash-500 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-flash-600 disabled:opacity-50";

/** A key field that never shows a stored key: "Saved" plus Replace and Remove. */
function KeyField({
  label,
  hasKey,
  draft,
  replacing,
  onDraft,
  onReplace,
  optional,
  t,
}: {
  label: string;
  hasKey: boolean;
  draft: string;
  replacing: boolean;
  onDraft: (value: string) => void;
  onReplace: (replacing: boolean) => void;
  optional?: boolean;
  t: DesktopT;
}) {
  if (hasKey && !replacing) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-ink-secondary">
          <Icon name="check" size={14} className="shrink-0 text-status-ok" />
          {t("local.preferences.key.saved", { label })}
        </span>
        <button type="button" className={SMALL_BUTTON} onClick={() => onReplace(true)}>
          {t("local.preferences.key.replace")}
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
        placeholder={optional ? t("local.preferences.key.optional", { label }) : label}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        className={FIELD}
      />
      {hasKey && (
        <div className="flex items-center gap-3 text-[12px]">
          <button type="button" className="font-medium text-sheet-link hover:underline" onClick={() => { onDraft(""); onReplace(false); }}>
            {t("local.preferences.key.keep")}
          </button>
          <span className="text-ink-secondary">{t("local.preferences.key.removeHint")}</span>
        </div>
      )}
    </div>
  );
}

function ModelProviderSection({
  settings,
  onSaved,
  t,
}: {
  settings: LocalSettingsDto;
  onSaved: (next: LocalSettingsDto) => void;
  t: DesktopT;
}) {
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
        text:
          preset === "none"
            ? t("local.preferences.model.savedRulesOnly")
            : t("local.preferences.model.savedProvider", { provider: providerLabel(info, t) }),
      });
    } catch (err) {
      setMessage({ tone: "error", text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("local.preferences.model.title")}
      subtitle={t("local.preferences.model.subtitle")}
      trailing={
        <InlineSelect<ModelPreset>
          ariaLabel={t("local.preferences.model.title")}
          value={preset}
          onChange={choose}
          items={PROVIDERS.map((p) => ({ value: p.value, label: providerLabel(p, t) }))}
        />
      }
    >
      <div className="space-y-2">
        {preset !== "none" && info.key !== "none" && (
          <KeyField
            label={t("local.preferences.model.apiKey")}
            hasKey={hasKey}
            draft={keyDraft}
            replacing={replacingKey}
            onDraft={setKeyDraft}
            onReplace={setReplacingKey}
            optional={info.key === "optional"}
            t={t}
          />
        )}
        {preset !== "none" && (
          <input
            type="text"
            spellCheck={false}
            aria-label={t("local.preferences.model.modelLabel")}
            placeholder={
              info.defaultModel
                ? t("local.preferences.model.modelDefaultPlaceholder", { model: info.defaultModel })
                : t("local.preferences.model.modelPlaceholder")
            }
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className={FIELD}
          />
        )}
        {preset !== "none" && info.url && (
          <input
            type="url"
            spellCheck={false}
            aria-label={t("local.preferences.model.baseUrlLabel")}
            placeholder={
              info.defaultUrl
                ? t("local.preferences.model.baseUrlDefaultPlaceholder", { url: info.defaultUrl })
                : t("local.preferences.model.baseUrlPlaceholder")
            }
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className={FIELD}
          />
        )}
        <div className="flex items-center justify-end gap-3">
          {message && (
            <span role={message.tone === "error" ? "alert" : "status"} className={`min-w-0 flex-1 text-[12px] leading-snug ${message.tone === "error" ? "text-status-error" : "text-status-ok"}`}>
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
  t,
}: {
  status: LocalModelStatusDto | undefined;
  progress: LocalModelProgressDto | null;
  onDownload: () => void;
  t: DesktopT;
}) {
  if (!status) return null;
  if (status.installed) {
    return (
      <p className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
        <Icon name="check" size={14} className="shrink-0 text-status-ok" />
        {t("local.preferences.download.installed", { device: deviceName })}
      </p>
    );
  }
  const running = status.downloading || progress?.stage === "downloading" || progress?.stage === "verifying";
  if (running) {
    const total = progress?.totalBytes || status.sizeBytes;
    const received = progress?.receivedBytes ?? 0;
    const ratio = total > 0 ? Math.min(1, received / total) : 0;
    return (
      <div className="space-y-1.5" role="status">
        <div className="h-1.5 overflow-hidden rounded-full bg-row">
          <div className="h-full rounded-full bg-flash-500 transition-[width]" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
        <p className="text-[12px] text-ink-secondary">
          {progress?.stage === "verifying"
            ? t("local.preferences.download.verifying")
            : t("local.preferences.download.downloading", {
                received: formatMegabytes(received, t),
                total: formatMegabytes(total, t),
              })}
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-[13px] text-ink-secondary">
        {progress?.stage === "failed" && progress.error
          ? progress.error
          : t("local.preferences.download.notDownloaded", { size: formatMegabytes(status.sizeBytes, t) })}
      </span>
      <button type="button" className={SAVE_BUTTON} onClick={onDownload}>
        {t("local.preferences.download.button")}
      </button>
    </div>
  );
}

function TranscriptionSection({
  settings,
  onSaved,
  t,
}: {
  settings: LocalSettingsDto;
  onSaved: (next: LocalSettingsDto) => void;
  t: DesktopT;
}) {
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
  const optionLabel = transcriptionLabel(option, t);
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
      setMessage({ tone: "ok", text: t("local.preferences.transcription.saved") });
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
        title={t("local.preferences.transcription.title")}
        subtitle={t("local.preferences.transcription.macSubtitle")}
      />
    );
  }

  return (
    <SettingRow
      title={t("local.preferences.transcription.title")}
      subtitle={t("local.preferences.transcription.windowsSubtitle")}
      trailing={
        <InlineSelect<TranscriptionChoice>
          ariaLabel={t("local.preferences.transcription.title")}
          value={choice}
          onChange={choose}
          items={TRANSCRIPTION_OPTIONS.map((o) => ({ value: o.value, label: transcriptionLabel(o, t) }))}
        />
      }
    >
      <div className="space-y-2">
        <p className="text-[13px] font-medium text-ink-text">{optionLabel}</p>
        {kind === "local" && localModel && (
          <ModelDownload
            status={models.find((m) => m.id === localModel)}
            progress={progress?.model === localModel ? progress : null}
            onDownload={() => download(localModel)}
            t={t}
          />
        )}
        {keyed && (
          <KeyField
            label={t("local.preferences.transcription.providerApiKey", { provider: option.provider })}
            hasKey={hasKey}
            draft={keyDraft}
            replacing={replacingKey}
            onDraft={setKeyDraft}
            onReplace={setReplacingKey}
            t={t}
          />
        )}
        {keyed && (
          <input
            type="text"
            spellCheck={false}
            aria-label={t("local.preferences.transcription.modelLabel")}
            placeholder={t("local.preferences.transcription.modelPlaceholder")}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className={FIELD}
          />
        )}
        <div className="flex items-center justify-end gap-3">
          {message && (
            <span role={message.tone === "error" ? "alert" : "status"} className={`min-w-0 flex-1 text-[12px] leading-snug ${message.tone === "error" ? "text-status-error" : "text-status-ok"}`}>
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
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 border-b border-subtle px-5 py-3 text-left hover:bg-row">
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
      <SectionTitle>{t("local.preferences.sections.aiAndTranscription")}</SectionTitle>
      {settings ? (
        <>
          <ModelProviderSection settings={settings} onSaved={setSettings} t={t} />
          <TranscriptionSection settings={settings} onSaved={setSettings} t={t} />
        </>
      ) : (
        <p className="px-5 py-3 text-[12px] text-ink-secondary">{loadError ?? t("local.preferences.loading")}</p>
      )}
      <div className="px-5 pt-3">
        <Notice tone="info">
          {t(isWindows ? "local.preferences.privacyNoticeWindows" : "local.preferences.privacyNoticeMac", { device: deviceName })}
        </Notice>
      </div>

      <SectionTitle>{t("local.preferences.sections.about")}</SectionTitle>
      <LinkRow
        label="Clipy Local"
        hint={
          appVersion
            ? t("local.preferences.about.versionHint", { version: appVersion })
            : t("local.preferences.about.sourceHint")
        }
        onClick={() => openUrl(LOCAL_PROJECT_URL)}
      />
      <LinkRow label={t("settings.links.whatsNew")} hint={t("settings.links.whatsNewHint")} onClick={onWhatsNew} />
      <LinkRow label={t("local.preferences.about.releases")} hint={t("local.preferences.about.releasesHint")} onClick={() => openUrl(`${LOCAL_PROJECT_URL}/releases`)} />
      <p className="px-5 pt-3 text-[12px] leading-snug text-ink-secondary">
        {/* The full app's name is a value, so the local edition's brand swap leaves it as Clipy. */}
        {t("local.fullApp.pitch", { fullApp: "Clipy" })}{" "}
        <button type="button" className="font-medium text-sheet-link hover:underline" onClick={() => openUrl(FULL_CLIPY_URL)}>
          {t("local.fullApp.button", { fullApp: "Clipy" })}
        </button>
      </p>
    </>
  );
}
