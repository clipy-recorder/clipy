import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ClipyWordmark } from "../components/ClipyWordmark";
import { Icon } from "../components/recorder/ui";
import { ANNOTATION_COLORS, ANNOTATION_WIDTH_MAX, ANNOTATION_WIDTH_MIN, getAnnotationWidth, type AnnotationColor } from "../lib/annotation";
import {
  captureScreenshot,
  getAppSettings,
  getClipboardHistoryEnabled,
  getRecorderShortcuts,
  SCREENSHOT_EDITOR_BUSY,
  setClipboardHistoryEnabled,
  updateScreenshotEditor,
  type RecorderShortcutAction,
} from "../lib/bridge";
import { flareOpacity, splitTrail, strokeFlarePath, trailSplitDistance, type StrokePoint } from "../lib/flareTrail";
import { hotkeyKeycaps } from "../lib/hotkey";
import { deviceName, isMacOS, isWindows } from "../lib/platform";
import { LOCAL_EDITION, LOCAL_PROJECT_URL } from "../lib/edition";
import {
  currentFeaturePlatform,
  featureById,
  featuresFor,
  getWhatsNewState,
  markFeatureTried,
  newsFor,
  onWhatsNewChanged,
  onWhatsNewFocus,
  recentFeatures,
  showRecorderFromWhatsNew,
  type Feature,
  type FeatureId,
  type WhatsNewStateDto,
  localizeFeature,
} from "../lib/whatsNew";
import { useTranslations } from "use-intl";
import { useDesktopT } from "../lib/messages";

type WhatsNewT = ReturnType<typeof useTranslations<"desktop.whatsNew">>;

/** Clipboard history limits, as in src-tauri/src/clipboard_history.rs. */
const CLIPBOARD_MAX_ITEMS = 10_000;
const CLIPBOARD_MAX_DAYS = 90;

/**
 * What's new: the release notes for the update just installed, and a
 * checklist of what Clipy can do, each with a place to try it.
 *
 * It only ever opens because someone asked (the recorder's update card, the
 * tray menu, Settings). Practising records nothing and uploads nothing the
 * user did not ask to (the screenshot editor keeps its own Upload button); the
 * checklist ticks itself when a feature is really used, here or in a
 * recording (see `whats_new.rs`).
 */

const RELEASES_URL = LOCAL_EDITION ? `${LOCAL_PROJECT_URL}/releases` : "https://clipy.online/download/releases";
const AGENT_DOCS_URL = LOCAL_EDITION ? LOCAL_PROJECT_URL : "https://clipy.online/for-agents";

type Page = "overview" | FeatureId;

