import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslations } from "use-intl";
import Home from "../routes/Home";
import { EDITION, type Edition } from "../lib/edition";

/**
 * The local edition's main window. There is no account, so Home opens with no
 * user and Local recording as the only destination, but only after the binary
 * has said it is the local edition too. A WebView built for one edition inside
 * the other's binary would call commands that are not registered there and
 * half work, so a mismatch stops here with a clear message instead.
 */

type Check =
  | { state: "checking" }
  | { state: "ok" }
  | { state: "mismatch"; binary: Edition | "unknown" };

/**
 * Asks the binary which edition it is. `get_edition` exists in both editions
 * from the release that added the local edition; an older binary does not
 * have it, which counts as "unknown" rather than an error.
 */
export async function binaryEdition(): Promise<Edition | "unknown"> {
  try {
    const answer = await invoke<unknown>("get_edition");
    return answer === "local" || answer === "cloud" ? answer : "unknown";
  } catch {
    return "unknown";
  }
}

export default function LocalEditionGate() {
  const t = useTranslations("desktop.app");
  const [check, setCheck] = useState<Check>({ state: "checking" });

  useEffect(() => {
    let active = true;
    void binaryEdition().then((binary) => {
      if (!active) return;
      setCheck(binary === EDITION ? { state: "ok" } : { state: "mismatch", binary });
    });
    return () => {
      active = false;
    };
  }, []);

  if (check.state === "ok") return <Home user={null} />;

  if (check.state === "checking") {
    return (
      <main className="popover-shell flex h-full flex-col items-center justify-center gap-3 popover-radius">
        <span className="clipy-boot-spinner" aria-hidden="true" />
        <span className="text-xs font-medium tracking-wide text-ink-secondary">{t("loading")}</span>
      </main>
    );
  }

  const binaryName =
    check.binary === "local"
      ? "Clipy Local"
      : t(check.binary === "cloud" ? "localEditionMismatch.official" : "localEditionMismatch.older", { app: "Clipy" });
  return (
    <main
      role="alert"
      className="popover-shell flex h-full flex-col items-center justify-center gap-3 px-6 text-center popover-radius"
    >
      <p className="text-[15px] font-semibold text-ink-text">{t("localEditionMismatch.title")}</p>
      <p className="text-[13px] leading-snug text-ink-secondary">
        {t("localEditionMismatch.body", { binary: binaryName })}
      </p>
    </main>
  );
}
