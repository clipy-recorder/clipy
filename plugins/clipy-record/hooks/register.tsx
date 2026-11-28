import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { RecordState } from '../types'

type $ = EngineInterface

/** The Clipy mark, drawn next to the Record button where the surface can draw SVG. */
const CLIPY_MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-label="Clipy"><defs><linearGradient id="clipyRecordMarkGrad" x1="20" y1="18" x2="45" y2="49" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FF6A3D"/><stop offset="0.55" stop-color="#FF4D29"/><stop offset="1" stop-color="#FF2778"/></linearGradient></defs><g transform="translate(32 31.5) rotate(-18) scale(1.38) translate(-16.5 -20)"><path d="M6 4 L6 32 L13 25 L18 36 L22 34.5 L18 23 L27 23 Z" fill="url(#clipyRecordMarkGrad)"/></g><circle cx="48.3" cy="48.3" r="4.5" fill="#FF4D29"/></svg>'

const IDLE: RecordState = { phase: 'idle', startedAt: null, arec: null, error: null, hint: null }
const recording = atom({ plugin: 'clipy-record', key: 'state' } as const, IDLE)
const elapsed = atom({ plugin: 'clipy-record', key: 'elapsed' } as const, 0)
// Hidden with the band's Hide button or /record-button; kept across sessions in $.store.
const hidden = atom({ plugin: 'clipy-record', key: 'hidden' } as const, false)
const COMMAND = 'record-button'

// The first CLI that records through the official Clipy app and keeps the take local.
const MIN_VERSION = '0.20.0'
// Stop waits for Clipy to build the AREC (up to 300 s in the app).
const STOP_TIMEOUT_MS = 360_000
// How long to wait for the app to finish a take it stopped by itself.
const READY_TIMEOUT_MS = 300_000
const INSTALL_HINT = 'Install it with: npm i -g @clipy/cli'
const GET_CLIPY_HINT =
  'Get Clipy, free to start: https://clipy.online/download?utm_source=claude-code&utm_medium=plugin&utm_campaign=record-button' +
  ' (or build Clipy Local, the open-source edition, from github.com/clipy-recorder/clipy)'
const UPDATE_HINT = `Update it with: npm i -g @clipy/cli@latest (this button needs ${MIN_VERSION} or later)`

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
              (args: string[]) => [platform === 'darwin' ? '/bin/zsh' : (process.env.SHELL || '/bin/sh'), '-lc', `clipy ${quote(args)}`],
              (args: string[]) => [platform === 'darwin' ? '/bin/zsh' : (process.env.SHELL || '/bin/sh'), '-lc', `npx -y @clipy/cli@0.21.0 ${quote(args)}`],
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
  void $.prompt.submit({
    text:
      `I just recorded my screen with Clipy to show you something${stoppedInApp ? ' (I stopped it in the Clipy app)' : ''}. ` +
      `Read the recording at ${arec} ` +
      '(an AREC file: a timestamped transcript and key moments, each with a screenshot whose path is relative to the file), ' +
      "look at the screenshots that matter, then do what I asked in it. If it isn't clear, summarize what you saw and ask.",
  })
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
async function finishedInApp($: $, options: PluginOptions, arec: string | null): Promise<void> {
  unwatch()
  await update($, recording, (s): RecordState => ({ ...s, phase: 'stopping' }))
  const c = await findCli($, options)
  // Clears the CLI's session file; the take itself is already the app's.
  if (c) await clipy($, c, ['session', 'abort'], 30_000).catch(() => undefined)
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

/** Every second the timer; every few, whether the app still records. */
function watch($: $, options: PluginOptions): void {
  if (stopWatching) return
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
        const run = await clipy($, cli, ['session', 'status', '--local', '--json'], 20_000)
        const state = parse(run).json?.state
        const now = await read($, recording)
        if (now.phase === 'recording' && (state === 'ended' || state === 'none')) {
          await finishedInApp($, options, now.arec)
        }
      } catch {
        // a missed poll is retried on the next one
      } finally {
        polling = false
      }
    })()
  })
  stopWatching = timer.cancel
}

async function start($: $, options: PluginOptions): Promise<void> {
  await update($, recording, (): RecordState => ({ ...IDLE, phase: 'starting' }))
  const c = await findCli($, options)
  if (!c) return fail($, "Clipy's command line tool isn't installed.", INSTALL_HINT)
  if (isOlder(c.version, '0.19.0')) {
    // Found again on the next press, so an upgrade takes effect without a restart.
    cli = null
    return fail($, `The Clipy CLI on this computer is ${c.version}, too old for this button.`, UPDATE_HINT)
  }
  const max = Math.min(29, Math.max(1, Math.round(Number(options.maxMinutes) || 10))) * 60
  const run = await clipy(
    $,
    c,
    ['session', 'start', '--local', '--source', 'mac-screen', '--mic', '--max', String(max), '--title', 'Shown to Claude', '--json'],
    60_000,
  )
  const { json, error } = parse(run)
  if (json?.state !== 'recording') {
    const tooOld = isOlder(c.version, MIN_VERSION)
    const noApp = /Neither the Clipy app nor Clipy Local is running/i.test(error)
    const hint = tooOld ? `Your Clipy CLI is ${c.version}. ${UPDATE_HINT}` : noApp ? GET_CLIPY_HINT : null
    cli = null
    return fail($, error || 'Clipy could not start recording.', hint)
  }
  const arec = typeof json.arec === 'string' && json.arec ? json.arec : null
  const now = await $.clock.now()
  await update($, elapsed, () => 0)
  await update($, recording, (): RecordState => ({ ...IDLE, phase: 'recording', startedAt: now, arec }))
  watch($, options)
}

