import { ConduitError, isConduitError, toConduitError } from '../primitives/errors'
import { consoleLogger, reportError } from '../primitives/logger'
import type { ReadableStore } from '../primitives/stores'
import { MAX_TIMER_DELAY_MS } from '../primitives/timers'
import type { EventBus } from '../primitives/events'
import { parseOrigin } from '../http/origin'
import { withRequest } from '../http/request'
import { composeSignals } from '../http/signals'
import type {
	PluginContext,
	ConduitPromise,
	ConduitRequest,
	ConduitResponse,
	Middleware,
	Next,
	Plugin,
	RequestOptions,
} from '../primitives/types'

/*
 *   ADAPTER
 ***************************************************************************************************/
export interface AdapterContext {
	/** Issues a request that bypasses this plugin, so loading a session cannot recurse into itself. */
	request<T = unknown>(path: string, options?: RequestOptions): ConduitPromise<T>
	/** Aborts when the plugin is torn down. */
	signal: AbortSignal
}

/**
 * Everything backend-specific about a session. A cookie backend implements
 * `load` and `identify`. A token backend adds `authorize` and `renew`.
 */
export interface SessionAdapter<S = unknown> {
	/** Reads the current session. `null` means signed out, which is not an error. */
	load(ctx: AdapterContext): Promise<S | null>
	/**
	 * A stable id for whoever is signed in. Compared on every successful read;
	 * a change resets everything identity-scoped, so one user never sees the
	 * cache of the one before.
	 */
	identify(session: S): string
	/**
	 * Attaches credentials to an outgoing request, and is only called with a live
	 * session. Every header it adds or changes counts as a credential: it reads
	 * `[redacted]` in events, and a request carrying it is not sent through a redirect.
	 */
	authorize?(request: ConduitRequest, session: S): ConduitRequest
	/** Whether a failure means the session is at fault. Defaults to HTTP 401. */
	isUnauthenticated?(error: ConduitError, request: ConduitRequest): boolean
	/** Epoch milliseconds, driving a re-read before the session lapses. */
	expiresAt?(session: S): number | undefined
	/** Attempts recovery. `false` gives up. Absent means a rejected session is lost. */
	renew?(ctx: AdapterContext): Promise<boolean>
	/** Called after `clear()` and after a session is lost, once local state is already gone. */
	onClear?(): void
}

/*
 *   STATE
 ***************************************************************************************************/
export type SessionStatus = 'unknown' | 'loading' | 'authenticated' | 'anonymous' | 'error'

/**
 * - `unknown`: never read, or `clear()` ran.
 * - `loading`: a read is in flight. It keeps the previous session and error.
 * - `authenticated`: a read found a session.
 * - `anonymous`: a read found nobody, or the session was lost, in which case `error` is `UNAUTHENTICATED`.
 * - `error`: a read failed. A previous session is kept, so requests keep using it.
 */
export type SessionState<S> =
	| {
			readonly status: 'unknown'
			readonly session: null
			readonly error: null
			readonly updatedAt: number
	  }
	| {
			readonly status: 'loading'
			readonly session: S | null
			readonly error: ConduitError | null
			readonly updatedAt: number
	  }
	| {
			readonly status: 'authenticated'
			readonly session: S
			readonly error: null
			readonly updatedAt: number
	  }
	| {
			readonly status: 'anonymous'
			readonly session: null
			readonly error: ConduitError | null
			readonly updatedAt: number
	  }
	| {
			readonly status: 'error'
			readonly session: S | null
			readonly error: ConduitError
			readonly updatedAt: number
	  }

export interface SessionHandle<S> extends ReadableStore<SessionState<S>> {
	/**
	 * Returns the session once it is known. A read already in flight is joined,
	 * and a known session, signed in or not, resolves without a request.
	 */
	load: () => Promise<S | null>
	/** Always starts a new read. The latest read wins and older results are dropped. */
	reload: () => Promise<S | null>
	/** Drops local state without telling the server. */
	clear: () => void
}

export interface SessionApi<S = unknown> {
	session: SessionHandle<S>
}

export interface SessionConfig<S = unknown> {
	adapter: SessionAdapter<S>
	/** Called once per lost session, after in-flight credentialed requests were cancelled and cached data dropped. */
	onUnauthenticated?: ((error: ConduitError) => void) | undefined
	/** Read the session as soon as the plugin installs. Defaults to false. */
	autoLoad?: boolean | undefined
	/** Re-read this long before `expiresAt`. Defaults to 60 seconds. */
	refreshLeewayMs?: number | undefined
	/**
	 * Extra origins, beyond the client's own, that also receive credentials, as
	 * `https://host`. They have to be in the client's `origins` too, or every
	 * request to them is rejected anyway.
	 */
	origins?: readonly string[] | undefined
	/**
	 * Names a `BroadcastChannel` that tells other tabs, and other bundles on the
	 * page, to re-read when this one signs out, loses the session or sees another
	 * user. Without it each tab learns on its next rejected request.
	 */
	channel?: string | undefined
}

