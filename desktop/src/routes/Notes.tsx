import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslations } from "use-intl";
import { LazyStore } from "@tauri-apps/plugin-store";
import { hideNotesWindow } from "../lib/bridge";

const settingsStore = new LazyStore("settings.json");
const RECORDING_NOTES_KEY = "recording_notes";
const FONT_SIZES = [14, 17, 21, 26] as const;

const FONT_INDEX_KEY = "note_font_index";
const clampFont = (i: number) => Math.min(FONT_SIZES.length - 1, Math.max(0, i));  
/**
 * The sticky note. Its own always-on-top window, excluded from every
 * capture: a teleprompter the user reads from, never part of the recording.
 * Text lives in the shared settings store so the recorder panel can tell
 * whether there is anything to show.
 */
export default function Notes() {
  const t = useTranslations("desktop.notes");
  const [text, setText] = useState("");
  const [fontIndex, setFontIndex] = useState(1);
  const loadedRef = useRef(false);
  const localEditRef = useRef(false);
  const userChangedFontRef = useRef(false);
  
  useEffect(() => {
    let disposed = false;
    settingsStore
      .get<string>(RECORDING_NOTES_KEY)
      .then((value) => {
        if (!disposed && typeof value === "string") setText(value);
      })
      .catch(() => {})
      .finally(() => {
        loadedRef.current = true;
      });
    const off = settingsStore.onKeyChange<string>(RECORDING_NOTES_KEY, (value) => {
      if (disposed || localEditRef.current) return;
      setText(typeof value === "string" ? value : "");
    });
    return () => {
      disposed = true;
      void off.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!loadedRef.current || !localEditRef.current) return;
    const timer = window.setTimeout(() => {
      settingsStore
        .set(RECORDING_NOTES_KEY, text)
        .then(() => settingsStore.save())
        .catch(() => {})
        .finally(() => {
          localEditRef.current = false;
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [text]);

  useEffect(() => {
  let disposed = false;
  settingsStore
    .get<number>(FONT_INDEX_KEY)
    .then((value) => {
      if (disposed || userChangedFontRef.current) return;
      if (typeof value === "number" && Number.isInteger(value)) {
        setFontIndex(clampFont(value));
      }
    })
    .catch(() => {});
  return () => {
    disposed = true;
  };
}, []);

const changeFont = (delta: number) => {
  const next = clampFont(fontIndex + delta);
  if (next === fontIndex) return;
  userChangedFontRef.current = true;
  setFontIndex(next);
  settingsStore
    .set(FONT_INDEX_KEY, next)
    .then(() => settingsStore.save())
    .catch(() => {});
};

useEffect(() => {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      changeFont(1);
    } else if (e.key === "-") {
      e.preventDefault();
      changeFont(-1);
    }
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
});
  
  const fontSize = FONT_SIZES[fontIndex];
  const pitch = Math.round(fontSize * 1.65);

  return (
    <main style={{ "--note-pitch": `${pitch}px` } as CSSProperties} className="clipy-note-paper flex h-screen w-screen flex-col overflow-hidden rounded-2xl text-[#2b2300]">
      <header data-tauri-drag-region className="flex cursor-grab select-none items-center gap-1 px-3 pb-1 pt-2.5">
        <span data-tauri-drag-region className="flex-1 text-[11px] font-bold uppercase tracking-wide text-[#8a6d00]">
          {t("title")}
        </span>
        <button
          type="button"
          onClick={() => changeFont(-1)}
          disabled={fontIndex === 0}
          aria-label={t("smaller")}
          className="h-6 w-6 rounded-md text-[13px] font-semibold text-[#8a6d00] hover:bg-[#f0e18a] disabled:opacity-40"
        >
          A-
        </button>
        <button
          type="button"
          onClick={() => changeFont(1)}
          disabled={fontIndex === FONT_SIZES.length - 1}
          aria-label={t("larger")}
          className="h-6 w-6 rounded-md text-[13px] font-semibold text-[#8a6d00] hover:bg-[#f0e18a] disabled:opacity-40"
        >
          A+
        </button>
        <button
          type="button"
          // The webview is reused across hide/show, so drop focus here or a
          // Space press on the reopened note would hide it again.
          onClick={(e) => {
            e.currentTarget.blur();
            void hideNotesWindow().catch(() => {});
          }}
          aria-label={t("hide")}
          className="ml-1 h-6 w-6 rounded-md text-[15px] leading-none text-[#8a6d00] hover:bg-[#f0e18a]"
        >
          ×
        </button>
      </header>
      <textarea
        value={text}
        onChange={(e) => {
          localEditRef.current = true;
          setText(e.target.value);
        }}
        placeholder={t("placeholder")}
        spellCheck={false}
        style={{ fontSize, lineHeight: `${pitch}px` }}
        className="clipy-scroll min-h-0 flex-1 resize-none bg-transparent px-4 pb-3 text-[#2b2300] placeholder:text-[#a08a30] focus:outline-none"
      />
      <p className="px-4 pb-2.5 text-[11px] text-[#a08a30]">Only you can see this. Never part of the recording.</p>
    </main>
  );
}
