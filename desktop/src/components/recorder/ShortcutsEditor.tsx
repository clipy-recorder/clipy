import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
  getRecorderShortcuts,
  setRecorderShortcut,
  type RecorderShortcutAction,
  type RecorderShortcutDto,
} from "../../lib/bridge";
import { formatHotkey, hotkeyKeycaps as keycaps } from "../../lib/hotkey";
import { Icon } from "./ui";

/** Rows in order; label and hint are `desktop.shortcuts.rows.<action>`. */
const ROWS: RecorderShortcutAction[] = [
  "screenshot_area",
  "screenshot_display",
  "annotation",
  "pause",
  "mic",
  "camera",
  "clipboard_history",
];

function hotkeyFromEvent(e: KeyboardEvent): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("Meta");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (parts.length === 0) return null;
  parts.push(e.code);
  return parts.join("+");
}

/**
 * Shortcut rows: label, keycaps, a clear ×. Click the field and press
 * the keys. The start/stop hotkey lives in the same list and reuses the
 * existing update path; the screenshot keys and recording actions go through
 * `set_recorder_shortcut`.
 */
export function ShortcutsEditor({
  stopHotkey,
  onStopHotkeyChange,
  onChange,
}: {
  stopHotkey: string;
  onStopHotkeyChange: (hotkey: string) => Promise<void>;
  /** Called with the fresh rows after any change. */
  onChange?: (rows: RecorderShortcutDto[]) => void;
}) {
  const t = useTranslations("desktop.shortcuts");
  const [rows, setRows] = useState<RecorderShortcutDto[]>([]);
  const [listening, setListening] = useState<RecorderShortcutAction | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    getRecorderShortcuts()
      .then((next) => {
        setRows(next);
        onChange?.(next);
      })
      .catch((err) => setError(String(err)));
  }, [onChange]);
  useEffect(refresh, [refresh]);

  const commit = useCallback(
    async (target: RecorderShortcutAction | "stop", hotkey: string) => {
      setBusy(true);
      setError(null);
      try {
        if (target === "stop") {
          if (!hotkey) throw new Error(t("stopNeedsKey"));
          await onStopHotkeyChange(hotkey);
        } else {
          await setRecorderShortcut(target, hotkey);
        }
        refresh();
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
        setListening(null);
      }
    },
    [onStopHotkeyChange, refresh, t],
  );

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setListening(null);
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && listening !== "stop") {
        void commit(listening, "");
        return;
      }
      const hotkey = hotkeyFromEvent(e);
      if (hotkey) void commit(listening, hotkey);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, commit]);

  const field = (
    target: RecorderShortcutAction | "stop",
    hotkey: string,
    clearable: boolean,
    warningId?: string,
  ) => {
    const active = listening === target;
    const caps = keycaps(hotkey);
    return (
      <div
        className={`flex h-11 w-full items-center gap-2 rounded-xl border bg-surface px-2.5 transition-colors ${
          active ? "border-flash-500 ring-2 ring-flash-500/25" : "border-subtle"
        }`}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => setListening(active ? null : target)}
          aria-describedby={warningId}
          aria-label={(() => {
            const name = target === "stop" ? t("stopName") : t(`rows.${target}.label`);
            return hotkey ? t("fieldLabelSet", { name, hotkey: formatHotkey(hotkey) }) : t("fieldLabel", { name });
          })()}
          className="flex h-full min-w-0 flex-1 items-center text-left"
        >
          {active ? (
            <span className="text-[12px] text-ink-secondary">{t("pressKeys")}</span>
          ) : caps.length === 0 ? (
            <span className="text-[12px] text-ink-secondary">{t("clickToSet")}</span>
          ) : (
            <span className="flex items-center gap-1">
              {caps.map((cap, i) => (
                <kbd
                  key={`${cap}-${i}`}
                  className="inline-flex h-7 min-w-[26px] items-center justify-center whitespace-nowrap rounded-md border border-strong bg-row px-1.5 font-sans text-[12px] font-semibold text-ink-text"
                >
                  {cap}
                </kbd>
              ))}
            </span>
          )}
        </button>
        {clearable && hotkey && !active && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void commit(target as RecorderShortcutAction, "")}
            aria-label={t("clearLabel")}
            title={t("clear")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-text text-canvas hover:bg-ink-text/80"
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div>
      <Row label={t("startStop")} hint={t("worksAnywhere")}>
        {field("stop", stopHotkey, false)}
      </Row>
      {ROWS.map((action) => {
        const current = rows.find((r) => r.action === action);
        // A key is saved but the OS did not register it, usually because another app holds it.
        const notWorking = !!current?.hotkey && !current.registered;
        const warningId = notWorking ? `shortcut-warning-${action}` : undefined;
        return (
          <Row
            key={action}
            label={t(`rows.${action}.label`)}
            hint={t(`rows.${action}.hint`)}
            warning={notWorking ? t("notWorking") : undefined}
            warningId={warningId}
          >
            {field(action, current?.hotkey ?? "", true, warningId)}
          </Row>
        );
      })}
      {error && <p className="px-5 pb-2 text-[12px] text-flash-600">{error}</p>}
    </div>
  );
}

function Row({
  label,
  hint,
  warning,
  warningId,
  children,
}: {
  label: string;
  hint: string;
  /** Shown under the field when the key is set but the OS did not register it. */
  warning?: string;
  /** The field's `aria-describedby` points at this id. */
  warningId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-2">
      <div className="w-[96px] shrink-0">
        <div className="text-[14px] font-semibold leading-tight text-ink-text">{label}</div>
        <div className="text-[11px] leading-snug text-ink-secondary">{hint}</div>
      </div>
      <div className="min-w-0 flex-1">
        {children}
        {warning && (
          <p id={warningId} className="mt-1 text-[11px] leading-snug text-flash-600">
            {warning}
          </p>
        )}
      </div>
    </div>
  );
}
