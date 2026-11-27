import type { HttpMethod, ParseMode, Vary } from '../primitives/types'

/*
 *   HASH
 ***************************************************************************************************/
/** FNV-1a, 32-bit. Cheap enough to run on every request, and not cryptographic. */
export function hashText(input: string): string {
	let hash = 0x811c9dc5

	for (let index = 0; index < input.length; index++) {
		hash ^= input.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}

	return (hash >>> 0).toString(36)
}

/*
 *   CANONICAL URL
 ***************************************************************************************************/
function getParamName(pair: string): string {
	const split = pair.indexOf('=')

	return split === -1 ? pair : pair.slice(0, split)
}

/**
 * Sorts the query string so `?a=1&b=2` and `?b=2&a=1` share an entry. Sorted by
 * name only and stably, so `?sort=name&sort=age` keeps its order and stays
 * distinct from the reverse.
 */
export function toCanonicalUrl(url: string): string {
	const mark = url.indexOf('?')

	if (mark === -1) {
		return url
	}

	const path = url.slice(0, mark)
	const pairs = url
		.slice(mark + 1)
		.split('&')
		.filter(pair => pair !== '')
		.sort((first, second) => {
			const a = getParamName(first)
			const b = getParamName(second)

			return Number(a > b) - Number(a < b)
		})

	return pairs.length === 0 ? path : `${path}?${pairs.join('&')}`
}

/*
 *   BODY FINGERPRINT
 ***************************************************************************************************/
const bodyIds = new WeakMap<object, string>()
let nextBodyId = 0

/**
 * Text-like bodies hash by value, so identical payloads share a key. A stream
 * or `Blob` cannot be read without consuming it, so it gets a per-instance id
 * and never matches anything else.
 */
export function fingerprintBody(body: BodyInit | null): string {
	if (body === null) {
		return ''
	}

	if (typeof body === 'string') {
		return hashText(body)
	}

	if (body instanceof URLSearchParams) {
		return hashText(body.toString())
	}

	const existing = bodyIds.get(body)

	if (existing !== undefined) {
		return existing
	}

	const id = `#${(nextBodyId++).toString(36)}`
	bodyIds.set(body, id)

	return id
}

/*
 *   HEADER VARIANCE
 ***************************************************************************************************/
/** A repeated name within one init comma-joins, the way `Headers` does. */
function joinPairs(pairs: ReadonlyArray<readonly string[]>): Map<string, string> {
	const joined = new Map<string, string>()

	for (const pair of pairs) {
		// A malformed pair from plain JS can be short.
		const [name, value] = pair as [string?, string?]

		if (name === undefined || value === undefined) {
			continue
		}

		const lower = name.toLowerCase()
		const existing = joined.get(lower)

		joined.set(lower, existing === undefined ? value : `${existing}, ${value}`)
	}

	return joined
}

/** A header init as lowercase `[name, value]` pairs. Plain and array inits are read directly, so a cache hit never builds a `Headers`. */
function toEntries(init: HeadersInit): Array<readonly [string, string]> {
	if (init instanceof Headers) {
		return [...init]
	}

	if (Array.isArray(init)) {
		return [...joinPairs(init)]
	}

	return Object.entries(init).map(([name, value]) => [name.toLowerCase(), value] as const)
}

function collect(init: HeadersInit | undefined, into: Map<string, string>): void {
	for (const [name, value] of init === undefined ? [] : toEntries(init)) {
		into.set(name, value)
	}
}

/**
 * Hashes the headers that make two requests to the same url different requests.
 *
 * Merging matches how the client builds them: a repeated name within one init
 * comma-joins, and the option headers replace the config ones.
 */
export function fingerprintHeaders(
	configHeaders: HeadersInit | undefined,
	optionHeaders: HeadersInit | undefined,
	vary: Vary,
): string {
	if (vary !== '*' && vary.length === 0) {
		return ''
	}

	const merged = new Map<string, string>()
	collect(configHeaders, merged)
	collect(optionHeaders, merged)

	if (merged.size === 0) {
		return ''
	}

	const wanted = vary === '*' ? undefined : new Set(vary.map(name => name.toLowerCase()))
	const parts: string[] = []

	for (const [name, value] of merged) {
		if (wanted === undefined || wanted.has(name)) {
			parts.push(`${name}:${value}`)
		}
	}

	if (parts.length === 0) {
		return ''
	}

	parts.sort()

	return hashText(parts.join('\n'))
}

/**
 * Everything beyond method, url and body that makes a request distinct,
 * pre-hashed so `withRequest` can recompute a key without the headers.
 */
export function deriveVariance(
	configHeaders: HeadersInit | undefined,
	optionHeaders: HeadersInit | undefined,
	vary: Vary,
	credentials: RequestCredentials | undefined,
): string {
	const headers = fingerprintHeaders(configHeaders, optionHeaders, vary)
	const parts: string[] = []

	if (headers !== '') {
		parts.push(`h:${headers}`)
	}

	if (credentials !== undefined) {
		parts.push(`c:${credentials}`)
	}

	return parts.join(' ')
}

/*
 *   KEY
 ***************************************************************************************************/
export interface KeyInputs {
	method: HttpMethod
	url: string
	body: BodyInit | null
	variance: string
	/** How the body will be decoded. Omitted means `auto`, the baseline. */
	parse?: ParseMode
}

/**
 * The identity a request is cached, deduped and superseded by, left readable
 * for devtools. Credentials and decode mode are part of it: colliding on either
 * serves a caller someone else's data, or the same bytes as the wrong type.
 */
export function deriveKey(inputs: KeyInputs): string {
	let key = `${inputs.method} ${toCanonicalUrl(inputs.url)}`

	if (inputs.body !== null) {
		key += ` ${fingerprintBody(inputs.body)}`
	}

	if (inputs.variance !== '') {
		key += ` ${inputs.variance}`
	}

	if (inputs.parse !== undefined && inputs.parse !== 'auto') {
		key += ` p:${inputs.parse}`
	}

	return key
}
