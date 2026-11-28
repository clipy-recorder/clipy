import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { ClipyMark, ClipyWordmark } from "../components/ClipyWordmark";
import { Switch } from "../components/recorder/ui";
import {
  beginSignIn,
  checkDesktopPermissions,
  finishOnboarding,
  getAppSettings,
  getAuthState,
  getLoginItemStatus,
  onAuthStateChanged,
  openTraySettings,
  openPrivacySettings,
  probeScreenCaptureStrict,
  relaunchIntoSetup,
  requestDesktopPermission,
  setLaunchAtLogin,
  type AuthStateDto,
  type DesktopPermission,
  type DesktopPermissionsDto,
  type LoginItemStatus,
  type PermissionStatus,
} from "../lib/bridge";
import { hotkeyKeycaps } from "../lib/hotkey";
import { useDesktopT, type DesktopT } from "../lib/messages";
import { deviceName, isMacOS, isWindows } from "../lib/platform";
import { APP_NAME, LOCAL_EDITION } from "../lib/edition";

/**
 * First-run setup: one thing per step, in a real window.
 *
 * It is the first thing a new user sees (see `onboarding.rs`), so it also
 * carries sign-in and the "where did the app go?" step a menu-bar or tray app
 * otherwise never explains. Every step is derived from live state: reopening
 * it from Settings, or after macOS makes the user quit and reopen for Screen
 * Recording, lands on the first thing that is still missing.
 *
 * It never closes itself. Deciding to open it is the caller's job; leaving is
 * the last step's button.
 */

type StepId = "welcome" | "signin" | "screen" | "accessibility" | "media" | "find" | "done";

// The local edition has no account, so no sign-in step.
const STEPS: StepId[] = LOCAL_EDITION
  ? isWindows
    ? ["welcome", "media", "find", "done"]
    : ["welcome", "screen", "accessibility", "media", "find", "done"]
  : isWindows
    ? ["welcome", "signin", "media", "find", "done"]
    : ["welcome", "signin", "screen", "accessibility", "media", "find", "done"];

/** The local edition's stand-in for the account state: never signed in, and
 *  never asked to. */
const LOCAL_AUTH: AuthStateDto = { signed_in: false, user: null };

function stepLabel(id: StepId, t: DesktopT): string {
  if (id === "find") return t(isWindows ? "onboarding.steps.systemTray" : "onboarding.steps.menuBar");
  return t(`onboarding.steps.${id}`);
}

/** "System Settings" on the Mac, "Windows Settings" on Windows. */
function settingsName(t: DesktopT): string {
  return t(isWindows ? "onboarding.settingsName.windows" : "onboarding.settingsName.mac");
}

const PROBE_TIMEOUT_MS = 4000;
// Longer than the worst forced check: wait out an older probe, then run one.
const CHECK_TIMEOUT_MS = 2 * PROBE_TIMEOUT_MS + 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

const isGranted = (status: PermissionStatus | undefined) => status === "granted" || status === "notNeeded";

function firstStepFor(
  auth: AuthStateDto,
  permissions: DesktopPermissionsDto | null,
  screenBlocked: boolean,
): StepId {
  if (!auth.signed_in) return "welcome";
  if (isWindows) return "media";
  if (!permissions) return "screen";
  if (!isGranted(permissions.screenRecording) || screenBlocked) return "screen";
  if (!isGranted(permissions.accessibility)) return "accessibility";
  return "media";
}

interface Nav {
  step: StepId | null;
  /** Index of the furthest step reached; steps up to it can be revisited. */
  furthest: number;
  direction: "forward" | "back";
}

type NavAction = { type: "go"; to: StepId } | { type: "next" } | { type: "back" };

function navigate(state: Nav, action: NavAction): Nav {
  const from = state.step ? STEPS.indexOf(state.step) : 0;
  const to =
    action.type === "go"
      ? STEPS.indexOf(action.to)
      : action.type === "next"
        ? // Once the last step has been reached (a "Fix" from it, or Back to
          // review), moving on returns there instead of walking every step.
          state.furthest === STEPS.length - 1
          ? STEPS.length - 1
          : Math.min(from + 1, STEPS.length - 1)
        : Math.max(from - 1, 0);
  return {
    step: STEPS[to],
    furthest: Math.max(state.furthest, to),
    direction: state.step !== null && to < from ? "back" : "forward",
  };
}

