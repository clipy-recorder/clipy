import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderChildren } from 'claude-code'

import type { Destination, RecordState } from '../types'
import { apiKey, cloudPrompt, fetchNewest, isNewer, isReadable, keyFor, modeOf, RECORD_URL, type Mode } from './cloud'
import { hostDisplay } from './display'
import { exchangeCode, forgetKey, newLogin, pollLogin, saveKey, shareKey, storedKey, type Claim } from './signin'

type $ = EngineInterface

/** The Clipy mark, drawn next to the Record button where the surface can draw SVG. */
const CLIPY_MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-label="Clipy"><defs><linearGradient id="clipyRecordMarkGrad" x1="20" y1="18" x2="45" y2="49" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FF6A3D"/><stop offset="0.55" stop-color="#FF4D29"/><stop offset="1" stop-color="#FF2778"/></linearGradient></defs><g transform="translate(32 31.5) rotate(-18) scale(1.38) translate(-16.5 -20)"><path d="M6 4 L6 32 L13 25 L18 36 L22 34.5 L18 23 L27 23 Z" fill="url(#clipyRecordMarkGrad)"/></g><circle cx="48.3" cy="48.3" r="4.5" fill="#FF4D29"/></svg>'

const IDLE: RecordState = { phase: 'idle', startedAt: null, arec: null, error: null, hint: null }
const recording = atom({ plugin: 'clipy-record', key: 'state' } as const, IDLE)
const elapsed = atom({ plugin: 'clipy-record', key: 'elapsed' } as const, 0)
// Hidden with the band's Hide button or /record-button; kept across sessions in $.store.
const hidden = atom({ plugin: 'clipy-record', key: 'hidden' } as const, false)
// Local or Cloud on this computer, chosen on the band and kept across sessions.
const destination = atom({ plugin: 'clipy-record', key: 'destination' } as const, 'local' as Destination)
const COMMAND = 'record-button'

// The first CLI that records through the official Clipy app and keeps the take local.
const MIN_VERSION = '0.20.0'
// Stop waits for Clipy to build the AREC (up to 300 s in the app).
const STOP_TIMEOUT_MS = 360_000
// How long to wait for the app to finish a take it stopped by itself.
const READY_TIMEOUT_MS = 300_000
const INSTALL_HINT = 'Install it with: npm i -g @clipy/cli'
const CLOUD_LOGIN_HINT = 'Run clipy login in a terminal and approve it in your browser, or switch the band to Local.'
const OPEN_CLIPY_HINT =
  'Open the Clipy app (or Clipy Local), then press Record again. Not installed yet? ' +
  'https://clipy.online/download?utm_source=claude-code&utm_medium=plugin&utm_campaign=record-button'
// The app stopped answering mid-take (quit or crashed): what it saved is in Clipy.
const DEAD_ERROR = 'Clipy stopped answering during the recording, so nothing was sent to Claude.'
const DEAD_HINT = 'Open Clipy: anything it saved is in its library, and you can send it from there.'
// Status checks that can fail in a row before the band says so.
const STATUS_FAILS_BEFORE_ERROR = 3
const UPDATE_HINT = `Update it with: npm i -g @clipy/cli@latest (this button needs ${MIN_VERSION} or later)`

// A cloud session asks the library every few seconds, gives up after half an
// hour, and sends a recording still preparing once it has had three minutes.
const CLOUD_POLL_EVERY_S = 5
const CLOUD_WAIT_MS = 30 * 60_000
const CLOUD_PREPARE_MS = 180_000
// A library check still unanswered after this is treated as lost, so a stalled
// request never holds the band; the wait token stops a late answer doing harm.
const CLOUD_CHECK_STALE_MS = 20_000
// Sign-in asks whether the person approved every few seconds, for up to ten minutes.
const LOGIN_POLL_EVERY_S = 3
const LOGIN_WAIT_MS = 10 * 60_000
const REFUSED_SIGNIN = 'Clipy refused the saved sign-in, so it was cleared. Sign in again.'
const REFUSED_ENV = 'Clipy refused the CLIPY_API_KEY in this environment. Check the key and that it can read recordings.'


type Run = { exitCode: number; stdout: string; stderr: string }
type Cli = { wrap: (args: string[]) => string[]; version: string }

/** "0.19.2" -> [0, 19, 2]; anything unreadable sorts lowest. */
function versionOf(text: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
}

