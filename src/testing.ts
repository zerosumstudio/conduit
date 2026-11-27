import { ConduitError } from './primitives/errors'
import type { FetchLike, HttpMethod } from './primitives/types'

export { clearSharedClients } from './client/shared'

/*
 *   REQUEST
 ***************************************************************************************************/
export interface MockRequest {
	method: string
	/** The absolute url the client sent, query and all. */
	url: string
	/** Just the path, which is what routes match against. */
	path: string
	query: URLSearchParams
	/** Values captured by `:name` segments in the route pattern. */
	params: Readonly<Record<string, string>>
	/** What a real fetch would send, including the `content-type` it derives from the body. */
	headers: Headers
	body: BodyInit | null
	/** Aborts when the client cancels the request, so a responder can stop what it started. */
	signal: AbortSignal
	/** The body decoded as JSON, or `undefined` if it was not text. */
	// The caller names the body type, the way response.json<T>() does.
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
	json<T = unknown>(): T | undefined
	/** The body as text, or `undefined` if it was not text. */
	text(): string | undefined
}

export type MockCall = Pick<MockRequest, 'method' | 'url' | 'path' | 'headers' | 'body'>

/*
 *   RESPONDERS
 ***************************************************************************************************/
/** Spelled out rather than `unknown`, which would absorb the function arm of {@link MockResponder}. */
export type MockValue =
	| Response
	| Error
	| Blob
	| FormData
	| URLSearchParams
	| ArrayBuffer
	| ReadableStream
	| Record<string, unknown>
	| readonly unknown[]
	| string
	| number
	| boolean
	| null
	| undefined

/**
 * What a route answers with:
 *
 * - a `Response` is used as-is
 * - an `Error` is a network failure
 * - `undefined` is a 204
 * - a string, `Blob`, `FormData`, `URLSearchParams`, `ArrayBuffer` or stream is the body of a `new Response()`, so a string is text
 * - anything else is JSON, so the common case is `server.get('/me', { id: 1 })`
 *
 * A function may return any of these, and one that throws answers 500.
 */
export type MockResponder = ((request: MockRequest) => unknown) | MockValue

export function json(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers)

	if (!headers.has('content-type')) {
		headers.set('content-type', 'application/json')
	}

	return new Response(JSON.stringify(body), { ...init, headers })
}

export function text(body: string, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers)

	if (!headers.has('content-type')) {
		headers.set('content-type', 'text/plain')
	}

	return new Response(body, { ...init, headers })
}

/** A failing status with an optional body. */
export function status(code: number, body: unknown = null): Response {
	return body === null ? new Response(null, { status: code }) : json(body, { status: code })
}

/** A request that never reached a server, as distinct from one that failed. */
export function networkError(message = 'Failed to fetch'): TypeError {
	return new TypeError(message)
}

/** A real fetch rejects with the abort reason as it is, which need not be an Error. */
function rejectWith(reject: (reason?: unknown) => void, reason: unknown): void {
	reject(reason)
}

/** Waits, unless the request is cancelled first, and frees its timer when it is. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			rejectWith(reject, signal.reason)

			return
		}

		const onAbort = (): void => {
			clearTimeout(timer)
			rejectWith(reject, signal.reason)
		}

		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)

		signal.addEventListener('abort', onAbort, { once: true })
	})
}

/** Wraps a responder so it answers late. Pair it with fake timers. */
export function delay(ms: number, responder: MockResponder): MockResponder {
	return async (request: MockRequest): Promise<unknown> => {
		await sleep(ms, request.signal)

		return typeof responder === 'function' ? responder(request) : responder
	}
}

/*
 *   MATCHING
 ***************************************************************************************************/
const ESCAPE = /[.+^${}()|[\]\\]/g

/**
 * Turns `/users/:id` into a matcher that also captures `id`, and `*` into a
 * wildcard. A `RegExp` is used as given.
 */