export default function Onboarding() {
  const t = useDesktopT();
  // The checks below are memoised once; they read the current words here.
  const tRef = useRef(t);
  tRef.current = t;
  const [auth, setAuth] = useState<AuthStateDto | null>(null);
  const [permissions, setPermissions] = useState<DesktopPermissionsDto | null>(null);
  // macOS can report Screen Recording as granted while ScreenCaptureKit still
  // refuses (a stale grant after an update or a mid-session toggle). Treat
  // that as not granted, or setup ends and every capture dies with -3801.
  const [screenStale, setScreenStale] = useState(false);
  // Granted per TCC but no probe has answered for that grant yet (it timed
  // out or failed). Not "fine": the screen step waits, it does not advance.
  const [screenPending, setScreenPending] = useState(false);
  // How many probes in a row gave no answer for that grant. After a couple,
  // the screen step offers a restart instead of waiting on macOS forever.
  const [screenUnanswered, setScreenUnanswered] = useState(0);
  const unanswered = useRef(0);
  const [checkError, setCheckError] = useState<string | null>(null);
  // The first full check (probe included) has finished.
  const [checked, setChecked] = useState(false);
  const [{ step, furthest, direction }, dispatch] = useReducer(navigate, {
    step: null,
    furthest: 0,
    direction: "forward",
  });

  useEffect(() => {
    if (LOCAL_EDITION) {
      setAuth(LOCAL_AUTH);
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    // An auth event is newer than any read that was already in flight.
    let receivedEvent = false;
    getAuthState()
      .then((next) => active && !receivedEvent && setAuth(next))
      .catch(() => active && !receivedEvent && setAuth({ signed_in: false, user: null }));
    onAuthStateChanged((next) => {
      receivedEvent = true;
      if (active) setAuth(next);
    })
      .then((fn) => (active ? (unlisten = fn) : fn()))
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // The deep probe enumerates ScreenCaptureKit content, so it runs only when
  // its answer is needed: while picking the first step, for a grant no probe
  // has answered yet, and once on arriving at the final checklist (and on
  // "Check again"). Otherwise the last answer stands until the status
  // changes; a stale grant cannot change until Clipy restarts anyway.
  const probeWanted = useRef(true);
  const probe = useRef<Promise<boolean> | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const queued = useRef<Promise<void> | null>(null);
  // Probes are numbered as they start; `answeredProbe` is the newest one that
  // answered. The last step only trusts a probe started after it asked.
  const probesStarted = useRef(0);
  const answeredProbe = useRef(0);
  const latestPermissions = useRef<DesktopPermissionsDto | null>(null);
  const generation = useRef(0);
  const forceProbe = useRef(false);
  const lastScreenStatus = useRef<PermissionStatus | null>(null);
  const check = useCallback(async () => {
    // A check given up on (see refresh) may still resolve later; only the
    // newest one may write state.
    const id = ++generation.current;
    const current = () => id === generation.current;
    // A forced probe (the last step's confirmation) is taken by this check.
    const forced = forceProbe.current;
    forceProbe.current = false;
    try {
      const next = await checkDesktopPermissions();
      if (!current()) return true;
      const screenGranted = isMacOS && next.screenRecording === "granted";
      // A grant stays unconfirmed until a probe has answered for it. It often
      // lands while the user is in System Settings, so it is probed whether
      // or not this window has focus.
      const unconfirmed = screenGranted && lastScreenStatus.current !== "granted";
      if (!screenGranted) {
        lastScreenStatus.current = next.screenRecording;
        unanswered.current = 0;
        setScreenUnanswered(0);
        setScreenStale(false);
        setScreenPending(false);
      } else if (unconfirmed) {
        // Pending before anything shows it as granted, so a step cannot
        // auto-advance on a grant no probe has confirmed.
        setScreenPending(true);
      }
      // Rows show live state at once; the probe below can take seconds.
      latestPermissions.current = next;
      setPermissions(next);
      setCheckError(null);
      // After two unanswered probes the step offers a restart and stops
      // asking on its own (only "Check again" asks again), so probes that
      // never return cannot pile up.
      const gaveUp = unanswered.current >= 2;
      if (screenGranted && (forced || (unconfirmed && !gaveUp) || probeWanted.current)) {
        // A wedged ScreenCaptureKit must not stall setup: no answer in time
        // keeps the previous one. A probe cannot be cancelled, so a slow one
        // is waited on rather than starting a second, except by a forced
        // check, which needs an answer to a probe it started itself (after
        // giving an older one a chance to settle).
        if (forced && probe.current) await withTimeout(probe.current, PROBE_TIMEOUT_MS);
        const startedHere = forced || !probe.current;
        let pending: Promise<boolean>;
        if (!startedHere && probe.current) {
          pending = probe.current;
        } else {
          const probeId = ++probesStarted.current;
          const started: Promise<boolean> = probeScreenCaptureStrict()
            .then((value) => {
              answeredProbe.current = Math.max(answeredProbe.current, probeId);
              return value;
            })
            .finally(() => {
              if (probe.current === started) probe.current = null;
            });
          probe.current = started;
          pending = started;
        }
        const capturable = await withTimeout(pending, PROBE_TIMEOUT_MS);
        if (!current()) return true;
        if (capturable !== undefined) {
          lastScreenStatus.current = "granted";
          unanswered.current = 0;
          setScreenUnanswered(0);
          setScreenStale(!capturable);
          setScreenPending(false);
        } else if (startedHere && lastScreenStatus.current !== "granted") {
          // Counted per probe, not per check that waited on one. The probe is
          // abandoned so the next check asks afresh instead of waiting on it.
          unanswered.current += 1;
          setScreenUnanswered(unanswered.current);
          if (probe.current === pending) probe.current = null;
        }
      }
      setChecked(true);
    } catch (err) {
      if (current()) {
        setCheckError(
          tRef.current("onboarding.errors.checkFailed", {
            settings: settingsName(tRef.current),
            error: String(err),
          }),
        );
      }
    }
    return true;
  }, []);
  // One check at a time, so a slow one cannot land after a newer one. A
  // request made meanwhile (Allow, focus, a step's entry check) is queued
  // once and runs right after, so its caller still sees fresh state.
  const refresh = useCallback((): Promise<void> => {
    if (!running.current) {
      // Bounded too: an IPC that never answers must not hold up every later
      // check (or leave the last step on "Checking…" for good).
      running.current = withTimeout(check(), CHECK_TIMEOUT_MS).then((finished) => {
        running.current = null;
        // Never answered: say so, so the window can still pick a step and
        // offer System Settings instead of spinning forever.
        if (finished === undefined && latestPermissions.current === null) {
          setCheckError(tRef.current("onboarding.errors.checkNoAnswer", { settings: settingsName(tRef.current) }));
        }
      });
      return running.current;
    }
    if (!queued.current) {
      queued.current = running.current.then(() => {
        queued.current = null;
        return refresh();
      });
    }
    return queued.current;
  }, [check]);

  /** "Check again" on the screen step: asks ScreenCaptureKit afresh even
   * after the automatic probes gave up. */
  const recheckScreen = useCallback(() => {
    forceProbe.current = true;
    return refresh();
  }, [refresh]);

  /** Re-check now; true when a screen grant (if any) was confirmed by a
   * probe answer from this call or later. */
  const verify = useCallback(async (): Promise<boolean> => {
    const before = probesStarted.current;
    // A running check already read the flag, so this is taken by the next
    // check, which starts after this call (refresh queues behind a running one).
    forceProbe.current = true;
    await refresh();
    if (!isMacOS || latestPermissions.current?.screenRecording !== "granted") return true;
    return answeredProbe.current > before;
  }, [refresh]);

  // Poll only while a step shows permission state; elsewhere a focus check
  // is enough (coming back from the browser or System Settings).
  const pollWanted = useRef(true);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      if (pollWanted.current) void refresh();
    }, 1500);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  // Pick the starting step once, when both reads are in.
  // After the first full check, probe included, so the first step is not
  // picked on a grant that is still being confirmed.
  const permissionsKnown = checked || checkError !== null;
  useEffect(() => {
    if (step !== null || !auth || !permissionsKnown) return;
    const first = firstStepFor(auth, permissions, screenStale || screenPending);
    dispatch({ type: "go", to: first });
  }, [auth, permissions, permissionsKnown, screenStale, screenPending, step]);

  const goTo = useCallback((to: StepId) => dispatch({ type: "go", to }), []);
  const next = useCallback(() => dispatch({ type: "next" }), []);
  const back = useCallback(() => dispatch({ type: "back" }), []);

  // Signing in happens in the browser. When it lands, move on by ourselves.
  // Only on the transition: going Back to this step while signed in shows
  // who you are signed in as instead of bouncing straight forward again.
  const signedIn = Boolean(auth?.signed_in);
  const wasSignedIn = useRef<boolean | null>(null);
  useEffect(() => {
    if (wasSignedIn.current === false && signedIn && step === "signin") next();
    if (auth) wasSignedIn.current = signedIn;
  }, [auth, signedIn, step, next]);

  const stepIndex = step ? STEPS.indexOf(step) : -1;
  // A layout effect runs before any child's passive effects, so the last
  // step's entry check already sees it wanted.
  useLayoutEffect(() => {
    probeWanted.current = step === null;
    pollWanted.current =
      step === null || step === "screen" || step === "accessibility" || step === "media" || step === "done";
  }, [step]);

  return (
    <main className="flex h-full w-full overflow-hidden bg-surface text-ink-text">
      <Sidebar
        current={stepIndex}
        furthest={furthest}
        satisfied={(id) => stepSatisfied(id, auth, permissions, screenStale || screenPending)}
        onSelect={(i) => goTo(STEPS[i])}
      />
      <section className="relative flex min-w-0 flex-1 flex-col">
        {/* The title bar is hidden on macOS; this strip keeps the window draggable. */}
        <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-9" />
        {step === null ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="clipy-boot-spinner" aria-hidden="true" />
          </div>
        ) : (
          <div
            key={step}
            className={`flex min-h-0 flex-1 flex-col px-10 pb-7 pt-10 ${direction === "back" ? "animate-slide-back" : "animate-slide-in"}`}
          >
            {step === "welcome" && <WelcomeStep onNext={next} />}
            {!LOCAL_EDITION && step === "signin" && <SignInStep auth={auth} onBack={back} onNext={next} />}
            {(step === "screen" || step === "accessibility") && (
              <MacPermissionStep
                permission={step === "screen" ? "screen" : "accessibility"}
                permissions={permissions}
                screenStale={screenStale}
                screenPending={screenPending}
                screenUnanswered={screenUnanswered}
                checkError={checkError}
                refresh={refresh}
                recheckScreen={recheckScreen}
                onBack={back}
                onNext={next}
              />
            )}
            {step === "media" && (
              <MediaStep
                permissions={permissions}
                checkError={checkError}
                refresh={refresh}
                onBack={back}
                onNext={next}
              />
            )}
            {step === "find" && <FindStep onBack={back} onNext={next} />}
            {step === "done" && (
              <DoneStep
                auth={auth}
                permissions={permissions}
                screenStale={screenStale}
                verify={verify}
                onBack={back}
                onFix={goTo}
              />
            )}
          </div>
        )}
      </section>
    </main>
  );
}

