// SPDX-License-Identifier: Apache-2.0
// GENERATED from lib/browserDiagnostics.ts Do not edit here. Edit the monorepo source and re-run oss/scripts/sync-from-monorepo.mjs.
export const BROWSER_DIAGNOSTICS_SCHEMA_VERSION = 2 as const;
const ACCEPTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];
export const MAX_BROWSER_DIAGNOSTIC_EVENTS = 2000;
export const MAX_BROWSER_DIAGNOSTICS_BYTES = 2 * 1024 * 1024;
export const MAX_BROWSER_DIAGNOSTICS_FULL_DETAIL_BYTES = 6 * 1024 * 1024;
export const MAX_DIAGNOSTIC_REQUEST_BODY_CHARS = 8192;
export const MAX_DIAGNOSTIC_RESPONSE_BODY_CHARS = 16384;
export const MAX_DIAGNOSTIC_STREAM_DATA_CHARS = 2048;
export const MAX_DIAGNOSTIC_HEADERS = 40;
export const MAX_DIAGNOSTIC_STACK_CHARS = 2000;
export const MAX_DIAGNOSTIC_PAGE_METADATA_CHARS = 10240;
export const DIAGNOSTIC_REDACTED = '[redacted]';
export const DIAGNOSTIC_TRUNCATED_MARKER = '…[truncated]';
const MAX_TEXT_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_RAW_TEXT_LENGTH = 8192;
const MAX_RAW_BODY_LENGTH = 65536;
const MAX_URL_LENGTH = 1024;
const MAX_FULL_URL_LENGTH = 2048;
const MAX_EVENT_TIME_MS = 12 * 60 * 60 * 1000;
export const MAX_ELEMENT_SELECTOR_LENGTH = 120;
const SECRET_KEY_NAMES = 'authorization|auth[_-]?token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|pwd|passphrase|private[_-]?key|session[_-]?id|sessionid|jsessionid|phpsessid|session|cookie|csrf|xsrf|bearer|token|credential|signature';
const SECRET_KEY_FRAGMENT = `[A-Za-z0-9_-]*(?:${SECRET_KEY_NAMES})[A-Za-z0-9_-]*`;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(`${SECRET_KEY_FRAGMENT}["']?\\s*([:=])\\s*(?:"[^"]*"|'[^']*'|[^\\s,;)}\\]]+)`, 'gi');
const SECRET_ADJACENT_PATTERN = new RegExp(`(${SECRET_KEY_FRAGMENT})\\s+["']?([A-Za-z0-9._~+/=-]{8,})`, 'gi');
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]*:[^\s@/]+@/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN[^-]{0,64}-----[\s\S]*?(?:-----END[^-]{0,64}-----|$)/g;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{12,}\b/g;
const BASE64_BLOB_PATTERN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{24,}={0,2}(?![A-Za-z0-9+/])/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
const SSN_PATTERN = /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/g;
const CARD_NUMBER_PATTERN = /\b(?:[0-9]{4}[ -]){3}[0-9]{1,4}\b|\b[0-9]{13,19}\b/g;
const SENSITIVE_PATH_SEGMENT_PATTERN = /(?:^|\/)(?:[0-9]{4,}|[A-Fa-f0-9]{8}-(?:[A-Fa-f0-9]{4}-){3}[A-Fa-f0-9]{12}|[A-Za-z0-9_-]{16,}|(?=[A-Za-z0-9_-]{10,}(?:\/|$))(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+)(?=\/|$)/g;
const SENSITIVE_QUERY_KEY_PATTERN = new RegExp(`^(?:${SECRET_KEY_NAMES}|ssn|sin|nino|tax[_-]?id|dob|birth[_-]?date|credit[_-]?card|card[_-]?number|cardnumber|cvv|cvc|pan|iban|account[_-]?number|email|e[_-]?mail|phone|tel|mobile|address|postcode|zip)$`, 'i');
const SENSITIVE_FIELD_PATTERN = new RegExp(`${SECRET_KEY_NAMES}|api[_-]?key|otp|one[_-]?time|ssn|social[_-]?security|tax[_-]?id|dob|birth|passport|licen[cs]e[_-]?number|credit[_-]?card|card[_-]?number|cardnumber|card[_-]?cvc|cvv|cvc|iban|account[_-]?number|routing[_-]?number|e[_-]?mail|phone|mobile|address|street|postcode|postal|zip[_-]?code|first[_-]?name|last[_-]?name|full[_-]?name|surname`, 'i');
const DESCRIPTIVE_FIELD_SUFFIX_PATTERN = /(?:[_-]?(?:type|count|length|expires?(?:[_-]?(?:in|at))?|status|required|enabled|present|valid|verified|exists|policy|strength|hint|format|provider|method|scope|label|placeholder|changed|set))$/i;
const ALWAYS_WITHHELD_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'set-cookie2',
    'x-api-key',
    'x-auth-token',
    'x-csrf-token',
    'x-xsrf-token',
]);
export function isSensitiveDiagnosticField(name: string): boolean {
    const key = String(name).trim();
    if (!key)
        return false;
    if (ALWAYS_WITHHELD_HEADERS.has(key.toLowerCase()))
        return true;
    if (DESCRIPTIVE_FIELD_SUFFIX_PATTERN.test(key))
        return false;
    return SENSITIVE_FIELD_PATTERN.test(key);
}
export type BrowserDiagnosticsConsoleMode = 'off' | 'errors' | 'all';
export type BrowserDiagnosticsNetworkMode = 'off' | 'failures' | 'all';
export type BrowserDiagnosticsUrlMode = 'route' | 'origin';
export type BrowserDiagnosticsTextMode = 'standard' | 'strict';
export type BrowserDiagnosticsNetworkDetailMode = 'off' | 'full';
export interface BrowserDiagnosticsPolicy {
    console: BrowserDiagnosticsConsoleMode;
    network: BrowserDiagnosticsNetworkMode;
    navigation: boolean;
    urls: BrowserDiagnosticsUrlMode;
    text: BrowserDiagnosticsTextMode;
    excludedOrigins: string[];
    networkDetail: BrowserDiagnosticsNetworkDetailMode;
    actions: boolean;
}
export const DEFAULT_EXCLUDED_DIAGNOSTIC_ORIGINS: string[] = [
    'accounts.google.com',
    'securetoken.googleapis.com',
    'identitytoolkit.googleapis.com',
    'login.microsoftonline.com',
    'login.live.com',
    '*.okta.com',
    '*.auth0.com',
    '*.onelogin.com',
    '*.duosecurity.com',
    'appleid.apple.com',
];
export const MAX_EXCLUDED_DIAGNOSTIC_ORIGINS = 50;
export const DEFAULT_BROWSER_DIAGNOSTICS_POLICY: BrowserDiagnosticsPolicy = {
    console: 'errors',
    network: 'failures',
    navigation: true,
    urls: 'route',
    text: 'standard',
    excludedOrigins: DEFAULT_EXCLUDED_DIAGNOSTIC_ORIGINS,
    networkDetail: 'off',
    actions: true,
};
export function isExcludedDiagnosticOrigin(url: string, patterns: readonly string[]): boolean {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    }
    catch {
        return false;
    }
    return patterns.some((pattern) => {
        const p = pattern.trim().toLowerCase();
        if (!p)
            return false;
        if (p.startsWith('*.')) {
            const base = p.slice(2);
            return host === base || host.endsWith(`.${base}`);
        }
        return host === p;
    });
}
const REDACTED_MESSAGE = '[message hidden by capture settings]';
export type BrowserConsoleLevel = 'debug' | 'info' | 'log' | 'warn' | 'error';
export type BrowserConsoleMethod = 'table' | 'assert' | 'trace' | 'dir' | 'count';
export type BrowserNavigationKind = 'initial' | 'push_state' | 'replace_state' | 'pop_state' | 'hash_change';
export type BrowserNavigationLoadType = 'navigate' | 'reload' | 'back_forward' | 'prerender';
export type BrowserNetworkTransport = 'fetch' | 'xhr' | 'beacon' | 'resource' | 'document';
export type BrowserNetworkOutcome = 'success' | 'http_error' | 'network_error' | 'graphql_error' | 'aborted';
export type BrowserBodyOmittedReason = 'policy' | 'binary' | 'too_large' | 'streaming' | 'unreadable' | 'opaque' | 'empty' | 'not_armed';
export interface BrowserNetworkTiming {
    dns_ms?: number;
    connect_ms?: number;
    ttfb_ms?: number;
    download_ms?: number;
}
export interface BrowserGraphqlSummary {
    operation?: string;
    operation_type?: 'query' | 'mutation' | 'subscription';
    errors?: number;
    first_error?: string;
}
export interface BrowserNetworkEvent {
    kind: 'network';
    time_ms: number;
    transport: BrowserNetworkTransport;
    method: string;
    url: string;
    status: number | null;
    duration_ms: number;
    outcome: BrowserNetworkOutcome;
    error?: string;
    resource_type?: string;
    response_type?: string;
    response_size?: number;
    request_body_size?: number;
    timing?: BrowserNetworkTiming;
    graphql?: BrowserGraphqlSummary;
    initiator?: string;
    full_url?: string;
    request_headers?: Record<string, string>;
    response_headers?: Record<string, string>;
    request_body?: string;
    response_body?: string;
    body_omitted?: {
        request?: BrowserBodyOmittedReason;
        response?: BrowserBodyOmittedReason;
    };
}
export interface BrowserStreamEvent {
    kind: 'stream';
    time_ms: number;
    protocol: 'websocket' | 'eventsource';
    connection: string;
    action: 'open' | 'message' | 'error' | 'close';
    url: string;
    direction?: 'sent' | 'received';
    size?: number;
    data?: string;
    code?: number;
    reason?: string;
    messages_sent?: number;
    messages_received?: number;
    bytes_sent?: number;
    bytes_received?: number;
}
export interface BrowserActionEvent {
    kind: 'action';
    time_ms: number;
    action: 'click' | 'submit' | 'change' | 'input';
    target: string;
    role?: string;
    selector?: string;
    checked?: boolean;
}
export type BrowserDiagnosticEvent = {
    kind: 'console';
    time_ms: number;
    level: BrowserConsoleLevel;
    message: string;
    method?: BrowserConsoleMethod;
    stack?: string;
} | {
    kind: 'error' | 'unhandled_rejection';
    time_ms: number;
    message: string;
    source?: string;
    line?: number;
    column?: number;
    stack?: string;
} | {
    kind: 'navigation';
    time_ms: number;
    navigation: BrowserNavigationKind;
    url: string;
    load_type?: BrowserNavigationLoadType;
} | BrowserNetworkEvent | BrowserStreamEvent | BrowserActionEvent;
export interface BrowserDiagnosticsEnvironment {
    page_url: string;
    platform: string | null;
    language: string | null;
    viewport_width: number | null;
    viewport_height: number | null;
    device_pixel_ratio: number | null;
    timezone_offset_minutes: number | null;
    browser_name?: string | null;
    browser_version?: string | null;
    os_name?: string | null;
    os_version?: string | null;
    user_agent?: string | null;
    screen_width?: number | null;
    screen_height?: number | null;
    timezone?: string | null;
    connection_type?: string | null;
    downlink_mbps?: number | null;
    rtt_ms?: number | null;
    incognito?: boolean | null;
    extension_version?: string | null;
    country?: string | null;
}
export interface BrowserDetectedTools {
    sentry?: {
        environment: string | null;
        release: string | null;
    };
    logrocket_url?: string;
    fullstory_url?: string;
}
export interface BrowserPageMetadata {
    data?: string;
    error?: 'not_a_function' | 'threw' | 'not_a_plain_object' | 'too_large' | 'not_serializable';
}
export interface BrowserDiagnosticsSidecar {
    schema_version: typeof BROWSER_DIAGNOSTICS_SCHEMA_VERSION;
    source: 'extension' | 'cdp';
    policy: BrowserDiagnosticsPolicy;
    environment: BrowserDiagnosticsEnvironment | null;
    events: BrowserDiagnosticEvent[];
    dropped_events: number;
    page_metadata?: BrowserPageMetadata | null;
    detected_tools?: BrowserDetectedTools | null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finiteNumber(value: unknown, min: number, max: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
        ? value
        : null;
}
function stringValue(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, maxLength) : null;
}
function redactedText(value: unknown): string | null {
    const raw = stringValue(value, MAX_RAW_TEXT_LENGTH);
    return raw ? redactBrowserDiagnosticText(raw) : null;
}
export function redactBrowserDiagnosticText(value: string, maxLength = MAX_TEXT_LENGTH): string {
    return redactPatterns(value.slice(0, MAX_RAW_TEXT_LENGTH)).slice(0, maxLength);
}
function redactPatterns(value: string): string {
    return value
        .replace(PRIVATE_KEY_BLOCK_PATTERN, '[redacted-key-block]')
        .replace(BEARER_PATTERN, (_match, scheme: string) => `${scheme} [redacted]`)
        .replace(URL_CREDENTIALS_PATTERN, (_match, scheme: string) => `${scheme}[redacted]:[redacted]@`)
        .replace(SECRET_ASSIGNMENT_PATTERN, (_match, separator: string) => `[redacted]${separator}[redacted]`)
        .replace(SECRET_ADJACENT_PATTERN, (_match, key: string) => `${key} [redacted]`)
        .replace(JWT_PATTERN, '[redacted-token]')
        .replace(AWS_ACCESS_KEY_PATTERN, '[redacted-token]')
        .replace(EMAIL_PATTERN, '[redacted-email]')
        .replace(SSN_PATTERN, '[redacted-id]')
        .replace(CARD_NUMBER_PATTERN, '[redacted-number]')
        .replace(BASE64_BLOB_PATTERN, '[redacted-token]')
        .replace(LONG_TOKEN_PATTERN, '[redacted-token]');
}
function truncateWithMarker(value: string, maxChars: number): string {
    if (value.length <= maxChars)
        return value;
    const keep = Math.max(0, maxChars - DIAGNOSTIC_TRUNCATED_MARKER.length);
    return `${value.slice(0, keep)}${DIAGNOSTIC_TRUNCATED_MARKER}`;
}
const MAX_JSON_REDACTION_DEPTH = 32;
export function redactDiagnosticJsonValue(value: unknown, depth = 0): unknown {
    if (depth > MAX_JSON_REDACTION_DEPTH)
        return DIAGNOSTIC_REDACTED;
    if (typeof value === 'string')
        return redactPatterns(value);
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map((item) => redactDiagnosticJsonValue(item, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        result[key] =
            isSensitiveDiagnosticField(key) && child !== null && child !== '' && child !== false
                ? DIAGNOSTIC_REDACTED
                : redactDiagnosticJsonValue(child, depth + 1);
    }
    return result;
}
function looksLikeJson(text: string): boolean {
    const first = text.trimStart()[0];
    return first === '{' || first === '[';
}
function looksLikeFormEncoded(text: string, contentType: string | null): boolean {
    if (contentType && /application\/x-www-form-urlencoded/i.test(contentType))
        return true;
    return !contentType && /^[^\s=&]+=[^\s]*(?:&[^\s=&]+=[^\s]*)*$/.test(text.trim()) && text.length < 4096;
}
function multipartBoundary(text: string, contentType: string | null): string | null {
    if (contentType && /multipart\//i.test(contentType)) {
        const declared = /boundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(contentType);
        if (declared)
            return declared[1] ?? declared[2] ?? null;
    }
    const first = /^--([^\r\n]{1,200})\r?\n/.exec(text);
    return first && /content-disposition:\s*form-data/i.test(text.slice(0, 4096)) ? first[1] : null;
}
const MULTIPART_OMITTED = '[multipart body omitted]';
const MULTIPART_FILE_OMITTED = '[file omitted]';
function redactMultipartBody(text: string, boundary: string): string {
    const delimiter = `--${boundary}`;
    const segments = text.split(delimiter);
    if (segments.length < 2)
        return MULTIPART_OMITTED;
    const parts: string[] = [];
    let closed = false;
    for (const segment of segments.slice(1)) {
        if (segment.startsWith('--')) {
            closed = true;
            break;
        }
        const split = /^\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(segment);
        if (!split) {
            parts.push(`\r\n${DIAGNOSTIC_REDACTED}\r\n`);
            continue;
        }
        const [, headers, rawValue] = split;
        const value = rawValue.replace(/\r?\n$/, '');
        const name = /\bname="([^"]*)"/i.exec(headers)?.[1] ?? '';
        const isFile = /\bfilename\*?\s*=/i.test(headers);
        const kept = isFile
            ? MULTIPART_FILE_OMITTED
            : !name || isSensitiveDiagnosticField(name)
                ? DIAGNOSTIC_REDACTED
                : redactPatterns(value);
        const partHeaders = isFile
            ? headers.replace(/\bfilename(\*?)\s*=\s*(?:"[^"\r\n]*"|[^;\r\n]*)/gi, `filename$1="${DIAGNOSTIC_REDACTED}"`)
            : headers;
        parts.push(`\r\n${redactPatterns(partHeaders)}\r\n\r\n${kept}\r\n`);
    }
    if (parts.length === 0)
        return MULTIPART_OMITTED;
    return `${delimiter}${parts.join(delimiter)}${delimiter}${closed ? '--' : ''}`;
}
export function redactDiagnosticBody(body: string, contentType: string | null, maxChars: number): string {
    const raw = body.slice(0, MAX_RAW_BODY_LENGTH);
    let redacted: string;
    const boundary = multipartBoundary(raw, contentType);
    if (boundary !== null) {
        try {
            redacted = redactMultipartBody(raw, boundary);
        }
        catch {
            redacted = MULTIPART_OMITTED;
        }
    }
    else if (contentType && /multipart\//i.test(contentType)) {
        redacted = MULTIPART_OMITTED;
    }
    else if (looksLikeJson(raw)) {
        try {
            redacted = JSON.stringify(redactDiagnosticJsonValue(JSON.parse(raw)));
        }
        catch {
            redacted = redactPatterns(raw);
        }
    }
    else if (looksLikeFormEncoded(raw, contentType)) {
        try {
            const params = new URLSearchParams(raw);
            const out: string[] = [];
            for (const [key, value] of params) {
                out.push(`${encodeURIComponent(key)}=${isSensitiveDiagnosticField(key) ? DIAGNOSTIC_REDACTED : encodeURIComponent(redactPatterns(value))}`);
            }
            redacted = out.join('&');
        }
        catch {
            redacted = redactPatterns(raw);
        }
    }
    else {
        redacted = redactPatterns(raw);
    }
    const cut = body.length > MAX_RAW_BODY_LENGTH ? `${redacted}${DIAGNOSTIC_TRUNCATED_MARKER}` : redacted;
    return truncateWithMarker(cut, maxChars);
}
export function redactDiagnosticHeaders(headers: unknown): Record<string, string> | undefined {
    if (!isRecord(headers))
        return undefined;
    const out: Record<string, string> = {};
    let count = 0;
    for (const [rawName, rawValue] of Object.entries(headers)) {
        if (count >= MAX_DIAGNOSTIC_HEADERS)
            break;
        const name = String(rawName).trim().toLowerCase().slice(0, 128);
        if (!name || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))
            continue;
        const value = typeof rawValue === 'string' ? rawValue : rawValue == null ? '' : String(rawValue);
        out[name] = isSensitiveDiagnosticField(name)
            ? DIAGNOSTIC_REDACTED
            : redactBrowserDiagnosticText(value, MAX_TEXT_LENGTH) || '';
        count++;
    }
    return count > 0 ? out : undefined;
}
export function redactDiagnosticFullUrl(value: string): string | null {
    try {
        const parsed = new URL(value, URL_SENTINEL_ORIGIN);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
            return null;
        }
        if (parsed.origin === URL_SENTINEL_ORIGIN)
            return null;
        const path = redactPatterns(parsed.pathname);
        const query: string[] = [];
        for (const [key, val] of parsed.searchParams) {
            query.push(`${encodeURIComponent(key.slice(0, 64))}=${isSensitiveDiagnosticField(key) || SENSITIVE_QUERY_KEY_PATTERN.test(key)
                ? DIAGNOSTIC_REDACTED
                : encodeURIComponent(redactPatterns(val)).replace(/%5B(redacted[a-z-]*)%5D/gi, '[$1]')}`);
        }
        return `${parsed.origin}${path}${query.length ? `?${query.join('&')}` : ''}`.slice(0, MAX_FULL_URL_LENGTH);
    }
    catch {
        return null;
    }
}
export function redactDiagnosticPageMetadata(json: string): string | null {
    if (typeof json !== 'string' || json.length > MAX_DIAGNOSTIC_PAGE_METADATA_CHARS * 2)
        return null;
    try {
        const parsed = JSON.parse(json) as unknown;
        if (!isRecord(parsed))
            return null;
        const text = JSON.stringify(redactDiagnosticJsonValue(parsed));
        return text.length <= MAX_DIAGNOSTIC_PAGE_METADATA_CHARS * 2 ? text : null;
    }
    catch {
        return null;
    }
}
const URL_SENTINEL_ORIGIN = 'https://clipy-invalid.invalid';
const REDACTED_QUERY_KEY = '[redacted-key]';
const RELATIVE_TARGET_ORIGIN = 'https://relative.invalid';
export function sanitizeBrowserDiagnosticUrl(value: string): string | null {
    try {
        const parsed = new URL(value, URL_SENTINEL_ORIGIN);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            return null;
        if (parsed.origin === URL_SENTINEL_ORIGIN)
            return null;
        const path = redactBrowserDiagnosticText(parsed.pathname.replace(SENSITIVE_PATH_SEGMENT_PATTERN, '/:id'));
        const keys = [
            ...new Set([...parsed.searchParams.keys()].map((key) => SENSITIVE_QUERY_KEY_PATTERN.test(key) ? REDACTED_QUERY_KEY : key.slice(0, 64))),
        ].sort();
        const query = keys.length > 0
            ? `?${keys.map((key) => (key === REDACTED_QUERY_KEY ? key : encodeURIComponent(key))).join('&')}`
            : '';
        return `${parsed.origin}${path}${query}`.slice(0, MAX_URL_LENGTH);
    }
    catch {
        return null;
    }
}
function normalizeTime(value: unknown): number | null {
    const parsed = finiteNumber(value, 0, MAX_EVENT_TIME_MS);
    return parsed === null ? null : Math.round(parsed);
}
function normalizeMethod(value: unknown): string {
    const raw = stringValue(value, 16)?.toUpperCase() ?? 'GET';
    return /^[A-Z]+$/.test(raw) ? raw : 'GET';
}
const CONSOLE_LEVELS: readonly BrowserConsoleLevel[] = ['debug', 'info', 'log', 'warn', 'error'];
const CONSOLE_METHODS: readonly BrowserConsoleMethod[] = ['table', 'assert', 'trace', 'dir', 'count'];
const NAVIGATION_KINDS: readonly BrowserNavigationKind[] = [
    'initial',
    'push_state',
    'replace_state',
    'pop_state',
    'hash_change',
];
const LOAD_TYPES: readonly BrowserNavigationLoadType[] = ['navigate', 'reload', 'back_forward', 'prerender'];
const NETWORK_TRANSPORTS: readonly BrowserNetworkTransport[] = ['fetch', 'xhr', 'beacon', 'resource', 'document'];
const NETWORK_OUTCOMES: readonly BrowserNetworkOutcome[] = [
    'success',
    'http_error',
    'network_error',
    'graphql_error',
    'aborted',
];
const BODY_OMITTED_REASONS: readonly BrowserBodyOmittedReason[] = [
    'policy',
    'binary',
    'too_large',
    'streaming',
    'unreadable',
    'opaque',
    'empty',
    'not_armed',
];
const STREAM_ACTIONS: readonly BrowserStreamEvent['action'][] = ['open', 'message', 'error', 'close'];
const ACTION_KINDS: readonly BrowserActionEvent['action'][] = ['click', 'submit', 'change', 'input'];
function redactedMessage(value: unknown): string | null {
    const raw = stringValue(value, MAX_RAW_TEXT_LENGTH);
    return raw ? redactBrowserDiagnosticText(raw, MAX_MESSAGE_LENGTH) : null;
}
function replaceStackUrls(stack: string, rewrite: (url: string) => string | null): string {
    return stack.replace(/\bhttps?:\/\/\S*/g, (match) => {
        const parts = /^(.*?)((?::\d+){1,2})?([),]*)$/.exec(match);
        const url = parts?.[1] ?? match;
        const position = parts?.[2] ?? '';
        const close = parts?.[3] ?? '';
        const replaced = rewrite(url);
        return `${replaced ?? '[url omitted]'}${position}${close}`;
    });
}
function redactedStack(value: unknown): string | undefined {
    const raw = stringValue(value, MAX_RAW_TEXT_LENGTH);
    if (!raw)
        return undefined;
    const lines = raw
        .split('\n')
        .slice(0, 30)
        .map((line) => line.replace(/\?[^\s):]*/g, ''))
        .map((line) => replaceStackUrls(line, (url) => sanitizeBrowserDiagnosticUrl(url)))
        .join('\n');
    const redacted = redactBrowserDiagnosticText(lines, MAX_DIAGNOSTIC_STACK_CHARS);
    return redacted || undefined;
}
function nonNegativeInt(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
    const n = finiteNumber(value, 0, max);
    return n === null ? undefined : Math.round(n);
}
function shortToken(value: unknown, maxLength: number, pattern = /^[A-Za-z0-9_.+/-]+$/): string | undefined {
    const raw = stringValue(value, maxLength);
    return raw && pattern.test(raw) ? raw : undefined;
}
function normalizeTiming(value: unknown): BrowserNetworkTiming | undefined {
    if (!isRecord(value))
        return undefined;
    const timing: BrowserNetworkTiming = {};
    for (const key of ['dns_ms', 'connect_ms', 'ttfb_ms', 'download_ms'] as const) {
        const n = finiteNumber(value[key], 0, MAX_EVENT_TIME_MS);
        if (n !== null)
            timing[key] = Math.round(n);
    }
    return Object.keys(timing).length > 0 ? timing : undefined;
}
function normalizeGraphql(value: unknown): BrowserGraphqlSummary | undefined {
    if (!isRecord(value))
        return undefined;
    const operation = shortToken(value.operation, 128, /^[A-Za-z_][A-Za-z0-9_]*$/);
    const operationType = enumValue(value.operation_type, ['query', 'mutation', 'subscription'] as const, 'query');
    const errors = nonNegativeInt(value.errors, 10000);
    const firstError = value.first_error === undefined ? null : redactedText(value.first_error);
    const summary: BrowserGraphqlSummary = {
        ...(operation ? { operation } : {}),
        ...(value.operation_type !== undefined ? { operation_type: operationType } : {}),
        ...(errors !== undefined ? { errors } : {}),
        ...(firstError ? { first_error: firstError } : {}),
    };
    return Object.keys(summary).length > 0 ? summary : undefined;
}
function normalizeBodyOmitted(value: unknown): BrowserNetworkEvent['body_omitted'] {
    if (!isRecord(value))
        return undefined;
    const request = BODY_OMITTED_REASONS.includes(value.request as BrowserBodyOmittedReason)
        ? (value.request as BrowserBodyOmittedReason)
        : undefined;
    const response = BODY_OMITTED_REASONS.includes(value.response as BrowserBodyOmittedReason)
        ? (value.response as BrowserBodyOmittedReason)
        : undefined;
    if (!request && !response)
        return undefined;
    return { ...(request ? { request } : {}), ...(response ? { response } : {}) };
}
function normalizeMimeType(value: unknown): string | undefined {
    const raw = stringValue(value, 200);
    if (!raw)
        return undefined;
    const mime = raw.split(';')[0].trim().toLowerCase();
    return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : undefined;
}
function normalizeNetworkEvent(value: Record<string, unknown>, time_ms: number): BrowserNetworkEvent | null {
    const transport = value.transport as BrowserNetworkTransport;
    const url = typeof value.url === 'string' ? sanitizeBrowserDiagnosticUrl(value.url) : null;
    const duration_ms = finiteNumber(value.duration_ms, 0, MAX_EVENT_TIME_MS);
    const status = value.status === null ? null : finiteNumber(value.status, 0, 999);
    const outcome = value.outcome as BrowserNetworkOutcome;
    if (!url ||
        duration_ms === null ||
        (value.status !== null && status === null) ||
        !NETWORK_TRANSPORTS.includes(transport) ||
        !NETWORK_OUTCOMES.includes(outcome)) {
        return null;
    }
    const error = redactedText(value.error);
    const resourceType = shortToken(value.resource_type, 32, /^[a-z0-9_-]+$/i);
    const responseType = normalizeMimeType(value.response_type);
    const responseSize = nonNegativeInt(value.response_size, 10 * 1024 * 1024 * 1024);
    const requestBodySize = nonNegativeInt(value.request_body_size, 10 * 1024 * 1024 * 1024);
    const timing = normalizeTiming(value.timing);
    const graphql = normalizeGraphql(value.graphql);
    const initiator = typeof value.initiator === 'string' ? redactedStack(value.initiator)?.split('\n')[0]?.slice(0, 300) : undefined;
    const fullUrl = typeof value.full_url === 'string' ? redactDiagnosticFullUrl(value.full_url) : null;
    const requestHeaders = redactDiagnosticHeaders(value.request_headers);
    const responseHeaders = redactDiagnosticHeaders(value.response_headers);
    const requestBody = typeof value.request_body === 'string' && value.request_body
        ? redactDiagnosticBody(value.request_body, requestHeaders?.['content-type'] ?? null, MAX_DIAGNOSTIC_REQUEST_BODY_CHARS)
        : undefined;
    const responseBody = typeof value.response_body === 'string' && value.response_body
        ? redactDiagnosticBody(value.response_body, responseType ?? null, MAX_DIAGNOSTIC_RESPONSE_BODY_CHARS)
        : undefined;
    const bodyOmitted = normalizeBodyOmitted(value.body_omitted);
    return {
        kind: 'network',
        time_ms,
        transport,
        method: normalizeMethod(value.method),
        url,
        status: status === null ? null : Math.round(status),
        duration_ms: Math.round(duration_ms),
        outcome,
        ...(error ? { error } : {}),
        ...(resourceType ? { resource_type: resourceType } : {}),
        ...(responseType ? { response_type: responseType } : {}),
        ...(responseSize !== undefined ? { response_size: responseSize } : {}),
        ...(requestBodySize !== undefined ? { request_body_size: requestBodySize } : {}),
        ...(timing ? { timing } : {}),
        ...(graphql ? { graphql } : {}),
        ...(initiator ? { initiator } : {}),
        ...(fullUrl ? { full_url: fullUrl } : {}),
        ...(requestHeaders ? { request_headers: requestHeaders } : {}),
        ...(responseHeaders ? { response_headers: responseHeaders } : {}),
        ...(requestBody ? { request_body: requestBody } : {}),
        ...(responseBody ? { response_body: responseBody } : {}),
        ...(bodyOmitted ? { body_omitted: bodyOmitted } : {}),
    };
}
function normalizeStreamUrl(value: unknown): string | null {
    if (typeof value !== 'string')
        return null;
    if (!/^wss?:\/\//i.test(value))
        return sanitizeBrowserDiagnosticUrl(value);
    const sanitized = sanitizeBrowserDiagnosticUrl(value.replace(/^ws/i, 'http'));
    return sanitized ? sanitized.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') : null;
}
function normalizeStreamEvent(value: Record<string, unknown>, time_ms: number): BrowserStreamEvent | null {
    const protocol = value.protocol;
    const action = value.action as BrowserStreamEvent['action'];
    const url = normalizeStreamUrl(value.url);
    const connection = shortToken(value.connection, 32, /^[a-z0-9-]+$/i);
    if ((protocol !== 'websocket' && protocol !== 'eventsource') ||
        !STREAM_ACTIONS.includes(action) ||
        !url ||
        !connection) {
        return null;
    }
    const direction = value.direction === 'sent' || value.direction === 'received' ? value.direction : undefined;
    const data = typeof value.data === 'string' && value.data
        ? /^\[binary \d+ bytes\]$/.test(value.data)
            ? value.data
            : redactDiagnosticBody(value.data, null, MAX_DIAGNOSTIC_STREAM_DATA_CHARS)
        : undefined;
    const reason = value.reason === undefined ? null : redactedText(value.reason);
    const counters: Partial<BrowserStreamEvent> = {};
    for (const key of ['size', 'code', 'messages_sent', 'messages_received', 'bytes_sent', 'bytes_received'] as const) {
        const n = nonNegativeInt(value[key]);
        if (n !== undefined)
            counters[key] = n;
    }
    return {
        kind: 'stream',
        time_ms,
        protocol,
        connection,
        action,
        url,
        ...(direction ? { direction } : {}),
        ...(data ? { data } : {}),
        ...(reason ? { reason } : {}),
        ...counters,
    };
}
function normalizeActionEvent(value: Record<string, unknown>, time_ms: number): BrowserActionEvent | null {
    const action = value.action as BrowserActionEvent['action'];
    const target = redactedText(value.target);
    if (!ACTION_KINDS.includes(action) || !target)
        return null;
    const role = shortToken(value.role, 32, /^[a-z]+$/i);
    const selector = normalizeElementSelector(value.selector);
    return {
        kind: 'action',
        time_ms,
        action,
        target: target.slice(0, 200),
        ...(role ? { role } : {}),
        ...(selector ? { selector } : {}),
        ...(typeof value.checked === 'boolean' ? { checked: value.checked } : {}),
    };
}
export function normalizeBrowserDiagnosticEvent(value: unknown): BrowserDiagnosticEvent | null {
    if (!isRecord(value))
        return null;
    const time_ms = normalizeTime(value.time_ms);
    if (time_ms === null)
        return null;
    if (value.kind === 'console') {
        const level = value.level as BrowserConsoleLevel;
        const message = redactedMessage(value.message);
        if (!message || !CONSOLE_LEVELS.includes(level))
            return null;
        const method = CONSOLE_METHODS.includes(value.method as BrowserConsoleMethod)
            ? (value.method as BrowserConsoleMethod)
            : undefined;
        const stack = redactedStack(value.stack);
        return {
            kind: 'console',
            time_ms,
            level,
            message,
            ...(method ? { method } : {}),
            ...(stack ? { stack } : {}),
        };
    }
    if (value.kind === 'error' || value.kind === 'unhandled_rejection') {
        const message = redactedMessage(value.message);
        if (!message)
            return null;
        const source = typeof value.source === 'string' ? sanitizeBrowserDiagnosticUrl(value.source) ?? undefined : undefined;
        const line = finiteNumber(value.line, 0, 10000000) ?? undefined;
        const column = finiteNumber(value.column, 0, 10000000) ?? undefined;
        const stack = redactedStack(value.stack);
        return {
            kind: value.kind,
            time_ms,
            message,
            ...(source ? { source } : {}),
            ...(line !== undefined ? { line: Math.round(line) } : {}),
            ...(column !== undefined ? { column: Math.round(column) } : {}),
            ...(stack ? { stack } : {}),
        };
    }
    if (value.kind === 'navigation') {
        const navigation = value.navigation as BrowserNavigationKind;
        const url = typeof value.url === 'string' ? sanitizeBrowserDiagnosticUrl(value.url) : null;
        if (!url || !NAVIGATION_KINDS.includes(navigation))
            return null;
        const loadType = LOAD_TYPES.includes(value.load_type as BrowserNavigationLoadType)
            ? (value.load_type as BrowserNavigationLoadType)
            : undefined;
        return { kind: 'navigation', time_ms, navigation, url, ...(loadType ? { load_type: loadType } : {}) };
    }
    if (value.kind === 'network')
        return normalizeNetworkEvent(value, time_ms);
    if (value.kind === 'stream')
        return normalizeStreamEvent(value, time_ms);
    if (value.kind === 'action')
        return normalizeActionEvent(value, time_ms);
    return null;
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(value as T) ? (value as T) : fallback;
}
export function normalizeBrowserDiagnosticsPolicy(value: unknown): BrowserDiagnosticsPolicy {
    if (!isRecord(value))
        return { ...DEFAULT_BROWSER_DIAGNOSTICS_POLICY, networkDetail: 'off', actions: false };
    return {
        console: enumValue(value.console, ['off', 'errors', 'all'] as const, DEFAULT_BROWSER_DIAGNOSTICS_POLICY.console),
        network: enumValue(value.network, ['off', 'failures', 'all'] as const, DEFAULT_BROWSER_DIAGNOSTICS_POLICY.network),
        navigation: typeof value.navigation === 'boolean'
            ? value.navigation
            : DEFAULT_BROWSER_DIAGNOSTICS_POLICY.navigation,
        urls: enumValue(value.urls, ['route', 'origin'] as const, DEFAULT_BROWSER_DIAGNOSTICS_POLICY.urls),
        text: enumValue(value.text, ['standard', 'strict'] as const, DEFAULT_BROWSER_DIAGNOSTICS_POLICY.text),
        excludedOrigins: normalizeExcludedDiagnosticOrigins(value.excludedOrigins),
        networkDetail: enumValue(value.networkDetail, ['off', 'full'] as const, 'off'),
        actions: typeof value.actions === 'boolean' ? value.actions : false,
    };
}
export function normalizeExcludedDiagnosticOrigins(value: unknown): string[] {
    if (!Array.isArray(value))
        return DEFAULT_EXCLUDED_DIAGNOSTIC_ORIGINS;
    const cleaned: string[] = [];
    const seen = new Set<string>();
    const inspectedLimit = Math.min(value.length, MAX_EXCLUDED_DIAGNOSTIC_ORIGINS * 4);
    for (let index = 0; index < inspectedLimit && cleaned.length < MAX_EXCLUDED_DIAGNOSTIC_ORIGINS; index++) {
        const entry = value[index];
        if (typeof entry !== 'string')
            continue;
        const normalized = entry.trim().toLowerCase().slice(0, 253);
        if (!normalized || seen.has(normalized))
            continue;
        seen.add(normalized);
        cleaned.push(normalized);
    }
    return cleaned;
}
export function applyBrowserDiagnosticsPolicy(event: BrowserDiagnosticEvent, policy: BrowserDiagnosticsPolicy): BrowserDiagnosticEvent | null {
    const maskUrl = (url: string): string => {
        if (policy.urls !== 'origin')
            return url;
        try {
            return new URL(url).origin;
        }
        catch {
            return url;
        }
    };
    const maskStack = (stack: string): string => policy.urls !== 'origin'
        ? stack
        : replaceStackUrls(stack, (url) => {
            try {
                return new URL(url).origin;
            }
            catch {
                return null;
            }
        });
    const strict = policy.text === 'strict';
    if (event.kind === 'console') {
        if (policy.console === 'off')
            return null;
        if (policy.console === 'errors' && event.level !== 'error' && event.level !== 'warn')
            return null;
        if (!strict)
            return event.stack ? { ...event, stack: maskStack(event.stack) } : event;
        const rest = { ...event, message: REDACTED_MESSAGE };
        delete rest.stack;
        return rest;
    }
    if (event.kind === 'error' || event.kind === 'unhandled_rejection') {
        const source = event.source ? maskUrl(event.source) : undefined;
        const { stack, ...rest } = event;
        return {
            ...rest,
            ...(source ? { source } : {}),
            ...(strict ? { message: REDACTED_MESSAGE } : stack ? { stack: maskStack(stack) } : {}),
        };
    }
    if (event.kind === 'navigation') {
        if (!policy.navigation)
            return null;
        if (isExcludedDiagnosticOrigin(event.url, policy.excludedOrigins))
            return null;
        return { ...event, url: maskUrl(event.url) };
    }
    if (event.kind === 'action') {
        if (!policy.actions)
            return null;
        if (strict) {
            const redacted: BrowserActionEvent = { ...event, target: REDACTED_MESSAGE };
            delete redacted.selector;
            return redacted;
        }
        let target = event.target.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (match) => {
            const route = sanitizeBrowserDiagnosticUrl(match);
            return route ? maskUrl(route) : '[url omitted]';
        });
        target = target.replace(/(^|")(\/[^\s"'<>]+)/g, (_, lead: string, path: string) => {
            if (policy.urls === 'origin')
                return `${lead}[url omitted]`;
            const route = sanitizeBrowserDiagnosticUrl(`${RELATIVE_TARGET_ORIGIN}${path}`);
            return `${lead}${route ? route.slice(RELATIVE_TARGET_ORIGIN.length) || '/' : '[url omitted]'}`;
        });
        return target === event.target ? event : { ...event, target };
    }
    const keepDetail = policy.networkDetail === 'full' && !strict;
    if (event.kind === 'stream') {
        if (policy.network === 'off')
            return null;
        if (isExcludedDiagnosticOrigin(event.url.replace(/^ws/i, 'http'), policy.excludedOrigins))
            return null;
        if (policy.network === 'failures') {
            const abnormalClose = event.action === 'close' && event.code !== undefined && ![1000, 1001, 1005].includes(event.code);
            if (event.action !== 'error' && !abnormalClose)
                return null;
        }
        const { data, reason, ...rest } = event;
        return {
            ...rest,
            url: maskUrl(event.url),
            ...(data && keepDetail ? { data } : {}),
            ...(reason && !strict ? { reason } : {}),
        };
    }
    if (event.kind !== 'network')
        return event;
    if (policy.network === 'off')
        return null;
    if (isExcludedDiagnosticOrigin(event.url, policy.excludedOrigins))
        return null;
    if (policy.network === 'failures' && event.outcome === 'success')
        return null;
    const { full_url, request_headers, response_headers, request_body, response_body, body_omitted, graphql, initiator, ...metadata } = event;
    const detail: Partial<BrowserNetworkEvent> = keepDetail
        ? {
            ...(full_url && policy.urls !== 'origin' ? { full_url } : {}),
            ...(request_headers ? { request_headers } : {}),
            ...(response_headers ? { response_headers } : {}),
            ...(request_body ? { request_body } : {}),
            ...(response_body ? { response_body } : {}),
            ...(body_omitted ? { body_omitted } : {}),
        }
        : {};
    const graphqlKept = graphql && strict ? { ...graphql } : graphql;
    if (graphqlKept && strict)
        delete graphqlKept.first_error;
    return {
        ...metadata,
        url: maskUrl(event.url),
        ...(event.error && strict ? { error: REDACTED_MESSAGE } : {}),
        ...(graphqlKept && Object.keys(graphqlKept).length > 0 ? { graphql: graphqlKept } : {}),
        ...(initiator && policy.urls !== 'origin' ? { initiator } : {}),
        ...detail,
    };
}
export function normalizeBrowserDiagnosticsEnvironment(value: unknown): BrowserDiagnosticsEnvironment | null {
    if (!isRecord(value))
        return null;
    const page_url = typeof value.page_url === 'string' ? sanitizeBrowserDiagnosticUrl(value.page_url) : null;
    if (!page_url)
        return null;
    const nullableText = (candidate: unknown, maxLength: number) => {
        const text = stringValue(candidate, maxLength);
        return text ? redactBrowserDiagnosticText(text) : null;
    };
    const integer = (candidate: unknown, min: number, max: number) => {
        const n = finiteNumber(candidate, min, max);
        return n === null ? null : Math.round(n);
    };
    const environment: BrowserDiagnosticsEnvironment = {
        page_url,
        platform: nullableText(value.platform, 120),
        language: nullableText(value.language, 32),
        viewport_width: integer(value.viewport_width, 0, 100000),
        viewport_height: integer(value.viewport_height, 0, 100000),
        device_pixel_ratio: finiteNumber(value.device_pixel_ratio, 0.1, 100),
        timezone_offset_minutes: integer(value.timezone_offset_minutes, -1440, 1440),
    };
    const optionalText: Array<[
        keyof BrowserDiagnosticsEnvironment,
        number
    ]> = [
        ['browser_name', 64],
        ['browser_version', 64],
        ['os_name', 64],
        ['os_version', 64],
        ['timezone', 64],
        ['connection_type', 16],
        ['extension_version', 32],
    ];
    for (const [key, max] of optionalText) {
        if (key in value)
            (environment as unknown as Record<string, unknown>)[key] = nullableText(value[key], max);
    }
    if ('user_agent' in value) {
        const ua = stringValue(value.user_agent, 512);
        environment.user_agent = ua ? redactBrowserDiagnosticText(ua, 512) : null;
    }
    if ('screen_width' in value)
        environment.screen_width = integer(value.screen_width, 0, 100000);
    if ('screen_height' in value)
        environment.screen_height = integer(value.screen_height, 0, 100000);
    if ('downlink_mbps' in value)
        environment.downlink_mbps = finiteNumber(value.downlink_mbps, 0, 100000);
    if ('rtt_ms' in value)
        environment.rtt_ms = integer(value.rtt_ms, 0, 600000);
    if ('incognito' in value)
        environment.incognito = typeof value.incognito === 'boolean' ? value.incognito : null;
    if ('country' in value) {
        const country = typeof value.country === 'string' ? value.country.trim().toUpperCase() : '';
        environment.country = /^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1' ? country : null;
    }
    return environment;
}
function normalizePageMetadata(value: unknown): BrowserPageMetadata | null {
    if (!isRecord(value))
        return null;
    const errors: readonly NonNullable<BrowserPageMetadata['error']>[] = [
        'not_a_function',
        'threw',
        'not_a_plain_object',
        'too_large',
        'not_serializable',
    ];
    if (typeof value.data === 'string') {
        const data = redactDiagnosticPageMetadata(value.data);
        return data ? { data } : { error: 'not_serializable' };
    }
    return errors.includes(value.error as NonNullable<BrowserPageMetadata['error']>)
        ? { error: value.error as NonNullable<BrowserPageMetadata['error']> }
        : null;
}
export function normalizeBrowserDiagnosticsPageContext(value: unknown): {
    page_metadata?: BrowserPageMetadata;
    detected_tools?: BrowserDetectedTools;
} | null {
    if (!isRecord(value))
        return null;
    const pageMetadata = normalizePageMetadata(value.page_metadata);
    const detectedTools = normalizeDetectedTools(value.detected_tools);
    if (!pageMetadata && !detectedTools)
        return null;
    return {
        ...(pageMetadata ? { page_metadata: pageMetadata } : {}),
        ...(detectedTools ? { detected_tools: detectedTools } : {}),
    };
}
function normalizeDetectedTools(value: unknown): BrowserDetectedTools | null {
    if (!isRecord(value))
        return null;
    const tools: BrowserDetectedTools = {};
    if (isRecord(value.sentry)) {
        const text = (candidate: unknown) => {
            const raw = stringValue(candidate, 120);
            return raw ? redactBrowserDiagnosticText(raw, 120) : null;
        };
        tools.sentry = { environment: text(value.sentry.environment), release: text(value.sentry.release) };
    }
    const vendorUrl = (candidate: unknown, hosts: RegExp) => {
        if (typeof candidate !== 'string' || candidate.length > 1024)
            return undefined;
        try {
            const parsed = new URL(candidate);
            return parsed.protocol === 'https:' && hosts.test(parsed.hostname) ? parsed.href : undefined;
        }
        catch {
            return undefined;
        }
    };
    const logrocket = vendorUrl(value.logrocket_url, /(^|\.)logrocket\.(com|io)$/i);
    const fullstory = vendorUrl(value.fullstory_url, /(^|\.)fullstory\.com$/i);
    if (logrocket)
        tools.logrocket_url = logrocket;
    if (fullstory)
        tools.fullstory_url = fullstory;
    return Object.keys(tools).length > 0 ? tools : null;
}
export function normalizeBrowserDiagnosticsSidecar(value: unknown): BrowserDiagnosticsSidecar | null {
    if (!isRecord(value) ||
        !ACCEPTED_SCHEMA_VERSIONS.includes(value.schema_version as number) ||
        (value.source !== 'extension' && value.source !== 'cdp')) {
        return null;
    }
    if (!Array.isArray(value.events) || value.events.length > MAX_BROWSER_DIAGNOSTIC_EVENTS)
        return null;
    const events: BrowserDiagnosticEvent[] = [];
    let rejected = 0;
    const policy = normalizeBrowserDiagnosticsPolicy(value.policy);
    for (const event of value.events) {
        const normalized = normalizeBrowserDiagnosticEvent(event);
        if (!normalized) {
            rejected++;
            continue;
        }
        const permitted = applyBrowserDiagnosticsPolicy(normalized, policy);
        if (!permitted) {
            rejected++;
            continue;
        }
        events.push(permitted);
    }
    const dropped = finiteNumber(value.dropped_events, 0, Number.MAX_SAFE_INTEGER);
    if (dropped === null)
        return null;
    const environment = value.environment === null ? null : normalizeBrowserDiagnosticsEnvironment(value.environment);
    const strict = policy.text === 'strict';
    const normalizedMetadata = strict ? null : normalizePageMetadata(value.page_metadata);
    const normalizedTools = normalizeDetectedTools(value.detected_tools);
    const siteOnly = policy.urls === 'origin';
    const pageMetadata = siteOnly && normalizedMetadata?.data
        ? { ...normalizedMetadata, data: urlsToOrigins(normalizedMetadata.data) }
        : normalizedMetadata;
    const detectedTools = siteOnly && normalizedTools ? withoutSessionLinks(normalizedTools) : normalizedTools;
    return {
        schema_version: BROWSER_DIAGNOSTICS_SCHEMA_VERSION,
        source: value.source,
        policy,
        environment: environment && policy.urls === 'origin'
            ? { ...environment, page_url: originOnly(environment.page_url) }
            : environment,
        events,
        dropped_events: Math.round(dropped) + rejected,
        ...(pageMetadata ? { page_metadata: pageMetadata } : {}),
        ...(detectedTools ? { detected_tools: detectedTools } : {}),
    };
}
const ABSOLUTE_URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
function urlsToOrigins(json: string): string {
    const walk = (value: unknown): unknown => {
        if (typeof value === 'string')
            return value.replace(ABSOLUTE_URL_IN_TEXT, (match) => originOnly(match));
        if (Array.isArray(value))
            return value.map(walk);
        if (isRecord(value))
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
        return value;
    };
    try {
        return JSON.stringify(walk(JSON.parse(json)));
    }
    catch {
        return json;
    }
}
function withoutSessionLinks(tools: BrowserDetectedTools): BrowserDetectedTools | null {
    const rest: BrowserDetectedTools = { ...tools };
    delete rest.logrocket_url;
    delete rest.fullstory_url;
    return Object.keys(rest).length > 0 ? rest : null;
}
function originOnly(url: string): string {
    try {
        return new URL(url).origin;
    }
    catch {
        return url;
    }
}
export function normalizeElementSelector(value: unknown): string | null {
    if (typeof value !== 'string')
        return null;
    const selector = value.trim();
    if (!selector || selector.length > MAX_ELEMENT_SELECTOR_LENGTH)
        return null;
    if (/[\u0000-\u001f\u007f`{};]/.test(selector))
        return null;
    if (!/^[\p{L}\p{N}\s#.\-_[\]="'():>+~*\\,!?&/]+$/u.test(selector))
        return null;
    if (/@/.test(selector))
        return null;
    return redactPatterns(selector) === selector ? selector : null;
}
export function normalizeElementTag(value: unknown): string | null {
    if (typeof value !== 'string')
        return null;
    const tag = value.trim().toLowerCase();
    return /^[a-z][a-z0-9-]{0,31}$/.test(tag) ? tag : null;
}