function pageFromHash(hash: string): Page {
  const id = hash.replace(/^#whats-new\/?/, "");
  return featureById(id) ? (id as FeatureId) : "overview";
}

export default function WhatsNew() {
  const t = useTranslations("desktop.whatsNew");
  const [state, setState] = useState<WhatsNewStateDto | null>(null);
  const [page, setPage] = useState<Page>(() => pageFromHash(window.location.hash));
  const [shortcuts, setShortcuts] = useState<Partial<Record<RecorderShortcutAction, string>>>({});
  const platform = currentFeaturePlatform();

  const refresh = useCallback(() => {
    getWhatsNewState().then(setState).catch(() => {});
    getRecorderShortcuts()
      .then((rows) => setShortcuts(Object.fromEntries(rows.map((r) => [r.action, r.hotkey]))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const offs: Array<() => void> = [];
    let disposed = false;
    const keep = (p: Promise<() => void>) =>
      void p.then((off) => (disposed ? off() : offs.push(off))).catch(() => {});
    keep(onWhatsNewChanged(setState));
    keep(onWhatsNewFocus((id) => setPage(featureById(id) ? (id as FeatureId) : "overview")));
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      offs.forEach((off) => off());
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const td = useDesktopT();
  const news = useMemo(
    () => (state ? newsFor(state, platform).map((f) => localizeFeature(f, td)) : []),
    [state, platform, td],
  );
  // New features first, then everything else in catalog order.
  const checklist = useMemo(() => {
    const all = featuresFor(platform).map((f) => localizeFeature(f, td));
    const fresh = new Set(news.map((f) => f.id));
    return [...all.filter((f) => fresh.has(f.id)), ...all.filter((f) => !fresh.has(f.id))];
  }, [news, platform, td]);
  const tried = useMemo(() => new Set(state?.tried ?? []), [state]);
  const triedCount = checklist.filter((f) => tried.has(f.id)).length;

  const close = () => void getCurrentWindow().close().catch(() => {});
  const go = (next: Page) => setPage(next);
  const nextAfter = (id: FeatureId): Page => {
    const index = checklist.findIndex((f) => f.id === id);
    return checklist[index + 1]?.id ?? "overview";
  };

  return (
    <main className="flex h-screen w-screen select-none overflow-hidden bg-surface text-ink-text">
      <nav
        aria-label={t("nav")}
        data-tauri-drag-region
        className={`flex w-[236px] shrink-0 flex-col border-r border-subtle bg-canvas px-4 pb-5 ${isMacOS ? "pt-12" : "pt-6"}`}
      >
        <div data-tauri-drag-region className="mb-4 px-2">
          <ClipyWordmark size={24} />
        </div>
        <RailHeading>{t("rail.whatsNew")}</RailHeading>
        <RailItem active={page === "overview"} onClick={() => go("overview")} marker={<VersionMarker />}>
          {t("rail.version", { version: state?.currentVersion ?? "" })}
        </RailItem>
        <RailHeading>{t("rail.tryIt")}</RailHeading>
        <ol className="flex flex-col gap-0.5">
          {checklist.map((f) => (
            <li key={f.id}>
              <RailItem
                active={page === f.id}
                onClick={() => go(f.id)}
                marker={<StatusMarker done={tried.has(f.id)} current={page === f.id} />}
                badge={news.some((n) => n.id === f.id) ? t("rail.new") : undefined}
              >
                {f.label}
              </RailItem>
            </li>
          ))}
        </ol>
        <div className="mt-auto px-2 pt-4" aria-live="polite">
          <p className="text-[12px] text-ink-secondary">
            {t.rich("rail.progress", {
              tried: triedCount,
              total: checklist.length,
              strong: (chunks) => <span className="font-semibold text-ink-text">{chunks}</span>,
            })}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-subtle">
            <div
              className="h-full rounded-full bg-flash-500 transition-[width] duration-500"
              style={{ width: `${checklist.length ? (triedCount / checklist.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      </nav>

      <section className={`flex min-w-0 flex-1 flex-col px-9 pb-6 ${isMacOS ? "pt-9" : "pt-7"}`}>
        {page === "overview" ? (
          <Overview
            state={state}
            news={news}
            tried={tried}
            onTry={(id) => go(id)}
            onTryAll={() => go((news.find((f) => !tried.has(f.id)) ?? news[0] ?? checklist.find((f) => !tried.has(f.id)) ?? checklist[0]).id)}
            onClose={close}
          />
        ) : (
          <FeaturePage
            key={page}
            feature={localizeFeature(featureById(page)!, td)}
            index={checklist.findIndex((f) => f.id === page)}
            total={checklist.length}
            tried={tried.has(page)}
            shortcuts={shortcuts}
            onBack={() => go("overview")}
            onNext={() => {
              // The last page's button reads "Done": finish, don't go back
              // to the overview the user started from.
              const next = nextAfter(page);
              if (next === "overview") close();
              else go(next);
            }}
            nextLabel={(() => {
              const next = nextAfter(page);
              return next === "overview" ? t("done") : t("next", { label: localizeFeature(featureById(next)!, td).label });
            })()}
          />
        )}
      </section>
    </main>
  );
}

// ─── Rail ────────────────────────────────────────────────────────────────────

function RailHeading({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 mt-4 px-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{children}</p>
  );
}

function RailItem({
  active,
  onClick,
  marker,
  badge,
  children,
}: {
  active: boolean;
  onClick: () => void;
  marker: ReactNode;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500/50 ${
        active ? "bg-surface font-semibold text-ink-text shadow-[0_1px_2px_rgba(10,13,22,0.08)]" : "text-ink-secondary hover:bg-surface/60 hover:text-ink-text"
      }`}
    >
      {marker}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {badge && (
        <span className="shrink-0 rounded-full bg-flash-50 px-1.5 py-0.5 text-[9.5px] font-bold tracking-[0.06em] text-flash-600">
          {badge}
        </span>
      )}
    </button>
  );
}

function VersionMarker() {
  return (
    <span aria-hidden className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-flash-50 text-flash-600">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.2l7.1-.6z" /></svg>
    </span>
  );
}

function StatusMarker({ done, current }: { done: boolean; current: boolean }) {
  const t = useTranslations("desktop.whatsNew");
  if (done) {
    return (
      <span aria-label={t("tried")} className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-emerald-700 text-white">
        <CheckIcon size={10} />
      </span>
    );
  }
  return (
    <span
      aria-label={t("notTried")}
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full ${current ? "ring-[1.5px] ring-inset ring-flash-500" : "ring-[1.5px] ring-inset ring-strong"}`}
    >
      {current && <span className="h-[7px] w-[7px] rounded-full bg-flash-500" />}
    </span>
  );
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
      <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

function Overview({
  state,
  news,
  tried,
  onTry,
  onTryAll,
  onClose,
}: {
  state: WhatsNewStateDto | null;
  news: Feature[];
  tried: Set<string>;
  onTry: (id: FeatureId) => void;
  onTryAll: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("desktop.whatsNew");
  const platform = currentFeaturePlatform();
  const hasNews = news.length > 0;
  const td = useDesktopT();
  const listed = hasNews ? news : state ? recentFeatures(state.currentVersion, platform).map((f) => localizeFeature(f, td)) : [];
  const from = state?.previousVersion;
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-flash-600">
          {hasNews
            ? from
              ? t("overview.updatedFrom", { from, to: state?.currentVersion ?? "" })
              : t("overview.updatedTo", { version: state?.currentVersion ?? "" })
            : t("overview.onVersion", { version: state?.currentVersion ?? t("overview.latestVersion") })}
        </p>
        <h1 className="mt-1 text-[24px] font-semibold leading-tight tracking-[-0.015em]">
          {hasNews ? t("overview.titleNews") : t("overview.titleRecent")}
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">
          {hasNews
            ? t("overview.bodyNews")
            : t("overview.bodyRecent")}
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {listed.map((f) => (
            <div key={f.id} className="flex items-center gap-4 rounded-xl border border-subtle p-3.5">
              <FeatureThumb id={f.id} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[14.5px] font-semibold">
                  {f.title}
                  {tried.has(f.id) && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                      <CheckIcon size={9} /> {t("tried")}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{f.blurb[platform]}</p>
              </div>
              <button
                type="button"
                onClick={() => onTry(f.id)}
                className="shrink-0 rounded-lg border border-strong bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink-text transition-colors hover:border-flash-400/60 hover:text-flash-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500/60"
              >
                {t("overview.tryIt")}
              </button>
            </div>
          ))}
        </div>
      </div>
      <Footer>
        <LinkButton onClick={() => void open(RELEASES_URL).catch(() => {})}>{t("overview.allReleases")}</LinkButton>
        <span className="flex-1" />
        <LinkButton onClick={onClose}>{t("overview.close")}</LinkButton>
        <PrimaryButton onClick={onTryAll} autoFocus>
          {hasNews ? t("overview.tryAll", { count: news.length }) : t("overview.startTrying")}
        </PrimaryButton>
      </Footer>
    </>
  );
}

/** A small drawing per feature, in markup so it adds nothing to the bundle. */
function FeatureThumb({ id }: { id: FeatureId }) {
  const frame = "relative h-[64px] w-[104px] shrink-0 overflow-hidden rounded-lg border border-subtle bg-canvas";
  const coral = "#ff4d29";
  switch (id) {
    case "clipboard":
      return (
        <div className={frame} aria-hidden>
          <div className="absolute inset-x-3 top-2.5 bottom-2 rounded-md bg-white p-1.5 shadow-soft">
            <div className="mb-1 h-1.5 rounded bg-flash-50" />
            <div className="mb-1 h-1.5 w-4/5 rounded bg-stone-100" />
            <div className="h-1.5 w-3/5 rounded bg-stone-100" />
          </div>
        </div>
      );
    case "window_recording":
      return (
        <div className={frame} aria-hidden>
          <div className="absolute left-2.5 top-2.5 h-9 w-14 rounded-md bg-white" style={{ boxShadow: `inset 0 0 0 2px ${coral}` }} />
          <div className="absolute left-10 top-6 h-8 w-14 rounded-md bg-[#dfe4ef] opacity-90" />
        </div>
      );
    case "screenshot_markup":
    case "screenshot_style":
      if (id === "screenshot_style") {
        return (
          <div className={frame} aria-hidden>
            <div
              className="absolute inset-0 rounded-md"
              style={{ background: "linear-gradient(135deg, #ff7a59, #ff3d77, #7b2ff7)" }}
            />
            <div className="absolute inset-x-4 inset-y-3 rounded-md bg-white shadow-soft" />
            <svg className="absolute inset-0" width="104" height="64"><rect x="30" y="20" width="44" height="12" rx="6" fill={coral} /><path d="M40 32l-6 10" stroke={coral} strokeWidth="2.5" strokeLinecap="round" /></svg>
          </div>
        );
      }
      return (
        <div className={frame} aria-hidden>
          <div className="absolute inset-x-2.5 inset-y-2 rounded-md bg-white" />
          <svg className="absolute inset-0" width="104" height="64"><rect x="24" y="18" width="40" height="22" rx="5" fill="none" stroke={coral} strokeWidth="2.5" /><path d="M70 44l12 9" stroke={coral} strokeWidth="2.5" strokeLinecap="round" /></svg>
        </div>
      );
    case "pointer":
      return (
        <div className={frame} aria-hidden>
          <div className="absolute inset-x-2.5 inset-y-2 rounded-md bg-white" />
          <svg className="absolute inset-0" width="104" height="64"><path d="M20 44 C 34 30, 52 24, 70 26" fill="none" stroke={coral} strokeWidth="4" strokeLinecap="round" /><path d="M72 22l0 18 5-5 4 8 3-1.5-4-8 7 0z" fill="#0a0d16" stroke="#fff" strokeWidth="1" strokeLinejoin="round" /></svg>
        </div>
      );
    case "flare":
    case "draw":
      return (
        <div className={frame} aria-hidden>
          <svg className="absolute inset-0" width="104" height="64"><path d={id === "flare" ? "M86 14 C 70 24, 30 26, 26 40 S 60 56, 66 44" : "M18 46 C 30 20, 46 20, 52 34 S 76 50, 86 22"} fill="none" stroke={coral} strokeWidth="4" strokeLinecap="round" /></svg>
        </div>
      );
    case "custom_size":
      return (
        <div className={frame} aria-hidden>
          <div className="absolute left-5 top-3 h-10 w-16 rounded-sm border-2 border-dashed border-flash-500" />
          {[["left-[17px] top-[9px]"], ["left-[79px] top-[9px]"], ["left-[17px] top-[49px]"], ["left-[79px] top-[49px]"]].map(([pos]) => (
            <span key={pos} className={`absolute ${pos} h-2 w-2 rounded-full bg-white ring-2 ring-flash-500`} />
          ))}
        </div>
      );
    case "local_ai":
      return (
        <div className={frame} aria-hidden>
          <div className="absolute left-1/2 top-2.5 h-9 w-14 -translate-x-1/2 rounded-md border-2 border-ink-700 bg-white">
            <div className="m-1.5 h-1 rounded bg-stone-300" />
            <div className="mx-1.5 h-1 w-2/3 rounded bg-stone-300" />
          </div>
          <div className="absolute bottom-2.5 left-1/2 h-1.5 w-[72px] -translate-x-1/2 rounded-full bg-ink-700" />
        </div>
      );
    case "agent":
      return (
        <div className={frame} aria-hidden>
          <div className="absolute inset-x-2.5 inset-y-2 rounded-md bg-ink-900 p-2 font-mono text-[8px] leading-[11px] text-stone-300">
            <span className="text-flash-400">$</span> clipy session
            <br />
            <span className="text-emerald-400">✓</span> recording…
          </div>
        </div>
      );
  }
}

// ─── Feature pages ───────────────────────────────────────────────────────────

function FeaturePage({
  feature,
  index,
  total,
  tried,
  shortcuts,
  onBack,
  onNext,
  nextLabel,
}: {
  feature: Feature;
  index: number;
  total: number;
  tried: boolean;
  shortcuts: Partial<Record<RecorderShortcutAction, string>>;
  onBack: () => void;
  onNext: () => void;
  nextLabel: string;
}) {
  const t = useTranslations("desktop.whatsNew");
  const platform = currentFeaturePlatform();
  const practice = PRACTICE[feature.id](shortcuts, t);
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {practice.area}
        <div className="mt-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-flash-600">
            {t("page.progress", { index: index + 1, total })}
          </p>
          <h1 className="mt-1 text-[22px] font-semibold leading-tight tracking-[-0.01em]">{feature.title}</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">{feature.blurb[platform]}</p>
          {practice.how && <div className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{practice.how}</div>}
          {tried && (
            <p role="status" className="clipy-fade-in mt-3 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-[12.5px] font-semibold text-emerald-700">
              <CheckIcon size={12} />
              {practice.doneText}
            </p>
          )}
        </div>
      </div>
      <Footer>
        <LinkButton onClick={onBack}>{t("page.back")}</LinkButton>
        <span className="flex-1" />
        {!tried && <LinkButton onClick={onNext}>{t("page.skip")}</LinkButton>}
        <PrimaryButton onClick={onNext}>{nextLabel}</PrimaryButton>
      </Footer>
    </>
  );
}

interface Practice {
  area: ReactNode;
  how?: ReactNode;
  doneText: string;
}

type Shortcuts = Partial<Record<RecorderShortcutAction, string>>;

const DEFAULT_KEYS: Record<"annotation" | "clipboard_history" | "screenshot_area", string> = isWindows
  ? { annotation: "Control+Alt+KeyD", clipboard_history: "Control+Shift+KeyV", screenshot_area: "Alt+Shift+Digit2" }
  : { annotation: "Meta+Alt+KeyD", clipboard_history: "Meta+Shift+KeyV", screenshot_area: "Meta+Shift+Digit2" };

/** The bound key, or the default when the list has not loaded. An action
 * switched off reads as "" and shows no keys. */
function keyFor(shortcuts: Shortcuts, action: keyof typeof DEFAULT_KEYS): string {
  return shortcuts[action] ?? DEFAULT_KEYS[action];
}

const PRACTICE: Record<FeatureId, (shortcuts: Shortcuts, t: WhatsNewT) => Practice> = {
  flare: (_, t) => ({
    area: <FlarePractice />,
    how: t.rich("practice.flareHow", {
      keys: () => <Keys keys={[isWindows ? "Ctrl" : "control"]} />,
      b: (chunks) => <b className="font-semibold text-ink-text">{chunks}</b>,
    }),
    doneText: t("practice.flareDone"),
  }),
  pointer: (_, t) => ({
    area: <PointerPractice />,
    how: t.rich("practice.pointerHow", {
      keys: () => <Keys keys={isWindows ? ["Ctrl", "Shift"] : ["control", "shift"]} />,
    }),
    doneText: t("practice.pointerDone"),
  }),
  draw: (s, t) => ({
    area: <DrawPractice />,
    how: t.rich("practice.drawHow", {
      keys: () => <Keys keys={hotkeyKeycaps(keyFor(s, "annotation"))} />,
    }),
    doneText: t("practice.drawDone"),
  }),
  clipboard: (s, t) => ({
    area: <ClipboardPractice hotkey={keyFor(s, "clipboard_history")} />,
    doneText: t("practice.clipboardDone", { items: CLIPBOARD_MAX_ITEMS, days: CLIPBOARD_MAX_DAYS }),
  }),
  screenshot_markup: (s, t) => ({
    area: <ScreenshotPractice hotkey={keyFor(s, "screenshot_area")} />,
    doneText: t("practice.markupDone"),
  }),
  screenshot_style: (s, t) => ({
    area: <ScreenshotPractice hotkey={keyFor(s, "screenshot_area")} />,
    how: <>{t("practice.styleHow")}</>,
    doneText: t("practice.styleDone"),
  }),
  window_recording: (_, t) => ({
    area: (
      <RecorderPractice
        steps={[
          t("practice.windowStep1"),
          isWindows ? t("practice.windowStep2Windows") : t("practice.windowStep2Mac"),
          t("practice.startRecording"),
        ]}
      />
    ),
    doneText: t("practice.windowDone"),
  }),
  custom_size: (_, t) => ({
    area: (
      <RecorderPractice
        steps={[t("practice.areaStep1"), t("practice.areaStep2"), t("practice.areaStep3")]}
      />
    ),
    doneText: t("practice.areaDone"),
  }),
  local_ai: (_, t) => ({
    area: (
      <RecorderPractice
        steps={LOCAL_EDITION ? [
          "Open the recorder and record as usual. Every recording is a Local AI recording.",
          t("practice.localStep3", { device: deviceName }),
        ] : [
          t("practice.localStep1"),
          isWindows ? t("practice.localStep2Windows") : t("practice.localStep2Mac"),
          t("practice.localStep3", { device: deviceName }),
        ]}
        aside={LOCAL_EDITION ? undefined : <DestinationSwitchPicture />}
      />
    ),
    doneText: t("practice.localDone"),
  }),
  agent: (_, t) => ({
    area: <AgentPractice />,
    doneText: t("practice.agentDone"),
  }),
};

// ─── Practice areas ──────────────────────────────────────────────────────────

function PracticeFrame({ children, note }: { children: ReactNode; note?: string }) {
  const t = useTranslations("desktop.whatsNew");
  return (
    <div className="relative h-[262px] overflow-hidden rounded-xl border border-subtle bg-canvas">
      {children}
      <span className="pointer-events-none absolute bottom-2.5 right-3.5 text-[11px] text-ink-muted">{note ?? t("practice.frameNote")}</span>
    </div>
  );
}

/** The mock app the user points at or draws over. */
function MockCheckout() {
  const t = useTranslations("desktop.whatsNew");
  return (
    <div className="pointer-events-none absolute left-9 top-7 w-[300px] rounded-xl bg-white p-4 shadow-[0_10px_30px_rgba(10,13,22,0.12)]">
      <p className="text-[12px] font-semibold text-ink-muted">{t("practice.mock.checkout")}</p>
      <p className="mt-0.5 text-[17px] font-semibold">Pro Annual</p>
      <div className="mt-3.5 h-2 w-[90%] rounded bg-stone-100" />
      <div className="mt-2 h-2 w-[70%] rounded bg-stone-100" />
      <div className="mt-4 flex justify-between text-[13px]">
        <span className="text-ink-secondary">{t("practice.mock.total")}</span>
        <b>$72.00</b>
      </div>
      <div className="mt-4 w-[118px] rounded-lg bg-[#2f6bff] py-2 text-center text-[13px] font-semibold text-white">{t("practice.mock.payNow")}</div>
    </div>
  );
}

type TrailPoint = StrokePoint & { t: number; breakBefore?: boolean };

/**
 * A canvas that draws and fades strokes exactly like the recording overlay
 * (`CursorTrail.tsx`): same smoothing, same idle fade, same pen width.
 */
function useTrailCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<TrailPoint[]>([]);
  const lastDrawnAt = useRef(0);
  const widthRef = useRef(6);

  useEffect(() => {
    void getAnnotationWidth()
      .then((w) => {
        if (Number.isFinite(w) && w >= ANNOTATION_WIDTH_MIN && w <= ANNOTATION_WIDTH_MAX) widthRef.current = w;
      })
      .catch(() => {});
    let frame = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        const opacity = flareOpacity(performance.now(), lastDrawnAt.current);
        if (opacity === 0) pointsRef.current = [];
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.scale(dpr, dpr);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const sub of splitTrail(pointsRef.current, trailSplitDistance(w, h))) strokeFlarePath(ctx, sub);
        ctx.restore();
      }
      frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const add = useCallback((x: number, y: number, color: string, breakBefore = false) => {
    const t = performance.now();
    const points = pointsRef.current;
    const last = points[points.length - 1];
    if (last && !breakBefore && Math.hypot(x - last.x, y - last.y) < 1.5) return false;
    lastDrawnAt.current = t;
    points.push({ x, y, t, color, width: widthRef.current, breakBefore });
    if (points.length > 600) points.splice(0, points.length - 600);
    return true;
  }, []);

  return { canvasRef, add };
}

function FlarePractice() {
  const t = useTranslations("desktop.whatsNew");
  const { canvasRef, add } = useTrailCanvas();
  const [held, setHeld] = useState(false);
  const heldSince = useRef<number | null>(null);
  const pointsThisHold = useRef(0);
  const doneRef = useRef(false);

  useEffect(() => {
    const release = () => {
      const since = heldSince.current;
      heldSince.current = null;
      setHeld(false);
      // A deliberate hold with real movement, not a stray Control tap.
      if (since !== null && performance.now() - since >= 300 && pointsThisHold.current >= 6 && !doneRef.current) {
        doneRef.current = true;
        void markFeatureTried("flare").catch(() => {});
      }
      pointsThisHold.current = 0;
    };
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Control" || e.repeat || heldSince.current !== null) return;
      heldSince.current = performance.now();
      setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Control") release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    // Bare Control, as in a recording; Control with a button is a click.
    if (!e.ctrlKey || e.buttons !== 0) return;
    if (heldSince.current === null) {
      heldSince.current = performance.now();
      setHeld(true);
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (add(e.clientX - rect.left, e.clientY - rect.top, "#ff4d29", pointsThisHold.current === 0)) pointsThisHold.current += 1;
  };

  return (
    <PracticeFrame>
      <MockCheckout />
      <canvas
        ref={canvasRef}
        onPointerMove={onMove}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={t("practice.flareArea")}
        className="absolute inset-0 h-full w-full"
      />
      <div className="pointer-events-none absolute right-7 top-6 flex flex-col items-center gap-2.5">
        <span
          className={`flex h-[42px] w-[78px] items-end rounded-lg bg-white px-2 pb-1.5 text-[12px] font-semibold transition-all ${
            held ? "translate-y-0.5 shadow-[inset_0_0_0_2px_#ff4d29,0_0_0_5px_rgba(255,77,41,0.16)]" : "shadow-[inset_0_0_0_1px_rgba(10,13,22,0.14),0_2px_0_rgba(10,13,22,0.14)]"
          }`}
        >
          {isWindows ? "Ctrl" : "control"}
        </span>
        <span className={`text-[11.5px] font-semibold ${held ? "text-flash-600" : "text-ink-muted"}`}>{held ? t("practice.held") : t("practice.holdMe")}</span>
      </div>
    </PracticeFrame>
  );
}

function DrawPractice() {
  const t = useTranslations("desktop.whatsNew");
  const td = useDesktopT();
  const { canvasRef, add } = useTrailCanvas();
  const [color, setColor] = useState<AnnotationColor>(ANNOTATION_COLORS[0].value);
  const drawing = useRef(false);
  const strokePoints = useRef(0);
  const doneRef = useRef(false);

  const at = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top] as const;
  };
  const end = () => {
    if (drawing.current && strokePoints.current >= 6 && !doneRef.current) {
      doneRef.current = true;
      void markFeatureTried("draw").catch(() => {});
    }
    drawing.current = false;
    strokePoints.current = 0;
  };

  return (
    <PracticeFrame>
      <MockCheckout />
      <canvas
        ref={canvasRef}
        aria-label={t("practice.drawArea")}
        className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          strokePoints.current = 0;
          const [x, y] = at(e);
          if (add(x, y, color, true)) strokePoints.current += 1;
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const [x, y] = at(e);
          if (add(x, y, color)) strokePoints.current += 1;
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      />
      <div className="absolute right-5 top-5 flex flex-col gap-2 rounded-2xl bg-ink-900 p-2 shadow-soft" role="radiogroup" aria-label={t("practice.penColour")}>
        {ANNOTATION_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={color === c.value}
            aria-label={td(`stop.colors.${c.name.toLowerCase()}`)}
            title={td(`stop.colors.${c.name.toLowerCase()}`)}
            onClick={() => setColor(c.value)}
            className={`h-5 w-5 rounded-full transition-transform ${color === c.value ? "scale-110 ring-2 ring-white ring-offset-2 ring-offset-ink-900" : "hover:scale-110"}`}
            style={{ background: c.value }}
          />
        ))}
      </div>
    </PracticeFrame>
  );
}


function ClipboardPractice({ hotkey }: { hotkey: string }) {
  const t = useTranslations("desktop.whatsNew");
  const sample = t("practice.clipboardSample");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getClipboardHistoryEnabled().then(setEnabled).catch(() => setEnabled(null));
  }, []);
  const turnOn = async () => {
    setError(null);
    try {
      await setClipboardHistoryEnabled(true);
      setEnabled(true);
    } catch (err) {
      setError(String(err));
    }
  };
  const copy = async () => {
    try {
      await writeText(sample);
      setCopied(true);
    } catch (err) {
      setError(String(err));
    }
  };
  return (
    <PracticeFrame note={t("practice.clipboardNote")}>
      <div className="flex h-full flex-col justify-center gap-4 px-8">
        {enabled === false ? (
          <div>
            <p className="text-[14px] font-semibold">{t("practice.clipboardOff")}</p>
            <p className="mt-1 text-[12.5px] text-ink-secondary">{t("practice.clipboardOffBody")}</p>
            <div className="mt-3">
              <SecondaryButton onClick={() => void turnOn()}>{t("practice.clipboardTurnOn")}</SecondaryButton>
            </div>
          </div>
        ) : (
          <>
            <Step n={1}>
              <span>{t("practice.copyLine")}</span>
              <span className="rounded-md bg-white px-2.5 py-1.5 text-[12.5px] shadow-[inset_0_0_0_1px_rgba(10,13,22,0.1)]">{sample}</span>
              <SecondaryButton onClick={() => void copy()}>{copied ? t("practice.copied") : t("practice.copy")}</SecondaryButton>
            </Step>
            <Step n={2}>
              {hotkey ? (
                <>
                  {t.rich("practice.pressToOpen", { keys: () => <Keys keys={hotkeyKeycaps(hotkey)} /> })}
                </>
              ) : (
                <span>{t("practice.noShortcut")}</span>
              )}
            </Step>
            <Step n={3}>
              <span>{t("practice.pickEntry")}</span>
            </Step>
          </>
        )}
        {error && <p role="alert" className="text-[12px] text-flash-600">{error}</p>}
      </div>
    </PracticeFrame>
  );
}

function ScreenshotPractice({ hotkey }: { hotkey: string }) {
  const t = useTranslations("desktop.whatsNew");
  const [editorOn, setEditorOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    getAppSettings()
      .then((s) => setEditorOn(s.screenshotEditor))
      .catch(() => setEditorOn(null));
  }, []);
  const take = async () => {
    setBusy(true);
    setMessage(null);
    try {
      // Copy is the default action here; the editor still offers Upload,
      // which only ever runs when the user presses it.
      await captureScreenshot("area", false);
    } catch (err) {
      const text = String(err);
      if (text.includes("cancelled")) return;
      setMessage(text.includes(SCREENSHOT_EDITOR_BUSY) ? t("practice.screenshotBusy") : t("practice.screenshotFailed", { error: text }));
    } finally {
      setBusy(false);
    }
  };
  const turnOn = async () => {
    try {
      await updateScreenshotEditor(true);
      setEditorOn(true);
    } catch (err) {
      setMessage(String(err));
    }
  };
  return (
    <PracticeFrame note={LOCAL_EDITION ? t("practice.screenshotNoteLocal") : t("practice.screenshotNote")}>
      <div className="flex h-full flex-col justify-center gap-4 px-8">
        {editorOn === false ? (
          <div>
            <p className="text-[14px] font-semibold">{t("practice.annotatingOff")}</p>
            <p className="mt-1 text-[12.5px] text-ink-secondary">{t("practice.annotatingOffBody")}</p>
            <div className="mt-3">
              <SecondaryButton onClick={() => void turnOn()}>{t("practice.annotatingTurnOn")}</SecondaryButton>
            </div>
          </div>
        ) : (
          <>
            <Step n={1}>
              <span>{t("practice.takeArea")}</span>
              {hotkey && (
                <>
                  {t.rich("practice.withKeys", { keys: () => <Keys keys={hotkeyKeycaps(hotkey)} /> })}
                </>
              )}
              <SecondaryButton onClick={() => void take()} disabled={busy}>
                {busy ? t("practice.waiting") : t("practice.takeScreenshot")}
              </SecondaryButton>
            </Step>
            <Step n={2}>
              <span>{t("practice.drawArrow")}</span>
            </Step>
            <Step n={3}>
              <span>{LOCAL_EDITION ? `Press Copy image to keep it on this ${deviceName}.` : t("practice.copyOrUpload", { device: deviceName })}</span>
            </Step>
          </>
        )}
        {message && <p role="alert" className="text-[12px] text-flash-600">{message}</p>}
      </div>
    </PracticeFrame>
  );
}

function RecorderPractice({ steps, aside }: { steps: string[]; aside?: ReactNode }) {
  const t = useTranslations("desktop.whatsNew");
  const list = (
    <div className={`flex flex-col justify-center gap-3.5 ${aside ? "min-w-0" : "h-full px-8"}`}>
      {steps.map((text, i) => (
        <Step key={text} n={i + 1}>
          <span>{text}</span>
        </Step>
      ))}
      <div>
        <SecondaryButton onClick={() => void showRecorderFromWhatsNew().catch(() => {})}>{t("practice.openRecorder")}</SecondaryButton>
      </div>
    </div>
  );
  return (
    <PracticeFrame note={t("practice.ticksNote")}>
      {aside ? (
        <div className="grid h-full grid-cols-[minmax(0,1fr)_auto] items-center gap-6 pb-5 pl-8 pr-6">
          {list}
          {aside}
        </div>
      ) : (
        list
      )}
    </PracticeFrame>
  );
}

/** The pointer works anywhere on screen, this window included, so the
 * practice is the real thing; Rust ticks it the first time it paints. */
function PointerPractice() {
  const t = useTranslations("desktop.whatsNew");
  return (
    <PracticeFrame note={t("practice.ticksNote")}>
      <div className="flex h-full flex-col justify-center gap-3.5 px-8">
        <Step n={1}>
          <span>{t("practice.pointerStep1")}</span>
        </Step>
        <Step n={2}>
          <span>{t("practice.pointerStep2")}</span>
        </Step>
        <Step n={3}>
          <span>{isWindows ? t("practice.pointerStep3Windows") : t("practice.pointerStep3Mac")}</span>
        </Step>
      </div>
    </PracticeFrame>
  );
}

/**
 * Where the Local AI switch is, drawn rather than screenshotted so it stays
 * true to the recorder and costs nothing in the bundle. It flips between
 * Cloud and Local AI to show the recorder turning dark, the cue that tells
 * the two apart (lib/recorderLook.ts). The night colours are literal: this
 * window always uses the light sheet tokens.
 */
function DestinationSwitchPicture() {
  const t = useTranslations("desktop.whatsNew");
  const [night, setNight] = useState(false);
  // Follows the system's Reduce motion setting live, not only when the
  // window opened: with it on, the picture holds still on Cloud.
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let timer: number | undefined;
    const sync = () => {
      window.clearInterval(timer);
      timer = undefined;
      if (reduce?.matches) {
        setNight(false);
        return;
      }
      timer = window.setInterval(() => setNight((on) => !on), 2400);
    };
    sync();
    reduce?.addEventListener?.("change", sync);
    return () => {
      window.clearInterval(timer);
      reduce?.removeEventListener?.("change", sync);
    };
  }, []);
  const track = night ? "bg-[#1C2130]" : "bg-[#f2f2f4]";
  const pill = night ? "bg-[#252B3A] shadow-none" : "bg-white shadow-[0_2px_6px_rgba(10,13,22,0.18)]";
  const idle = night ? "text-[#9CA3B5]" : "text-ink-secondary";
  return (
    <figure className="m-0 flex w-[200px] flex-col items-center gap-2.5">
      <div
        aria-hidden
        className={`relative w-full rounded-[14px] p-2.5 shadow-[0_12px_30px_rgba(10,13,22,0.18)] ring-1 motion-safe:transition-colors motion-safe:duration-500 ${
          night ? "bg-[#11151F] text-[#EEF0F5] ring-white/10" : "bg-white text-ink-text ring-black/5"
        }`}
      >
        <div className="mb-2 flex items-center justify-between">
          <ClipyWordmark size={12} />
          <span className={`h-4 w-10 rounded-md motion-safe:transition-colors motion-safe:duration-500 ${track}`} />
          <span className="text-[11px] leading-none opacity-50">×</span>
        </div>
        <div className="flex items-center gap-1">
          <div className={`grid flex-1 grid-cols-2 gap-[2px] rounded-[9px] p-[2px] motion-safe:transition-colors motion-safe:duration-500 ${track}`}>
            <span className={`flex items-center gap-1 rounded-[7px] px-1.5 py-1 text-[9.5px] font-bold motion-safe:transition-all motion-safe:duration-500 ${night ? idle : `${pill} text-ink-text`}`}>
              <Icon name="cloudUpload" size={10} className={night ? "" : "text-flash-500"} />
              {t("practice.cloud")}
            </span>
            <span
              className={`flex items-center gap-1 rounded-[7px] px-1.5 py-1 text-[9.5px] font-bold motion-safe:transition-all motion-safe:duration-500 ${
                night ? `${pill} text-[#EEF0F5]` : `${idle} ring-2 ring-flash-500 motion-safe:animate-pulse`
              }`}
            >
              <Icon name="laptop" size={10} className={night ? "text-flash-500" : ""} />
              {t("practice.localAi")}
            </span>
          </div>
          <Icon name="info" size={10} className="opacity-50" />
          <Icon name="settings" size={10} className="opacity-50" />
        </div>
        <div className={`mt-2 h-4 rounded-md motion-safe:transition-colors motion-safe:duration-500 ${track}`} />
        <div className={`mt-1 h-4 rounded-md motion-safe:transition-colors motion-safe:duration-500 ${track}`} />
        <div className="mt-2 flex h-5 items-center justify-center rounded-md bg-flash-500 text-[9px] font-bold text-white">
          {night ? t("practice.startLocal") : t("practice.start")}
        </div>
        <svg
          className={`absolute motion-safe:transition-transform motion-safe:duration-300 ${night ? "left-[150px] top-[50px] scale-90" : "left-[150px] top-[50px]"}`}
          width="14"
          height="18"
          viewBox="0 0 14 18"
        >
          <path d="M1 1v14l3.6-3.4 2.4 5.4 2.4-1-2.4-5.3H12z" fill="#0A0D16" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      </div>
      <figcaption className="min-h-[2.75em] text-center text-[11.5px] leading-snug text-ink-secondary">
        {night ? t("practice.nightCaption") : t("practice.dayCaption")}
      </figcaption>
    </figure>
  );
}

const AGENT_COMMANDS = LOCAL_EDITION
  ? ["npm install -g @clipy/cli", "clipy record --local --source mac-screen --max 30"]
  : ["npm install -g @clipy/cli", "clipy setup claude"];

function AgentPractice() {
  const t = useTranslations("desktop.whatsNew");
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <PracticeFrame note={t("practice.agentNote")}>
      <div className="flex h-full flex-col justify-center gap-3 px-8">
        <p className="text-[13px] text-ink-secondary">
          {LOCAL_EDITION ? t("practice.agentRunLocal") : t("practice.agentRun")}
        </p>
        {AGENT_COMMANDS.map((cmd) => (
          <div key={cmd} className="flex items-center gap-3 rounded-lg bg-ink-900 px-3.5 py-2.5 font-mono text-[12.5px] text-stone-100">
            <span className="text-flash-400">$</span>
            <span className="flex-1 select-text">{cmd}</span>
            <button
              type="button"
              onClick={() => void writeText(cmd).then(() => setCopied(cmd)).catch(() => {})}
              className="rounded-md px-2 py-1 font-sans text-[11.5px] font-semibold text-stone-300 hover:bg-ink-700 hover:text-white"
            >
              {copied === cmd ? t("practice.copied") : t("practice.copy")}
            </button>
          </div>
        ))}
        <p className="text-[13px] text-ink-secondary">
          {LOCAL_EDITION ? t("practice.agentThenLocal") : t("practice.agentThen")}{" "}
          <button type="button" className="font-semibold text-flash-600 hover:underline" onClick={() => void open(AGENT_DOCS_URL).catch(() => {})}>
            {t("practice.howItWorks")}
          </button>
        </p>
      </div>
    </PracticeFrame>
  );
}

// ─── Small parts ─────────────────────────────────────────────────────────────

function Step({ n, children }: { n: number; children: ReactNode }) {
  // The number keeps its own column and lines up with the first line of
  // text. Children wrap inside the second column: with the wrap on the whole
  // row, a long sentence dropped below its number instead.
  return (
    <div className="flex items-baseline gap-2 text-[13px] text-ink-text">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-bold text-flash-600 shadow-[inset_0_0_0_1px_rgba(255,77,41,0.3)]">{n}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {keys.map((k, i) => (
        <kbd
          key={`${k}-${i}`}
          className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[5px] bg-white px-1.5 font-sans text-[11px] font-semibold text-ink-text shadow-[inset_0_0_0_1px_rgba(10,13,22,0.14),0_1px_0_rgba(10,13,22,0.14)]"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex shrink-0 items-center gap-3 pt-2">{children}</div>;
}

function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-2 py-2 text-[13px] font-medium text-ink-secondary transition-colors hover:text-ink-text focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500/60"
    >
      {children}
    </button>
  );
}

function PrimaryButton({ children, onClick, autoFocus }: { children: ReactNode; onClick: () => void; autoFocus?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      autoFocus={autoFocus}
      className="inline-flex min-w-[140px] items-center justify-center gap-2 rounded-xl bg-flash-500 px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_6px_16px_rgba(255,77,41,0.28)] transition-colors hover:bg-flash-600 focus:outline-none focus-visible:ring-4 focus-visible:ring-flash-500/25"
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-lg border border-strong bg-surface px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-text transition-colors hover:border-flash-400/60 hover:text-flash-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500/60 disabled:opacity-50"
    >
      {children}
    </button>
  );
}
