import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { Client } from './client/core'
import { resolveEndpointTags, type Endpoint } from './client/endpoint'
import type { CacheApi } from './plugins/cache'
import type { ObservableApi } from './plugins/observable'
import { IDLE_QUERY_STATE, type QueryState, type QueryStatus } from './plugins/query-state'
import type { SessionApi, SessionState } from './plugins/session'
import { isCacheable } from './http/method'
import { IS_DEVELOPMENT } from './primitives/dev'
import { ConduitError, isErrorCode, toConduitError } from './primitives/errors'
import type { ReadableStore } from './primitives/stores'
import type { MethodOptions, ResponseSource, SafeResult } from './primitives/types'

/*
 *   TYPES
 ***************************************************************************************************/
export interface UseRequestOptions extends MethodOptions {
	/** Hold off until a dependency is ready. Defaults to true. */
	enabled?: boolean | undefined
	/** Keep the last successful answer on screen while a new key's first fetch is in flight. Defaults to false. */
	keepPreviousData?: boolean | undefined
	/** Read again when the tab becomes visible. A fresh cache entry is served as it is. Defaults to false. */
	refetchOnFocus?: boolean | undefined
	/** Read again when the connection comes back. Defaults to false. */
	refetchOnReconnect?: boolean | undefined
}

export interface UseRequestResult<T> {
	data: T | undefined
	error: ConduitError | undefined
	status: QueryStatus
	/** No data yet and a request is in the air. */
	isLoading: boolean
	/** A request is in the air, with or without data on screen. */
	isFetching: boolean
	/** The data on screen was served past its ttl, while a refresh runs behind it. */
	isStale: boolean
	/** When the data on screen arrived, in epoch milliseconds. `0` before anything has. */
	updatedAt: number
	/** Always asks the network, whatever the cache holds. */
	refetch(): Promise<void>
}

export interface UseMutationOptions<V> {
	/** Tags to invalidate once `mutate` succeeds. Needs the cache plugin. */
	invalidates?: readonly string[] | ((variables: V) => readonly string[]) | undefined
}

export type MutationStatus = 'idle' | 'pending' | 'success' | 'error'

export interface UseMutationResult<T, V> {
	/** Never rejects. Resolves the same `SafeResult` as `.safe()`, after the tags are invalidated. */
	mutate(variables: V): Promise<SafeResult<T>>
	/** The latest call owns the state, whichever one settles last. */
	status: MutationStatus
	data: T | undefined
	error: ConduitError | undefined
	isPending: boolean
	reset(): void
}

export interface Hooks {
	/**
	 * Runs a request and renders its state, keyed the way the cache and dedupe
	 * key it. It never cancels what it started: a request that was superseded or
	 * outlived its component finishes and fills the cache. Cancel with a `scope`
	 * or your own `signal`.
	 *
	 * A client `headers` function that answers differently per call gives every
	 * render a different key under `vary: '*'`, and this refetches on each one.
	 * Development warns when that happens.
	 */
	useRequest<T = unknown>(path: string, options?: UseRequestOptions): UseRequestResult<T>
	useRequest<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		vars: Vars,
		options?: UseRequestOptions,
	): UseRequestResult<Result>
	useMutation<T = unknown, V = void>(
		run: (variables: V) => PromiseLike<T>,
		options?: UseMutationOptions<V>,
	): UseMutationResult<T, V>
	useMutation<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		options?: UseMutationOptions<Vars>,
	): UseMutationResult<Result, Vars>
	/** Returns a warm-the-cache function that runs in the prefetch lane. */
	usePrefetch(): (path: string, options?: MethodOptions) => void
}

export interface SessionHooks<S> {
	useSession(): SessionState<S>
}

/*
 *   DISABLED SNAPSHOT
 ***************************************************************************************************/
const disabledStore: ReadableStore<QueryState<never>> = {
	getState: () => IDLE_QUERY_STATE,
	subscribe: () => () => {},
}

