import type { EngineInterface } from 'claude-code'

import { storedKey } from './signin'

type $ = EngineInterface

const CLIPY = 'https://clipy.online'
const UTM = 'utm_source=claude-code&utm_medium=plugin&utm_campaign=record-button-cloud'
/** Where a cloud session sends the person to record: their library, with New recording. */
export const RECORD_URL = `${CLIPY}/videos?${UTM}`

/**
 * Where the band records. `local`: this computer, through the Clipy app, and
 * the take stays here. `cloud`: the session runs off the person's computer, so
 * they record on theirs and Claude reads the share link. null: no band.
 */
export type Mode = 'local' | 'cloud' | null

export async function modeOf($: $): Promise<Mode> {
  const { platform, isHosted } = await $.session.info()
  const remote = await $.env.get('CLAUDE_CODE_REMOTE').catch(() => undefined)
  if (isHosted || remote === 'true') return 'cloud'
  return platform === 'macos' || platform === 'windows' ? 'local' : null
}

export type KeySource = 'env' | 'signin' | null

/** CLIPY_API_KEY in the environment wins; else the key the band signed in for. */
export async function keyFor($: $): Promise<{ key: string; source: KeySource }> {
  const env = ((await $.env.get('CLIPY_API_KEY').catch(() => undefined)) ?? '').trim()
  const saved = await storedKey($)
  // The band shares its own key as CLIPY_API_KEY, which still counts as the sign-in's.
  if (env && env !== saved) return { key: env, source: 'env' }
  return saved ? { key: saved, source: 'signin' } : { key: '', source: null }
}

export async function apiKey($: $): Promise<string> {
  return (await keyFor($)).key
}

export type CloudRecording = {
  id: string
  createdAt: string
  /** uploading while it records, then transcoding, transcribing, annotating, ready or failed. */
  stage: string
  /** preparing, usable, complete or failed: whether an agent can read it yet. */
  readiness: string
}

/** The newest recording in a `/api/v1/recordings?limit=1` answer; null when there is none. */
export function newestOf(text: string): CloudRecording | null {
  try {
    const first = (JSON.parse(text) as { recordings?: Array<Record<string, unknown>> }).recordings?.[0]
    if (!first || typeof first.id !== 'string' || !first.id) return null
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    return { id: first.id, createdAt: str(first.createdAt), stage: str(first.stage), readiness: str(first.agentReadiness) }
  } catch {
    return null
  }
}

/** `serverTime`: the response's Date header as ISO, on the same clock that stamps createdAt. */
export type Newest = {
  recording: CloudRecording | null
  error: string | null
  serverTime?: string | null
  /** Clipy refused the key itself (401 or 403). */
  refused?: boolean
}

/** An HTTP Date header as ISO; null when absent or unreadable. */
export function isoFromHttpDate(value: string | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function isApiError(text: string): boolean {
  try {
    return typeof (JSON.parse(text) as { error?: unknown }).error === 'string'
  } catch {
    return false
  }
}

/** The newest recording in the person's Clipy library, read with their API key. */
export async function fetchNewest($: $, key: string): Promise<Newest> {
  try {
    const r = await $.http.fetch(`${CLIPY}/api/v1/recordings?limit=1`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'clipy-record-plugin' },
    })
    // Only Clipy's own refusal counts: a 401, or a 403 carrying the API's JSON error.
    // A 403 page from a proxy or WAF must not wipe a good key.
    if (r.status === 401 || (r.status === 403 && isApiError(r.text))) {
      return {
        recording: null,
        refused: true,
        error: 'Clipy refused the key. Check it can read recordings, or sign in again.',
      }
    }
    if (!r.ok) return { recording: null, error: `Clipy did not answer (${r.status}). Try again in a moment.` }
    return { recording: newestOf(r.text), error: null, serverTime: isoFromHttpDate(r.headers.date) }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return {
      recording: null,
      error: `This session can't reach clipy.online (${why}). Allow it in the environment's network access.`,
    }
  }
}

/**
 * Whether `r` was made after Record was pressed. created_at is ISO, so it
 * compares as text. The baseline covers what was in the library; `since`, the
 * server's time at the press, covers a take still uploading then, which the
 * library does not list until it plays.
 */
export function isNewer(
  r: CloudRecording,
  baselineId: string | null,
  baselineAt: string | null,
  since: string | null = null,
): boolean {
  if (r.id === baselineId) return false
  if (since && r.createdAt && r.createdAt < since) return false
  return !baselineAt || !r.createdAt || r.createdAt >= baselineAt
}

/** Whether Claude can read it now: transcript and summary are in, or it failed and says so. */
export function isReadable(r: CloudRecording): boolean {
  return r.readiness === 'usable' || r.readiness === 'complete' || r.readiness === 'failed' || r.stage === 'failed'
}

export function cloudPrompt(id: string): string {
  return (
    'I just recorded my screen with Clipy to show you something. ' +
    `Read its agent context at ${CLIPY}/video/${id}.arec ` +
    '(an AREC document: the timestamped transcript, summary and key moments, each with a screenshot link), ' +
    `and open ${CLIPY}/video/${id} if you need the video. ` +
    'If the link asks for sign-in, read it with the Clipy CLI and the CLIPY_API_KEY in this environment: ' +
    `npx -y @clipy/cli@0.21.0 context ${id}. ` +
    "Look at the screenshots that matter, then do what I asked in it. If it isn't clear, summarize what you saw and ask."
  )
}
