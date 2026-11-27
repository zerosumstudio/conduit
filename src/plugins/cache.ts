import { formatKey } from '../http/redact'
import type { EventBus } from '../primitives/events'
import { consoleLogger, reportError } from '../primitives/logger'
import { protect } from '../primitives/freeze'
import { withRequest } from '../http/request'
import type {
	PluginContext,
	ConduitRequest,
	ConduitResponse,
	Middleware,
	Next,
	Plugin,
	ResponseSource,
} from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface CacheConfig {
	/** How long a stored response counts as fresh. Defaults to 30 seconds. */
	ttlMs?: number | undefined
	/**
	 * How long past `ttlMs` a stale response may still be served while a refresh
	 * runs behind it. `Infinity` means indefinitely, and the default 0 means never.
	 */
	staleMs?: number | undefined
	/** Entry cap. Defaults to 200. The oldest read is evicted first. */
	max?: number | undefined
}

export interface CacheApi {
	/**
	 * Drops one entry and suppresses any read of that key already in flight.
	 * `false` means nothing was stored, not that the in-flight read survives.
	 */
	invalidate(key: string): boolean
	/** Drops every entry carrying a tag. Returns how many went. */
	invalidateTag(tag: string): number
	clearCache(): void
	getCacheSize(): number
	/**
	 * Writes a value directly, for an optimistic update, without a network
	 * round trip. Also reaches any mounted `useRequest` watching the same key.
	 * Returns the previous value, so a failed mutation can roll back to it.
	 */
	setData<T = unknown>(key: string, data: T | ((previous: T | undefined) => T)): T | undefined
}

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_ENTRIES = 200

/*
 *   ENTRY
 ***************************************************************************************************/
interface Entry {
	status: number
	headers: Headers
	data: unknown
	tags: readonly string[]
	freshUntil: number
	staleUntil: number
}

/** A read in flight, and whether an invalidation has overtaken it. */
interface PendingRead {
	readonly key: string
	readonly tags: readonly string[]
	isSuppressed: boolean
}

/** What `setData` builds on when nothing is stored under the key yet. */
const EMPTY_ENTRY: Pick<Entry, 'status' | 'headers' | 'tags'> = {
	status: 200,
	headers: new Headers(),
	tags: [],
}

/**
 * Tags accumulate rather than being replaced. Several callers populate one key
 * and only some know its tags, so last-write-wins would unhook the entry from
 * `invalidateTag` without saying so.
 */