/*
 *   SHARED QUERY STATE
 ***************************************************************************************************/
/** What either call form normalises into, so one implementation drives both. */
interface RequestDescriptor {
	/** `undefined` when disabled, or when the key could not be derived yet. */
	key: string | undefined
	isEnabled: boolean
	run: (options: { refresh: boolean }) => Promise<void>
}

interface PreviousSnapshot<T> {
	key: string
	data: T | undefined
	error: ConduitError | undefined
	status: QueryStatus
	from: ResponseSource | undefined
	updatedAt: number
}

interface RequestBehaviour {
	keepPreviousData: boolean
	refetchOnFocus: boolean
	refetchOnReconnect: boolean
}

interface MutationState {
	status: MutationStatus
	data: unknown
	error: ConduitError | undefined
}

const IDLE_MUTATION: MutationState = { status: 'idle', data: undefined, error: undefined }

/** The hook flags, split from the options that go to the request. */
function splitOptions(options: UseRequestOptions): {
	behaviour: RequestBehaviour
	isEnabled: boolean
	request: MethodOptions
} {
	const {
		enabled = true,
		keepPreviousData = false,
		refetchOnFocus = false,
		refetchOnReconnect = false,
		...request
	} = options

	return {
		behaviour: { keepPreviousData, refetchOnFocus, refetchOnReconnect },
		isEnabled: enabled,
		request,
	}
}

/**
 * The query key, or `undefined` while there is not one yet. An `INVALID_ARGUMENT`
 * is a request that is not ready, such as a missing param, and says nothing.
 * Anything else is a problem worth a development warning.
 */
function tryGetKey(client: Client, isEnabled: boolean, getKey: () => string): string | undefined {
	if (!isEnabled) {
		return undefined
	}

	try {
		return getKey()
	} catch (error) {
		if (IS_DEVELOPMENT && !isErrorCode(error, 'INVALID_ARGUMENT')) {
			client.config.logger.warn(
				`[conduit] useRequest cannot derive a key: ${toConduitError(error).message}`,
			)
		}

		return undefined
	}
}

/** Adds `cache: 'refresh'` for an explicit refetch, which skips whatever is stored. */
function buildRunOptions(
	request: MethodOptions,
	key: string,
	refresh: boolean,
): MethodOptions & { key: string } {
	return refresh
		? { ...request, key, meta: { ...request.meta, cache: 'refresh' } }
		: { ...request, key }
}

/** Whether the previous key's data stands in while a new key's first fetch is in flight. */
function isShowingPrevious<T>(
	state: QueryState<T>,
	previous: PreviousSnapshot<T> | undefined,
	key: string | undefined,
	keepPreviousData: boolean,
): previous is PreviousSnapshot<T> {
	return (
		keepPreviousData &&
		previous !== undefined &&
		key !== undefined &&
		previous.key !== key &&
		state.data === undefined &&
		state.status !== 'success'
	)
}

/** What the hook returns: the store's state, or the previous key's while a new one loads. */
function buildResult<T>(
	state: QueryState<T>,
	previous: PreviousSnapshot<T> | undefined,
	key: string | undefined,
	isEnabled: boolean,
	keepPreviousData: boolean,
	refetch: () => Promise<void>,
): UseRequestResult<T> {
	const view = isShowingPrevious(state, previous, key, keepPreviousData)
		? { ...previous, isFetching: true }
		: state
	// Idle with a key and enabled means the first fetch is about to start.
	const isAboutToFetch = isEnabled && key !== undefined && view.status === 'idle'

	return {
		data: view.data,
		error: view.error,
		status: view.status,
		isLoading: view.data === undefined && (view.isFetching || isAboutToFetch),
		isFetching: view.isFetching,
		isStale: view.from === 'stale',
		updatedAt: view.updatedAt,
		refetch,
	}
}

/*
 *   MUTATION TAGS
 ***************************************************************************************************/