// ─── Chrome ──────────────────────────────────────────────────────────────────

/** Whether a step's requirement is met right now, independent of visits. */
function stepSatisfied(
  id: StepId,
  auth: AuthStateDto | null,
  permissions: DesktopPermissionsDto | null,
  screenStale: boolean,
): boolean {
  switch (id) {
    case "signin":
      return Boolean(auth?.signed_in);
    case "screen":
      return isGranted(permissions?.screenRecording) && !screenStale;
    case "accessibility":
      return isGranted(permissions?.accessibility);
    case "media":
      return isGranted(permissions?.camera) && isGranted(permissions?.microphone);
    default:
      return true;
  }
}

function Sidebar({
  current,
  furthest,
  satisfied,
  onSelect,
}: {
  current: number;
  furthest: number;
  satisfied: (id: StepId) => boolean;
  onSelect: (index: number) => void;
}) {
  const t = useDesktopT();
  return (
    <nav
      aria-label={t("onboarding.sidebar.label")}
      data-tauri-drag-region
      className={`flex w-[212px] shrink-0 flex-col border-r border-subtle bg-canvas px-5 pb-6 ${isMacOS ? "pt-12" : "pt-7"}`}
    >
      <div data-tauri-drag-region className="mb-7 px-1.5">
        <ClipyWordmark size={24} />
      </div>
      <ol className="flex flex-col gap-0.5">
        {STEPS.map((id, index) => {
          // A check only for a step that is passed AND met. A passed step
          // that is not met (camera skipped, a grant revoked) keeps its
          // number, so the list never contradicts the final checklist.
          const visited = index !== current && index < Math.max(furthest, current);
          const done = visited && satisfied(id);
          const active = index === current;
          const reachable = index <= furthest;
          return (
            <li key={id}>
              <button
                type="button"
                disabled={!reachable || active}
                onClick={() => onSelect(index)}
                aria-current={active ? "step" : undefined}
                className={`flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-[13px] transition-colors ${
                  active
                    ? "bg-surface font-semibold text-ink-text shadow-[0_1px_2px_rgba(10,13,22,0.06)]"
                    : reachable
                      ? "text-ink-secondary hover:bg-raised hover:text-ink-text"
                      : "cursor-default text-ink-muted/70"
                }`}
              >
                <span
                  className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${
                    done
                      ? "bg-emerald-600 text-white"
                      : visited && id !== "media"
                        ? "border border-spark-500 text-amber-700"
                      : active
                        ? "bg-flash-500 text-white"
                        : "border border-strong text-ink-muted"
                  }`}
                >
                  {done ? <CheckIcon size={12} /> : index + 1}
                </span>
                {stepLabel(id, t)}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-auto px-1.5 text-[11px] leading-snug text-ink-muted">
        {t("onboarding.sidebar.footnote")}
      </p>
    </nav>
  );
}

function StepLayout({
  visual,
  eyebrow,
  title,
  children,
  footer,
}: {
  visual?: ReactNode;
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <>
      {visual && (
        <div className="relative h-[208px] shrink-0 overflow-hidden rounded-xl border border-subtle bg-canvas">
          {visual}
        </div>
      )}
      <div className={`min-h-0 flex-1 ${visual ? "mt-6" : ""}`}>
        {eyebrow && (
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-flash-600">{eyebrow}</p>
        )}
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
        <div className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{children}</div>
      </div>
      <div className="mt-5 flex shrink-0 items-center gap-3">{footer}</div>
    </>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  autoFocus,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  // Not the `autoFocus` attribute: React applies that only at mount, and the
  // Done button is enabled after a re-check, so Enter would land nowhere.
  // Focus when it first becomes wanted and pressable, and again whenever it
  // turns pressable after being disabled (a re-check, a failed finish), since
  // disabling it dropped focus. Nothing else moves focus, so it is never
  // pulled off a control the user is operating.
  const ref = useRef<HTMLButtonElement | null>(null);
  const focused = useRef(false);
  const wasDisabled = useRef(Boolean(disabled));
  useEffect(() => {
    const reEnabled = wasDisabled.current && !disabled;
    wasDisabled.current = Boolean(disabled);
    if (!autoFocus || disabled || (focused.current && !reEnabled)) return;
    focused.current = true;
    ref.current?.focus();
  }, [autoFocus, disabled]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="ml-auto inline-flex min-w-[148px] items-center justify-center gap-2 rounded-xl bg-flash-500 px-5 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-flash-600 focus:outline-none focus-visible:ring-4 focus-visible:ring-flash-500/25 disabled:cursor-not-allowed disabled:bg-row-hover disabled:text-ink-secondary"
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
      className="inline-flex items-center justify-center rounded-xl border border-strong bg-surface px-4 py-2.5 text-[13px] font-medium text-ink-text transition-colors hover:border-flash-400/60 hover:text-flash-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500/60 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  const t = useDesktopT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-2 py-2 text-[13px] font-medium text-ink-secondary transition-colors hover:text-ink-text focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500/60"
    >
      {t("onboarding.back")}
    </button>
  );
}

function GrantedBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700">
      <CheckIcon size={12} />
      {children}
    </span>
  );
}

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className="mt-3 flex items-center gap-3 rounded-lg border border-spark-400/30 bg-spark-50 px-3 py-2.5">
      <p className="flex-1 text-[12px] leading-snug text-amber-900">{children}</p>
      {action}
    </div>
  );
}

// ─── Steps ───────────────────────────────────────────────────────────────────

/** Ask for a permission the way the OS allows: prompt when it has not been
 * decided, otherwise (or when the prompt is refused) open its settings page.
 * Throws only when neither works. */
async function requestOrOpenSettings(
  permission: DesktopPermission,
  status: PermissionStatus | undefined,
  t: DesktopT,
  stale = false,
) {
  try {
    if (status === "denied" || stale) {
      await openPrivacySettings(permission);
    } else if (!(await requestDesktopPermission(permission))) {
      await openPrivacySettings(permission);
    }
  } catch (err) {
    try {
      await openPrivacySettings(permission);
    } catch {
      throw new Error(t("onboarding.errors.openSettingsFailed", { settings: settingsName(t), error: String(err) }));
    }
  }
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  const t = useDesktopT();
  return (
    <StepLayout
      visual={<WelcomeVisual />}
      eyebrow={t("onboarding.welcome.eyebrow")}
      title={t("onboarding.welcome.title")}
      footer={
        <PrimaryButton onClick={onNext} autoFocus>
          {t("onboarding.welcome.start")}
        </PrimaryButton>
      }
    >
      {LOCAL_EDITION
        ? t("onboarding.welcome.bodyLocal", { device: deviceName })
        : t("onboarding.welcome.body")}
    </StepLayout>
  );
}

function SignInStep({ auth, onBack, onNext }: { auth: AuthStateDto | null; onBack: () => void; onNext: () => void }) {
  const t = useDesktopT();
  const rich = useTranslations("desktop");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = Boolean(auth?.signed_in);

  const start = async () => {
    setError(null);
    setWaiting(true);
    try {
      await beginSignIn();
    } catch (err) {
      setWaiting(false);
      setError(String(err));
    }
  };

  return (
    <StepLayout
      visual={<SignInVisual waiting={waiting && !signedIn} />}
      title={signedIn ? t("onboarding.signIn.titleSignedIn") : t("onboarding.signIn.title")}
      footer={
        <>
          <BackButton onClick={onBack} />
          {signedIn ? (
            <PrimaryButton onClick={onNext} autoFocus>
              {t("onboarding.continue")}
            </PrimaryButton>
          ) : (
            <PrimaryButton onClick={() => void start()} autoFocus>
              <GoogleIcon />
              {waiting ? t("onboarding.signIn.openAgain") : t("onboarding.signIn.google")}
            </PrimaryButton>
          )}
        </>
      }
    >
      {signedIn ? (
        auth?.user?.email ? (
          <>
            {rich.rich("onboarding.signIn.signedInAs", {
              email: auth.user.email,
              b: (chunks) => <span className="font-medium text-ink-text">{chunks}</span>,
            })}
          </>
        ) : (
          <>{t("onboarding.signIn.signedIn")}</>
        )
      ) : waiting ? (
        <span className="inline-flex items-center gap-2">
          <span className="onb-spinner" aria-hidden="true" />
          {t("onboarding.signIn.waiting")}
        </span>
      ) : (
        <>{t("onboarding.signIn.body")}</>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-flash-600">
          {error}
        </p>
      )}
    </StepLayout>
  );
}

/** The words of the two macOS grant steps (`onboarding.screen`, `onboarding.accessibility`). */
function macCopy(permission: "screen" | "accessibility", t: DesktopT) {
  const key = (field: string) => t(`onboarding.${permission}.${field}`);
  return {
    title: key("title"),
    body: key("body"),
    pane: key("pane"),
    allow: key("allow"),
    granted: key("granted"),
  };
}

function MacPermissionStep({
  permission,
  permissions,
  screenStale,
  screenPending,
  screenUnanswered,
  checkError,
  refresh,
  recheckScreen,
  onBack,
  onNext,
}: {
  permission: "screen" | "accessibility";
  permissions: DesktopPermissionsDto | null;
  screenStale: boolean;
  screenPending: boolean;
  screenUnanswered: number;
  recheckScreen: () => Promise<void>;
  checkError: string | null;
  refresh: () => Promise<void>;
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useDesktopT();
  const copy = macCopy(permission, t);
  const settings = settingsName(t);
  const raw = permission === "screen" ? permissions?.screenRecording : permissions?.accessibility;
  const stale = permission === "screen" && screenStale;
  const pending = permission === "screen" && screenPending && !stale;
  const granted = isGranted(raw) && !stale && !pending;
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Move on by ourselves only when the grant arrives while this step is
  // showing. Landing here already granted (Back, or a reopen) waits for a click.
  // `null` until the first successful read: a step entered before the
  // permissions could be read must not treat that first answer as a grant
  // that just arrived.
  const known = permissions !== null;
  const wasGranted = useRef<boolean | null>(known ? granted : null);
  useEffect(() => {
    if (!known) return;
    if (granted && wasGranted.current === false) {
      const timer = window.setTimeout(onNext, 900);
      wasGranted.current = true;
      return () => window.clearTimeout(timer);
    }
    wasGranted.current = granted;
  }, [known, granted, onNext]);

  const restart = () => {
    setError(null);
    relaunchIntoSetup().catch((err) => setError(t("onboarding.errors.restartFailed", { error: String(err) })));
  };

  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestOrOpenSettings(permission, raw, t, stale);
      setAsked(true);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepLayout
      visual={<SettingsVisual pane={copy.pane} on={granted} />}
      title={copy.title}
      footer={
        <>
          <BackButton onClick={onBack} />
          {granted && <GrantedBadge>{copy.granted}</GrantedBadge>}
          {granted ? (
            <PrimaryButton onClick={onNext} autoFocus>
              {t("onboarding.continue")}
            </PrimaryButton>
          ) : (
            <PrimaryButton onClick={() => void (pending ? recheckScreen() : allow())} disabled={busy}>
              {busy
                ? t("onboarding.permission.opening")
                : pending
                  ? t("onboarding.permission.checkAgain")
                  : asked || raw === "denied" || stale
                    ? t("onboarding.permission.openSettings", { settings })
                    : copy.allow}
            </PrimaryButton>
          )}
        </>
      }
    >
      {copy.body}
      {stale && (
        <Notice action={<SecondaryButton onClick={restart}>{t("onboarding.permission.restart")}</SecondaryButton>}>
          {t("onboarding.permission.stale", { settings })}
        </Notice>
      )}
      {pending && screenUnanswered < 2 && (
        <p role="status" className="mt-3 inline-flex items-center gap-2 text-[12px] text-ink-secondary">
          <span className="onb-spinner" aria-hidden="true" />
          {t("onboarding.permission.checking")}
        </p>
      )}
      {pending && screenUnanswered >= 2 && (
        <Notice action={<SecondaryButton onClick={restart}>{t("onboarding.permission.restart")}</SecondaryButton>}>
          {t("onboarding.permission.unanswered")}
        </Notice>
      )}
      {!stale && !pending && !granted && permission === "screen" && asked && (
        <Notice action={<SecondaryButton onClick={restart}>{t("onboarding.permission.quitReopen")}</SecondaryButton>}>
          {t("onboarding.permission.switchedOn")}
        </Notice>
      )}
      {(error || checkError) && (
        <p role="alert" className="mt-2 break-words text-[12px] text-flash-600">
          {error ?? checkError}
        </p>
      )}
    </StepLayout>
  );
}

function MediaStep({
  permissions,
  checkError,
  refresh,
  onBack,
  onNext,
}: {
  permissions: DesktopPermissionsDto | null;
  checkError: string | null;
  refresh: () => Promise<void>;
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useDesktopT();
  const [busy, setBusy] = useState<DesktopPermission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cameraOn = isGranted(permissions?.camera);
  const micOn = isGranted(permissions?.microphone);

  const allow = async (permission: "camera" | "microphone") => {
    const status = permission === "camera" ? permissions?.camera : permissions?.microphone;
    setBusy(permission);
    setError(null);
    try {
      await requestOrOpenSettings(permission, status, t);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <StepLayout
      eyebrow={t("onboarding.media.eyebrow")}
      title={t("onboarding.media.title")}
      footer={
        <>
          <BackButton onClick={onBack} />
          <PrimaryButton onClick={onNext} autoFocus={cameraOn && micOn}>
            {cameraOn || micOn ? t("onboarding.continue") : t("onboarding.media.skip")}
          </PrimaryButton>
        </>
      }
    >
      {t("onboarding.media.body")}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <MediaCard
          title={t("onboarding.media.camera.title")}
          detail={t("onboarding.media.camera.detail")}
          allowLabel={t("onboarding.media.camera.allow")}
          icon={<CameraGlyph />}
          status={permissions?.camera}
          busy={busy === "camera"}
          onAllow={() => void allow("camera")}
        />
        <MediaCard
          title={t("onboarding.media.microphone.title")}
          detail={t("onboarding.media.microphone.detail")}
          allowLabel={t("onboarding.media.microphone.allow")}
          icon={<MicGlyph />}
          status={permissions?.microphone}
          busy={busy === "microphone"}
          onAllow={() => void allow("microphone")}
        />
      </div>
      {(error || checkError) && (
        <p role="alert" className="mt-2 break-words text-[12px] text-flash-600">
          {error ?? checkError}
        </p>
      )}
    </StepLayout>
  );
}

function MediaCard({
  title,
  detail,
  allowLabel,
  icon,
  status,
  busy,
  onAllow,
}: {
  title: string;
  detail: string;
  allowLabel: string;
  icon: ReactNode;
  status: PermissionStatus | undefined;
  busy: boolean;
  onAllow: () => void;
}) {
  const t = useDesktopT();
  const granted = isGranted(status);
  return (
    <div
      className={`flex flex-col rounded-xl border p-4 transition-colors ${
        granted ? "border-emerald-200 bg-emerald-50/50" : "border-subtle bg-canvas"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`flex h-10 w-10 items-center justify-center rounded-full ${granted ? "bg-emerald-100 text-emerald-700" : "bg-surface text-ink-text shadow-[0_1px_2px_rgba(10,13,22,0.08)]"}`}>
          {icon}
        </span>
        {granted && <GrantedBadge>{isWindows ? t("onboarding.media.allowed") : t("onboarding.media.on")}</GrantedBadge>}
      </div>
      <p className="mt-3 text-[14px] font-semibold text-ink-text">{title}</p>
      <p className="mt-0.5 text-[12px] leading-snug text-ink-secondary">{detail}</p>
      {!granted && (
        <button
          type="button"
          onClick={onAllow}
          disabled={busy || status === undefined}
          aria-label={
            status === "denied"
              ? t("onboarding.media.openSettingsLabel", { name: title })
              : t("onboarding.media.allowLabel", { name: title })
          }
          className="mt-3 self-start rounded-lg border border-strong bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-text transition hover:border-flash-400/60 hover:text-flash-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500/60 disabled:opacity-50"
        >
          {busy
            ? t("onboarding.media.checking")
            : status === "denied"
              ? t("onboarding.permission.openSettings", { settings: settingsName(t) })
              : allowLabel}
        </button>
      )}
    </div>
  );
}

function FindStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useDesktopT();
  const rich = useTranslations("desktop");
  // Read from Rust (the one place the default lives); no line until it lands.
  const [hotkey, setHotkey] = useState("");
  const [trayError, setTrayError] = useState<string | null>(null);
  useEffect(() => {
    getAppSettings()
      .then((settings) => settings?.hotkey && setHotkey(settings.hotkey))
      .catch(() => {});
  }, []);
  const keys = hotkeyKeycaps(hotkey);
  return (
    <StepLayout
      visual={isWindows ? <TrayVisual /> : <MenuBarVisual />}
      title={isWindows ? t("onboarding.find.titleTray") : t("onboarding.find.titleMenuBar")}
      footer={
        <>
          <BackButton onClick={onBack} />
          {isWindows && (
            <SecondaryButton
              onClick={() => {
                setTrayError(null);
                openTraySettings().catch((err) =>
                  setTrayError(t("onboarding.errors.taskbarFailed", { error: String(err) })),
                );
              }}
            >
              {t("onboarding.find.openTaskbar")}
            </SecondaryButton>
          )}
          <PrimaryButton onClick={onNext} autoFocus>
            {t("onboarding.find.gotIt")}
          </PrimaryButton>
        </>
      }
    >
      {isWindows ? (
        <>
          {rich.rich("onboarding.find.bodyWindows", {
            key: (chunks) => <span className="font-medium text-ink-text">{chunks}</span>,
          })}
        </>
      ) : (
        <>{t("onboarding.find.bodyMac")}</>
      )}
      {keys.length > 0 && (
        <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-text">
          <span className="text-ink-secondary">{t("onboarding.find.shortcut")}</span>
          <span className="inline-flex items-center gap-1">
            {keys.map((key) => (
              <kbd
                key={key}
                className="min-w-[26px] rounded-md border border-strong bg-surface px-1.5 py-0.5 text-center font-sans text-[12px] font-semibold shadow-[0_1px_0_#d0cabe]"
              >
                {key}
              </kbd>
            ))}
          </span>
        </div>
      )}
      {trayError && (
        <p role="alert" className="mt-2 break-words text-[12px] text-flash-600">
          {trayError}
        </p>
      )}
    </StepLayout>
  );
}

function DoneStep({
  auth,
  permissions,
  screenStale,
  verify,
  onBack,
  onFix,
}: {
  auth: AuthStateDto | null;
  permissions: DesktopPermissionsDto | null;
  screenStale: boolean;
  verify: () => Promise<boolean>;
  onBack: () => void;
  onFix: (step: StepId) => void;
}) {
  const t = useDesktopT();
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginItem, setLoginItem] = useState<LoginItemStatus>("unavailable");
  const [loginBusy, setLoginBusy] = useState(false);
  // The screen grant can go stale while earlier steps skip the deep probe.
  // Confirm it again on arrival before "Open the recorder" can be pressed;
  // no answer from ScreenCaptureKit is "not confirmed", never "fine".
  const [rechecked, setRechecked] = useState(false);
  const [screenConfirmed, setScreenConfirmed] = useState(false);
  // Only the newest run may write: "Check again" or a grant change starts a
  // new one, and an older, slower run must not land on top of it.
  const latestRun = useRef(0);
  const runVerify = useCallback(() => {
    const run = ++latestRun.current;
    const current = () => run === latestRun.current;
    setRechecked(false);
    void verify()
      .then((ok) => current() && setScreenConfirmed(ok))
      .finally(() => current() && setRechecked(true));
  }, [verify]);
  // A "not granted" answer confirms nothing about a grant that arrives later.
  const screenGranted = permissions?.screenRecording === "granted";
  useEffect(() => {
    runVerify();
    return () => {
      latestRun.current += 1;
    };
  }, [runVerify, screenGranted]);

  useEffect(() => {
    if (!isMacOS) return;
    getLoginItemStatus()
      .then(setLoginItem)
      .catch(() => setLoginItem("unavailable"));
  }, []);

  const signedIn = LOCAL_EDITION || Boolean(auth?.signed_in);
  const screenReady = isWindows || (isGranted(permissions?.screenRecording) && !screenStale);
  const clicksReady = isWindows || isGranted(permissions?.accessibility);
  const ready = rechecked && screenConfirmed && signedIn && screenReady && clicksReady && (permissions?.ready ?? false);

  const rows: Array<{ id: string; label: string; ok: boolean; optional?: boolean; fix: StepId; detail?: string }> = [
    { id: "signedIn", label: t("onboarding.done.rows.signedIn"), ok: signedIn, fix: "signin", detail: auth?.user?.email },
    ...(isWindows
      ? []
      : [
          { id: "screen", label: t("onboarding.done.rows.screen"), ok: screenReady, fix: "screen" as StepId },
          { id: "clicks", label: t("onboarding.done.rows.clicks"), ok: clicksReady, fix: "accessibility" as StepId },
        ]),
    {
      id: "camera",
      label: t("onboarding.done.rows.camera"),
      ok: isGranted(permissions?.camera),
      optional: true,
      fix: "media",
    },
    {
      id: "microphone",
      label: t("onboarding.done.rows.microphone"),
      ok: isGranted(permissions?.microphone),
      optional: true,
      fix: "media",
    },
  ];
  // No account in the local edition: drop the "Signed in" row.
  if (LOCAL_EDITION) rows.shift();

  // Missing rows decide the heading straight away; the re-check can only
  // turn "ready" into "almost there", never the other way round.
  const missingRow = rows.some((row) => !row.ok && !row.optional);
  const blocked = missingRow || (rechecked && !ready);

  const finish = async () => {
    setClosing(true);
    setError(null);
    try {
      // Rust saves, tells the recorder, then closes this window.
      await finishOnboarding();
    } catch (err) {
      // Say what failed rather than closing as if it worked (a failed save
      // would otherwise reopen setup on every launch).
      setClosing(false);
      setError(String(err));
    }
  };

  const toggleLogin = async () => {
    setLoginBusy(true);
    try {
      setLoginItem(await setLaunchAtLogin(loginItem !== "enabled"));
    } catch {
      // Settings > Startup shows the reason; setup should not get stuck here.
    } finally {
      setLoginBusy(false);
    }
  };

  return (
    <StepLayout
      title={blocked ? t("onboarding.done.titleBlocked") : t("onboarding.done.title")}
      footer={
        <>
          <BackButton onClick={onBack} />
          <PrimaryButton onClick={() => void finish()} disabled={!ready || closing} autoFocus={ready}>
            {!rechecked ? t("onboarding.done.checking") : closing ? t("onboarding.done.opening") : t("onboarding.done.open")}
          </PrimaryButton>
        </>
      }
    >
      <div className="flex items-start gap-4">
        <span className="onb-done-badge mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-flash-50">
          <ClipyMark size={34} />
        </span>
        <p>
          {!blocked
            ? t(
                LOCAL_EDITION
                  ? "onboarding.done.readyLocal"
                  : "onboarding.done.ready",
              )
            : missingRow
              ? t("onboarding.done.missing")
              : isMacOS
                ? t("onboarding.done.waitingMac")
                : t("onboarding.done.waitingWindows")}
        </p>
      </div>
      <ul className="mt-4 divide-y divide-subtle rounded-xl border border-subtle bg-canvas px-4">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3 py-2">
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                row.ok ? "bg-emerald-600 text-white" : row.optional ? "border border-strong" : "bg-flash-500 text-white"
              }`}
            >
              {row.ok ? <CheckIcon size={11} /> : row.optional ? null : <span className="text-[11px] font-bold">!</span>}
            </span>
            <span className="text-[13px] font-medium text-ink-text">{row.label}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-secondary">
              {row.ok ? row.detail ?? "" : row.optional ? t("onboarding.done.off") : t("onboarding.done.needsOk")}
            </span>
            {!row.ok && (
              <button
                type="button"
                onClick={() => onFix(row.fix)}
                className="text-[12px] font-medium text-flash-600 hover:underline"
              >
                {row.optional ? t("onboarding.done.turnOn") : t("onboarding.done.fix")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {rechecked && !screenConfirmed && screenReady && (
        <Notice
          action={
            <span className="flex shrink-0 gap-2">
              <SecondaryButton onClick={runVerify}>{t("onboarding.permission.checkAgain")}</SecondaryButton>
              <SecondaryButton
                onClick={() =>
                  void relaunchIntoSetup().catch((err) =>
                    setError(t("onboarding.errors.restartFailed", { error: String(err) })),
                  )
                }
              >
                {t("onboarding.permission.restart")}
              </SecondaryButton>
            </span>
          }
        >
          {t("onboarding.done.screenUnconfirmed")}
        </Notice>
      )}
      {rechecked && !isMacOS && permissions === null && (
        <Notice action={<SecondaryButton onClick={runVerify}>{t("onboarding.permission.checkAgain")}</SecondaryButton>}>
          {t("onboarding.done.windowsUnread")}
        </Notice>
      )}
      {isMacOS && loginItem !== "unavailable" && (
        <label className="mt-3 flex cursor-pointer items-center gap-3 text-[13px] text-ink-text">
          <Switch
            checked={loginItem === "enabled"}
            disabled={loginBusy}
            onChange={() => void toggleLogin()}
            label={t("onboarding.done.loginItem")}
          />
          {t("onboarding.done.loginItem")}
          {loginItem === "requiresApproval" && (
            <span className="text-[12px] text-ink-secondary">
              {t("onboarding.done.approve", { settings: settingsName(t) })}
            </span>
          )}
        </label>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-flash-600">
          {error}
        </p>
      )}
    </StepLayout>
  );
}

// ─── Visuals ─────────────────────────────────────────────────────────────────
// Drawn in markup rather than shipped as images: they follow the brand tokens,
// stay sharp at any scale and cost nothing in the bundle.

function WelcomeVisual() {
  const t = useDesktopT();
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(120%_90%_at_20%_0%,#fff1ec_0%,#faf6f0_55%)]">
      <div className="relative h-[150px] w-[250px] rounded-lg border border-subtle bg-surface shadow-pop">
        <div className="flex h-5 items-center gap-1 border-b border-subtle px-2">
          <span className="h-1.5 w-1.5 rounded-full bg-[#ff5f57]" />
          <span className="h-1.5 w-1.5 rounded-full bg-[#febc2e]" />
          <span className="h-1.5 w-1.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="space-y-2 p-3">
          <div className="h-2 w-2/3 rounded bg-row-hover" />
          <div className="h-2 w-1/2 rounded bg-row" />
          <div className="h-2 w-3/5 rounded bg-row" />
          <div className="mt-3 h-7 w-24 rounded-md bg-flash-50" />
        </div>
        <svg className="onb-cursor absolute left-[118px] top-[78px]" width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <path d="M5 3l14 7-6 2-2 6z" fill="#0a0d16" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <span className="onb-click absolute left-[112px] top-[72px] h-5 w-5 rounded-full border-2 border-flash-500" />
        <div className="absolute -bottom-4 -left-5 h-[62px] w-[62px] overflow-hidden rounded-[18px] border-[3px] border-white bg-[linear-gradient(160deg,#ffd7c8,#ff8a66)] shadow-soft">
          <div className="absolute left-1/2 top-[13px] h-[18px] w-[18px] -translate-x-1/2 rounded-full bg-[#fff3ec]" />
          <div className="absolute -bottom-3 left-1/2 h-[30px] w-[42px] -translate-x-1/2 rounded-full bg-[#fff3ec]" />
        </div>
        <div className="absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink-950 px-2.5 py-1 text-[11px] font-semibold text-white shadow-soft">
          <span className="h-1.5 w-1.5 animate-record-pulse rounded-full bg-flash-500" />
          0:42
        </div>
      </div>
      <div className="onb-float absolute right-8 top-9 rounded-lg border border-subtle bg-surface px-3 py-2 shadow-pop">
        <p className="text-[11px] font-semibold text-ink-text">{LOCAL_EDITION ? t("onboarding.visuals.arecSaved") : t("onboarding.visuals.linkCopied")}</p>
        <p className="text-[11px] text-ink-secondary">
          {LOCAL_EDITION
            ? "recording.arec"
            : "clipy.online/video/…"}
        </p>
      </div>
      <div className="onb-float-delayed absolute bottom-8 right-10 flex items-center gap-2 rounded-lg border border-subtle bg-surface px-3 py-2 shadow-pop">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-ink-950 text-[11px] font-bold text-white">{">_"}</span>
        <p className="text-[11px] font-medium text-ink-text">{t("onboarding.visuals.agentRead")}</p>
      </div>
    </div>
  );
}

function SignInVisual({ waiting }: { waiting: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-6">
      <div className="flex h-[76px] w-[76px] items-center justify-center rounded-[22px] bg-surface shadow-pop">
        <ClipyMark size={48} />
      </div>
      <div className="relative h-[2px] w-[120px] bg-[repeating-linear-gradient(90deg,#d0cabe_0_6px,transparent_6px_12px)]">
        <span className={`absolute -top-[4px] h-[10px] w-[10px] rounded-full bg-flash-500 ${waiting ? "onb-travel" : "left-1/2 -translate-x-1/2"}`} />
      </div>
      <div className="w-[150px] overflow-hidden rounded-lg border border-subtle bg-surface shadow-pop">
        <div className="flex h-5 items-center gap-1 border-b border-subtle bg-row px-2">
          <span className="h-1.5 w-1.5 rounded-full bg-stone-300" />
          <span className="h-1.5 w-1.5 rounded-full bg-stone-300" />
          <span className="ml-1 h-2 flex-1 rounded-sm bg-surface" />
        </div>
        <div className="flex flex-col items-center gap-2 px-3 py-4">
          <GoogleIcon size={20} />
          <div className="h-1.5 w-16 rounded bg-row-hover" />
          <div className="h-5 w-full rounded-md bg-flash-500/90" />
        </div>
      </div>
    </div>
  );
}

const SETTINGS_SIDEBAR = ["general", "appearance", "privacy", "desktopDock", "displays"] as const;

function SettingsVisual({ pane, on }: { pane: string; on: boolean }) {
  const t = useDesktopT();
  return (
    <div className="absolute inset-0 flex items-end justify-center pt-5">
      <div className="flex h-[188px] w-[440px] overflow-hidden rounded-t-xl border border-b-0 border-subtle bg-surface shadow-pop">
        <div className="w-[140px] shrink-0 border-r border-subtle bg-row/70 p-2.5">
          <div className="mb-3 flex gap-1">
            <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
            <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
            <span className="h-2 w-2 rounded-full bg-[#28c840]" />
          </div>
          {SETTINGS_SIDEBAR.map((item) => (
            <div
              key={item}
              className={`mb-1 truncate rounded px-1.5 py-1 text-[11px] ${item === "privacy" ? "bg-[#0a84ff] font-medium text-white" : "text-ink-secondary"}`}
            >
              {t(`onboarding.visuals.settings.${item}`)}
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1 p-3.5">
          <p className="text-[11px] text-ink-muted">‹ {t("onboarding.visuals.settings.privacy")}</p>
          <p className="mt-0.5 truncate text-[13px] font-semibold text-ink-text">{pane}</p>
          <div className="mt-3 divide-y divide-subtle rounded-lg border border-subtle">
            <div className="relative flex items-center gap-2 px-2.5 py-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface shadow-[0_0_0_1px_#e6e2da]">
                <ClipyMark size={18} />
              </span>
              <span className="flex-1 text-[12px] font-medium text-ink-text">{APP_NAME}</span>
              <span className={`relative h-[18px] w-[32px] rounded-full ${on ? "bg-[#0a84ff]" : "onb-switch bg-stone-300"}`}>
                <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow ${on ? "left-[16px]" : "onb-knob left-[2px]"}`} />
              </span>
              {!on && (
                <svg className="onb-pointer absolute right-1 top-5" width="16" height="16" viewBox="0 0 24 24" aria-hidden>
                  <path d="M5 3l14 7-6 2-2 6z" fill="#0a0d16" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            {[0.55, 0.4].map((w) => (
              <div key={w} className="flex items-center gap-2 px-2.5 py-2 opacity-50">
                <span className="h-6 w-6 rounded-md bg-row-hover" />
                <span className="h-2 rounded bg-row-hover" style={{ width: `${w * 100}%` }} />
                <span className="ml-auto h-[18px] w-[32px] rounded-full bg-stone-300" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuBarVisual() {
  const t = useDesktopT();
  return (
    <div className="absolute inset-0 bg-[linear-gradient(160deg,#ffe2d6_0%,#f7d4e6_45%,#d9d6f5_100%)]">
      <div className="flex h-7 items-center gap-3 bg-white/70 px-3 text-[11px] font-medium text-ink-text backdrop-blur">
        <span className="font-semibold">Finder</span>
        <span className="text-ink-secondary">{t("onboarding.visuals.menu.file")}</span>
        <span className="text-ink-secondary">{t("onboarding.visuals.menu.edit")}</span>
        <span className="text-ink-secondary">{t("onboarding.visuals.menu.view")}</span>
        <span className="ml-auto flex items-center gap-3">
          <span className="relative flex h-5 w-6 items-center justify-center rounded bg-ink-950/10">
            <span className="onb-ring absolute inset-[-4px] rounded-md border-2 border-flash-500" />
            <ClipyMark size={16} />
          </span>
          <WifiGlyph />
          <BatteryGlyph />
          <span>{t("onboarding.visuals.menuBarClock")}</span>
        </span>
      </div>
      <PopoverMock className="absolute right-[92px] top-9" />
      <div className="absolute left-6 top-14 max-w-[150px] text-[12px] font-medium leading-snug text-ink-text/80">
        {t("onboarding.visuals.menuBarHint")}
      </div>
    </div>
  );
}

// Windows 11 hides a new tray icon behind the ^ overflow, so the picture is
// the fix rather than the destination: Clipy is dragged out of the overflow
// onto the taskbar, then the recorder opens above it. Positions are fixed
// pixels so the drag lands exactly on the slot.
function TrayVisual() {
  const rich = useTranslations("desktop");
  return (
    <div className="absolute inset-0 overflow-hidden bg-[linear-gradient(160deg,#dfe9f7_0%,#e8e2f6_55%,#f6e3dc_100%)]">
      <div className="absolute left-6 top-6 max-w-[190px] text-[12px] font-medium leading-snug text-ink-text/80">
        {rich.rich("onboarding.visuals.trayHint", {
          key: (chunks) => <span className="font-semibold text-ink-text">{chunks}</span>,
        })}
      </div>

      {/* The ^ overflow flyout, open. */}
      <div className="onb-flyout absolute bottom-[50px] right-[112px] h-[64px] w-[96px] rounded-lg border border-white/70 bg-white/90 shadow-pop backdrop-blur">
        {[0, 1, 2].map((col) =>
          [0, 1].map((row) => (
            <span
              key={`${col}-${row}`}
              className={`absolute h-6 w-6 rounded-md ${
                col === 1 && row === 0 ? "border border-dashed border-stone-300" : "bg-ink-950/10"
              }`}
              style={{ left: 8 + col * 28, top: 8 + row * 28 }}
            />
          )),
        )}
      </div>

      <PopoverMock className="onb-tray-pop absolute bottom-[52px] right-[48px]" />

      <div className="absolute inset-x-0 bottom-0 h-10 border-t border-white/60 bg-white/75 backdrop-blur">
        <div className="absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-2">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`h-6 w-6 rounded-md ${i === 0 ? "bg-[#0a84ff]/80" : "bg-ink-950/10"}`} />
          ))}
        </div>
        <span className="absolute bottom-[10px] right-[134px] text-[12px] font-semibold text-ink-secondary">^</span>
        <span className="absolute bottom-2 right-[100px] h-6 w-6 rounded">
          <span className="onb-slot-ring absolute inset-[-3px] rounded-md border-2 border-flash-500" />
        </span>
        <span className="absolute bottom-[13px] right-[74px] text-ink-text">
          <WifiGlyph />
        </span>
        <span className="absolute bottom-[5px] right-3 text-right text-[11px] leading-tight text-ink-text">
          {rich("onboarding.visuals.trayTime")}
          <br />
          {rich("onboarding.visuals.trayDay")}
        </span>
      </div>
      {/* Clipy, travelling from the flyout to its taskbar slot. */}
      <span className="onb-drag absolute z-10 bottom-[82px] right-[148px] flex h-6 w-6 items-center justify-center rounded-md bg-white shadow-soft">
        <ClipyMark size={16} />
        <svg className="absolute -bottom-3 -right-3" width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <path d="M5 3l14 7-6 2-2 6z" fill="#0a0d16" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  );
}

function PopoverMock({ className }: { className: string }) {
  const t = useDesktopT();
  return (
    <div className={`onb-pop w-[132px] rounded-xl border border-subtle bg-surface p-2.5 shadow-pop ${className}`}>
      <div className="mb-2 flex items-center justify-between">
        <ClipyWordmark size={12} />
        <span className="h-1.5 w-1.5 rounded-full bg-stone-300" />
      </div>
      <div className="mb-1.5 h-5 rounded-md bg-row" />
      <div className="mb-2.5 h-5 rounded-md bg-row" />
      <div className="flex h-6 items-center justify-center rounded-lg bg-flash-500 text-[11px] font-semibold text-white">
        {t("onboarding.visuals.startRecording")}
      </div>
    </div>
  );
}

// ─── Glyphs ──────────────────────────────────────────────────────────────────

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}

function GoogleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className="shrink-0 rounded-full bg-white p-[1px]">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function CameraGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="6" width="13" height="12" rx="2.5" />
      <path d="m16 10 5-3v10l-5-3" />
    </svg>
  );
}

function MicGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}

function WifiGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0" />
      <circle cx="12" cy="19.5" r="1" fill="currentColor" />
    </svg>
  );
}

function BatteryGlyph() {
  return (
    <svg width="20" height="12" viewBox="0 0 28 14" fill="none" aria-hidden>
      <rect x="0.75" y="0.75" width="23.5" height="12.5" rx="3.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="3" width="16" height="8" rx="1.5" fill="currentColor" />
      <path d="M26 5v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