function mergeTags(
	previous: readonly string[] | undefined,
	next: readonly string[],
): readonly string[] {
	if (previous === undefined || previous.length === 0) {
		return next
	}

	if (next.length === 0) {
		return previous
	}

	const merged = new Set(previous)

	for (const tag of next) {
		merged.add(tag)
	}

	return merged.size === previous.length ? previous : [...merged]
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * A response cache shared by every bundle, so a remote that mounts second reads
 * what the first already fetched. A hit costs a map lookup and nothing else.
 *
 * It stores what `request.cacheable` allows, which is `GET` and `HEAD` unless a
 * request or endpoint says otherwise. Tags only label entries for `invalidateTag`.
 */
export function cache(config: CacheConfig = {}): Plugin<CacheApi> {
	const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS
	const max = config.max ?? DEFAULT_MAX_ENTRIES
	const staleMs = config.staleMs ?? 0

	const entries = new Map<string, Entry>()
	const revalidating = new Set<string>()

	/**
	 * A read that started before an invalidation must not store what it fetched.
	 * Tracked per read rather than by a shared counter, which would also discard
	 * every unrelated response in flight at the time.
	 */
	const inFlight = new Set<PendingRead>()

	const lifetime = new AbortController()
	let events: EventBus | undefined
	let context: PluginContext | undefined

	const begin = (request: ConduitRequest): PendingRead => {
		const pending: PendingRead = { key: request.key, tags: request.tags, isSuppressed: false }
		inFlight.add(pending)

		return pending
	}

	const suppress = (matches: (pending: PendingRead) => boolean): void => {
		for (const pending of inFlight) {
			if (matches(pending)) {
				pending.isSuppressed = true
			}
		}
	}

	const announce = (target: string, removed: number): number => {
		if (removed === 0) {
			return removed
		}

		context?.notifyCacheChange({ type: 'invalidate', target })

		if (events?.active === true) {
			events.emit('cache:invalidate', {
				type: 'cache:invalidate',
				target,
				removed,
				at: Date.now(),
			})
		}

		return removed
	}

	const read = (key: string): Entry | undefined => {
		const entry = entries.get(key)

		if (entry === undefined) {
			return undefined
		}

		entries.delete(key)
		entries.set(key, entry)

		return entry
	}

	const enforceCap = (): void => {
		if (entries.size > max) {
			const oldest = entries.keys().next().value

			if (oldest !== undefined) {
				entries.delete(oldest)
			}
		}
	}

	const write = (
		request: ConduitRequest,
		response: ConduitResponse,
		pending: PendingRead,
	): void => {
		if (pending.isSuppressed) {
			return
		}

		const now = Date.now()

		protect(response.data)

		entries.set(request.key, {
			status: response.status,
			headers: response.headers,
			data: response.data,
			tags: mergeTags(entries.get(request.key)?.tags, request.tags),
			freshUntil: now + ttlMs,
			staleUntil: now + ttlMs + staleMs,
		})

		enforceCap()
	}

	const serve = (
		entry: Entry,
		request: ConduitRequest,
		from: ResponseSource,
	): ConduitResponse => ({
		status: entry.status,
		headers: entry.headers,
		data: entry.data,
		raw: undefined,
		from,
		attempt: 1,
		request,
	})

	const isStorable = (response: ConduitResponse): boolean => {
		const control = response.headers.get('cache-control')

		return control === null || !/no-store|no-cache/i.test(control)
	}

	const refresh = (request: ConduitRequest, next: Next): boolean => {
		if (revalidating.has(request.key)) {
			return false
		}

		revalidating.add(request.key)

		const detached = withRequest(request, {
			signal: lifetime.signal,
			meta: { ...request.meta, cache: 'bypass' },
		})

		const pending = begin(detached)
		const dispatch = context?.dispatch ?? next

		dispatch(detached)
			.then(response => {
				if (isStorable(response)) {
					write(detached, response, pending)
				}
			})
			.catch((error: unknown) => {
				reportError(
					context?.config.logger ?? consoleLogger,
					'A background refresh failed.',
					error,
				)
			})
			.finally(() => {
				inFlight.delete(pending)
				revalidating.delete(request.key)
			})

		return true
	}

	const fetchAndStore = async (request: ConduitRequest, next: Next): Promise<ConduitResponse> => {
		const pending = begin(request)

		try {
			const response = await next(request)

			if (isStorable(response)) {
				write(request, response, pending)
			}

			return response
		} finally {
			inFlight.delete(pending)
		}
	}

	/** The stored answer for a request, while it is fresh or may still be served stale. */
	const serveStored = (
		entry: Entry,
		request: ConduitRequest,
		next: Next,
		now: number,
	): ConduitResponse | undefined => {
		if (now < entry.freshUntil) {
			if (events?.active === true) {
				events.emit('cache:hit', {
					type: 'cache:hit',
					key: formatKey(request),
					owner: request.owner,
					at: now,
				})
			}

			return serve(entry, request, 'cache')
		}

		if (now >= entry.staleUntil) {
			return undefined
		}

		const hasStarted = refresh(request, next)

		if (events?.active === true) {
			events.emit('cache:stale', {
				type: 'cache:stale',
				key: formatKey(request),
				owner: request.owner,
				isRevalidating: hasStarted,
				at: now,
			})
		}

		return serve(entry, request, 'stale')
	}

	const middleware: Middleware = async (request, next) => {
		const mode = request.meta.cache

		if (mode === 'bypass' || !request.cacheable) {
			return next(request)
		}

		if (mode === 'refresh') {
			return fetchAndStore(request, next)
		}

		const now = Date.now()
		const entry = read(request.key)
		const stored = entry === undefined ? undefined : serveStored(entry, request, next, now)

		if (stored !== undefined) {
			return stored
		}

		if (events?.active === true) {
			events.emit('cache:miss', {
				type: 'cache:miss',
				key: formatKey(request),
				owner: request.owner,
				at: now,
			})
		}

		return fetchAndStore(request, next)
	}

	const clearCache = (): void => {
		const removed = entries.size

		entries.clear()
		suppress(() => true)
		announce('*', removed)
	}

	let release: (() => void) | undefined

	return {
		name: 'cache',
		middleware,
		onInit: ctx => {
			events = ctx.events
			context = ctx

			release = ctx.onResetIdentity(clearCache)

			return {
				invalidate: (key: string): boolean => {
					suppress(pending => pending.key === key)

					return announce(key, entries.delete(key) ? 1 : 0) > 0
				},

				invalidateTag: (tag: string): number => {
					let removed = 0

					for (const [key, entry] of entries) {
						if (entry.tags.includes(tag)) {
							entries.delete(key)
							removed++
						}
					}

					suppress(pending => pending.tags.includes(tag))

					return announce(`tag:${tag}`, removed)
				},

				clearCache,

				getCacheSize: (): number => entries.size,

				setData: <T>(
					key: string,
					data: T | ((previous: T | undefined) => T),
				): T | undefined => {
					const existing = entries.get(key)
					const { status, headers, tags } = existing ?? EMPTY_ENTRY
					const previous = existing?.data as T | undefined
					const next =
						typeof data === 'function'
							? (data as (previous: T | undefined) => T)(previous)
							: data
					const now = Date.now()

					protect(next)

					entries.set(key, {
						status,
						headers,
						data: next,
						tags,
						freshUntil: now + ttlMs,
						staleUntil: now + ttlMs + staleMs,
					})

					enforceCap()
					context?.notifyCacheChange({ type: 'set', key, data: next, at: now })

					if (events?.active === true) {
						events.emit('cache:set', { type: 'cache:set', key, data: next, at: now })
					}

					return previous
				},
			}
		},
		onDestroy: () => {
			release?.()
			release = undefined
			lifetime.abort()
			entries.clear()
			revalidating.clear()
			inFlight.clear()
		},
	}
}
