import { useTranslations } from "use-intl";
import { Icon } from "../components/recorder/ui";
import { deviceName } from "../lib/platform";

/**
 * The local edition's destination row. The official app shows a Cloud and
 * Local AI switch here; this edition has one destination, so it says where
 * the recording goes and offers no choice.
 */
export function LocalDestination() {
  const t = useTranslations("desktop.home.destination");
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-2 rounded-[14px] bg-row px-3 py-2 text-ink-text"
      title={t("localEditionHint", { device: deviceName })}
    >
      <Icon name="laptop" size={17} className="shrink-0 text-flash-500" />
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-bold leading-tight">{t("local")}</span>
        <span className="block truncate text-[11px] font-medium leading-tight opacity-80">{t("localEditionShort", { device: deviceName })}</span>
      </span>
    </div>
  );
}
