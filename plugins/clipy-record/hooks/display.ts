import type { EngineInterface } from 'claude-code'

type $ = EngineInterface
type Run = { exitCode: number; stdout: string; stderr: string }

type Rect = { x: number; y: number; width: number; height: number }
type Display = Rect & { id: number }
type Window = Rect & { app_name: string }
export type Sources = { displays: Display[]; windows: Window[] }

/** The app name in `lsappinfo find` output: `ASN:0x0-0x392d92a-"Claude":`. */
export function nameFromFind(text: string): string | null {
  return /-"([^"]+)":/.exec(text)?.[1] ?? null
}

/** The app name in `lsappinfo info -only name` output: `"Claude" ASN:…`. */
export function nameFromInfo(text: string): string | null {
  return /^"([^"]+)"/.exec(text.trim())?.[1] ?? null
}

// Window lists carry invisible marks in some app names (a left-to-right mark before "WhatsApp").
const plain = (name: string) => name.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim()

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * The display that holds the app's main window, by the window's centre, else
 * by the most overlap. Null when there is one display (nothing to choose), the
 * app has no real window on screen, or the window is on no display.
 */
export function pickDisplay(sources: Sources, appName: string): number | null {
  if (sources.displays.length < 2) return null
  const want = plain(appName)
  // Windows come front to back; tiny ones are menus, badges and pop-ups.
  const win = sources.windows.find(w => plain(w.app_name) === want && w.width >= 200 && w.height >= 120)
  if (!win) return null
  const cx = win.x + win.width / 2
  const cy = win.y + win.height / 2
  const holding = sources.displays.find(d => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height)
  if (holding) return holding.id
  let best: Display | null = null
  let most = 0
  for (const d of sources.displays) {
    const o = overlap(win, d)
    if (o > most) {
      most = o
      best = d
    }
  }
  return best?.id ?? null
}

function parseSources(text: string): Sources | null {
  try {
    const start = text.indexOf('{')
    const json = JSON.parse(text.slice(start)) as Partial<Sources>
    if (!Array.isArray(json.displays) || !Array.isArray(json.windows)) return null
    return { displays: json.displays, windows: json.windows }
  } catch {
    return null
  }
}

/**
 * The display Claude Code is on, as an id for `--display`, so a multi-screen
 * setup records the screen the person is looking at instead of the primary one.
 *
 * The host app is the one that started this process (`__CFBundleIdentifier`:
 * the Claude app, a terminal, VS Code), else the frontmost app, which is the
 * host when Record was just pressed. macOS only; null whenever it cannot tell,
 * and the Clipy app then records its default screen as before.
 */
export async function hostDisplay(
  $: $,
  run: (argv: string[], timeoutMs: number) => Promise<Run>,
  clipySources: () => Promise<Run>,
): Promise<string | null> {
  try {
    const { platform } = await $.session.info()
    if (platform !== 'macos') return null
    const bundle = ((await $.env.get('__CFBundleIdentifier').catch(() => undefined)) ?? '').trim()
    let app: string | null = null
    if (/^[A-Za-z0-9.-]+$/.test(bundle)) {
      app = nameFromFind((await run(['lsappinfo', 'find', `bundleid=${bundle}`], 5_000)).stdout)
    }
    if (!app) {
      const front = (await run(['lsappinfo', 'front'], 5_000)).stdout.trim()
      if (front) app = nameFromInfo((await run(['lsappinfo', 'info', '-only', 'name', front], 5_000)).stdout)
    }
    if (!app) return null
    const sources = parseSources((await clipySources()).stdout)
    const id = sources ? pickDisplay(sources, app) : null
    return id === null ? null : String(id)
  } catch {
    return null
  }
}
