import { useCallback, useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import { useFormatter, useTranslations } from "use-intl";
import { deviceName, isWindows } from "../lib/platform";
import { LOCAL_EDITION } from "../lib/edition";

type LocalRecording = {
  id: string;
  stage: string;
  message: string;
  directory: string;
  arec_path: string | null;
  updated_at_ms?: number;
  bytes: number;
  kept: boolean;
  expires_at_ms: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an unkept local recording stays, as `local` in Rust clears it. */
const RETENTION_DAYS = 14;

type LocalT = ReturnType<typeof useTranslations<"desktop.local">>;

const formatBytes = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

// Days rather than a date: the question a viewer has is "how long have I got",
// and a recording made minutes ago should not read as clearing "on the 28th".
const formatExpiry = (t: LocalT, row: LocalRecording) => {
  if (row.kept) return t("expiry.kept");
  if (!row.expires_at_ms) return null;
  const days = Math.ceil((row.expires_at_ms - Date.now()) / DAY_MS);
  if (days <= 0) return t("expiry.soon");
  return t("expiry.days", { days });
};

/**
 * `listAll` is the recorder strip's Local library sheet: every recording at
 * once, and an empty state instead of nothing.
 */
export default function LocalModePanel({ signedIn, listAll = false }: { signedIn: boolean; listAll?: boolean }) {
  const t = useTranslations("desktop.local");
  const format = useFormatter();
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<LocalRecording[]>([]);
  const [showAll, setShowAll] = useState(listAll);
  const [loaded, setLoaded] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const refreshSeq = useRef(0);
  const refresh = useCallback(() => {
    const seq = ++refreshSeq.current;
    return invoke<LocalRecording[]>("list_local_recordings")
      .then((rows) => {
        if (seq !== refreshSeq.current) return;
        setRecordings(rows);
        setReadError(null);
      })
      .catch((err) => {
        if (seq !== refreshSeq.current) return;
        setReadError(String(err));
      })
      .finally(() => {
        if (seq === refreshSeq.current) setLoaded(true);
      });
  }, []);
  useEffect(() => {
    let active = true;
    const poll = () => { if (active) void refresh(); };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh]);

  const signIn = async () => {
    setBusy(true); setActionError(null);
    try {
      await invoke("begin_sign_in");
    } catch (err) { setActionError(String(err)); }
    finally { setBusy(false); }
  };
  const action = async (command: string, row: LocalRecording) => {
    setActionError(null);
    try { await invoke(command, { id: row.id }); }
    catch (err) { setActionError(String(err)); }
  };
  const copyPath = async (path: string) => {
    setActionError(null);
    try { await writeText(path); setCopiedPath(path); }
    catch (err) { setActionError(String(err)); }
  };
  const setKept = async (row: LocalRecording) => {
    setActionError(null);
    try { await invoke("set_local_recording_kept", { id: row.id, kept: !row.kept }); await refresh(); }
    catch (err) { setActionError(String(err)); }
  };
  const remove = async (row: LocalRecording) => {
    setActionError(null);
    setConfirmingId(null);
    try { await invoke("delete_local_recording", { id: row.id }); await refresh(); }
    catch (err) { setActionError(String(err)); }
  };
  const error = actionError ?? readError;
  const total = recordings.reduce((sum, row) => sum + row.bytes, 0);
  const recordingCard = (row: LocalRecording) => (
    <div key={row.id} className="border-t border-subtle pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <p role="status">{row.stage === "ready" ? t("status.ready") : row.arec_path ? t("status.saved", { device: deviceName }) : row.stage === "failed" ? t("status.failed") : t("status.recording", { device: deviceName })}</p>
        <p className="shrink-0 text-ink-secondary">{formatBytes(row.bytes)}</p>
      </div>
      <p className="text-ink-secondary">
        {showAll && row.updated_at_ms && `${format.dateTime(new Date(row.updated_at_ms), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · `}
        {formatExpiry(t, row)}
      </p>
      {row.stage !== "ready" && <p className="mt-1 text-ink-secondary">{row.stage === "failed" ? row.message : t("preparing")}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {row.arec_path && <button type="button" className="rounded-sm bg-row-hover px-2 py-1 font-semibold text-ink-text" onClick={() => void copyPath(row.arec_path!)}>{copiedPath === row.arec_path ? t("pathCopied") : t("copyArecPath")}</button>}
        <button type="button" className="text-flash-600" onClick={() => void action("show_local_viewer", row)}>{t("open")}</button>
        <button type="button" className="text-flash-600" onClick={() => void action("open_local_recording", row)}>{isWindows ? t("showInExplorer") : t("showInFinder")}</button>
        {row.stage === "failed" && (LOCAL_EDITION || signedIn) && <button type="button" className="text-flash-600" onClick={() => void action("retry_local_recording", row)}>{t("retry")}</button>}
        <button type="button" className="text-flash-600" onClick={() => void setKept(row)}>{row.kept ? t("stopKeeping") : t("keep")}</button>
        {confirmingId === row.id
          ? (<><button type="button" className="font-semibold text-flash-600" onClick={() => void remove(row)}>{t("moveToTrash")}</button>
              <button type="button" className="text-ink-secondary" onClick={() => setConfirmingId(null)}>{t("cancel")}</button></>)
          : <button type="button" className="text-ink-secondary" onClick={() => setConfirmingId(row.id)}>{t("delete")}</button>}
      </div>
    </div>
  );
  if (signedIn && !error && recordings.length === 0) {
    return listAll && loaded ? <p className="px-1 py-6 text-center text-[13px] text-ink-secondary">{t("empty")}</p> : null;
  }

  return (
    <section aria-label={t("sectionLabel")} className="mx-3.5 mt-2 space-y-2 rounded-lg border border-subtle bg-row p-2.5 text-[11px] text-ink-secondary">
      {!LOCAL_EDITION && !signedIn && <button type="button" onClick={() => void signIn()} disabled={busy}
        className="text-flash-600 disabled:opacity-40">{busy ? t("openingSignIn") : t("signInToRecord")}</button>}
      {error && <p role="alert" className="text-flash-600">{error}</p>}
      {recordings.length > 0 && <p className="text-ink-secondary">{t("totalOnDevice", { size: formatBytes(total), device: deviceName, days: RETENTION_DAYS })}</p>}
      {/* Windows has no on-device speech engine: say where the audio goes. */}
      {!LOCAL_EDITION && isWindows && <p className="text-ink-secondary">{t("windowsAudio")}</p>}
      {listAll && recordings.map(recordingCard)}
      {!listAll && recordings[0] && recordingCard(recordings[0])}
      {!listAll && recordings.length > 1 && <button type="button" className="text-flash-600" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? t("hidePrevious") : t("previous", { count: recordings.length - 1 })}</button>}
      {!listAll && showAll && <div className="max-h-40 space-y-2 overflow-y-auto">{recordings.slice(1).map(recordingCard)}</div>}
    </section>
  );
}
