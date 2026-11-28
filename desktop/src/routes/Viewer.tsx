import { convertFileSrc } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { ClipyWordmark } from "../components/ClipyWordmark";
import { groupTranscriptLines } from "../lib/transcriptLines";
import {
  MOMENT_BACK_GRACE_MS,
  clampSeekMs,
  findAdjacentMomentMs,
  resolveViewerShortcut,
} from "../lib/viewerShortcuts";
import {
  readLocalRecording,
  revealLocalRecordingFile,
  updateOpenLocalArec,
  type LocalRecordingDto,
} from "../lib/bridge";

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function recordedOn(ms: number, locale: string): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The AREC viewer: a local recording read straight from its folder. Video
 * on top, the moments and transcript beside it, every timestamp seeks.
 * Read-only on purpose; editing stays on the web app.
 */
export default function Viewer() {
  const t = useTranslations("desktop.viewer");
  const locale = useLocale();
  const params = useMemo(() => new URLSearchParams(window.location.hash.split("?")[1] ?? ""), []);
  const id = useMemo(() => params.get("id") ?? "", [params]);
  // Set only when Clipy opened this window itself, so the offer to stop
  // doing that appears exactly where the behaviour was just experienced.
  const openedAutomatically = useMemo(() => params.get("auto") === "1", [params]);
  const [recording, setRecording] = useState<LocalRecordingDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [copied, setCopied] = useState(false);
  const [autoOpen, setAutoOpen] = useState<"on" | "turningOff" | "off" | "dismissed">("on");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const shortcutsWrapRef = useRef<HTMLDivElement | null>(null);
  const shortcutsButtonRef = useRef<HTMLButtonElement | null>(null);
  // Apple's on-device recognizer hands back one segment per word, so the raw
  // list reads as a column of single words. Fold them into lines for display;
  // the AREC on disk keeps every word.
  const lines = useMemo(() => groupTranscriptLines(recording?.segments ?? []), [recording?.segments]);
  const momentTimestamps = useMemo(
    () => (recording?.frames ?? []).map((frame) => frame.timestampMs),
    [recording?.frames],
  );

  useEffect(() => {
    let disposed = false;
    const load = () => {
      readLocalRecording(id)
        .then((value) => {
          if (disposed) return;
          setRecording(value);
          setError(null);
          if (value.stage !== "ready" && value.stage !== "failed") window.setTimeout(load, 3000);
        })
        .catch((err) => {
          if (!disposed) setError(String(err));
        });
    };
    load();
    return () => {
      disposed = true;
    };
  }, [id]);

  const seek = (ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = ms / 1000;
    setPosition(ms);
    void video.play().catch(() => {});
  };

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const command = resolveViewerShortcut(e, { helpOpen: shortcutsOpen });
      if (!command) return;

      if (command.type === "closeHelp") {
        e.preventDefault();
        setShortcutsOpen(false);
        shortcutsButtonRef.current?.focus();
        return;
      }

      if (command.type === "toggleHelp") {
        e.preventDefault();
        setShortcutsOpen((open) => !open);
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      if (command.type === "togglePlay") {
        e.preventDefault();
        if (video.paused || video.ended) {
          void video.play().catch(() => {});
        } else {
          video.pause();
        }
        return;
      }

      if (command.type === "seekRelative") {
        e.preventDefault();
        const durationMs =
          Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : recording.durationMs;
        const nextMs = clampSeekMs(video.currentTime * 1000 + command.deltaMs, durationMs);
        video.currentTime = nextMs / 1000;
        setPosition(nextMs);
        return;
      }

      if (command.type === "seekMoment") {
        e.preventDefault();
        const graceMs = video.paused ? 0 : MOMENT_BACK_GRACE_MS;
        const nextMs = findAdjacentMomentMs(momentTimestamps, video.currentTime * 1000, command.direction, graceMs);
        if (nextMs === null) return;
        video.currentTime = nextMs / 1000;
        setPosition(nextMs);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [recording, momentTimestamps, shortcutsOpen]);

  useEffect(() => {
    if (!shortcutsOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (shortcutsWrapRef.current && e.target instanceof Node && !shortcutsWrapRef.current.contains(e.target)) {
        setShortcutsOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [shortcutsOpen]);

  const copyPath = async () => {
    if (!recording) return;
    await writeText(recording.arecPath);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const stopOpening = async () => {
    setAutoOpen("turningOff");
    try {
      await updateOpenLocalArec(false);
      setAutoOpen("off");
    } catch {
      // A preference that did not save must not claim it did.
      setAutoOpen("on");
    }
  };

  if (error) {
    return (
      <main className="flex h-screen items-center justify-center bg-surface px-8 text-center text-ink-text">
        <div>
          <p className="text-[18px] font-semibold">{t("notOnMac")}</p>
          <p className="mt-2 text-[14px] text-ink-secondary">{error}</p>
        </div>
      </main>
    );
  }
  if (!recording) {
    return <main className="h-screen bg-surface" />;
  }

  const activeLine = lines.findIndex((line) => position >= line.startMs && position < line.endMs);
  const shortcutRows = [
    { label: t("shortcuts.playPause"), keys: [t("shortcuts.keys.space")] },
    { label: t("shortcuts.skip5s"), keys: ["←", "→"] },
    { label: t("shortcuts.moments"), keys: ["[", "]"] },
    { label: t("shortcuts.seekFocused"), keys: [t("shortcuts.keys.enter")] },
    { label: t("shortcuts.toggleHelp"), keys: ["?"] },
  ];

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-surface text-ink-text">
      <header className="flex items-center gap-4 border-b border-subtle px-6 py-3">
        <ClipyWordmark size={22} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{t("recordedFrom", { date: recordedOn(recording.recordedAtMs, locale) })}</p>
          <p className="text-[12px] text-ink-secondary">
            {clock(recording.durationMs)}
            {recording.clickCount > 0 ? ` · ${t("clicks", { count: recording.clickCount })}` : ""}
            {` · ${t("onThisMac")}`}
          </p>
        </div>
        {recording.stage !== "ready" && (
          <span className="rounded-full bg-note px-3 py-1 text-[12px] font-medium text-[#6a5300]">
            {recording.stage === "failed" ? t("processingFailed") : t("preparing")}
          </span>
        )}
        <button type="button" onClick={() => void copyPath()} className="rounded-full bg-row px-4 py-2 text-[13px] font-semibold hover:bg-row-hover">
          {copied ? t("copied") : t("copyArecPath")}
        </button>
        <button
          type="button"
          onClick={() => void revealLocalRecordingFile(recording.arecPath).catch(() => {})}
          className="rounded-full bg-row px-4 py-2 text-[13px] font-semibold hover:bg-row-hover"
        >
          {t("showInFinder")}
        </button>
        <div ref={shortcutsWrapRef} className="relative">
          <button
            ref={shortcutsButtonRef}
            type="button"
            onClick={() => setShortcutsOpen((open) => !open)}
            aria-label={t("shortcuts.buttonLabel")}
            aria-expanded={shortcutsOpen}
            aria-haspopup="dialog"
            title={t("shortcuts.buttonLabel")}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-row text-[14px] font-bold hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f5fd0]"
          >
            ?
          </button>
          {shortcutsOpen && (
            <div
              role="dialog"
              aria-label={t("shortcuts.title")}
              className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-subtle bg-surface p-3.5 shadow-pop animate-pop-in"
            >
              <p className="pb-2 text-[12px] font-bold uppercase tracking-wide text-ink-secondary">
                {t("shortcuts.title")}
              </p>
              <ul className="space-y-2 text-[13px]">
                {shortcutRows.map((row) => (
                  <li key={row.label} className="flex items-center justify-between gap-3">
                    <span className="text-ink-text">{row.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {row.keys.map((keycap) => (
                        <kbd
                          key={keycap}
                          className="rounded-sm border border-subtle bg-row px-1.5 py-0.5 font-sans text-[11px] font-semibold text-ink-text"
                        >
                          {keycap}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </header>

      {openedAutomatically && autoOpen !== "dismissed" && (
        <div className="flex items-center gap-3 border-b border-subtle bg-note px-6 py-2 text-[12px] text-[#6a5300]">
          <p className="min-w-0 flex-1">
            {autoOpen === "off"
              ? t("autoOff")
              : t("autoOpened")}
          </p>
          {autoOpen === "off" ? (
            <button
              type="button"
              onClick={() => setAutoOpen("dismissed")}
              className="shrink-0 rounded-full px-3 py-1 font-semibold hover:bg-[#f2e3b0]"
            >
              {t("gotIt")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void stopOpening()}
              disabled={autoOpen === "turningOff"}
              className="shrink-0 rounded-full px-3 py-1 font-semibold hover:bg-[#f2e3b0] disabled:opacity-50"
            >
              {t("dontOpen")}
            </button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col bg-[#0a0d16] p-6">
          <video
            ref={videoRef}
            src={convertFileSrc(recording.videoPath)}
            controls
            playsInline
            onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime * 1000)}
            className="h-full w-full rounded-xl bg-black object-contain"
          />
        </section>

        <aside className="flex w-[380px] shrink-0 flex-col overflow-y-auto border-l border-subtle">
          {recording.frames.length > 0 && (
            <div className="border-b border-subtle px-5 py-4">
              <h2 className="pb-3 text-[13px] font-bold uppercase tracking-wide text-ink-secondary">{t("keyMoments")}</h2>
              <div className="space-y-3">
                {recording.frames.map((frame) => (
                  <button
                    key={`${frame.timestampMs}-${frame.path}`}
                    type="button"
                    data-viewer-seek="true"
                    onClick={() => seek(frame.timestampMs)}
                    className="flex w-full gap-3 rounded-xl p-1.5 text-left transition-colors hover:bg-row focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f5fd0]"
                  >
                    <img src={convertFileSrc(frame.path)} alt="" className="h-14 w-24 shrink-0 rounded-lg bg-row object-cover" />
                    <span className="min-w-0">
                      <span className="block text-[12px] font-semibold text-[#2f5fd0]">{clock(frame.timestampMs)}</span>
                      <span className="line-clamp-2 text-[13px] leading-snug text-ink-text">{frame.reason}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="px-5 py-4">
            <h2 className="pb-3 text-[13px] font-bold uppercase tracking-wide text-ink-secondary">{t("transcript")}</h2>
            {lines.length === 0 ? (
              <p className="text-[13px] text-ink-secondary">{recording.stage === "ready" ? t("noSpeech") : t("transcribing")}</p>
            ) : (
              <div className="space-y-1">
                {lines.map((line, index) => (
                  <button
                    key={`${line.startMs}-${index}`}
                    type="button"
                    data-viewer-seek="true"
                    onClick={() => seek(line.startMs)}
                    className={`flex w-full gap-3 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f5fd0] ${
                      index === activeLine ? "bg-[#e9effc]" : "hover:bg-row"
                    }`}
                  >
                    <span className="w-11 shrink-0 pt-px text-[12px] font-semibold tabular-nums text-[#2f5fd0]">{clock(line.startMs)}</span>
                    <span className="text-[13px] leading-snug text-ink-text">{line.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