const UNAUTHORISED = 401
const DEFAULT_REFRESH_LEEWAY_MS = 60_000

/*
 *   CREDENTIALS
 ***************************************************************************************************/
/** Names of the headers a request holds, and what they hold, to see what `authorize` added. */
function snapshotHeaders(headers: Headers): Map<string, string> {
	const snapshot = new Map<string, string>()

	headers.forEach((value, name) => {
		snapshot.set(name, value)
	})

	return snapshot
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * One session for every bundle on the page. Reads and recovery are
 * single-flight, and losing the session runs once however many requests failed
 * at the same moment.
 *
 * Nothing about the session is sticky. A lost session is `anonymous`, and every
 * later request goes out without credentials until a read finds one again.
 */
export function session<S = unknown>(config: SessionConfig<S>): Plugin<SessionApi<S>> {
	const adapter = config.adapter

	if (typeof adapter.identify !== 'function') {
		throw new ConduitError({
			code: 'INVALID_ARGUMENT',
			message: 'session({ adapter }) needs identify(session).',
		})
	}

	const leewayMs = config.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS
	const extraOrigins = new Set((config.origins ?? []).map(parseOrigin))
	const listeners = new Set<(state: SessionState<S>) => void>()
	const lifetime = new AbortController()
	/** One controller per in-flight credentialed request, so losing the session cancels only those. */
	const flights = new Set<AbortController>()

	let state: SessionState<S> = { status: 'unknown', session: null, error: null, updatedAt: 0 }
	let reading: Promise<S | null> | undefined
	let readToken = 0
	let renewing: Promise<boolean> | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	/** Goes up on every successful read, so a request can tell the session it was sent under from today's. */
	let generation = 0
	let lostGeneration = -1
	let lostError: ConduitError | undefined
	let lastIdentity: string | undefined
	/** Whether a real identity has ever been observed, so the very first read never resets by itself. */
	let isIdentityKnown = false
	let context: PluginContext | undefined
	let events: EventBus | undefined
	let channel: BroadcastChannel | undefined

	const isLost = (next: SessionState<S>): boolean =>
		next.status === 'anonymous' && next.error?.code === 'UNAUTHENTICATED'

	const publish = (next: SessionState<S>): void => {
		state = next

		if (events?.active === true) {
			events.emit('session:change', {
				type: 'session:change',
				status: next.status,
				isLost: isLost(next),
				at: next.updatedAt,
			})
		}

		for (const listener of [...listeners]) {
			try {
				listener(next)
			} catch (error) {
				context?.config.logger.error(
					`[conduit] A session listener threw. The session is unaffected. ${String(error)}`,
				)
			}
		}
	}

	const broadcast = (): void => {
		if (!lifetime.signal.aborted) {
			channel?.postMessage({ type: 'session:change' })
		}
	}

	/** Arms a timer for a delay of any size, in chunks the platform can hold. */
	const stopRefreshTimer = (): void => {
		clearTimeout(timer)
		timer = undefined
	}

	/** Reports a background read that failed. The state already says so, and nobody awaits it. */
	const reportInBackground = (promise: Promise<unknown>): void => {
		promise.catch((error: unknown) => {
			reportError(context?.config.logger ?? consoleLogger, 'The session read failed.', error)
		})
	}

	const arm = (delayMs: number, run: () => void): void => {
		if (delayMs > MAX_TIMER_DELAY_MS) {
			timer = setTimeout(() => {
				arm(delayMs - MAX_TIMER_DELAY_MS, run)
			}, MAX_TIMER_DELAY_MS)

			return
		}

		timer = setTimeout(run, Math.max(0, delayMs))
	}

	const scheduleRefresh = (value: S | null): void => {
		stopRefreshTimer()

		if (value === null || adapter.expiresAt === undefined) {
			return
		}

		const expires = adapter.expiresAt(value)

		if (expires === undefined || !Number.isFinite(expires)) {
			return
		}

		const now = Date.now()
		const beforeLeeway = expires - now - leewayMs

		if (beforeLeeway > 0) {
			arm(beforeLeeway, handleRefreshDue)

			return
		}

		const untilExpiry = expires - now

		if (untilExpiry > 0) {
			arm(untilExpiry, handleRefreshDue)
		}
	}

	const adapterContext: AdapterContext = {
		request: <T>(path: string, options?: RequestOptions): ConduitPromise<T> => {
			if (context === undefined) {
				throw new ConduitError({
					code: 'INVALID_ARGUMENT',
					message: 'The session plugin was used before it was installed.',
				})
			}

			return context.request<T>(path, {
				...options,
				lane: options?.lane ?? 'critical',
				meta: { ...options?.meta, session: 'bypass', cache: 'bypass', dedupe: 'bypass' },
			})
		},
		signal: lifetime.signal,
	}

	/** Cancels what is in flight under the current credentials, so none of it lands under the next ones. */
	const cancelFlights = (reason: ConduitError): void => {
		for (const flight of [...flights]) {
			flight.abort(reason)
		}
	}

	/*
	 * READS
	 */
	/** Takes what a read found: the new generation, a reset if the user changed, and the new state. */
	const acceptRead = (value: S | null, isFromPeer: boolean): S | null => {
		const identity = value === null ? undefined : adapter.identify(value)
		const hasChangedIdentity = isIdentityKnown && identity !== lastIdentity

		generation++

		if (hasChangedIdentity) {
			cancelFlights(
				new ConduitError({ code: 'ABORTED', message: 'The signed-in user changed.' }),
			)
			context?.resetIdentity()
		}

		lastIdentity = identity
		isIdentityKnown = true

		publish(
			value === null
				? { status: 'anonymous', session: null, error: null, updatedAt: Date.now() }
				: { status: 'authenticated', session: value, error: null, updatedAt: Date.now() },
		)
		scheduleRefresh(value)

		if (hasChangedIdentity && !isFromPeer) {
			broadcast()
		}

		return value
	}

	const runRead = async (token: number, isFromPeer: boolean): Promise<S | null> => {
		publish({
			status: 'loading',
			session: state.session,
			error: state.error,
			updatedAt: Date.now(),
		})

		try {
			const value = await adapter.load(adapterContext)

			if (token !== readToken) {
				return await (reading ?? Promise.resolve(state.session))
			}

			return acceptRead(value, isFromPeer)
		} catch (cause) {
			if (token !== readToken) {
				return await (reading ?? Promise.resolve(state.session))
			}

			const error = isConduitError(cause)
				? cause
				: toConduitError(
						cause,
						'UNKNOWN',
						`The session could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
					)

			publish({ status: 'error', session: state.session, error, updatedAt: Date.now() })

			throw error
		} finally {
			if (token === readToken) {
				reading = undefined
			}
		}
	}

	const read = (isFromPeer = false): Promise<S | null> => {
		readToken++
		reading = runRead(readToken, isFromPeer)

		return reading
	}

	const load = (): Promise<S | null> => {
		if (state.status === 'authenticated' || state.status === 'anonymous') {
			return Promise.resolve(state.session)
		}

		return reading ?? read()
	}

	const reload = (): Promise<S | null> => read()

	const handleRefreshDue = (): void => {
		if (renewing === undefined) {
			reportInBackground(reload())
		}
	}

	/*
	 * LOSING THE SESSION
	 */
	const lose = (cause: ConduitError): ConduitError => {
		if (lostGeneration === generation && lostError !== undefined) {
			return lostError
		}

		const error = toConduitError(cause, 'UNAUTHENTICATED')

		lostGeneration = generation
		lostError = error
		lastIdentity = undefined
		isIdentityKnown = false
		stopRefreshTimer()

		cancelFlights(error)

		publish({ status: 'anonymous', session: null, error, updatedAt: Date.now() })

		context?.resetIdentity()
		adapter.onClear?.()
		config.onUnauthenticated?.(error)
		broadcast()

		return error
	}

	const isUnauthenticated = (error: ConduitError, request: ConduitRequest): boolean =>
		adapter.isUnauthenticated === undefined
			? error.code === 'HTTP_STATUS' && error.status === UNAUTHORISED
			: adapter.isUnauthenticated(error, request)

	const renew = async (): Promise<boolean> => {
		if (reading !== undefined) {
			return reading.then(
				value => value !== null,
				() => false,
			)
		}

		if (adapter.renew === undefined) {
			return false
		}

		renewing ??= adapter
			.renew(adapterContext)
			.then(async recovered => {
				if (recovered) {
					await reload().catch((error: unknown) => {
						reportError(
							context?.config.logger ?? consoleLogger,
							'The read after renewal failed.',
							error,
						)
					})
				}

				return recovered && state.status === 'authenticated'
			})
			.catch((error: unknown) => {
				reportError(
					context?.config.logger ?? consoleLogger,
					'The adapter could not renew the session.',
					error,
				)

				return false
			})
			.finally(() => {
				renewing = undefined
			})

		return renewing
	}

	/*
	 * REQUESTS
	 */
	const authorize = (request: ConduitRequest): ConduitRequest => {
		if (adapter.authorize === undefined || state.session === null) {
			return request
		}

		const before = snapshotHeaders(request.headers)
		const authorized = adapter.authorize(request, state.session)
		const changed: string[] = []

		authorized.headers.forEach((value, name) => {
			if (before.get(name) !== value) {
				changed.push(name)
			}
		})

		if (changed.length > 0) {
			authorized.meta.credentialHeaders = [
				...new Set([...(authorized.meta.credentialHeaders ?? []), ...changed]),
			]
		}

		return authorized
	}

	/** Sends one request with whatever credentials the session holds now. */
	const send = async (request: ConduitRequest, next: Next): Promise<ConduitResponse> => {
		if (state.session === null) {
			return next(request)
		}

		const flight = new AbortController()
		const authorized = authorize(request)

		flights.add(flight)

		try {
			const signal = composeSignals([authorized.signal, flight.signal])

			return await next(withRequest(authorized, { signal }))
		} finally {
			flights.delete(flight)
		}
	}

	/** A token adapter has nothing to send until it knows who is signed in. */
	const prepare = async (): Promise<void> => {
		const isSettled =
			state.status === 'authenticated' ||
			state.status === 'anonymous' ||
			(state.status === 'error' && state.session !== null)

		if (adapter.authorize === undefined || isSettled) {
			return
		}

		try {
			await load()
		} catch (cause) {
			if (state.session === null) {
				throw toConduitError(cause)
			}
		}
	}

	const isInScope = (request: ConduitRequest): boolean => {
		if (!URL.canParse(request.url)) {
			return false
		}

		return (
			context?.isApiOrigin(request.url) === true ||
			extraOrigins.has(new URL(request.url).origin)
		)
	}

	/**
	 * What follows a rejected credentialed request: a replay with today's
	 * session, after one try at renewal when it was sent under the current one.
	 */
	const recover = async (
		request: ConduitRequest,
		next: Next,
		error: ConduitError,
		sentGeneration: number,
		sentIdentity: string | undefined,
	): Promise<ConduitResponse> => {
		if (lostGeneration === generation && lostError !== undefined) {
			throw lostError
		}

		if (sentGeneration === generation && !(await renew())) {
			throw lose(error)
		}

		// A request is only ever replayed for the user it was sent for.
		if (lastIdentity !== sentIdentity) {
			throw toConduitError(
				error,
				'UNAUTHENTICATED',
				`${error.message} The user changed, so it was not replayed.`,
			)
		}

		try {
			return await send(request, next)
		} catch (replayCause) {
			const replayed = toConduitError(replayCause)
			const isLostNow = isUnauthenticated(replayed, request) && state.session !== null

			throw isLostNow ? lose(replayed) : replayed
		}
	}

	const middleware: Middleware = async (request, next) => {
		if (request.meta.session === 'bypass' || !isInScope(request)) {
			return next(request)
		}

		await prepare()

		const sentGeneration = generation
		const sentIdentity = lastIdentity
		const hasCredentials = state.session !== null

		try {
			return await send(request, next)
		} catch (cause) {
			const error = toConduitError(cause)

			if (!hasCredentials || !isUnauthenticated(error, request)) {
				throw error
			}

			return recover(request, next, error, sentGeneration, sentIdentity)
		}
	}

	const handle: SessionHandle<S> = {
		getState: () => state,
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		load,
		reload,
		clear: () => {
			stopRefreshTimer()
			readToken++
			reading = undefined
			lastIdentity = undefined
			isIdentityKnown = false
			cancelFlights(
				new ConduitError({ code: 'ABORTED', message: 'The session was cleared.' }),
			)
			context?.resetIdentity()
			adapter.onClear?.()
			publish({ status: 'unknown', session: null, error: null, updatedAt: Date.now() })
			broadcast()
		},
	}

	return {
		name: 'session',
		middleware,
		onInit: ctx => {
			context = ctx
			events = ctx.events

			for (const origin of extraOrigins) {
				if (!ctx.config.origins.includes(origin) && !ctx.isApiOrigin(origin)) {
					ctx.config.logger.warn(
						`[conduit] session({ origins }) lists ${origin}, which is not in the client's origins, so every request to it is rejected. Add it to createClient({ origins }).`,
					)
				}
			}

			if (config.channel !== undefined && typeof BroadcastChannel === 'function') {
				channel = new BroadcastChannel(config.channel)
				channel.onmessage = (message: MessageEvent<unknown>) => {
					const data = message.data as { type?: unknown } | null

					// Only our own message counts, and one read serves every message that arrives meanwhile.
					if (data?.type === 'session:change') {
						reportInBackground(reading ?? read(true))
					}
				}
			}

			if (config.autoLoad === true) {
				reportInBackground(load())
			}

			return { session: handle }
		},
		onDestroy: () => {
			stopRefreshTimer()
			lifetime.abort()
			channel?.close()
			channel = undefined
			listeners.clear()
		},
	}
}
