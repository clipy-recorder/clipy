/**
 * Which app this WebView is built into.
 *
 * - `"cloud"`: the official Clipy app (`vite build`).
 * - `"local"`: the local edition (`vite build --mode oss`): no Clipy account,
 *   no upload, no updater, and Local recording as the only destination.
 *
 * Both values are literals that Vite substitutes at build time, so a branch on
 * `LOCAL_EDITION` folds away and the official bundle carries none of the local
 * edition's code (and the reverse). Outside Vite (the repository's vitest
 * suite) nothing defines them, and the WebView reads as the official app.
 *
 * Branch on `LOCAL_EDITION` in shared code with an early return or a
 * conditional expression, not by wrapping existing code in a new block: the
 * former folds to exactly the old output in the official build.
 */
export type Edition = "cloud" | "local";

export const EDITION: Edition =
  typeof __CLIPY_EDITION__ === "string" ? __CLIPY_EDITION__ : "cloud";

export const LOCAL_EDITION: boolean =
  typeof __CLIPY_LOCAL_EDITION__ === "boolean" ? __CLIPY_LOCAL_EDITION__ : false;

/** The name people see: the local edition is its own app, Clipy Local. */
export const APP_NAME: string = brandText("Clipy");

/**
 * The local edition is its own app, so the product name in every translated
 * message reads "Clipy Local". The catalogs keep the official app's "Clipy".
 */
export function brandText(text: string): string {
  return LOCAL_EDITION ? text.replace(/\bClipy\b(?! Local)/g, "Clipy Local") : text;
}

/** `brandText` over a whole message tree (identity in the official app). */
export function brandMessages<T>(tree: T): T {
  if (!LOCAL_EDITION) return tree;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return brandText(value);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    }
    return value;
  };
  return walk(tree) as T;
}

/** Same as `LOCAL_EDITION`, for call sites that read better as a function. */
export function isLocalEdition(): boolean {
  return LOCAL_EDITION;
}

/** The local edition's public source repository: setup notes, releases and
 *  the guide link point here instead of the hosted site. */
export const LOCAL_PROJECT_URL = "https://github.com/clipy-recorder/clipy";
