import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clock as format, splitCommand } from './register'
import { confirmationCode } from './signin'
import { nameFromFind, nameFromInfo, pickDisplay } from './display'

const BAND = {
  plugin: 'clipy-record',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

type Out = { exitCode: number; stdout: string; stderr: string }
type Cli = {
  version?: string | null
  start?: Out | 'throw'
  stop?: Out | 'throw'
  abort?: 'throw'
  /** What `session status` says; 'fail' makes the command itself fail. */
  status?: string
  /** Claude Code refuses the prompt the band submits. */
  submitDeny?: string
  /** Screens: the host app's bundle id, what `lsappinfo find` prints, and `clipy sources --json`. */
  bundle?: string
  find?: string
  sources?: unknown
  /** The app refuses any --display, as after that monitor was unplugged. */
  noDisplay?: true
}

const ran = (o: Out) => ({ value: { ...o, isStdoutTruncated: false, isStderrTruncated: false } })

/** The host beneath the mod: a Mac, a data folder, and a clipy that answers as told. */
function host(on: On, cli: Cli, platform: 'macos' | 'linux' = 'macos') {
  const calls: string[][] = []
  const prompts: string[] = []
  const clock = mock.clock(on)
  // Paths Clipy trashed: a cancel in the app removes the take's folder.
  const gone: string[] = []
  on('fs.stat', (_, e) =>
    gone.some(g => e.path.startsWith(g))
      ? { deny: 'missing' }
      : { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } },
  )
  on('session.info', () => ({ value: { platform, isHosted: false, transcriptPath: '/t.jsonl' } }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data/clipy-record' } }))
  if (cli.bundle) on('env.get', (_, e) => ({ value: e.name === '__CFBundleIdentifier' ? cli.bundle : undefined }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const args = e.argv.join(' ')
    if (e.argv[0] === 'lsappinfo') return ran({ exitCode: 0, stdout: args.includes('find') ? (cli.find ?? '') : '', stderr: '' })
    if (args.includes(' sources ') || args.endsWith('sources --json') || args.includes("'sources'")) {
      return ran({ exitCode: 0, stdout: JSON.stringify(cli.sources ?? { displays: [], windows: [] }), stderr: '' })
    }
    if (args.includes('--version')) {
      if (cli.version == null) return { deny: 'not found' }
      return ran({ exitCode: 0, stdout: `${cli.version}\n`, stderr: '' })
    }
    if (args.includes('session start')) {
      if (cli.start === 'throw') return { deny: 'could not launch' }
      if (cli.noDisplay && args.includes('--display')) {
        return ran({ exitCode: 1, stdout: '', stderr: 'error: no display with id 1\n' })
      }
      return ran(cli.start ?? { exitCode: 0, stdout: '{"state":"recording"}', stderr: '' })
    }
    if (args.includes('session abort') && cli.abort === 'throw') return { deny: 'could not launch' }
    if (args.includes('session status')) {
      if (cli.status === 'fail') return ran({ exitCode: 1, stdout: '', stderr: 'error: bridge timed out\n' })
      return ran({ exitCode: 0, stdout: `{"state":"${cli.status ?? 'recording'}"}`, stderr: '' })
    }
    if (args.includes('session stop')) {
      if (cli.stop === 'throw') return { deny: 'timed out' }
      return ran(
        cli.stop ?? {
          exitCode: 0,
          stdout: '{"arec":"/recordings/take/recording.arec","state":"stopped"}',
          stderr: '',
        },
      )
    }
    return ran({ exitCode: 0, stdout: '{}', stderr: '' })
  })
  on('prompt.submit', (_, e) => {
    if (cli.submitDeny) return { drop: cli.submitDeny }
    prompts.push(e.text)
    return { text: e.text }
  })
  return { calls, prompts, clock, gone }
}

test('record, watch the timer, stop and hand the AREC to Claude', async ($, on) => {
  const { calls, prompts, clock } = host(on, { version: '0.20.0' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'record' })

    const start = calls.find(c => c.includes('start'))
    expect(start).toEqual(expect.arrayContaining(['--local', '--source', 'mac-screen', '--mic', '--max', '600']))
    expect((await ui.find({ type: 'Text', text: /0:00/ }))?.text).toContain('0:00')
    expect(await ui.find({ key: 'stop' })).toBeDefined()

    await clock.advance(5_000)
    expect((await ui.find({ type: 'Text', text: /0:05/ }))?.text).toContain('0:05')

    await ui.press({ key: 'stop' })
    expect(prompts.at(-1)).toContain('/recordings/take/recording.arec')
    expect(await ui.find({ key: 'record' })).toBeDefined()
    await ui.unmount()
    calls.length = 0
  }
})

test('the desktop draws the Clipy mark beside the button; the terminal keeps the dot', async ($, on) => {
  host(on, { version: '0.20.0' })
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await desktop.findAll({}))).toContain('"type":"Svg"')
  expect((await desktop.find({ key: 'record' }))?.text).toBe('Record with Clipy')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await terminal.findAll({}))).not.toContain('"type":"Svg"')
  expect((await terminal.find({ key: 'record' }))?.text).toBe('● Record with Clipy')
  await terminal.unmount()
})