export function isOlder(version: string, than: string): boolean {
  const a = versionOf(version)
  const b = versionOf(than)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/**
 * Splits the configured command into arguments. Single or double quotes keep a
 * path with spaces together; backslashes stay literal, as in Windows paths.
 */
export function splitCommand(command: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

const quote = (args: string[]) => args.map(a => `'${a.replaceAll("'", "'\\''")}'`).join(' ')

/**
 * The CLI's JSON object and its error text. A failed take still prints JSON
 * (exit 1 with a Partial AREC path), so the JSON is read whatever the exit code.
 */
export function parse(run: Run): { json: Record<string, unknown> | null; error: string } {
  const text = run.stdout.trim()
  const start = text.indexOf('{')
  let json: Record<string, unknown> | null = null
  if (start !== -1) {
    try {
      json = JSON.parse(text.slice(start)) as Record<string, unknown>
    } catch {
      json = null
    }
  }
  if (run.exitCode === 0 && json) return { json, error: '' }
  const said = typeof json?.error === 'string' ? json.error : typeof json?.message === 'string' ? json.message : ''
  const lines = (json ? run.stderr : `${run.stderr}\n${run.stdout}`).split('\n').map(l => l.trim()).filter(Boolean)
  const line = said || (lines.find(l => /^error:/i.test(l)) ?? lines.at(-1) ?? 'clipy failed')
  return { json, error: line.replace(/^error:\s*/i, '') }
}

/** `--local` for a take kept on this computer; an uploading take is asked about without it. */
const kept = (s: RecordState) => (s.upload ? [] : ['--local'])

/** The share id in an uploaded take's stop output (`id`, else the end of `shareUrl`). */
export function uploadedId(json: Record<string, unknown> | null): string {
  if (typeof json?.id === 'string' && json.id) return json.id
  const url = typeof json?.shareUrl === 'string' ? json.shareUrl : ''
  return /\/video\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? ''
}

// Module state: start and stop must share one folder, since a Clipy session
// belongs to the folder it started in. Both are found again after a reload.
let workDir = ''
let cli: Cli | null = null
let stopWatching: (() => void) | null = null
let polling = false

async function dir($: $): Promise<string> {
  if (!workDir) workDir = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA ?? ''
  return workDir
}

/** How to run clipy here: the configured command, PATH, or a login shell's PATH. */
async function findCli($: $, options: PluginOptions): Promise<Cli | null> {
  if (cli) return cli
  const cwd = await dir($)
  const configured = String(options.clipyCommand ?? '').trim()
  const { platform } = await $.session.info()
  const candidates: Array<(args: string[]) => string[]> = configured
    ? [args => [...splitCommand(configured), ...args]]
    : [
        args => ['clipy', ...args],
        ...(platform === 'windows'
          ? [(args: string[]) => ['cmd', '/c', 'clipy', ...args], (args: string[]) => ['cmd', '/c', 'npx', '-y', '@clipy/cli@0.21.0', ...args]]
          : [
              (args: string[]) => ['/bin/zsh', '-lc', `clipy ${quote(args)}`],
              (args: string[]) => ['/bin/zsh', '-lc', `npx -y @clipy/cli@0.21.0 ${quote(args)}`],
            ]),
      ]
  for (const wrap of candidates) {
    try {
      const run = await $.process.run(wrap(['--version']), { cwd, timeoutMs: 120_000 })
      if (run.exitCode === 0 && /\d+\.\d+\.\d+/.test(run.stdout)) {
        cli = { wrap, version: run.stdout.trim() }
        return cli
      }
    } catch {
      // not startable this way; try the next
    }
  }
  return null
}

/** Runs a clipy command; a command that cannot launch or times out comes back as a failed run. */
async function clipy($: $, c: Cli, args: string[], timeoutMs: number): Promise<Run> {
  try {
    return await $.process.run(c.wrap(args), { cwd: await dir($), timeoutMs })
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { exitCode: -1, stdout: '', stderr: `error: Clipy's command line tool did not run (${why})` }
  }
}

async function fail($: $, error: string, hint: string | null = null): Promise<void> {
  unwatch()
  await update($, recording, () => ({ ...IDLE, error, hint }))
}

function unwatch(): void {
  stopWatching?.()
  stopWatching = null
}

/** Hands the finished recording to Claude as the next prompt. */
async function send($: $, arec: string, stoppedInApp: boolean): Promise<void> {
  unwatch()
  await update($, recording, () => IDLE)
  submitOrSay(
    $,
    `I just recorded my screen with Clipy to show you something${stoppedInApp ? ' (I stopped it in the Clipy app)' : ''}. ` +
      `Read the recording at ${arec} ` +
      '(an AREC file: a timestamped transcript and key moments, each with a screenshot whose path is relative to the file), ' +
      "look at the screenshots that matter, then do what I asked in it. If it isn't clear, summarize what you saw and ask.",
    arec,
  )
}

/** Hands an uploaded take to Claude as its share link. */
async function sendLink($: $, id: string): Promise<void> {
  unwatch()
  await update($, recording, () => IDLE)
  submitOrSay($, cloudPrompt(id), `https://clipy.online/video/${id}`)
}

/** Sends the prompt; if Claude Code refuses it, the band says so and where the recording is. */
export function submitOrSay($: $, text: string, where: string): void {
  const notSent = (why: string) =>
    fail($, `The recording is ready but could not be sent to Claude (${why}).`, `Paste this into the prompt: ${where}`)
  void $.prompt.submit({ text }).then(
    async result => {
      if (result.drop) await notSent(result.drop)
    },
    async (e: unknown) => notSent(e instanceof Error ? e.message : String(e)),
  )
}

/** The folder that holds a take's AREC, with its trailing separator. */
function folderOf(arec: string): string {
  return arec.slice(0, Math.max(arec.lastIndexOf('/'), arec.lastIndexOf('\\')) + 1)
}

/** The app's progress on a take (its status.json beside the AREC); null when unreadable. */
async function stageOf($: $, arec: string): Promise<string | null> {
  try {
    const text = await $.fs.read(`${folderOf(arec)}status.json`)
    const stage = (JSON.parse(String(text)) as { stage?: unknown }).stage
    return typeof stage === 'string' ? stage : ''
  } catch {
    return null
  }
}

async function exists($: $, path: string): Promise<boolean> {
  return $.fs.stat(path).then(
    () => true,
    () => false,
  )
}

/** Cancel in the app trashes the take's folder: back to idle, nothing for Claude. */
async function discarded($: $): Promise<void> {
  await update($, recording, () => IDLE)
  $.ui.toast('The recording was discarded in the Clipy app, so nothing was sent to Claude.')
}

/** The app ended the take (its Stop, Cancel, or the time limit): wait for the AREC, then send it. */
async function finishedInApp($: $, options: PluginOptions, arec: string | null, uploaded = false): Promise<void> {
  unwatch()
  await update($, recording, (s): RecordState => ({ ...s, phase: 'stopping' }))
  const c = await findCli($, options)
  // Clears the CLI's session file; the take itself is already the app's.
  if (c) await clipy($, c, ['session', 'abort'], 30_000)
  if (uploaded) {
    // The app uploads it; only the app knows its link, so the band says where it is.
    return fail(
      $,
      'The recording was stopped in the Clipy app, so the band did not get its link.',
      'It is in your Clipy library: copy its link from Clipy and paste it here.',
    )
  }
  if (!arec) return fail($, 'The recording was stopped in the Clipy app. Open it from Clipy to send it to Claude.')
  const until = (await $.clock.now()) + READY_TIMEOUT_MS
  while ((await $.clock.now()) < until) {
    const stage = await stageOf($, arec)
    if (stage === null && !(await exists($, folderOf(arec)))) return discarded($)
    if (stage === 'ready' || stage === 'failed') break
    await $.clock.sleep(2000)
  }
  if (!(await exists($, arec))) {
    return (await exists($, folderOf(arec))) ? fail($, 'Clipy did not finish this recording. Open it from Clipy.') : discarded($)
  }
  // A failed or still-preparing take has a Partial or Preparing AREC, which says so itself.
  return send($, arec, true)
}

const LOST_CONTACT = "Can't reach Clipy to check on the recording"
let statusFails = 0

/** The app quit or crashed mid-take: clear the CLI's session so Record works again, and say so. */
async function appDied($: $, options: PluginOptions): Promise<void> {
  unwatch()
  const c = await findCli($, options)
  const run = c ? await clipy($, c, ['session', 'abort'], 30_000) : null
  const cleared = run?.exitCode === 0
  return fail($, DEAD_ERROR, cleared ? DEAD_HINT : `${DEAD_HINT} If Record then says a session is active, run: clipy session abort`)
}

/** Every second the timer; every few, whether the app still records. */
function watch($: $, options: PluginOptions): void {
  if (stopWatching) return
  statusFails = 0
  let n = 0
  const timer = $.clock.every(1000, () => {
    n += 1
    void (async () => {
      const s = await read($, recording)
      if (s.phase !== 'recording' || s.startedAt === null) return
      const seconds = Math.floor(((await $.clock.now()) - s.startedAt) / 1000)
      await update($, elapsed, () => seconds)
      if (n % 3 !== 0 || polling || !cli) return
      polling = true
      try {
        const run = await clipy($, cli, ['session', 'status', ...kept(s), '--json'], 20_000)
        const { json, error } = parse(run)
        const state = json?.state
        const now = await read($, recording)
        if (now.phase !== 'recording') return
        if (state === 'ended' || state === 'none') {
          statusFails = 0
          await finishedInApp($, options, now.arec, now.upload === true)
        } else if (state === 'recording') {
          statusFails = 0
          if (now.error?.startsWith(LOST_CONTACT)) {
            await update($, recording, (st): RecordState => (st.phase === 'recording' ? { ...st, error: null } : st))
          }
        } else if (state === 'dead') {
          // Once could be a blip while the app is busy; twice in a row, it is gone.
          statusFails += 1
          if (statusFails >= 2) await appDied($, options)
        } else {
          statusFails += 1
          if (statusFails >= STATUS_FAILS_BEFORE_ERROR) {
            const why = error || 'no answer'
            await update($, recording, (st): RecordState =>
              st.phase === 'recording' ? { ...st, error: `${LOST_CONTACT} (${why}). Still trying.` } : st,
            )
          }
        }
      } catch (e) {
        statusFails += 1
        if (statusFails >= STATUS_FAILS_BEFORE_ERROR) {
          const why = e instanceof Error ? e.message : String(e)
          await update($, recording, (st): RecordState =>
            st.phase === 'recording' ? { ...st, error: `${LOST_CONTACT} (${why}). Still trying.` } : st,
          )
        }
      } finally {
        polling = false
      }
    })()
  })
  stopWatching = timer.cancel
}

async function start($: $, options: PluginOptions): Promise<void> {
  const upload = (await read($, destination)) === 'cloud'
  await update($, recording, (): RecordState => ({ ...IDLE, phase: 'starting', upload }))
  const c = await findCli($, options)
  if (!c) return fail($, "Clipy's command line tool isn't installed.", INSTALL_HINT)
  if (isOlder(c.version, '0.19.0')) {
    // Found again on the next press, so an upgrade takes effect without a restart.
    cli = null
    return fail($, `The Clipy CLI on this computer is ${c.version}, too old for this button.`, UPDATE_HINT)
  }
  const max = Math.min(29, Math.max(1, Math.round(Number(options.maxMinutes) || 10))) * 60
  // On several screens, record the one Claude Code is on, not the primary one.
  const display = await hostDisplay(
    $,
    async (argv, timeoutMs) => $.process.run(argv, { cwd: await dir($), timeoutMs }),
    // Ask the app this take records with: Clipy Local answers only `--local --source mac-screen`.
    () => clipy($, c, upload ? ['sources', '--json'] : ['sources', '--local', '--source', 'mac-screen', '--json'], 20_000),
  )
  const startWith = (screen: string | null) =>
    clipy(
      $,
      c,
      [
        'session',
        'start',
        ...(upload ? [] : ['--local']),
        '--source',
        'mac-screen',
        ...(screen ? ['--display', screen] : []),
        '--mic',
        '--max',
        String(max),
        '--title',
        'Shown to Claude',
        '--json',
      ],
      60_000,
    )
  let run = await startWith(display)
  // A screen unplugged since it was picked: record the default one rather than nothing.
  if (display && parse(run).json?.state !== 'recording' && /display/i.test(parse(run).error)) run = await startWith(null)
  const { json, error } = parse(run)
  if (json?.state !== 'recording') {
    const tooOld = isOlder(c.version, MIN_VERSION)
    const noApp = /Neither the Clipy app nor Clipy Local is running/i.test(error)
    const signedOut = upload && /auth_required|no API key|clipy login|sign in/i.test(error)
    cli = null
    if (noApp) return fail($, "Clipy isn't open, so the recording didn't start.", OPEN_CLIPY_HINT)
    if (signedOut) return fail($, 'Cloud recording needs Clipy signed in on this computer.', CLOUD_LOGIN_HINT)
    const hint = tooOld ? `Your Clipy CLI is ${c.version}. ${UPDATE_HINT}` : null
    return fail($, error || 'Clipy could not start recording, and did not say why.', hint)
  }
  const arec = typeof json.arec === 'string' && json.arec ? json.arec : null
  const now = await $.clock.now()
  await update($, elapsed, () => 0)
  await update($, recording, (): RecordState => ({ ...IDLE, phase: 'recording', startedAt: now, arec, upload }))
  watch($, options)
}

async function stop($: $, options: PluginOptions): Promise<void> {
  unwatch()
  const before = await read($, recording)
  await update($, recording, (s): RecordState => ({ ...s, phase: 'stopping', error: null }))
  const c = await findCli($, options)
  if (!c) return fail($, "Clipy's command line tool isn't installed.", INSTALL_HINT)
  const run = await clipy($, c, ['session', 'stop', ...kept(before), '--json'], STOP_TIMEOUT_MS)
  const { json, error } = parse(run)
  if (before.upload) {
    const id = uploadedId(json)
    if (id) return sendLink($, id)
  } else {
    const arec = typeof json?.arec === 'string' ? json.arec : ''
    if (arec) return send($, arec, false)
  }
  // Stopped in the app between two polls: the take is still there.
  if (/stopped from the Clipy|no recording session/i.test(error) && (before.arec || before.upload)) {
    return finishedInApp($, options, before.arec, before.upload === true)
  }
  // Ask Clipy where the take stands, so the controls stay usable.
  const state = parse(await clipy($, c, ['session', 'status', ...kept(before), '--json'], 20_000)).json?.state
  if (state === 'recording') {
    await update($, recording, (): RecordState => ({ ...before, phase: 'recording', error: error || 'Clipy did not stop.' }))
    return watch($, options)
  }
  if (state === 'ended' && (before.arec || before.upload)) return finishedInApp($, options, before.arec, before.upload === true)
  if (state === 'dead') return appDied($, options)
  return fail($, error || 'Clipy did not return a recording, and did not say why.')
}

async function cancel($: $, options: PluginOptions): Promise<void> {
  unwatch()
  const before = await read($, recording)
  const c = await findCli($, options)
  if (!c) {
    await update($, recording, (): RecordState => ({
      ...before,
      phase: 'recording',
      error: "Clipy's command line tool didn't run, so the band can't cancel. Stop the recording in the Clipy app.",
    }))
    return watch($, options)
  }
  const run = await clipy($, c, ['session', 'abort'], 30_000)
  if (run.exitCode !== 0) {
    // Never show Record while Clipy may still be recording: ask, and keep the controls if so.
    const state = parse(await clipy($, c, ['session', 'status', ...kept(before), '--json'], 20_000)).json?.state
    if (state !== 'none' && state !== 'ended' && state !== 'dead') {
      const error = `Clipy could not cancel: ${parse(run).error}`
      await update($, recording, (): RecordState => ({ ...before, phase: 'recording', error }))
      return watch($, options)
    }
  }
  await update($, recording, () => IDLE)
}

/** Cloud: remember the newest recording, then wait for one made after it. */
async function startCloud($: $): Promise<void> {
  // The first lookup can stall too: the band offers Cancel while it runs, and
  // this token keeps a late answer from reviving a start that was cancelled.
  const token = await $.clock.now()
  await update($, recording, (): RecordState => ({ ...IDLE, phase: 'starting', startedAt: token }))
  const stillMine = (st: RecordState) => st.phase === 'starting' && st.startedAt === token
  const end = async (error: string, hint: string | null = null): Promise<void> => {
    await update($, recording, (st): RecordState => (stillMine(st) ? { ...IDLE, error, hint } : st))
  }
  const { key, source } = await keyFor($)
  // No key yet: sign in first, and the wait starts once it is done.
  if (!key) return startSignIn($)
  const { recording: newest, error, serverTime, refused } = await fetchNewest($, key)
  if (refused && source === 'signin') {
    return end(REFUSED_SIGNIN + (await forgetKeySafely($)))
  }
  if (error) return end(refused ? REFUSED_ENV : error)
  const now = await $.clock.now()
  let mine = false
  await update($, recording, (st): RecordState => {
    if (!stillMine(st)) return st
    mine = true
    return {
      ...IDLE,
      phase: 'waiting',
      startedAt: now,
      cloud: {
        baselineId: newest?.id ?? null,
        baselineAt: newest?.createdAt ?? null,
        since: serverTime ?? null,
        id: null,
        uploadedAt: null,
      },
    }
  })
  if (!mine) return
  await update($, elapsed, () => 0)
  watchCloud($)
}

/** Whether `st` is still the wait that began at `token` (a Cancel, or a new Record, ends it). */
const sameWait = (st: RecordState, token: number) => st.phase === 'waiting' && st.startedAt === token

// The library check in flight, if any: one at a time, unless it has stalled.
let checking: { id: number; at: number } | null = null
let checks = 0

async function beginCheck($: $): Promise<number | null> {
  const now = await $.clock.now()
  if (checking && now - checking.at < CLOUD_CHECK_STALE_MS) return null
  checks += 1
  checking = { id: checks, at: now }
  return checks
}

function endCheck(id: number): void {
  if (checking?.id === id) checking = null
}

async function sendCloud($: $, id: string, token: number): Promise<void> {
  // Checked and cleared in one write, so a Cancel pressed while the library was read wins.
  let mine = false
  await update($, recording, (st): RecordState => {
    if (!sameWait(st, token)) return st
    mine = true
    return IDLE
  })
  if (!mine) return
  unwatch()
  submitOrSay($, cloudPrompt(id), `https://clipy.online/video/${id}`)
}

type Check = 'sent' | 'none' | 'recording' | 'preparing' | 'error'

/** Looks for the new recording and sends it once Claude can read it (or at once, with `now`). */
async function checkCloud($: $, now: boolean): Promise<Check> {
  const s = await read($, recording)
  const w = s.cloud
  const token = s.startedAt
  if (s.phase !== 'waiting' || !w || token === null) return 'none'
  const { key, source } = await keyFor($)
  const { recording: r, error, refused } = key
    ? await fetchNewest($, key)
    : { recording: null, error: 'There is no Clipy key any more. Cancel, then sign in again.', refused: false }
  const keep = (patch: Partial<RecordState>) =>
    update($, recording, (st): RecordState => (sameWait(st, token) ? { ...st, ...patch } : st))
  if (refused && source === 'signin') {
    await keep({ error: `${REFUSED_SIGNIN} Cancel first.${await forgetKeySafely($)}` })
    return 'error'
  }
  if (error) {
    await keep({ error: refused ? REFUSED_ENV : error })
    return 'error'
  }
  if (!r || !isNewer(r, w.baselineId, w.baselineAt, w.since ?? null)) {
    if (s.error) await keep({ error: null })
    return 'none'
  }
  const at = await $.clock.now()
  const uploadedAt = r.stage === 'uploading' ? null : w.id === r.id && w.uploadedAt !== null ? w.uploadedAt : at
  const settled = uploadedAt !== null && at - uploadedAt >= CLOUD_PREPARE_MS
  if (uploadedAt !== null && (now || isReadable(r) || settled)) {
    await sendCloud($, r.id, token)
    return 'sent'
  }
  await keep({ error: null, cloud: { ...w, id: r.id, uploadedAt } })
  return uploadedAt === null ? 'recording' : 'preparing'
}

/** Every second the timer; every few, the library. */
function watchCloud($: $): void {
  if (stopWatching) return
  let n = 0
  const timer = $.clock.every(1000, () => {
    n += 1
    void (async () => {
      const s = await read($, recording)
      if (s.phase !== 'waiting' || s.startedAt === null) return
      const now = await $.clock.now()
      await update($, elapsed, () => Math.floor((now - s.startedAt!) / 1000))
      if (now - s.startedAt > CLOUD_WAIT_MS) {
        return fail($, 'No new Clipy recording showed up in 30 minutes, so nothing was sent.')
      }
      if (n % CLOUD_POLL_EVERY_S !== 0) return
      const id = await beginCheck($)
      if (id === null) return
      try {
        await checkCloud($, false)
      } catch (e) {
        // The next check tries again; meanwhile the band says what went wrong.
        const error = `Checking your Clipy library failed (${e instanceof Error ? e.message : String(e)}). Still trying.`
        await update($, recording, (st): RecordState => (st.phase === 'waiting' ? { ...st, error } : st))
      } finally {
        endCheck(id)
      }
    })()
  })
  stopWatching = timer.cancel
}

/** Send now: the new recording even if it is still preparing; its AREC says so. */
async function sendNow($: $): Promise<void> {
  const id = await beginCheck($)
  if (id === null) {
    $.ui.toast('Still checking your Clipy library. Try Send now again in a few seconds.')
    return
  }
  try {
    const result = await checkCloud($, true)
    if (result === 'none') $.ui.toast('No new recording in your Clipy library yet. Record one, then press Send now.')
    if (result === 'recording') $.ui.toast('Clipy is still recording. Stop it in Clipy, and it is sent once it uploads.')
  } finally {
    endCheck(id)
  }
}

async function cancelCloud($: $): Promise<void> {
  unwatch()
  // A check still out belongs to this wait; its token keeps it from touching the next one.
  checking = null
  await update($, recording, () => IDLE)
}

/** Whether `st` is still the sign-in that began at `token`. */
const sameLogin = (st: RecordState, token: number) => st.phase === 'signin' && st.startedAt === token

/** Cloud with no key: open a copy-code login and wait for the approval (or a pasted code). */
async function startSignIn($: $): Promise<void> {
  unwatch()
  checking = null
  let login
  try {
    login = await newLogin()
  } catch (e) {
    return fail($, `Couldn't start signing in to Clipy (${e instanceof Error ? e.message : String(e)}).`)
  }
  const token = await $.clock.now()
  await update($, recording, (): RecordState => ({ ...IDLE, phase: 'signin', startedAt: token, login }))
  watchSignIn($)
}

/** Saves the key once, for whichever of the poll and the paste got it, then starts the wait. */
async function finishSignIn($: $, token: number, claim: Claim): Promise<void> {
  if ('pending' in claim) return
  if ('error' in claim) {
    const stopPolling = claim.kind !== 'transient'
    await update($, recording, (st): RecordState =>
      sameLogin(st, token) && st.login
        ? {
            ...st,
            error: claim.error,
            login: { ...st.login, errorTransient: !stopPolling, polling: stopPolling ? false : st.login.polling },
          }
        : st,
    )
    // Only the timeout keeps running, so a stuck login still ends; the paste still works.
    if (stopPolling) loginPollingStopped = true
    return
  }
  let mine = false
  await update($, recording, (st): RecordState => {
    if (!sameLogin(st, token)) return st
    mine = true
    return IDLE
  })
  if (!mine) return
  unwatch()
  let unshared: string | null
  try {
    unshared = await saveKey($, claim.key)
  } catch (e) {
    return fail($, `Signed in, but the key could not be saved (${e instanceof Error ? e.message : String(e)}).`)
  }
  const who = claim.email ? `Signed in to Clipy as ${claim.email}.` : 'Signed in to Clipy.'
  $.ui.toast(unshared ? `${who} Claude's commands could not get the key (${unshared}), so private recordings need CLIPY_API_KEY.` : who)
  await startCloud($)
}

// Set when polling cannot help; the timer then only enforces the timeout.
let loginPollingStopped = false

function watchSignIn($: $): void {
  if (stopWatching) return
  loginPollingStopped = false
  let n = 0
  const timer = $.clock.every(1000, () => {
    n += 1
    void (async () => {
      const s = await read($, recording)
      if (s.phase !== 'signin' || !s.login || s.startedAt === null) return
      const token = s.startedAt
      if ((await $.clock.now()) - token > LOGIN_WAIT_MS) {
        return fail($, 'Signing in to Clipy timed out after 10 minutes. Press Sign in to try again.')
      }
      if (n % LOGIN_POLL_EVERY_S !== 0 || loginPollingStopped || s.login.polling === false) return
      const id = await beginCheck($)
      if (id === null) return
      try {
        const claim = await pollLogin($, s.login.verifier)
        // A pending answer clears an error from an earlier poll that might have been passing,
        // never one that ended polling; a paste's own error lives in the hint.
        if ('pending' in claim && s.error && s.login.errorTransient) {
          await update($, recording, (st): RecordState => (sameLogin(st, token) ? { ...st, error: null } : st))
        }
        await finishSignIn($, token, claim)
      } catch (e) {
        const error = `Checking the sign-in failed (${e instanceof Error ? e.message : String(e)}). Still trying.`
        await update($, recording, (st): RecordState => (sameLogin(st, token) ? { ...st, error } : st))
      } finally {
        endCheck(id)
      }
    })()
  })
  stopWatching = timer.cancel
}

async function pasteCode($: $, value: string): Promise<void> {
  const s = await read($, recording)
  if (s.phase !== 'signin' || !s.login || s.startedAt === null) return
  const token = s.startedAt
  const code = value.trim()
  if (!code) return
  const claim = await exchangeCode($, code, s.login.verifier)
  if ('error' in claim) {
    await update($, recording, (st): RecordState => (sameLogin(st, token) ? { ...st, hint: claim.error } : st))
    return
  }
  await finishSignIn($, token, claim)
}

async function forgetKeySafely($: $): Promise<string> {
  try {
    await forgetKey($)
    return ''
  } catch (e) {
    return ` It could not be cleared (${e instanceof Error ? e.message : String(e)}); set CLIPY_API_KEY instead.`
  }
}

export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

async function setDestination($: $, value: Destination): Promise<void> {
  await $.store.set('destination', value)
  await update($, destination, () => value)
}

async function setHidden($: $, value: boolean): Promise<void> {
  await $.store.set('hidden', value)
  await update($, hidden, () => value)
}

const STARTUP_REDRAWS_MS = [1_000, 3_000, 8_000, 20_000]

async function redrawWhileStarting($: $): Promise<void> {
  for (const wait of STARTUP_REDRAWS_MS) {
    try {
      await $.clock.sleep(wait)
      $.ui.invalidate('ui.render')
    } catch {
      return
    }
  }
}

export const register: Register = (on, options) => {
  on('command.run', { command: COMMAND }, async $ => {
    const next = !(await read($, hidden))
    await setHidden($, next)
    return {
      text: next
        ? 'The Record with Clipy button is hidden. Run /record-button to show it again.'
        : 'The Record with Clipy button is back above the prompt.',
    }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: 'Show or hide the Record with Clipy button above the prompt' })
    await update($, hidden, () => false)
    if ((await $.store.get('hidden')) === true) await update($, hidden, () => true)
    const saved = await $.store.get('destination').catch(() => undefined)
    await update($, destination, (): Destination => (saved === 'cloud' ? 'cloud' : 'local'))
    // A cloud session signed in earlier: Claude's commands get the key again.
    if ((await modeOf($)) === 'cloud') {
      const key = await storedKey($)
      const denied = key ? await shareKey($, key).catch((e: unknown) => String(e)) : null
      if (denied) $.ui.toast(`Signed in to Clipy, but Claude's commands could not get the key (${denied}).`)
    }
    // A reload or a new session finds the band where the CLI says it is.
    const s = await read($, recording)
    const mode = await modeOf($)
    if (s.phase === 'recording' && mode === 'local') {
      const c = await findCli($, options)
      const run = c ? await clipy($, c, ['session', 'status', ...kept(s), '--json'], 20_000) : null
      const { json, error } = run ? parse(run) : { json: null, error: "Clipy's command line tool didn't run" }
      const state = json?.state
      if (state === 'recording') watch($, options)
      else if (state === 'ended') await finishedInApp($, options, s.arec, s.upload === true)
      else if (state === 'dead') await appDied($, options)
      else if (state === 'none') await update($, recording, () => IDLE)
      else {
        // Unknown: keep Stop and Cancel and say why, rather than hide a take that may still run.
        await update($, recording, (st): RecordState => ({ ...st, error: `${LOST_CONTACT} (${error || 'no answer'}). Still trying.` }))
        watch($, options)
      }
    } else if (s.phase === 'waiting' && s.cloud && mode === 'cloud') {
      watchCloud($)
    } else if (s.phase === 'signin' && s.login && mode === 'cloud') {
      watchSignIn($)
    } else if (s.phase !== 'idle') {
      await update($, recording, () => IDLE)
    }
    // In a cloud session the plugin can load after the app first draws the area
    // above the prompt, and nothing would draw the band until its state changed.
    // Ask for a draw now, and a few times while the app's view attaches.
    $.ui.invalidate('ui.render')
    void redrawWhileStarting($)
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const mode: Mode = await modeOf($)
    if (!mode) return next(e)

    const state = await read($, recording)
    // A take in progress always shows, hidden or not.
    if (state.phase === 'idle' && !state.error && (await read($, hidden))) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Button, Link, Text } = elements
    // `remote`: Claude Code itself runs in a cloud session, so Cloud is the only way.
    // Otherwise the person picks: Local keeps the take here, Cloud uploads it for a link.
    const remote = mode === 'cloud'
    const dest: Destination = remote ? 'cloud' : await read($, destination)
    // A take in flight keeps the look it started with, whatever the toggle says now.
    const look: Destination = state.phase === 'recording' || state.phase === 'stopping' ? (state.upload ? 'cloud' : 'local') : dest
    // The band keeps the prompt's own look; Cloud shows only on the Record button
    // (the surface's primary button) and in the words beside it.
    const cloud = look === 'cloud'
    // The desktop app, VS Code and mobile draw SVG; the terminal keeps the dot.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
    const band = (...rows: RenderChildren[]) => (
      <Box flexDirection="column" flexGrow={1}>
        {rows}
      </Box>
    )

    if (state.phase === 'recording' || state.phase === 'waiting') {
      if (!stopWatching) {
        if (state.phase === 'waiting') watchCloud($)
        else watch($, options)
      }
      const seconds = await read($, elapsed)
      const w = state.cloud
      const status = state.error
        ? null
        : state.phase === 'recording'
          ? state.upload
            ? 'Recording your screen and mic; it uploads when you stop. Show Claude what you mean.'
            : 'Recording your screen and mic. Show Claude what you mean.'
          : w?.id && w.uploadedAt === null
            ? 'Clipy is recording. Stop it in Clipy and Claude gets it.'
            : w?.id
              ? 'Clipy is preparing your recording for Claude…'
              : 'Record in Clipy on your computer; Claude gets it when it is ready.'
      return band(
        <Box justifyContent="space-between" flexGrow={1}>
          <Box>
            <Text color="red">● {clock(seconds)} </Text>
            {state.error ? <Text color="red">{state.error}</Text> : <Text>{status}</Text>}
            {state.phase === 'waiting' && !w?.id ? (
              <Text>
                {' '}
                <Link key="open" href={RECORD_URL} label="Open Clipy" />
              </Text>
            ) : null}
          </Box>
          <Box>
            {state.phase === 'waiting' ? (
              <Button key="send" hotkey="s" label="Send now" onPress={() => sendNow($)} />
            ) : (
              <Button key="stop" hotkey="s" label="Stop and send" onPress={() => stop($, options)} />
            )}
            <Text> </Text>
            <Button
              key="cancel"
              hotkey="c"
              label="Cancel"
              dimColor
              onPress={() => (state.phase === 'waiting' ? cancelCloud($) : cancel($, options))}
            />
          </Box>
        </Box>,
      )
    }
    if (state.phase === 'signin' && state.login) {
      if (!stopWatching) watchSignIn($)
      const waiting = state.login.polling !== false
      const { Input } = elements
      return band(
        <Box key="row" justifyContent="space-between" flexGrow={1}>
          <Box>
            <Text>
              {waiting
                ? 'Approve in your browser and this signs in by itself. '
                : 'Approve in your browser, then paste the code it shows. '}
            </Text>
            <Text>
              <Link key="signin-page" href={state.login.url} label="Open the sign-in page" />
            </Text>
            <Text bold>
              {`  Code ${state.login.confirm}`}
            </Text>
          </Box>
          <Button key="cancel" hotkey="c" label="Cancel" dimColor onPress={() => cancelCloud($)} />
        </Box>,
        <Input
          key="code"
          placeholder="Or paste the code from that page"
          submitLabel="Use code"
          onSubmit={value => pasteCode($, value)}
        />,
        state.error ? (
          <Text key="error" color="red">
            {state.error}
          </Text>
        ) : null,
        state.hint ? (
          <Text key="hint">
            {state.hint}
          </Text>
        ) : null,
      )
    }
    if (state.phase === 'starting' || state.phase === 'stopping') {
      const text =
        state.phase === 'stopping'
          ? state.upload
            ? 'Clipy is uploading the recording…'
            : 'Clipy is building the recording on this computer…'
          : remote
            ? 'Checking your Clipy library…'
            : 'Starting Clipy…'
      return band(
        <Box justifyContent="space-between" flexGrow={1}>
          <Box>
            <Text> {text}</Text>
          </Box>
          {remote && state.phase === 'starting' ? (
            <Button key="cancel" hotkey="c" label="Cancel" dimColor onPress={() => cancelCloud($)} />
          ) : null}
        </Box>,
      )
    }
    const noKey = remote && !(await apiKey($))
    const idleText = noKey
      ? 'Sign in to Clipy so this session can pick up your recordings.'
      : remote
        ? 'Record on your computer; Claude reads the share link.'
        : cloud
          ? 'Uploads to Clipy; Claude gets the share link.'
          : 'Stays on this computer; Claude reads the file.'
    return band(
      <Box key="row" justifyContent="space-between" flexGrow={1}>
          <Box>
            {state.error ? (
              <Text color="red">
                {state.error}
              </Text>
            ) : (
              <Text dimColor>
                {idleText}
              </Text>
            )}
          </Box>
          <Box>
            {Svg ? <Svg key="mark" source={CLIPY_MARK} alt="Clipy" width={18} height={18} /> : null}
            {Svg ? <Text> </Text> : null}
            {noKey ? (
              <Button key="signin" hotkey="i" label="Sign in to Clipy" variant="primary" onPress={() => startSignIn($)} />
            ) : (
              <Button
                key="record"
                hotkey="r"
                label={Svg ? 'Record with Clipy' : '● Record with Clipy'}
                variant={cloud ? 'primary' : undefined}
                onPress={() => (remote ? startCloud($) : start($, options))}
              />
            )}
            {remote ? null : <Text> </Text>}
            {remote ? null : (
              <Button
                key="destination"
                hotkey="m"
                label={cloud ? 'Switch to Local' : 'Switch to Cloud'}
                dimColor
                onPress={() => setDestination($, cloud ? 'local' : 'cloud')}
              />
            )}
            <Text> </Text>
            <Button key="hide" hotkey="h" label="Hide" dimColor onPress={() => setHidden($, true)} />
          </Box>
      </Box>,
      state.hint ? (
        <Text key="hint" dimColor>
          {state.hint}
        </Text>
      ) : null,
    )
  })
}
