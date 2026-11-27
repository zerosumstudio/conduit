import { ConduitError, type ConduitErrorCode, type ConduitErrorInit } from '../primitives/errors'
import type { ConduitRequest, ConduitResponse, RedactConfig } from '../primitives/types'

/*
 *   DEFAULTS
 ***************************************************************************************************/
export interface RedactRules {
	/** Header names, matched case-insensitively. */
	readonly headers: readonly string[]
	/** Query parameter names, matched case-insensitively. A trailing `*` matches a prefix. */
	readonly query: readonly string[]
}

/** What `ClientConfig.redact` falls back to. Spread it to widen the lists rather than replace them. */
export const DEFAULT_REDACT: RedactRules = Object.freeze({
	headers: Object.freeze([
		'authorization',
		'cookie',
		'proxy-authorization',
		'x-api-key',
		'x-auth-token',
		'x-csrf-token',
		'x-xsrf-token',
		'x-session-token',
		'x-access-token',
		'x-amz-security-token',
	]),
	query: Object.freeze([
		'token',
		'access_token',
		'refresh_token',
		'id_token',
		'code',
		'key',
		'api_key',
		'apikey',
		'password',
		'secret',
		'signature',
		'sig',
		'client_secret',
		'access-token',
		'jwt',
		'private_token',
		'sessionid',
		'x-amz-*',
		'x-goog-*',
	]),
})

const REDACTED = '[redacted]'

/** Lowercases both lists, and falls back to the defaults for whichever one is left out. */
export function resolveRedact(config: RedactConfig = {}): RedactRules {
	return {
		headers: (config.headers ?? DEFAULT_REDACT.headers).map(name => name.toLowerCase()),
		query: (config.query ?? DEFAULT_REDACT.query).map(name => name.toLowerCase()),
	}
}

/** The headers the redirect and upload guards treat as credentials: the defaults, plus any configured. */
export function resolveCredentialHeaders(config: RedactConfig = {}): readonly string[] {
	const configured = (config.headers ?? []).map(name => name.toLowerCase())

	return [...new Set([...DEFAULT_REDACT.headers, ...configured])]
}

/*
 *   QUERY
 ***************************************************************************************************/
export function stripQuery(url: string): string {
	const mark = url.search(/[?#]/)

	return mark === -1 ? url : url.slice(0, mark)
}

function decodeName(name: string): string {
	try {
		return decodeURIComponent(name.replace(/\+/g, ' ')).toLowerCase()
	} catch {
		return name.toLowerCase()
	}
}

/** Builds a function that replaces the value of every named query parameter in a url. */
export function createUrlRedactor(names: readonly string[]): (url: string) => string {
	if (names.length === 0) {
		return url => url
	}

	const exact = new Set<string>()
	const prefixes: string[] = []

	for (const name of names) {
		if (name.endsWith('*')) {
			prefixes.push(name.slice(0, -1))
		} else {
			exact.add(name)
		}
	}

	const isSecret = (name: string): boolean =>
		exact.has(name) || prefixes.some(prefix => name.startsWith(prefix))

	return url => {
		const mark = url.indexOf('?')

		if (mark === -1) {
			return url
		}

		const hashMark = url.indexOf('#', mark)
		const end = hashMark === -1 ? url.length : hashMark
		const pairs = url
			.slice(mark + 1, end)
			.split('&')
			.map(pair => {
				const split = pair.indexOf('=')

				if (split === -1) {
					return pair
				}

				return isSecret(decodeName(pair.slice(0, split)))
					? `${pair.slice(0, split)}=${REDACTED}`
					: pair
			})

		return `${url.slice(0, mark)}?${pairs.join('&')}${url.slice(end)}`
	}
}

/*
 *   MESSAGES
 ***************************************************************************************************/
/** `GET https://host/path`, with no query, for every message conduit writes. */
export function describeRequest(request: Pick<ConduitRequest, 'method' | 'url'>): string {
	return `${request.method} ${stripQuery(request.url)}`
}

/** The key as events and `.response()` show it: query secrets hidden, the real key left to the cache. */
export function formatKey(request: Pick<ConduitRequest, 'key' | 'redactUrl'>): string {
	return request.redactUrl(request.key)
}

/** The url a `ConduitError` carries: the request's url with its secret query values hidden. */
export function formatErrorUrl(request: Pick<ConduitRequest, 'url' | 'redactUrl'>): string {
	return request.redactUrl(request.url)
}

type ErrorExtras = Pick<ConduitErrorInit, 'status' | 'headers' | 'body' | 'cause'>

/** An error about one request: its method, query-safe url and owner, and a message that starts with what was asked. */
export function createRequestError(
	request: Pick<ConduitRequest, 'method' | 'url' | 'owner' | 'redactUrl'>,
	code: ConduitErrorCode,
	detail: string,
	extras: ErrorExtras = {},
): ConduitError {
	return new ConduitError({
		code,
		message: `${describeRequest(request)} ${detail}`,
		method: request.method,
		url: formatErrorUrl(request),
		owner: request.owner,
		...extras,
	})
}

/*
 *   VIEWS
 ***************************************************************************************************/
/**
 * The request as events and `.response()` show it: credential headers read
 * `[redacted]` and secret query values are hidden. The pipeline keeps the real one.
 */
export function redactRequest(request: ConduitRequest, rules: RedactRules): ConduitRequest {
	const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(request)

	descriptors['url'] = { enumerable: true, configurable: true, value: formatErrorUrl(request) }
	descriptors['key'] = { enumerable: true, configurable: true, value: formatKey(request) }
	// Read on every access: an adapter can set a credential in place after an event was emitted,
	// so neither the names nor the copy can be fixed at the start.
	descriptors['headers'] = {
		enumerable: true,
		configurable: true,
		get(): Headers {
			const redacted = new Headers(request.headers)
			const hidden = new Set([...rules.headers, ...(request.meta.credentialHeaders ?? [])])

			for (const name of hidden) {
				if (redacted.has(name)) {
					redacted.set(name, REDACTED)
				}
			}

			return redacted
		},
	}

	return Object.defineProperties({}, descriptors) as ConduitRequest
}

/** Same idea as {@link redactRequest}, applied to the `request` a response carries. */
export function redactResponse<T>(
	response: ConduitResponse<T>,
	rules: RedactRules,
): ConduitResponse<T> {
	const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(response)
	let redacted: ConduitRequest | undefined

	descriptors['request'] = {
		enumerable: true,
		configurable: true,
		get(): ConduitRequest {
			redacted ??= redactRequest(response.request, rules)

			return redacted
		},
	}

	return Object.defineProperties({}, descriptors) as ConduitResponse<T>
}