test('cancel throws the take away and says nothing to Claude', async ($, on) => {
  const { calls, prompts } = host(on, { version: '0.20.0' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await ui.press({ key: 'cancel' })

  expect(calls.some(c => c.includes('abort'))).toBe(true)
  expect(prompts).toEqual([])
  expect(await ui.find({ key: 'record' })).toBeDefined()
  await ui.unmount()
})

test("the CLI's error and an update hint show in the band", async ($, on) => {
  host(on, {
    version: '0.19.0',
    start: {
      exitCode: 1,
      stdout: '',
      stderr: 'error: The Clipy app (v1.1.84) is running but cannot keep a recording on this computer.\n',
    },
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'record' })

    expect((await ui.find({ type: 'Text', text: /cannot keep a recording/ }))?.text).toContain('v1.1.84')
    expect((await ui.find({ type: 'Text', text: /npm i -g @clipy\/cli@latest/ }))?.text).toContain('0.20.0')
    await ui.unmount()
  }
})

test('a CLI too old to record locally is named before trying', async ($, on) => {
  const { calls } = host(on, { version: '0.13.1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  expect((await ui.find({ type: 'Text', text: /too old/ }))?.text).toContain('0.13.1')
  expect(calls.some(c => c.includes('start'))).toBe(false)
  await ui.unmount()
})

test('no CLI at all says how to install it', async ($, on) => {
  host(on, { version: null })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  expect(await ui.find({ type: 'Text', text: /isn't installed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm i -g @clipy\/cli/ })).toBeDefined()
  await ui.unmount()
})

test('a configured command runs instead of clipy', { options: { clipyCommand: 'node /cli/dist/index.js' } }, async ($, on) => {
  const { calls } = host(on, { version: '0.19.0' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  expect(calls[0]?.slice(0, 2)).toEqual(['node', '/cli/dist/index.js'])
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()
})

test('no band where Clipy cannot record', async ($, on) => {
  host(on, { version: '0.20.0' }, 'linux')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ key: 'record' })).toBeUndefined()
  await ui.unmount()
})

test('a take stopped in the Clipy app still reaches Claude', async ($, on) => {
  const arec = '/recordings/take/recording.arec'
  const cli: Cli = {
    version: '0.20.0',
    start: { exitCode: 0, stdout: `{"state":"recording","local":true,"arec":"${arec}"}`, stderr: '' },
  }
  const { calls, prompts, clock } = host(on, cli)
  let stage = 'transcribing'
  on('fs.read', (_, e) => {
    expect(e.path).toBe('/recordings/take/status.json')
    return { value: JSON.stringify({ stage }) }
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await clock.advance(3000)
  expect(await ui.find({ key: 'stop' })).toBeDefined()

  cli.status = 'ended'
  await clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: /building the recording/ })).toBeDefined()
  expect(calls.some(c => c.includes('abort'))).toBe(true)
  expect(prompts).toEqual([])

  stage = 'ready'
  await clock.advance(2000)
  expect(prompts.at(-1)).toContain(arec)
  expect(prompts.at(-1)).toContain('stopped it in the Clipy app')
  expect(await ui.find({ key: 'record' })).toBeDefined()
  await ui.unmount()
})

test('Hide tucks the band away across sessions and /record-button brings it back', async ($, on) => {
  host(on, { version: '0.20.0' })
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'record' })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ key: 'record' })).toBeUndefined()
    await ui.unmount()

    // A new session remembers.
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const again = await $.ui.mount({ ...BAND, surface })
    expect(await again.find({ key: 'record' })).toBeUndefined()

    const shown = await $.command.run({ command: 'record-button' } as never)
    expect(JSON.stringify(shown)).toContain('back above the prompt')
    expect(await again.find({ key: 'record' })).toBeDefined()
    await again.unmount()
  }
})