function toMatcher(pattern: string | RegExp): RegExp {
	if (pattern instanceof RegExp) {
		return pattern
	}

	const source = pattern
		.replace(ESCAPE, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '(?<$1>[^/]+)')

	return new RegExp(`^${source}$`)
}

/*
 *   SERVER
 ***************************************************************************************************/
export interface MockRouteOptions {
	/** Retire the route after this many matches. */
	times?: number | undefined
}

export interface MockServerConfig {
	/**
	 * Prefixed to every string pattern, so routes read like the client's paths.
	 * An absolute one, `https://api.test/v1`, also pins the origin the routes match.
	 */
	baseUrl?: string | undefined
	/** What an unmatched request does. Throwing, the default, fails it where it was made. */
	onUnmatched?: 'throw' | 'notFound' | undefined
}

export interface MockServer {
	/** Hand this to `createClient({ fetch })`. */
	readonly fetch: FetchLike
	/** Every request that arrived, in order. */
	readonly calls: readonly MockCall[]
	/** Later routes win, and a route used up by `times` falls through to the earlier ones. */
	route(
		method: HttpMethod | '*',
		pattern: string | RegExp,
		responder: MockResponder,
		options?: MockRouteOptions,
	): MockServer
	get(pattern: string | RegExp, responder: MockResponder, options?: MockRouteOptions): MockServer
	post(pattern: string | RegExp, responder: MockResponder, options?: MockRouteOptions): MockServer
	put(pattern: string | RegExp, responder: MockResponder, options?: MockRouteOptions): MockServer
	patch(
		pattern: string | RegExp,
		responder: MockResponder,
		options?: MockRouteOptions,
	): MockServer
	delete(
		pattern: string | RegExp,
		responder: MockResponder,
		options?: MockRouteOptions,
	): MockServer
	any(pattern: string | RegExp, responder: MockResponder, options?: MockRouteOptions): MockServer
	/** Drops every route and every recorded call. */
	reset(): void
}

interface Route {
	method: HttpMethod | '*'
	label: string
	matcher: RegExp
	responder: MockResponder
	remaining: number
}

/*
 *   ANSWERING
 ***************************************************************************************************/
const RESPONSE_BODIES: ReadonlyArray<abstract new (...args: never[]) => unknown> = [
	Blob,
	FormData,
	URLSearchParams,
	ArrayBuffer,
	ReadableStream,
]

/** Resolves once the answer is ready, or rejects with `signal.reason` the moment the request is cancelled. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) {
			rejectWith(reject, signal.reason)

			return
		}

		const onAbort = (): void => {
			rejectWith(reject, signal.reason)
		}

		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			value => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort)
				rejectWith(reject, error)
			},
		)
	})
}

function toResponse(result: unknown): Response {
	if (result instanceof Response) {
		return result.clone()
	}

	if (result instanceof Error) {
		throw result
	}

	if (result === undefined) {
		return new Response(null, { status: 204 })
	}

	if (typeof result === 'string' || RESPONSE_BODIES.some(body => result instanceof body)) {
		return new Response(result as BodyInit)
	}

	return json(result)
}

async function answer(responder: MockResponder, request: MockRequest): Promise<Response> {
	let result: unknown

	try {
		result = typeof responder === 'function' ? await responder(request) : responder
	} catch (error) {
		// A returned Error is a network failure. A thrown one is the server blowing up.
		return json(
			{ message: error instanceof Error ? error.message : String(error) },
			{ status: 500 },
		)
	}

	return toResponse(result)
}

/*
 *   FACTORY
 ***************************************************************************************************/
function parseBase(baseUrl: string): { origin: string | undefined; prefix: string } {
	if (URL.canParse(baseUrl)) {
		const parsed = new URL(baseUrl)

		return { origin: parsed.origin, prefix: parsed.pathname.replace(/\/$/, '') }
	}

	return { origin: undefined, prefix: baseUrl.replace(/\/$/, '') }
}

