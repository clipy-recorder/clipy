import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";

export type IconName =
  | "monitor"
  | "cloudUpload"
  | "laptop"
  | "window"
  | "tab"
  | "region"
  | "camera"
  | "cameraOff"
  | "mic"
  | "micOff"
  | "video"
  | "photo"
  | "chevronDown"
  | "chevronLeft"
  | "close"
  | "check"
  | "effects"
  | "notes"
  | "library"
  | "more"
  | "info"
  | "settings"
  | "bulb"
  | "noise"
  | "bug"
  | "smile"
  | "external"
  | "lock"
  | "unlock"
  | "globe"
  | "sparkle"
  | "crown"
  | "paste"
  | "copy"
  | "star"
  | "starFilled"
  | "edit"
  | "trash"
  | "search"
  | "link"
  | "code"
  | "lines"
  | "mail";

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  const shared = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
  switch (name) {
    case "monitor":
      return <svg {...shared}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /></svg>;
    case "cloudUpload":
      return <svg {...shared}><path d="M7 18h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.3 9.2 4.5 4.5 0 0 0 7 18z" /><path d="M12 15.5v-5" /><path d="m9.8 12.6 2.2-2.2 2.2 2.2" /></svg>;
    case "laptop":
      return <svg {...shared}><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></svg>;
    case "window":
      return <svg {...shared}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18" /></svg>;
    case "tab":
      return <svg {...shared}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><path d="M7 4v5" /><path d="M12 4v5" /></svg>;
    case "region":
      return <svg {...shared}><rect x="7" y="7" width="14" height="12" rx="2" /><path d="M3 15V5a2 2 0 0 1 2-2h10" /></svg>;
    case "camera":
      return <svg {...shared}><path d="M15 10l5-3v10l-5-3z" /><rect x="3" y="7" width="12" height="10" rx="2" /></svg>;
    case "cameraOff":
      return <svg {...shared}><path d="m3 3 18 18" /><path d="M15 10l5-3v8" /><path d="M12 7H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h8" /></svg>;
    case "mic":
      return <svg {...shared}><path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /><path d="M9 21h6" /></svg>;
    case "micOff":
      return <svg {...shared}><path d="m4 4 16 16" /><path d="M9 9v2a3 3 0 0 0 5 2.2" /><path d="M15 9V6a3 3 0 0 0-5.2-2" /><path d="M5 11a7 7 0 0 0 11 5.7" /><path d="M12 18v3" /></svg>;
    case "video":
      return <svg {...shared}><rect x="3" y="7" width="13" height="10" rx="2" /><path d="m16 11 5-3v8l-5-3z" /></svg>;
    case "photo":
      return <svg {...shared}><path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><circle cx="12" cy="12.5" r="3.2" /></svg>;
    case "chevronDown":
      return <svg {...shared}><path d="m6 9 6 6 6-6" /></svg>;
    case "chevronLeft":
      return <svg {...shared}><path d="m15 5-7 7 7 7" /></svg>;
    case "close":
      return <svg {...shared}><path d="M6 6l12 12" /><path d="M18 6 6 18" /></svg>;
    case "check":
      return <svg {...shared}><path d="m5 12 5 5 9-10" /></svg>;
    case "effects":
      return <svg {...shared}><path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.6-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1 .9-1.8 1.9-1.8H17a4 4 0 0 0 4-4c0-4.2-4-7.5-9-7.5z" /><circle cx="7.5" cy="11" r="1" fill="currentColor" /><circle cx="10" cy="7.5" r="1" fill="currentColor" /><circle cx="14.5" cy="7.5" r="1" fill="currentColor" /></svg>;
    case "notes":
      return <svg {...shared}><path d="M6 3h9l5 5v13H6z" /><path d="M15 3v5h5" /><path d="M9 12h6" /><path d="M9 16h6" /></svg>;
    case "library":
      return <svg {...shared}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><path d="m10 13 4 2.5-4 2.5z" fill="currentColor" stroke="none" /></svg>;
    case "more":
      return <svg {...shared}><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" /></svg>;
    case "info":
      return <svg {...shared}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><circle cx="12" cy="8" r="0.6" fill="currentColor" /></svg>;
    case "settings":
      return <svg {...shared}><circle cx="12" cy="12" r="3" /><path d="M19.1 14.5a1.7 1.7 0 0 0 .4 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.4 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .4-1.9 1.7 1.7 0 0 0-1.6-1H2.5a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.4h.1a1.7 1.7 0 0 0 1-1.6V2.5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.4l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.4 1.9v.1a1.7 1.7 0 0 0 1.6 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z" /></svg>;
    case "bulb":
      return <svg {...shared}><path d="M9 18h6" /><path d="M10 21h4" /><path d="M8.5 14.5A6 6 0 1 1 15.5 14.5c-.7.7-1.5 1.5-1.5 2.5h-4c0-1-.8-1.8-1.5-2.5z" /></svg>;
    case "noise":
      return <svg {...shared}><path d="M4 10v4h3l4 3V7l-4 3z" /><path d="m15 9 5 6" /><path d="m20 9-5 6" /></svg>;
    case "bug":
      return <svg {...shared}><rect x="8" y="8" width="8" height="12" rx="4" /><path d="M9 5l1.5 2" /><path d="M15 5l-1.5 2" /><path d="M4 13h4" /><path d="M16 13h4" /><path d="M5 19l3-2" /><path d="M19 19l-3-2" /><path d="M5 8l3 2" /><path d="M19 8l-3 2" /></svg>;
    case "smile":
      return <svg {...shared}><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" /><circle cx="9" cy="10" r="0.7" fill="currentColor" /><circle cx="15" cy="10" r="0.7" fill="currentColor" /></svg>;
    case "external":
      return <svg {...shared}><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>;
    case "globe":
      return <svg {...shared}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.8 3 2.8 15 0 18" /><path d="M12 3c-2.8 3-2.8 15 0 18" /></svg>;
    case "lock":
      return <svg {...shared}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
    case "unlock":
      return <svg {...shared}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></svg>;
    case "paste":
      return <svg {...shared}><path d="M9 4h6v3H9z" /><path d="M15 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" /><path d="M12 11v6" /><path d="m9.5 14.5 2.5 2.5 2.5-2.5" /></svg>;
    case "copy":
      return <svg {...shared}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
    case "star":
      return <svg {...shared}><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z" /></svg>;
    case "starFilled":
      return <svg {...shared} fill="currentColor"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z" /></svg>;
    case "edit":
      return <svg {...shared}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>;
    case "trash":
      return <svg {...shared}><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></svg>;
    case "search":
      return <svg {...shared}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
    case "link":
      return <svg {...shared}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>;
    case "code":
      return <svg {...shared}><path d="m8 7-5 5 5 5" /><path d="m16 7 5 5-5 5" /></svg>;
    case "lines":
      return <svg {...shared}><path d="M5 6h14" /><path d="M5 12h14" /><path d="M5 18h9" /></svg>;
    case "mail":
      return <svg {...shared}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></svg>;
    case "crown":
      return <svg {...shared}><path d="M11.6 3.3a.5.5 0 0 1 .8 0l2.9 4.4a1 1 0 0 0 1.5.2l3.6-3.1a.5.5 0 0 1 .8.5l-2.6 9.9a1 1 0 0 1-1 .8H6.4a1 1 0 0 1-1-.8L2.8 5.3a.5.5 0 0 1 .8-.5l3.6 3.1a1 1 0 0 0 1.5-.2z" /><path d="M5 21h14" /></svg>;
    case "sparkle":
      return <svg {...shared}><path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z" /><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></svg>;
  }
}