function invalidateTags(
	client: Partial<CacheApi>,
	tags: readonly string[] | ((variables: unknown) => readonly string[]) | undefined,
	variables: unknown,
): void {
	const resolved = resolveEndpointTags(tags, variables)

	if (resolved === undefined) {
		return
	}

	for (const tag of resolved) {
		client.invalidateTag?.(tag)
	}
}

/*
 *   PAGE EVENTS
 ***************************************************************************************************/
/**
 * One listener per page event however many hooks want it, attached when the
 * first hook subscribes and removed with the last.
 */
function createPageEvent(
	target: () => EventTarget | undefined,
	type: string,
	isRelevant: () => boolean,
): (listener: () => void) => () => void {
	const listeners = new Set<() => void>()

	const handle = (): void => {
		if (!isRelevant()) {
			return
		}

		for (const listener of [...listeners]) {
			listener()
		}
	}

	return listener => {
		const source = target()

		if (source === undefined) {
			return () => {}
		}

		if (listeners.size === 0) {
			source.addEventListener(type, handle)
		}

		listeners.add(listener)

		return () => {
			listeners.delete(listener)

			if (listeners.size === 0) {
				source.removeEventListener(type, handle)
			}
		}
	}
}

/*
 *   FACTORY
 ***************************************************************************************************/
/**
 * Binds the hooks to one client, at module scope rather than through a
 * provider. Context does not cross a federation boundary; a shared client does.
 *
 * ```ts
 * export const { useRequest, useSession } = createHooks(api)
 * ```
 */