async function stop($: $, options: PluginOptions): Promise<void> {
  unwatch()
  const before = await read($, recording)
  await update($, recording, (s): RecordState => ({ ...s, phase: 'stopping', error: null }))
  const c = await findCli($, options)
  if (!c) return fail($, "Clipy's command line tool isn't installed.", INSTALL_HINT)
  const run = await clipy($, c, ['session', 'stop', '--local', '--json'], STOP_TIMEOUT_MS)
  const { json, error } = parse(run)
  const arec = typeof json?.arec === 'string' ? json.arec : ''
  if (arec) return send($, arec, false)
  // Stopped in the app between two polls: the take is still there.
  if (/stopped from the Clipy|no recording session/i.test(error) && before.arec) {
    return finishedInApp($, options, before.arec)
  }
  // Ask Clipy where the take stands, so the controls stay usable.
  const state = parse(await clipy($, c, ['session', 'status', '--local', '--json'], 20_000)).json?.state
  if (state === 'recording') {
    await update($, recording, (): RecordState => ({ ...before, phase: 'recording', error: error || 'Clipy did not stop.' }))
    return watch($, options)
  }
  if (state === 'ended' && before.arec) return finishedInApp($, options, before.arec)
  return fail($, error || 'Clipy did not return a recording.')
}

async function cancel($: $, options: PluginOptions): Promise<void> {
  unwatch()
  const before = await read($, recording)
  const c = await findCli($, options)
  const run = c ? await clipy($, c, ['session', 'abort'], 30_000) : null
  if (run && run.exitCode !== 0) {
    // Never show Record while Clipy may still be recording: ask, and keep the controls if so.
    const state = c ? parse(await clipy($, c, ['session', 'status', '--local', '--json'], 20_000)).json?.state : null
    if (state !== 'none' && state !== 'ended') {
      const error = `Clipy could not cancel: ${parse(run).error}`
      await update($, recording, (): RecordState => ({ ...before, phase: 'recording', error }))
      return watch($, options)
    }
  }
  await update($, recording, () => IDLE)
}

export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

async function setHidden($: $, value: boolean): Promise<void> {
  await $.store.set('hidden', value)
  await update($, hidden, () => value)
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
    // A reload or a new session finds the band where the CLI says it is.
    const s = await read($, recording)
    if (s.phase === 'recording') {
      const c = await findCli($, options)
      const run = c ? await clipy($, c, ['session', 'status', '--local', '--json'], 20_000).catch(() => null) : null
      const state = run ? parse(run).json?.state : null
      if (state === 'recording') watch($, options)
      else if (state === 'ended') await finishedInApp($, options, s.arec)
      else await update($, recording, () => IDLE)
    } else if (s.phase !== 'idle') {
      await update($, recording, () => IDLE)
    }
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { platform, isHosted } = await $.session.info()
    if (isHosted || (platform !== 'macos' && platform !== 'windows')) return next(e)

    const state = await read($, recording)
    // A take in progress always shows, hidden or not.
    if (state.phase === 'idle' && !state.error && (await read($, hidden))) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The desktop app, VS Code and mobile draw SVG; the terminal keeps the dot.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null

    if (state.phase === 'recording') {
      if (!stopWatching) watch($, options)
      const seconds = await read($, elapsed)
      return (
        <Box justifyContent="space-between" flexGrow={1}>
          <Box>
            <Text color="red">● {clock(seconds)} </Text>
            {state.error ? (
              <Text color="red">{state.error}</Text>
            ) : (
              <Text>Recording your screen and mic. Show Claude what you mean.</Text>
            )}
          </Box>
          <Box>
            <Button key="stop" hotkey="s" label="Stop and send" onPress={() => stop($, options)} />
            <Text> </Text>
            <Button key="cancel" hotkey="c" label="Cancel" dimColor onPress={() => cancel($, options)} />
          </Box>
        </Box>
      )
    }
    if (state.phase === 'starting' || state.phase === 'stopping') {
      return (
        <Box>
          <Text dimColor>
            {state.phase === 'starting' ? 'Starting Clipy…' : 'Clipy is building the recording on this computer…'}
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box justifyContent="space-between" flexGrow={1}>
          {state.error ? (
            <Text color="red">{state.error}</Text>
          ) : (
            <Text dimColor>Show Claude your screen instead of typing it out</Text>
          )}
          <Box>
            {Svg ? <Svg key="mark" source={CLIPY_MARK} alt="Clipy" width={18} height={18} /> : null}
            {Svg ? <Text> </Text> : null}
            <Button
              key="record"
              hotkey="r"
              label={Svg ? 'Record with Clipy' : '● Record with Clipy'}
              onPress={() => start($, options)}
            />
            <Text> </Text>
            <Button key="hide" hotkey="h" label="Hide" dimColor onPress={() => setHidden($, true)} />
          </Box>
        </Box>
        {state.hint ? <Text dimColor>{state.hint}</Text> : null}
      </Box>
    )
  })
}