test('with no Clipy app running, the band says to open it and where to get it', async ($, on) => {
  host(on, {
    version: '0.20.0',
    start: {
      exitCode: 1,
      stdout: '',
      stderr: 'error: Neither the Clipy app nor Clipy Local is running. Open Clipy (or install it from https://clipy.online/download) and try again.\n',
    },
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  expect((await ui.find({ type: 'Text', text: /isn't open/ }))?.text).toBe("Clipy isn't open, so the recording didn't start.")
  const hint = (await ui.find({ type: 'Text', text: /utm_source=claude-code/ }))?.text
  expect(hint).toContain('Open the Clipy app')
  expect(hint).toContain('Clipy Local')
  await ui.unmount()
})

test('a take stopped in the app on Windows reads the status beside its AREC', async ($, on) => {
  const arec = 'C:\\Clipy\\take\\recording.arec'
  const cli: Cli = {
    version: '0.20.0',
    start: { exitCode: 0, stdout: JSON.stringify({ state: 'recording', arec }), stderr: '' },
    status: 'ended',
  }
  const { prompts, clock } = host(on, cli)
  const read: string[] = []
  on('fs.read', (_, e) => {
    read.push(e.path)
    return { value: JSON.stringify({ stage: 'ready' }) }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await clock.advance(3000)

  expect(read[0]).toEndWith('C:\\Clipy\\take\\status.json')
  expect(prompts.at(-1)).toContain(arec)
  await ui.unmount()
})

test('a take whose processing failed still reaches Claude as a Partial AREC', async ($, on) => {
  const arec = '/recordings/take/recording.arec'
  const { prompts } = host(on, {
    version: '0.20.0',
    stop: {
      exitCode: 1,
      stdout: JSON.stringify({ ok: false, local: true, status: 'failed', arec, message: 'Partial: processing failed.' }),
      stderr: '',
    },
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await ui.press({ key: 'stop' })

  expect(prompts.at(-1)).toContain(arec)
  expect(await ui.find({ type: 'Text', text: /Partial/ })).toBeUndefined()
  await ui.unmount()
})

test('a take cancelled in the Clipy app sends nothing to Claude', async ($, on) => {
  const arec = '/recordings/take/recording.arec'
  const cli: Cli = {
    version: '0.20.0',
    start: { exitCode: 0, stdout: JSON.stringify({ state: 'recording', arec }), stderr: '' },
  }
  const { prompts, clock, gone } = host(on, cli)
  on('fs.read', () => ({ deny: 'missing' }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  cli.status = 'ended'
  gone.push('/recordings/take')
  await clock.advance(3000)

  expect(prompts).toEqual([])
  expect(await ui.find({ key: 'record' })).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeDefined()
  await ui.unmount()
})

test('the timer reads minutes and seconds', () => {
  expect(format(5)).toBe('0:05')
  expect(format(65)).toBe('1:05')
  expect(format(600)).toBe('10:00')
})

test('a CLI that cannot run leaves the band usable', async ($, on) => {
  const cli: Cli = { version: '0.20.0', start: 'throw' }
  host(on, cli)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  expect(await ui.find({ type: 'Text', text: /did not run/ })).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeDefined()

  // A stop that fails while the app still records brings Stop and Cancel back.
  cli.start = undefined
  cli.stop = 'throw'
  await ui.press({ key: 'record' })
  await ui.press({ key: 'stop' })
  expect(await ui.find({ type: 'Text', text: /did not run/ })).toBeDefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  await ui.unmount()
})

test('a cancel that cannot run keeps Stop and Cancel while Clipy records', async ($, on) => {
  const cli: Cli = { version: '0.20.0', abort: 'throw' }
  const { prompts } = host(on, cli)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await ui.press({ key: 'cancel' })

  expect(await ui.find({ type: 'Text', text: /could not cancel/ })).toBeDefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeUndefined()
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('a configured command keeps quoted paths with spaces together', () => {
  expect(splitCommand('node "D:\\Clipy Tools\\cli\\index.js"')).toEqual(['node', 'D:\\Clipy Tools\\cli\\index.js'])
  expect(splitCommand("  /usr/bin/node '/opt/Clipy Tools/cli.js'  ")).toEqual(['/usr/bin/node', '/opt/Clipy Tools/cli.js'])
  expect(splitCommand('clipy')).toEqual(['clipy'])
  expect(splitCommand('node ""')).toEqual(['node', ''])
})

test('upgrading the CLI after a too-old message works on the next press', async ($, on) => {
  const cli: Cli = { version: '0.13.1' }
  host(on, cli)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  expect(await ui.find({ type: 'Text', text: /too old/ })).toBeDefined()

  cli.version = '0.20.0'
  await ui.press({ key: 'record' })
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()
})

type Rec = { id: string; createdAt: string; stage: string; agentReadiness: string }

/** A cloud session: Linux off the person's computer, a Clipy library read over the API. */
type Answer = { status: number; text?: string } | 'hang'

function cloudHost(
  on: On,
  env: Record<string, string> = { CLAUDE_CODE_REMOTE: 'true', CLIPY_API_KEY: 'clipy_test_key' },
  isHosted = false,
  stored: Record<string, unknown> = {},
) {
  const library: Rec[] = [{ id: 'old1', createdAt: '2026-11-27T09:00:00.000Z', stage: 'ready', agentReadiness: 'complete' }]
  const prompts: string[] = []
  const runs: string[][] = []
  const auth: string[] = []
  const clock = mock.clock(on)
  // The environment, read and written: the band shares its key as CLIPY_API_KEY.
  const vars: Record<string, string | undefined> = { ...env }
  on('env.get', (_, e) => ({ value: vars[e.name] }))
  on('env.set', (_, e) => {
    vars[e.name] = e.value
    return { value: {} }
  })
  mock.store(on, stored)
  // The next answers the API gives, in order; empty means the library as it stands.
  const answers: Answer[] = []
  // Sign-in: the poll stays pending until `login.approved`; the paste works for `login.code`.
  const login = { approved: false, code: 'good-code', pollStatus: 0, verifiers: [] as string[] }
  const signinBodies: string[] = []
  on('session.info', () => ({ value: { platform: 'linux' as const, isHosted, transcriptPath: '/t.jsonl' } }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data/clipy-record' } }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { deny: 'no Clipy app in a cloud session' }
  })
  on('http.fetch', (_, e) => {
    const reply = (status: number, body: unknown) => ({
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
    })
    if (e.url.endsWith('/api/cli-auth/poll')) {
      signinBodies.push(String(e.init?.body ?? ''))
      if (login.pollStatus) return reply(login.pollStatus, { error: 'Not found' })
      return login.approved
        ? reply(200, { apiKey: 'clipy_signed_in', scopes: ['recordings:read'], email: 'me@example.test' })
        : reply(202, { status: 'pending' })
    }
    if (e.url.endsWith('/api/cli-auth/exchange')) {
      const body = JSON.parse(String(e.init?.body ?? '{}')) as { code?: string }
      return body.code === login.code
        ? reply(200, { apiKey: 'clipy_pasted', scopes: ['recordings:read'], email: null })
        : reply(400, { error: 'invalid or expired code' })
    }
    auth.push(String((e.init?.headers as Record<string, string> | undefined)?.Authorization ?? ''))
    const answer = answers.shift()
    if (answer === 'hang') return new Promise<never>(() => {})
    const status = answer?.status ?? 200
    const text = answer?.text ?? JSON.stringify({ recordings: library.slice(0, 1) })
    // The server's clock when Record is pressed: 09:30, after the old take and before the new ones.
    return { value: { status, ok: status < 300, headers: { date: 'Fri, 27 Nov 2026 09:30:00 GMT' }, text } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  const add = (r: Rec) => library.unshift(r)
  return { library, prompts, runs, auth, clock, add, answers, toasts, login, signinBodies, vars }
}

test('a local session keeps the plain band and the plain Record button', async ($, on) => {
  host(on, { version: '0.20.0' })
  const local = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const drawn = JSON.stringify(await local.findAll({}))
  expect(drawn).not.toContain('backgroundColor')
  expect(JSON.stringify(await local.find({ key: 'record' }))).not.toContain('primary')
  expect(drawn).toContain('Stays on this computer')
  await local.unmount()
})

test('in a cloud session Record is the primary button on a plain band', async ($, on) => {
  cloudHost(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const drawn = JSON.stringify(await ui.findAll({}))
    expect(drawn).not.toContain('backgroundColor')
    expect(JSON.stringify(await ui.find({ key: 'record' }))).toContain('"variant":"primary"')
    await ui.unmount()
  }
})

test('cloud: record on the computer, and Claude gets the new recording once it is readable', async ($, on) => {
  const { prompts, runs, auth, clock, add, library } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  expect(await ui.find({ key: 'send' })).toBeDefined()
  expect(JSON.stringify(await ui.findAll({}))).toContain('https://clipy.online/videos')
  expect(auth[0]).toBe('Bearer clipy_test_key')

  // Still recording in Clipy: nothing is sent.
  add({ id: 'new1', createdAt: '2026-11-27T10:00:00.000Z', stage: 'uploading', agentReadiness: 'preparing' })
  await clock.advance(10_000)
  expect(prompts).toEqual([])
  expect((await ui.find({ type: 'Text', text: /Clipy is recording/ }))?.text).toBeDefined()

  // Transcript and summary in: sent, and the band is back to Record.
  library[0] = { ...library[0]!, stage: 'annotating', agentReadiness: 'usable' }
  await clock.advance(5_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('https://clipy.online/video/new1.arec')
  expect(prompts[0]).not.toContain('old1')
  expect(await ui.find({ key: 'record' })).toBeDefined()
  // A cloud session never runs the Clipy CLI.
  expect(runs).toEqual([])
  await ui.unmount()
})

test('cloud: a recording still preparing after three minutes is sent anyway', async ($, on) => {
  const { prompts, clock, add } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'record' })
  add({ id: 'slow1', createdAt: '2026-11-27T10:00:00.000Z', stage: 'transcribing', agentReadiness: 'preparing' })
  await clock.advance(60_000)
  expect(prompts).toEqual([])
  await clock.advance(180_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('slow1')
  await ui.unmount()
})

test('cloud: Send now with nothing new keeps waiting; Cancel sends nothing', async ($, on) => {
  const { prompts } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await ui.press({ key: 'send' })
  expect(prompts).toEqual([])
  expect(await ui.find({ key: 'send' })).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(prompts).toEqual([])
  expect(await ui.find({ key: 'record' })).toBeDefined()
  await ui.unmount()
})

test('cloud: Send now sends a recording that is still preparing', async ($, on) => {
  const { prompts, add } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  add({ id: 'prep1', createdAt: '2026-11-27T10:00:00.000Z', stage: 'transcoding', agentReadiness: 'preparing' })
  await ui.press({ key: 'send' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('prep1')
  await ui.unmount()
})

const NO_KEY = { CLAUDE_CODE_REMOTE: 'true' }

test('cloud with no key offers sign-in, which finishes by itself once approved', async ($, on) => {
  const { login, auth, clock, signinBodies, toasts } = cloudHost(on, NO_KEY)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'record' })).toBeUndefined()
  await ui.press({ key: 'signin' })

  const drawn = JSON.stringify(await ui.findAll({}))
  expect(drawn).toContain('https://clipy.online/cli/authorize?')
  expect(drawn).toContain('mode=manual')
  expect(drawn).toContain('scopes=recordings%3Aread')
  expect(await ui.find({ key: 'code' })).toBeDefined()

  await clock.advance(6_000)
  expect(await ui.find({ key: 'code' })).toBeDefined()
  // The poll proves itself with the verifier, and the challenge in the link is that verifier's hash.
  const verifier = (JSON.parse(signinBodies[0]!) as { verifier: string }).verifier
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)

  login.approved = true
  await clock.advance(3_000)
  expect(toasts.at(-1)).toContain('me@example.test')
  // Straight on to waiting for the recording, with the new key.
  expect(await ui.find({ key: 'send' })).toBeDefined()
  expect(auth.at(-1)).toBe('Bearer clipy_signed_in')
  await ui.unmount()
})

test('cloud sign-in: a pasted code works, and a wrong one says so and keeps waiting', async ($, on) => {
  const { auth } = cloudHost(on, NO_KEY)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'signin' })
  await ui.input({ key: 'code', text: 'wrong-code', kind: 'submit' })
  expect((await ui.find({ type: 'Text', text: /didn't work or has expired/ }))?.text).toBeDefined()
  expect(await ui.find({ key: 'code' })).toBeDefined()
  await ui.input({ key: 'code', text: 'good-code', kind: 'submit' })
  expect(await ui.find({ key: 'send' })).toBeDefined()
  expect(auth.at(-1)).toBe('Bearer clipy_pasted')
  await ui.unmount()
})

test('cloud sign-in against a server without the poll asks for the code', async ($, on) => {
  const { login, clock } = cloudHost(on, NO_KEY)
  login.pollStatus = 404
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'signin' })
  await clock.advance(3_000)
  expect((await ui.find({ type: 'Text', text: /Paste the code/ }))?.text).toBeDefined()
  expect(await ui.find({ key: 'code' })).toBeDefined()
  await ui.unmount()
})

test('a saved sign-in Clipy refuses is cleared and sign-in is offered again', async ($, on) => {
  const { answers } = cloudHost(on, NO_KEY, false, { apiKey: 'clipy_revoked' })
  answers.push({ status: 401, text: '{"error":"Invalid API key"}' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  expect((await ui.find({ type: 'Text', text: /refused the saved sign-in/ }))?.text).toBeDefined()
  expect(await ui.find({ key: 'signin' })).toBeDefined()
  await ui.unmount()
})

test('cloud sign-in can be cancelled, and gives up after ten minutes', async ($, on) => {
  const { clock } = cloudHost(on, NO_KEY)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'signin' })
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'signin' })).toBeDefined()
  await ui.press({ key: 'signin' })
  await clock.advance(10 * 60_000 + 2_000)
  expect((await ui.find({ type: 'Text', text: /timed out/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('a hosted session counts as cloud with no CLAUDE_CODE_REMOTE', async ($, on) => {
  cloudHost(on, { CLIPY_API_KEY: 'clipy_test_key' }, true)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await ui.findAll({}))).toContain('Claude reads the share link')
  expect(await ui.find({ key: 'destination' })).toBeUndefined()
  await ui.unmount()
})

test('cloud: a refused key says so and keeps the band usable', async ($, on) => {
  const { answers, prompts } = cloudHost(on)
  answers.push({ status: 401, text: '{"error":"Invalid API key"}' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  expect((await ui.find({ type: 'Text', text: /refused the CLIPY_API_KEY/ }))?.text).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeDefined()
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('cloud: a request that never answers stops holding the band, and a later check sends', async ($, on) => {
  const { answers, prompts, clock, add, toasts } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  answers.push('hang')
  await clock.advance(5_000)
  // The hung check holds the library read: Send now says so rather than doing nothing.
  await ui.press({ key: 'send' })
  expect(toasts.at(-1)).toContain('Still checking')
  expect(prompts).toEqual([])
  add({ id: 'late1', createdAt: '2026-11-27T10:00:00.000Z', stage: 'ready', agentReadiness: 'complete' })
  // Checks keep backing off while the stalled one is fresh, then go ahead without it.
  await clock.advance(10_000)
  expect(prompts).toEqual([])
  await clock.advance(15_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('late1')
  await ui.unmount()
})

test('cloud: nothing new in 30 minutes ends the wait without sending', async ($, on) => {
  const { prompts, clock } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'record' })
  await clock.advance(30 * 60_000 + 2_000)
  expect((await ui.find({ type: 'Text', text: /30 minutes/ }))?.text).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeDefined()
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('cloud: a check from a cancelled wait never sends into the next one', async ($, on) => {
  const { answers, prompts, clock, add } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  // This check stalls; the person cancels and records again before it gives up.
  answers.push('hang')
  await clock.advance(5_000)
  await ui.press({ key: 'cancel' })
  await clock.advance(1_000)
  await ui.press({ key: 'record' })
  add({ id: 'fresh1', createdAt: '2026-11-27T10:00:00.000Z', stage: 'ready', agentReadiness: 'complete' })
  await clock.advance(15_000)
  // Only the new wait's own check sends, and only once.
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('fresh1')
  await ui.unmount()
})

test('cloud: a first lookup that stalls can be cancelled, and its late answer changes nothing', async ($, on) => {
  const { answers, prompts, clock } = cloudHost(on)
  answers.push('hang')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // The press never settles while its lookup hangs, so it is not awaited.
  void ui.press({ key: 'record' })
  await clock.advance(100)
  expect((await ui.find({ type: 'Text', text: /Checking your Clipy library/ }))?.text).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'record' })).toBeDefined()
  // Record again works, with the stalled start left behind.
  await ui.press({ key: 'record' })
  expect(await ui.find({ key: 'send' })).toBeDefined()
  await clock.advance(10_000)
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('cloud: a take still uploading when Record was pressed is not sent as the new one', async ($, on) => {
  const { prompts, clock, add } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  // Started at 09:15, before the press, and only listed once it plays.
  add({ id: 'earlier1', createdAt: '2026-11-27T09:15:00.000Z', stage: 'ready', agentReadiness: 'complete' })
  await clock.advance(10_000)
  expect(prompts).toEqual([])
  add({ id: 'mine1', createdAt: '2026-11-27T09:31:00.000Z', stage: 'ready', agentReadiness: 'complete' })
  await clock.advance(5_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('mine1')
  await ui.unmount()
})

test('Clipy quitting mid-recording says so, clears the session, and Record works again', async ($, on) => {
  const cli: Cli = { version: '0.20.0' }
  const { calls, prompts, clock } = host(on, cli)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  cli.status = 'dead'
  // One dead answer could be a blip; the band waits for a second.
  await clock.advance(3_000)
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await clock.advance(3_000)
  expect((await ui.find({ type: 'Text', text: /stopped answering/ }))?.text).toContain('nothing was sent')
  expect((await ui.find({ type: 'Text', text: /Open Clipy/ }))?.text).toBeDefined()
  expect(calls.some(c => c.join(' ').includes('session abort'))).toBe(true)
  expect(await ui.find({ key: 'record' })).toBeDefined()
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('status checks that keep failing show an error but keep Stop and Cancel, and recover', async ($, on) => {
  const cli: Cli = { version: '0.20.0' }
  const { clock } = host(on, cli)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'record' })
  cli.status = 'fail'
  await clock.advance(9_000)
  expect((await ui.find({ type: 'Text', text: /Can't reach Clipy/ }))?.text).toContain('bridge timed out')
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  cli.status = 'recording'
  await clock.advance(3_000)
  expect(await ui.find({ type: 'Text', text: /Can't reach Clipy/ })).toBeUndefined()
  await ui.unmount()
})

test('a prompt Claude Code refuses leaves the path in the band instead of losing it', async ($, on) => {
  host(on, { version: '0.20.0', submitDeny: 'a turn is running' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await ui.press({ key: 'stop' })
  expect((await ui.find({ type: 'Text', text: /could not be sent to Claude/ }))?.text).toContain('a turn is running')
  expect((await ui.find({ type: 'Text', text: /Paste this into the prompt/ }))?.text).toContain('/recordings/take/recording.arec')
  await ui.unmount()
})

test('stop when Clipy has quit says so instead of a generic failure', async ($, on) => {
  const cli: Cli = { version: '0.20.0', stop: { exitCode: 1, stdout: '', stderr: 'error: the Clipy app is not answering\n' } }
  host(on, cli)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  cli.status = 'dead'
  await ui.press({ key: 'stop' })
  expect((await ui.find({ type: 'Text', text: /stopped answering/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('Switch to Cloud records through the app with upload and sends Claude the share link', async ($, on) => {
  const cli: Cli = {
    version: '0.20.0',
    stop: { exitCode: 0, stdout: '{"id":"abc123","shareUrl":"https://clipy.online/video/abc123"}', stderr: '' },
  }
  const { calls, prompts } = host(on, cli)
  mock.store(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'destination' })

  expect(JSON.stringify(await ui.find({ key: 'record' }))).toContain('"variant":"primary"')
  expect(JSON.stringify(await ui.findAll({}))).toContain('Uploads to Clipy')
  expect((await ui.find({ key: 'destination' }))?.text).toBe('Switch to Local')

  await ui.press({ key: 'record' })
  const start = calls.find(c => c.join(' ').includes('session start'))
  expect(start).not.toContain('--local')
  // Status and stop for an uploading take are asked without --local too.
  await ui.press({ key: 'stop' })
  expect(calls.find(c => c.join(' ').includes('session stop'))).not.toContain('--local')
  expect(prompts.at(-1)).toContain('https://clipy.online/video/abc123.arec')
  expect(await ui.find({ key: 'record' })).toBeDefined()
  await ui.unmount()
})

test('the Local/Cloud choice is kept across sessions', async ($, on) => {
  host(on, { version: '0.20.0' })
  mock.store(on, { destination: 'cloud' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await ui.find({ key: 'record' }))).toContain('"variant":"primary"')
  expect((await ui.find({ key: 'destination' }))?.text).toBe('Switch to Local')
  await ui.unmount()
})

test('Cloud on this computer with the CLI signed out says how to sign in', async ($, on) => {
  host(on, {
    version: '0.20.0',
    start: { exitCode: 1, stdout: '{"error":"no API key. Run clipy login to approve this device"}', stderr: '' },
  })
  mock.store(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'destination' })
  await ui.press({ key: 'record' })
  expect((await ui.find({ type: 'Text', text: /needs Clipy signed in/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /clipy login/ }))?.text).toContain('switch the band to Local')
  await ui.unmount()
})

test('a cloud session has no Local/Cloud toggle', async ($, on) => {
  cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'destination' })).toBeUndefined()
  await ui.unmount()
})

test('the match code is computed as clipy.online computes it', async () => {
  // The same vector is tested in lib/server/__tests__/cliAuthPoll.test.ts.
  expect(await confirmationCode('VUjza-715nZd22cDut-6X__MMgZ8B9E2MP8fvGp1CSI')).toBe('7GV8-VNDY')
})

test('cloud sign-in shows the match code the approval page shows', async ($, on) => {
  cloudHost(on, NO_KEY)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'signin' })
  const drawn = JSON.stringify(await ui.findAll({}))
  const challenge = /challenge=([A-Za-z0-9_-]{43})/.exec(drawn)?.[1]
  expect(challenge).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Code / }))?.text).toContain(await confirmationCode(challenge!))
  // The verifier itself is never drawn.
  expect(drawn).not.toMatch(/verifier/i)
  await ui.unmount()
})

test('cloud sign-in: a spent login stops polling and keeps its error, and the paste still works', async ($, on) => {
  const { login, clock, signinBodies } = cloudHost(on, NO_KEY)
  login.pollStatus = 400
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'signin' })
  await clock.advance(3_000)
  const polls = signinBodies.length
  expect((await ui.find({ type: 'Text', text: /Cancel and sign in again/ }))?.text).toBeDefined()
  await clock.advance(15_000)
  expect(signinBodies.length).toBe(polls)
  expect((await ui.find({ type: 'Text', text: /Cancel and sign in again/ }))?.text).toBeDefined()
  expect(await ui.find({ key: 'code' })).toBeDefined()
  await ui.unmount()
})

test('a 403 page from a proxy does not wipe a saved sign-in', async ($, on) => {
  const { answers } = cloudHost(on, NO_KEY, false, { apiKey: 'clipy_good' })
  answers.push({ status: 403, text: '<html>Attention required</html>' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  expect((await ui.find({ type: 'Text', text: /Clipy did not answer \(403\)/ }))?.text).toBeDefined()
  // Still signed in: Record, not Sign in.
  expect(await ui.find({ key: 'record' })).toBeDefined()
  expect(await ui.find({ key: 'signin' })).toBeUndefined()
  await ui.unmount()
})

test('after sign-in, Claude’s own commands get the key as CLIPY_API_KEY', async ($, on) => {
  const { login, clock, vars } = cloudHost(on, NO_KEY)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'signin' })
  login.approved = true
  await clock.advance(3_000)
  expect(vars.CLIPY_API_KEY).toBe('clipy_signed_in')
  await ui.unmount()
})

test('a key the person set is never replaced by the sign-in', async ($, on) => {
  const { prompts, vars, auth } = cloudHost(on, { CLAUDE_CODE_REMOTE: 'true', CLIPY_API_KEY: 'clipy_mine' }, false, { apiKey: 'clipy_old' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  expect(vars.CLIPY_API_KEY).toBe('clipy_mine')
  expect(auth.at(-1)).toBe('Bearer clipy_mine')
  expect(prompts).toEqual([])
  await ui.unmount()
})

// The layout from a real three-screen Mac: the built-in display is 1 at (0,0), two above it.
const SCREENS = {
  displays: [
    { id: 4, x: 732, y: -1440, width: 3440, height: 1440 },
    { id: 1, x: 0, y: 0, width: 1512, height: 982 },
    { id: 3, x: -1828, y: -1440, width: 2560, height: 1440 },
  ],
  windows: [
    { app_name: '\u200eWhatsApp', x: 1200, y: -1200, width: 1094, height: 842 },
    { app_name: 'Claude', x: 2000, y: -30, width: 22, height: 22 },
    { app_name: 'Claude', x: 0, y: 33, width: 1512, height: 949 },
  ],
}

test('the screen Claude Code is on is the one recorded', () => {
  expect(pickDisplay(SCREENS, 'Claude')).toBe(1)
  expect(pickDisplay(SCREENS, 'WhatsApp')).toBe(4)
  // A window straddling screens goes where its centre is.
  expect(pickDisplay({ ...SCREENS, windows: [{ app_name: 'iTerm2', x: -400, y: -900, width: 1000, height: 600 }] }, 'iTerm2')).toBe(3)
  // Nothing to choose with one screen, or with no real window of the app.
  expect(pickDisplay({ ...SCREENS, displays: [SCREENS.displays[1]!] }, 'Claude')).toBeNull()
  expect(pickDisplay(SCREENS, 'Cursor')).toBeNull()
})

test('lsappinfo output gives the host app name', () => {
  expect(nameFromFind('ASN:0x0-0x392d92a-"Claude":\n')).toBe('Claude')
  expect(nameFromFind('')).toBeNull()
  expect(nameFromInfo('"iTerm2" ASN:0x0-0x16e16e0: (in front)\n    bundleID=[ NULL ]')).toBe('iTerm2')
})

test('Record passes the display of the app running Claude Code', async ($, on) => {
  const { calls } = host(on, {
    version: '0.20.0',
    bundle: 'com.anthropic.claudefordesktop',
    find: 'ASN:0x0-0x392d92a-"Claude":',
    sources: SCREENS,
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  const start = calls.find(c => c.join(' ').includes('session start'))!
  expect(start).toEqual(expect.arrayContaining(['--display', '1']))
  // Local asks the same app the take records with, so Clipy Local alone works too.
  const sources = calls.find(c => c.join(' ').includes('sources'))!.join(' ')
  expect(sources).toContain('--local')
  expect(sources).toContain('mac-screen')
  await ui.unmount()
})

test('a screen that cannot be found falls back to the default one', async ($, on) => {
  const { calls } = host(on, {
    version: '0.20.0',
    bundle: 'com.anthropic.claudefordesktop',
    find: 'ASN:0x0-0x1-"Claude":',
    sources: SCREENS,
    noDisplay: true,
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  const starts = calls.filter(c => c.join(' ').includes('session start'))
  expect(starts).toHaveLength(2)
  expect(starts[0]).toContain('--display')
  expect(starts[1]).not.toContain('--display')
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()
})

test('starting a session asks for the band to be drawn, then again while the view attaches', async ($, on) => {
  const { clock } = host(on, { version: '0.20.0' })
  mock.store(on)
  const redraws: string[] = []
  on('ui.invalidate', (_, e) => {
    redraws.push(String(e.event))
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(redraws).toEqual(['ui.render'])
  await clock.advance(32_000)
  expect(redraws.length).toBe(5)
  expect(redraws.every(r => r === 'ui.render')).toBe(true)
})