/**
 * A server for tests, without a server. It sits at the transport, so cache,
 * dedupe, retry, the queue and session recovery all run for real, and it honours
 * the request's signal the way a real fetch does.
 *
 * ```ts
 * const server = createMockServer({ baseUrl: 'https://api.test' })
 * server.get('/users/:id', request => ({ id: request.params.id }))
 * server.post('/users', status(201, { id: 2 }))
 *
 * const api = createClient({ baseUrl: 'https://api.test', fetch: server.fetch })
 * ```
 */
export function createMockServer(config: MockServerConfig = {}): MockServer {
	const base = parseBase(config.baseUrl ?? '')
	const unmatched = config.onUnmatched ?? 'throw'
	const routes: Route[] = []
	const calls: MockCall[] = []

	/** The last registered route that still has matches left and fits the method and path. */
	const findRoute = (
		method: string,
		path: string,
	): { route: Route; match: RegExpExecArray } | undefined => {
		for (let index = routes.length - 1; index >= 0; index--) {
			const route = routes[index]

			if (route === undefined || route.remaining <= 0) {
				continue
			}

			if (route.method !== '*' && route.method !== method) {
				continue
			}

			const match = route.matcher.exec(path)

			if (match !== null) {
				return { route, match }
			}
		}

		return undefined
	}

	const handle = async (url: string, init: RequestInit): Promise<Response> => {
		// The same object a real fetch builds, so headers, body rules and the signal all match it.
		const request = new Request(url, init)
		const parsed = new URL(url)
		const method = request.method
		const headers = request.headers
		const body = init.body ?? null
		const path = parsed.pathname

		calls.push({ method, url: parsed.href, path, headers, body })

		const route =
			base.origin !== undefined && parsed.origin !== base.origin
				? undefined
				: findRoute(method, path)

		if (route !== undefined) {
			route.route.remaining--

			return answer(route.route.responder, {
				method,
				url: parsed.href,
				path,
				query: parsed.searchParams,
				params: route.match.groups ?? {},
				headers,
				body,
				signal: request.signal,
				// The caller names the body type, so this is as loose as JSON.parse is.
				json: () => (typeof body === 'string' ? (JSON.parse(body) as never) : undefined),
				text: () => (typeof body === 'string' ? body : undefined),
			})
		}

		if (unmatched === 'notFound') {
			return new Response(null, { status: 404 })
		}

		const registered =
			routes.length === 0
				? '(none)'
				: routes
						.map(r => r.label)
						.reverse()
						.join(', ')

		throw new ConduitError({
			code: 'INVALID_ARGUMENT',
			message: `No route for ${method} ${path}. Registered, latest first: ${registered}`,
			method,
		})
	}

	const server: MockServer = {
		calls,

		fetch: (url, init) => {
			const signal = init.signal ?? new AbortController().signal

			return raceSignal(handle(url, init), signal)
		},

		route: (method, pattern, responder, options = {}) => {
			const prefixed = typeof pattern === 'string' ? `${base.prefix}${pattern}` : pattern

			routes.push({
				method,
				label: `${method} ${String(prefixed)}`,
				matcher: toMatcher(prefixed),
				responder,
				remaining: options.times ?? Number.POSITIVE_INFINITY,
			})

			return server
		},

		get: (pattern, responder, options) => server.route('GET', pattern, responder, options),
		post: (pattern, responder, options) => server.route('POST', pattern, responder, options),
		put: (pattern, responder, options) => server.route('PUT', pattern, responder, options),
		patch: (pattern, responder, options) => server.route('PATCH', pattern, responder, options),
		delete: (pattern, responder, options) =>
			server.route('DELETE', pattern, responder, options),
		any: (pattern, responder, options) => server.route('*', pattern, responder, options),

		reset: () => {
			routes.length = 0
			calls.length = 0
		},
	}

	return server
}
