import type { EngineInterface } from 'claude-code'

type $ = EngineInterface

const CLIPY = 'https://clipy.online'
/** What the key may do: read the library to find the new recording, nothing else. */
const SCOPES = 'recordings:read'
const CLIENT_NAME = 'Claude Code (cloud session)'
const STORE_KEY = 'apiKey'

/** The key this session uses: CLIPY_API_KEY wins; else the one the band signed in for. */
export async function storedKey($: $): Promise<string> {
  const value = await $.store.get(STORE_KEY).catch(() => undefined)
  return typeof value === 'string' ? value.trim() : ''
}

/** Saves the key; returns why Claude's commands could not get it, if they could not. */
export async function saveKey($: $, key: string): Promise<string | null> {
  await $.store.set(STORE_KEY, key)
  return shareKey($, key)
}

/**
 * Gives Claude's own commands the signed-in key, so `clipy context <id>` can
 * read a private recording: the CLI reads CLIPY_API_KEY. Never replaces a key
 * the person set themselves. Returns why not, when the engine refuses.
 */
export async function shareKey($: $, key: string): Promise<string | null> {
  try {
    const current = ((await $.env.get('CLIPY_API_KEY').catch(() => undefined)) ?? '').trim()
    if (current && current !== key) return null
    const result = await $.env.set('CLIPY_API_KEY', key)
    return 'deny' in result && typeof result.deny === 'string' ? result.deny : null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Forgets a key Clipy refused, so the band offers sign-in again, and takes it back from Claude's commands. */
export async function forgetKey($: $): Promise<void> {
  const saved = await storedKey($)
  await $.store.set(STORE_KEY, null)
  const current = ((await $.env.get('CLIPY_API_KEY').catch(() => undefined)) ?? '').trim()
  if (saved && current === saved) await $.env.set('CLIPY_API_KEY', undefined).catch(() => undefined)
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** `confirm`: the match code the approval page shows too (see `confirmationCode`). */
export type Login = { verifier: string; url: string; confirm: string }

const CONFIRM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * The approval page's match code for a challenge, computed as clipy.online does
 * (lib/server/cli-auth.ts `confirmationCode`): Crockford base32 of
 * SHA-256(challenge), first 8 characters, as ABCD-EFGH.
 */
export async function confirmationCode(challenge: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(challenge)))
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of digest) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5 && out.length < 8) {
      out += CONFIRM_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    if (out.length >= 8) break
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`
}

/**
 * A copy-code login, the one `clipy login --no-browser` uses: the page shows a
 * code to paste, and the band also polls for the approval so pasting is only
 * the fallback. The verifier never leaves this session except to claim the key.
 */
export async function newLogin(): Promise<Login> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64url(new Uint8Array(digest))
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)))
  const url = new URL(`${CLIPY}/cli/authorize`)
  url.searchParams.set('challenge', challenge)
  url.searchParams.set('state', state)
  url.searchParams.set('mode', 'manual')
  url.searchParams.set('name', CLIENT_NAME)
  url.searchParams.set('scopes', SCOPES)
  return { verifier, url: url.toString(), confirm: await confirmationCode(challenge) }
}

/**
 * `key` once approved; `pending` until then. An error is `transient` (the next
 * poll may work), `final` (this login is spent: start over), or `unsupported`
 * (an older clipy.online without the poll: paste the code).
 */
export type Claim =
  | { key: string; email: string | null }
  | { pending: true }
  | { error: string; kind: 'transient' | 'final' | 'unsupported' }

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'clipy-record-plugin' }

function keyFrom(text: string): { key: string; email: string | null } | null {
  try {
    const body = JSON.parse(text) as { apiKey?: unknown; email?: unknown }
    if (typeof body.apiKey !== 'string' || !body.apiKey) return null
    return { key: body.apiKey, email: typeof body.email === 'string' ? body.email : null }
  } catch {
    return null
  }
}

function errorFrom(text: string, status: number): string {
  try {
    const said = (JSON.parse(text) as { error?: unknown }).error
    if (typeof said === 'string' && said) return `${said} (${status})`
  } catch {
    // not JSON
  }
  return `Clipy answered ${status}`
}

/** Asks whether the person approved yet (no-paste sign-in). */
export async function pollLogin($: $, verifier: string): Promise<Claim> {
  try {
    const r = await $.http.fetch(`${CLIPY}/api/cli-auth/poll`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ verifier }),
    })
    if (r.status === 202 || r.status === 429) return { pending: true }
    if (r.ok) {
      return keyFrom(r.text) ?? { error: 'Clipy approved the sign-in but sent no key. Paste the code instead.', kind: 'unsupported' }
    }
    // An older clipy.online has no poll: the pasted code still works.
    if (r.status === 404 || r.status === 405) {
      return { error: 'Paste the code from the sign-in page to finish.', kind: 'unsupported' }
    }
    // A 4xx spends or refuses this login (the key limit, say): polling again cannot help.
    if (r.status >= 400 && r.status < 500) {
      return { error: `${errorFrom(r.text, r.status)}. Cancel and sign in again.`, kind: 'final' }
    }
    return { error: `${errorFrom(r.text, r.status)}. Still trying.`, kind: 'transient' }
  } catch (e) {
    return {
      error: `This session can't reach clipy.online (${e instanceof Error ? e.message : String(e)}). Still trying.`,
      kind: 'transient',
    }
  }
}

/** Trades the pasted code for a key (copy-code sign-in). */
export async function exchangeCode($: $, code: string, verifier: string): Promise<Claim> {
  try {
    const r = await $.http.fetch(`${CLIPY}/api/cli-auth/exchange`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ code: code.trim(), verifier }),
    })
    if (r.ok) return keyFrom(r.text) ?? { error: 'Clipy accepted the code but sent no key. Try signing in again.', kind: 'final' }
    if (r.status === 400) {
      const said = errorFrom(r.text, r.status)
      return /key limit/i.test(said)
        ? { error: `${said}.`, kind: 'final' }
        : { error: "That code didn't work or has expired. Paste it again, or start over.", kind: 'transient' }
    }
    return { error: errorFrom(r.text, r.status), kind: 'transient' }
  } catch (e) {
    return { error: `This session can't reach clipy.online (${e instanceof Error ? e.message : String(e)}).`, kind: 'transient' }
  }
}
