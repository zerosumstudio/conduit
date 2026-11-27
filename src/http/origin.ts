import { ConduitError } from '../primitives/errors'
import { stripQuery } from './redact'

/*
 *   TYPES
 ***************************************************************************************************/
export interface OriginPolicy {
	/** Joins a relative path onto `baseUrl`, or takes an absolute one, then resolves and checks it. */
	resolve(path: string): URL
	/** The last check, run by the transport on whatever url a middleware handed down. */
	assertAllowed(url: string): URL
	/** Whether a url sits on the client's own API origin. */
	isApiOrigin(url: string): boolean
}

const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])

/*
 *   ORIGINS
 ***************************************************************************************************/
/** Reduces `https://host:8443/` to its origin, or fails when the entry is not an http(s) origin. */
export function parseOrigin(entry: string): string {
	const parsed = URL.canParse(entry) ? new URL(entry) : undefined

	if (
		parsed === undefined ||
		!WEB_PROTOCOLS.has(parsed.protocol) ||
		parsed.username !== '' ||
		parsed.password !== '' ||
		parsed.search !== '' ||
		parsed.hash !== '' ||
		(parsed.pathname !== '/' && parsed.pathname !== '')
	) {
		throw new ConduitError({
			code: 'INVALID_ARGUMENT',
			message: `"${stripQuery(entry)}" is not an origin. Use scheme, host and port, like "https://api.example.com".`,
		})
	}

	return parsed.origin
}

/**
 * What a relative url resolves against. `fetch` resolves against the document's
 * base, which a `<base href>` can move away from `location`, so this reads it.
 */
function getDocumentBase(): string | undefined {
	const candidates: unknown[] = [
		typeof document === 'object' ? (document as { baseURI?: unknown }).baseURI : undefined,
		typeof location === 'object' ? (location as { href?: unknown }).href : undefined,
	]

	for (const candidate of candidates) {
		if (
			typeof candidate === 'string' &&
			URL.canParse(candidate) &&
			WEB_PROTOCOLS.has(new URL(candidate).protocol)
		) {
			return candidate
		}
	}

	return undefined
}

/*
 *   POLICY
 ***************************************************************************************************/
/**
 * One place that decides where a request may go. Every url is resolved with
 * `new URL` and compared as an origin, and what gets sent is the checked href,
 * never the string it came from.
 */
export function createOriginPolicy(baseUrl: string, origins: readonly string[]): OriginPolicy {
	const allowed = new Set(origins)
	const isAbsoluteBase = URL.canParse(baseUrl)
	const absoluteBase = isAbsoluteBase ? new URL(baseUrl) : undefined
	const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
	const joinBase =
		isAbsoluteBase || trimmed === '' || trimmed.startsWith('/') ? trimmed : `/${trimmed}`

	if (absoluteBase !== undefined && !WEB_PROTOCOLS.has(absoluteBase.protocol)) {
		throw new ConduitError({
			code: 'INVALID_ARGUMENT',
			message: `baseUrl "${stripQuery(baseUrl)}" is not an http(s) url.`,
		})
	}

	const basePath =
		absoluteBase === undefined ? joinBase : absoluteBase.pathname.replace(/\/$/, '')

	const reject = (url: string, why: string): never => {
		throw new ConduitError({
			code: 'ORIGIN_REJECTED',
			message: `"${stripQuery(url)}" ${why}`,
		})
	}

	const getRelativeBase = (): string => {
		const documentBase = getDocumentBase()

		if (documentBase === undefined) {
			throw new ConduitError({
				code: 'INVALID_ARGUMENT',
				message: `A relative baseUrl ("${baseUrl}") needs a page. Pass an absolute baseUrl on a server.`,
			})
		}

		return documentBase
	}

	const getApiOrigin = (): string =>
		absoluteBase === undefined ? new URL(getRelativeBase()).origin : absoluteBase.origin

	const parse = (url: string, base: string | undefined): URL => {
		if (!URL.canParse(url, base)) {
			return reject(url, 'is not a url conduit can send.')
		}

		return new URL(url, base)
	}

	const assertWeb = (parsed: URL, original: string): void => {
		if (!WEB_PROTOCOLS.has(parsed.protocol)) {
			reject(
				original,
				`uses ${parsed.protocol}, and only http and https are sent. If this is a path, start it with a slash.`,
			)
		}

		if (parsed.username !== '' || parsed.password !== '') {
			reject(original, 'carries credentials in the url, which fetch refuses.')
		}
	}

	const assertOrigin = (parsed: URL, original: string): void => {
		assertWeb(parsed, original)

		if (parsed.origin !== getApiOrigin() && !allowed.has(parsed.origin)) {
			reject(
				original,
				'leaves the origins this client is allowed to call. Add it to config.origins if this is intentional.',
			)
		}
	}

	return {
		resolve(path) {
			if (URL.canParse(path)) {
				const absolute = new URL(path)

				assertOrigin(absolute, path)

				return absolute
			}

			const joined = joinBase + (path.startsWith('/') ? path : `/${path}`)
			const parsed = parse(joined, absoluteBase === undefined ? getRelativeBase() : undefined)

			assertOrigin(parsed, path)

			const inside =
				basePath === '' ||
				parsed.pathname === basePath ||
				parsed.pathname.startsWith(`${basePath}/`)

			if (!inside) {
				reject(path, `resolves outside baseUrl's path "${basePath}".`)
			}

			return parsed
		},

		assertAllowed(url) {
			const parsed = parse(url, undefined)

			assertOrigin(parsed, url)

			return parsed
		},

		isApiOrigin(url) {
			try {
				return URL.canParse(url) && new URL(url).origin === getApiOrigin()
			} catch {
				return false
			}
		},
	}
}