export function createHooks<S>(
	client: Client & ObservableApi & SessionApi<S>,
): Hooks & SessionHooks<S>
export function createHooks(client: Client & ObservableApi): Hooks
export function createHooks(
	client: Client & ObservableApi & Partial<SessionApi> & Partial<CacheApi>,
): Hooks & Partial<SessionHooks<unknown>> {
	/**
	 * Runs the hooks have started and that have not settled, by key and
	 * invalidation. StrictMode's second effect, and every hook watching a key that
	 * was just invalidated, join one run instead of each starting a request.
	 */
	const runs = new Map<string, Promise<void>>()

	const subscribeVisible = createPageEvent(
		() => (typeof document === 'undefined' ? undefined : document),
		'visibilitychange',
		() => document.visibilityState === 'visible',
	)

	const subscribeOnline = createPageEvent(
		() => (typeof window === 'undefined' ? undefined : window),
		'online',
		() => true,
	)

	function useRequestCore<T>(
		descriptor: RequestDescriptor,
		behaviour: RequestBehaviour,
	): UseRequestResult<T> {
		const { key, isEnabled, run } = descriptor
		const { keepPreviousData, refetchOnFocus, refetchOnReconnect } = behaviour

		const store = useMemo(() => (key === undefined ? undefined : client.observe<T>(key)), [key])
		const activeStore = store ?? disabledStore
		const state = useSyncExternalStore(
			activeStore.subscribe,
			activeStore.getState,
			activeStore.getState,
		)

		const latestRun = useRef(run)
		const latestInvalidatedAt = useRef(state.invalidatedAt)

		useEffect(() => {
			latestRun.current = run
			latestInvalidatedAt.current = state.invalidatedAt
		})

		const execute = useCallback(
			(refresh: boolean): Promise<void> => {
				if (key === undefined) {
					return Promise.resolve()
				}

				const runId = `${key}@${latestInvalidatedAt.current}${refresh ? ':refresh' : ''}`
				const pending = runs.get(runId)

				if (pending !== undefined) {
					return pending
				}

				const started = latestRun.current({ refresh }).finally(() => {
					runs.delete(runId)
				})

				runs.set(runId, started)

				return started
			},
			[key],
		)

		const refetch = useCallback((): Promise<void> => execute(true), [execute])

		useEffect(() => {
			if (isEnabled) {
				void execute(false)
			}
		}, [execute, isEnabled, state.invalidatedAt])

		useEffect(() => {
			if (!isEnabled || !refetchOnFocus) {
				return
			}

			return subscribeVisible(() => {
				void execute(false)
			})
		}, [execute, isEnabled, refetchOnFocus])

		useEffect(() => {
			if (!isEnabled || !refetchOnReconnect) {
				return
			}

			return subscribeOnline(() => {
				void execute(false)
			})
		}, [execute, isEnabled, refetchOnReconnect])

		const [previous, setPrevious] = useState<PreviousSnapshot<T> | undefined>(undefined)

		useEffect(() => {
			if (!keepPreviousData || key === undefined) {
				return
			}

			if (state.status === 'success' || state.status === 'error') {
				setPrevious({
					key,
					data: state.data,
					error: state.error,
					status: state.status,
					from: state.from,
					updatedAt: state.updatedAt,
				})
			}
		}, [
			keepPreviousData,
			key,
			state.status,
			state.data,
			state.error,
			state.from,
			state.updatedAt,
		])

		return buildResult(state, previous, key, isEnabled, keepPreviousData, refetch)
	}

	/*
	 * REQUEST: path form
	 */
	function useRequestByPath<T>(path: string, options: UseRequestOptions): UseRequestResult<T> {
		const { behaviour, isEnabled, request } = splitOptions(options)

		const latestRequest = useRef(request)

		useEffect(() => {
			latestRequest.current = request
		})

		const key = tryGetKey(client, isEnabled, () => client.getKey(path, request))
		const hasWarned = useRef(false)

		useEffect(() => {
			if (!IS_DEVELOPMENT || hasWarned.current || key === undefined) {
				return
			}

			hasWarned.current = true

			if (client.getKey(path, request) !== key) {
				client.config.logger.warn(
					`[conduit] useRequest("${path}") derived two keys in one render, so the client's headers function answers differently per call. Narrow vary to the headers that matter.`,
				)
			}
		}, [path, request, key])

		const descriptor = useMemo<RequestDescriptor>(
			() => ({
				key,
				isEnabled: isEnabled && key !== undefined,
				run: async ({ refresh }) => {
					if (key !== undefined) {
						await client
							.request<T>(path, buildRunOptions(latestRequest.current, key, refresh))
							.safe()
					}
				},
			}),
			[path, key, isEnabled],
		)

		return useRequestCore<T>(descriptor, behaviour)
	}

	/*
	 * REQUEST: endpoint form
	 */
	function useRequestByEndpoint<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		vars: Vars,
		options: UseRequestOptions,
	): UseRequestResult<Result> {
		const { behaviour, isEnabled, request } = splitOptions(options)

		const latestVars = useRef(vars)
		const latestRequest = useRef(request)

		useEffect(() => {
			latestVars.current = vars
			latestRequest.current = request
		})

		useEffect(() => {
			if (IS_DEVELOPMENT && !isCacheable(endpoint.method, endpoint.cacheable)) {
				client.config.logger.warn(
					`[conduit] useRequest was given a ${endpoint.method} endpoint for "${endpoint.path}" that is not cacheable, so it sends a request on every mount. Use useMutation, or set cacheable: true.`,
				)
			}
		}, [endpoint])

		const key = tryGetKey(client, isEnabled, () => client.getKey(endpoint, vars))

		const descriptor = useMemo<RequestDescriptor>(
			() => ({
				key,
				isEnabled: isEnabled && key !== undefined,
				run: async ({ refresh }) => {
					if (key !== undefined) {
						await client
							.call(
								endpoint,
								latestVars.current,
								buildRunOptions(latestRequest.current, key, refresh),
							)
							.safe()
					}
				},
			}),
			[endpoint, key, isEnabled],
		)

		return useRequestCore<Result>(descriptor, behaviour)
	}

	function useRequest<T = unknown>(path: string, options?: UseRequestOptions): UseRequestResult<T>
	function useRequest<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		vars: Vars,
		options?: UseRequestOptions,
	): UseRequestResult<Result>
	function useRequest(
		pathOrEndpoint: string | Endpoint<unknown>,
		varsOrOptions?: unknown,
		maybeOptions?: UseRequestOptions,
	): UseRequestResult<unknown> {
		// The form is fixed at each call site, so the hooks below always run in the same order.
		if (typeof pathOrEndpoint === 'string') {
			// eslint-disable-next-line react-hooks/rules-of-hooks
			return useRequestByPath(
				pathOrEndpoint,
				(varsOrOptions as UseRequestOptions | undefined) ?? {},
			)
		}

		// eslint-disable-next-line react-hooks/rules-of-hooks
		return useRequestByEndpoint(pathOrEndpoint, varsOrOptions, maybeOptions ?? {})
	}

	/*
	 * MUTATION
	 */
	function useMutation<T, V>(
		run: (variables: V) => PromiseLike<T>,
		options?: UseMutationOptions<V>,
	): UseMutationResult<T, V>
	function useMutation<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		options?: UseMutationOptions<Vars>,
	): UseMutationResult<Result, Vars>
	function useMutation(
		runOrEndpoint: ((variables: unknown) => PromiseLike<unknown>) | Endpoint<unknown>,
		options?: UseMutationOptions<unknown>,
	): UseMutationResult<unknown, unknown> {
		const [state, setState] = useState<MutationState>(IDLE_MUTATION)

		const isAlive = useRef(true)
		const latestCall = useRef(0)
		const latest = useRef(runOrEndpoint)
		const latestOptions = useRef(options)

		useEffect(() => {
			latest.current = runOrEndpoint
			latestOptions.current = options
		})

		useEffect(() => {
			isAlive.current = true

			return () => {
				isAlive.current = false
			}
		}, [])

		const mutate = useCallback(async (variables: unknown): Promise<SafeResult<unknown>> => {
			const call = ++latestCall.current
			const ownsState = (): boolean => isAlive.current && latestCall.current === call

			setState(current => ({ ...current, status: 'pending', error: undefined }))

			try {
				const current = latest.current
				const data =
					typeof current === 'function'
						? await current(variables)
						: await client.call(current, variables)

				// An endpoint's own tags and any the caller added both apply.
				if (typeof current !== 'function') {
					invalidateTags(client, current.invalidates, variables)
				}

				invalidateTags(client, latestOptions.current?.invalidates, variables)

				if (ownsState()) {
					setState({ status: 'success', data, error: undefined })
				}

				return { data, error: null }
			} catch (cause) {
				const error = toConduitError(cause)

				if (ownsState()) {
					setState({ status: 'error', data: undefined, error })
				}

				return { data: null, error }
			}
		}, [])

		const reset = useCallback(() => {
			latestCall.current++
			setState(IDLE_MUTATION)
		}, [])

		return {
			mutate,
			status: state.status,
			data: state.data,
			error: state.error,
			isPending: state.status === 'pending',
			reset,
		}
	}

	/*
	 * PREFETCH
	 */
	function usePrefetch(): (path: string, options?: MethodOptions) => void {
		return useCallback((path: string, options?: MethodOptions) => {
			void client.get(path, { ...options, lane: options?.lane ?? 'prefetch' }).safe()
		}, [])
	}

	/*
	 * SESSION
	 */
	function useSession(): SessionState<unknown> {
		const handle = client.session

		if (handle === undefined) {
			throw new ConduitError({
				code: 'INVALID_ARGUMENT',
				message:
					'useSession needs the session plugin. Install it with .with(session({ adapter })).',
			})
		}

		return useSyncExternalStore(handle.subscribe, handle.getState, handle.getState)
	}

	return { useRequest, useMutation, usePrefetch, useSession }
}

export type { QueryState, QueryStatus }
