import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { getTalkSettings, setTalkSettings, type TalkKey, type TalkPaste, type TalkSettingsDto } from "../../lib/bridge";
import { InlineSelect, SectionTitle, SettingRow } from "./ui";

const KEYS: TalkKey[] = ["off", "fn", "right_option"];
const PASTES: TalkPaste[] = ["words_and_path", "path", "words"];

/**
 * Talk to your agent: which key starts a talk take and what is pasted when it
 * ends. Rendered only where the app supports it (macOS for now).
 */
export function TalkSettings() {
  const t = useTranslations("desktop.settings.talk");
  const [settings, setSettings] = useState<TalkSettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getTalkSettings()
      .then(setSettings)
      .catch((err) => setError(String(err)));
  }, []);
  useEffect(refresh, [refresh]);
  // The Fn setting can change in System Settings while this is open.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const save = useCallback(
    async (change: { key?: TalkKey; paste?: TalkPaste }) => {
      setError(null);
      try {
        await setTalkSettings(change);
        refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  if (!settings?.supported) return null;
  const fnClash = settings.key === "fn" && settings.fnUsage !== "nothing";

  return (
    <>
      <SectionTitle>{t("title")}</SectionTitle>
      <p className="px-5 pb-1 text-[12px] leading-snug text-ink-secondary">{t("intro")}</p>
      <SettingRow
        title={t("key.title")}
        subtitle={t("key.subtitle")}
        trailing={
          <InlineSelect<TalkKey>
            value={settings.key}
            ariaLabel={t("key.title")}
            items={KEYS.map((key) => ({ value: key, label: t(`key.options.${key}`) }))}
            onChange={(key) => void save({ key })}
          />
        }
      />
      {fnClash && <p className="px-5 pt-2 text-[12px] leading-snug text-flash-600">{t("fnClash")}</p>}
      <SettingRow
        title={t("paste.title")}
        subtitle={t(`paste.hints.${settings.paste}`)}
        disabled={settings.key === "off"}
        trailing={
          <InlineSelect<TalkPaste>
            value={settings.paste}
            ariaLabel={t("paste.title")}
            items={PASTES.map((paste) => ({ value: paste, label: t(`paste.options.${paste}`) }))}
            onChange={(paste) => void save({ paste })}
          />
        }
      />
      {error && <p className="px-5 pt-2 text-[12px] text-flash-600">{error}</p>}
    </>
  );
}