/** The "On" / "Off" chip that lives at the right end of a device row. */
export function OnOffPill({
  on,
  onClick,
  disabled,
  label,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  const t = useTranslations("desktop.ui");
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`shrink-0 rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors ${
        on ? "bg-emerald-700 text-white hover:bg-emerald-800" : "bg-stone-500 text-white hover:bg-ink-600"
      } disabled:opacity-50`}
    >
      {on ? t("on") : t("off")}
    </button>
  );
}

/** Grey capsule row: icon, label, trailing control. */
export function Row({
  icon,
  label,
  onClick,
  trailing,
  children,
  title,
  className = "",
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  trailing?: ReactNode;
  children?: ReactNode;
  title?: string;
  className?: string;
}) {
  // A div with button semantics rather than a <button>: the trailing slot
  // holds its own button (the On/Off chip), and buttons cannot nest.
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      title={title}
      className={`relative flex w-full items-center gap-3 overflow-hidden rounded-2xl bg-row px-4 text-left transition-colors ${
        onClick ? "cursor-pointer hover:bg-row-hover" : ""
      } ${className}`}
      style={{ minHeight: 60 }}
    >
      {children}
      <span className="relative z-10 shrink-0 text-ink-text">
        <Icon name={icon} size={24} />
      </span>
      <span className="relative z-10 min-w-0 flex-1 truncate text-[17px] font-semibold text-ink-text">{label}</span>
      {trailing && <span className="relative z-10 shrink-0">{trailing}</span>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-flash-500" : "bg-stone-400"
      } disabled:opacity-50`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/** Settings row: optional icon tile, title + subtitle, trailing control, optional body. */
export function SettingRow({
  icon,
  title,
  subtitle,
  trailing,
  children,
  disabled,
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={`border-b border-subtle px-5 py-4 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-3">
        {icon && (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-row text-ink-text">
            <Icon name={icon} size={22} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold leading-tight text-ink-text">{title}</div>
          {subtitle && <div className="mt-0.5 text-[13px] leading-snug text-ink-secondary">{subtitle}</div>}
        </div>
        {trailing && <div className="shrink-0">{trailing}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="px-5 pb-2 pt-5 text-[19px] font-bold text-ink-text">{children}</div>;
}

/** Back arrow + title, shared by every sub-screen. */
export function ScreenHeader({ title, onBack, trailing }: { title: string; onBack: () => void; trailing?: ReactNode }) {
  const t = useTranslations("desktop.ui");
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-4">
      <button
        type="button"
        onClick={onBack}
        aria-label={t("back")}
        className="flex h-9 w-9 items-center justify-center rounded-full text-ink-text hover:bg-row"
      >
        <Icon name="chevronLeft" size={22} />
      </button>
      <h1 className="flex-1 text-[24px] font-bold tracking-tight text-ink-text">{title}</h1>
      {trailing}
    </div>
  );
}

/** Underlined tabs with a sliding indicator (the Effects / Settings tabs). */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  const index = Math.max(0, tabs.findIndex((t) => t.value === value));
  const width = 100 / tabs.length;
  return (
    <div className="relative mx-5 shrink-0 border-b border-subtle">
      <div className="flex" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={tab.value === value}
            onClick={() => onChange(tab.value)}
            className={`flex-1 whitespace-nowrap pb-3 pt-2 text-[15px] font-semibold transition-colors ${
              tab.value === value ? "text-ink-text" : "text-ink-secondary hover:text-ink-text"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <span
        aria-hidden="true"
        className="absolute bottom-[-1px] h-[3px] rounded-full bg-flash-500 transition-transform duration-200 ease-out"
        style={{ width: `${width}%`, transform: `translateX(${index * 100}%)` }}
      />
    </div>
  );
}

export interface MenuItem<T extends string> {
  value: T;
  label: string;
  hint?: string;
  icon?: IconName;
  /** Rendered under a small "More" heading (Camera only sits there). */
  more?: boolean;
  disabled?: boolean;
  /** A link at the row's right edge, shown on hover ("Select"). It
   *  goes to `onAction` instead of `onSelect`, so a row can switch mode on
   *  click and open that mode's chooser from the link. */
  action?: string;
}

/**
 * Floating menu anchored under a row. Owns its own outside-click/Escape
 * dismissal so callers only track `open`.
 */
export function Menu<T extends string>({
  open,
  onClose,
  items,
  value,
  onSelect,
  onAction,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  items: MenuItem<T>[];
  value: T;
  onSelect: (v: T) => void;
  onAction?: (v: T) => void;
  ariaLabel: string;
}) {
  const tUi = useTranslations("desktop.ui");
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    // Deferred so the click that opened the menu does not immediately close it.
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
  const primary = items.filter((i) => !i.more);
  const more = items.filter((i) => i.more);
  const renderItem = (item: MenuItem<T>) => {
    const selected = item.value === value;
    const disabled = item.disabled === true;
    const action = item.action && onAction ? item.action : null;
    const pick = () => {
      if (disabled) return;
      onSelect(item.value);
      onClose();
    };
    const act = () => {
      if (disabled) return;
      onAction?.(item.value);
      onClose();
    };
    // A div with menu-item semantics rather than a <button>: the action
    // link is its own button, and buttons cannot nest.
    return (
      <div
        key={item.value}
        role="menuitemradio"
        aria-checked={selected}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onClick={pick}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick();
          }
        }}
        className={`group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
          selected ? "bg-sheet-link-soft text-sheet-link" : "text-ink-text hover:bg-row"
        } ${disabled ? "cursor-default opacity-50" : "cursor-pointer"}`}
      >
        {item.icon && <Icon name={item.icon} size={22} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-medium">{item.label}</span>
          {item.hint && <span className="block whitespace-pre-line text-[12px] text-ink-secondary">{item.hint}</span>}
        </span>
        {/* The link and the check share one cell and swap by opacity. Hiding
            the check outright gave the hint text room to unwrap, the row got
            shorter, slid out from under the pointer, and the hover flickered
            on and off forever. */}
        {(action || selected) && (
          <span className="grid shrink-0 items-center justify-items-end">
            {action && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  act();
                }}
                className="col-start-1 row-start-1 rounded-md px-1.5 py-0.5 text-[14px] font-semibold text-sheet-link underline-offset-2 opacity-0 transition-opacity hover:underline focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                {action}
              </button>
            )}
            {selected && (
              <span
                className={`pointer-events-none col-start-1 row-start-1 flex h-6 w-6 items-center justify-center rounded-full bg-[#2f5fd0] text-white transition-opacity ${
                  action ? "group-hover:opacity-0 group-focus-within:opacity-0" : ""
                }`}
              >
                <Icon name="check" size={14} />
              </span>
            )}
          </span>
        )}
      </div>
    );
  };
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      className="absolute left-0 right-0 top-0 z-40 max-h-[420px] overflow-y-auto rounded-2xl bg-surface py-1 shadow-pop animate-pop-in"
    >
      {primary.map(renderItem)}
      {more.length > 0 && (
        <>
          <div className="px-4 pb-1 pt-3 text-[13px] font-semibold text-ink-secondary">{tUi("more")}</div>
          {more.map(renderItem)}
        </>
      )}
    </div>
  );
}

/** Compact select used inside settings rows (for example "720p ⌄"). */
export function InlineSelect<T extends string>({
  value,
  items,
  onChange,
  ariaLabel,
}: {
  value: T;
  items: Array<{ value: T; label: string; disabled?: boolean; hint?: string }>;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const current = items.find((i) => i.value === value) ?? items[0];

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (open) {
      const enabledItems = items.filter((i) => !i.disabled);
      const currentIndex = enabledItems.findIndex((i) => i.value === value);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = enabledItems[(currentIndex + 1) % enabledItems.length];
        if (next) onChange(next.value);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = enabledItems[(currentIndex - 1 + enabledItems.length) % enabledItems.length];
        if (prev) onChange(prev.value);
      } else if (e.key === "Home") {
        e.preventDefault();
        if (enabledItems[0]) onChange(enabledItems[0].value);
      } else if (e.key === "End") {
        e.preventDefault();
        if (enabledItems[enabledItems.length - 1]) onChange(enabledItems[enabledItems.length - 1].value);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
  };

  return (
    <div ref={wrapRef} className="relative" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[150px] items-center gap-1 rounded-lg px-2 py-1 text-[16px] font-semibold text-ink-text hover:bg-row focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flash-500"
      >
        <span className="truncate">{current?.label ?? ""}</span>
        <Icon name="chevronDown" size={18} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          ref={listboxRef}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          className="absolute right-0 top-full z-40 mt-1 min-w-[180px] max-w-[260px] overflow-hidden rounded-xl bg-surface py-1 shadow-pop animate-pop-in"
        >
          {items.map((item) => (
            <button
              key={item.value}
              type="button"
              role="option"
              aria-selected={item.value === value}
              disabled={item.disabled}
              onClick={() => {
                onChange(item.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className={`block w-full truncate px-3 py-2 text-left text-[15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-flash-500 ${
                item.value === value ? "bg-sheet-link-soft text-sheet-link" : "text-ink-text hover:bg-row"
              } disabled:opacity-50`}
            >
              {item.label}
              {item.hint && <span className="block text-[11px] text-ink-secondary">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  tone = "brand",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "brand" | "neutral" | "danger";
}) {
  const toneClass =
    tone === "brand"
      ? "bg-flash-500 text-white hover:bg-flash-600"
      : tone === "danger"
        ? "bg-status-error-soft text-status-error hover:bg-status-error-line/40"
        : "bg-row text-ink-text hover:bg-row-hover";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-2xl py-3.5 text-[17px] font-bold transition-colors disabled:opacity-60 ${toneClass}`}
    >
      {children}
    </button>
  );
}

export function Notice({ tone, children }: { tone: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const cls =
    tone === "error"
      ? "border-status-error-line bg-status-error-soft text-status-error"
      : tone === "warn"
        ? "border-status-warn-line bg-status-warn-soft text-status-warn"
        : tone === "ok"
          ? "border-status-ok-line bg-status-ok-soft text-status-ok"
          : "border-subtle bg-row text-ink-secondary";
  return <div className={`rounded-xl border px-3 py-2 text-[12px] leading-snug ${cls}`}>{children}</div>;
}
