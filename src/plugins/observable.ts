import { toConduitError } from '../primitives/errors'
import type { Unsubscribe } from '../primitives/events'
import { createStore, type ReadableStore, type WritableStore } from '../primitives/stores'
import type { ConduitRequest, Middleware, Plugin } from '../primitives/types'
import { IDLE_QUERY_STATE, type QueryState, type QueryStatus } from './query-state'

/*
 *   STATE
 ***************************************************************************************************/
export type { QueryState, QueryStatus }

export interface ObservableConfig {
	/** How many keys to keep state for. Defaults to 200. A watched key is never evicted. */
	max?: number | undefined
}

export interface ObservableApi {
	/** The live state of one key, created on first call and shared by every watcher. */
	observe<T = unknown>(key: string): ReadableStore<QueryState<T>>
	/** How many keys currently have state. */
	getObservedCount(): number
}

const DEFAULT_MAX_ENTRIES = 200

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Turns request traffic into per-key state for framework bindings to read. It
 * lives on the client, so two remotes rendering the same query watch one store.
 */
export function observable(config: ObservableConfig = {}): Plugin<ObservableApi> {
	const max = config.max ?? DEFAULT_MAX_ENTRIES
	const stores = new Map<string, WritableStore<QueryState<unknown>>>()
	/** Tags seen on requests for a key, so a `cache:invalidate` tag target can be matched here too. */
	const tagsByKey = new Map<string, Set<string>>()
	let generation = 0
	/** Counts identity resets, so a read that started before one never writes after it. */
	let epoch = 0

	const pending = new Map<string, number>()

	const enter = (key: string): void => {
		pending.set(key, (pending.get(key) ?? 0) + 1)
	}

	/** Drops one participant and reports how many are left. */
	const leave = (key: string): number => {
		const left = (pending.get(key) ?? 1) - 1

		if (left <= 0) {
			pending.delete(key)

			return 0
		}

		pending.set(key, left)

		return left
	}

	const trackTags = (request: ConduitRequest): void => {
		if (request.tags.length === 0) {
			return
		}

		let known = tagsByKey.get(request.key)

		if (known === undefined) {
			known = new Set()
			tagsByKey.set(request.key, known)
		}

		for (const tag of request.tags) {
			known.add(tag)
		}
	}

	const wrappers = new Map<string, ReadableStore<QueryState<unknown>>>()

	const forget = (key: string): void => {
		stores.delete(key)
		tagsByKey.delete(key)
		wrappers.delete(key)
	}

	let sweepTimer: ReturnType<typeof setTimeout> | undefined

	const sweep = (): void => {
		if (stores.size <= max) {
			return
		}

		for (const [key, store] of stores) {
			if (stores.size <= max) {
				break
			}

			if (store.listeners === 0) {
				forget(key)
			}
		}
	}

	const requestSweep = (): void => {
		if (sweepTimer !== undefined) {
			return
		}

		sweepTimer = setTimeout(() => {
			sweepTimer = undefined
			sweep()
		}, 0)
	}

	const getStore = (key: string): WritableStore<QueryState<unknown>> => {
		const existing = stores.get(key)

		if (existing !== undefined) {
			stores.delete(key)
			stores.set(key, existing)

			return existing
		}

		const created = createStore<QueryState<unknown>>(IDLE_QUERY_STATE)
		stores.set(key, created)

		if (stores.size > max) {
			requestSweep()
		}

		return created
	}

	const bumpOne = (key: string): void => {
		const store = stores.get(key)

		if (store === undefined) {
			return
		}

		generation++
		store.update(current => ({ ...current, invalidatedAt: generation }))
	}

	const bumpAll = (): void => {
		generation++

		for (const store of stores.values()) {
			store.update(current => ({ ...current, invalidatedAt: generation }))
		}
	}

	const applySet = (key: string, data: unknown, at: number): void => {
		const store = stores.get(key)

		if (store === undefined) {
			return
		}

		store.set({
			status: 'success',
			data,
			error: undefined,
			from: 'cache',
			isFetching: false,
			updatedAt: at,
			invalidatedAt: store.getState().invalidatedAt,
		})
	}

	const bumpTag = (tag: string): void => {
		for (const [key, tags] of tagsByKey) {
			if (tags.has(tag)) {
				bumpOne(key)
			}
		}
	}

	const middleware: Middleware = async (request, next) => {
		const store = getStore(request.key)
		const startedAtEpoch = epoch

		trackTags(request)
		enter(request.key)

		store.update(current => ({
			...current,
			status: current.data === undefined ? 'loading' : current.status,
			isFetching: true,
		}))

		try {
			const response = await next(request)
			const others = leave(request.key)

			// Whoever was signed in when this started is not who is signed in now.
			if (epoch !== startedAtEpoch) {
				return response
			}

			store.set({
				status: 'success',
				data: response.data,
				error: undefined,
				from: response.from,
				isFetching: others > 0,
				updatedAt: Date.now(),
				invalidatedAt: store.getState().invalidatedAt,
			})

			return response
		} catch (cause) {
			const error = toConduitError(cause)
			const others = leave(request.key)

			if (epoch !== startedAtEpoch) {
				throw error
			}

			if (error.code === 'ABORTED') {
				if (others === 0) {
					store.update(current => ({
						...current,
						status: current.data === undefined ? 'idle' : current.status,
						isFetching: false,
					}))
				}

				throw error
			}

			store.update(current => ({
				...current,
				status: 'error',
				error,
				isFetching: others > 0,
				updatedAt: Date.now(),
			}))

			throw error
		}
	}

	let releaseReset: (() => void) | undefined
	let releaseChange: (() => void) | undefined

	return {
		name: 'observable',
		middleware,
		onInit: ctx => {
			releaseReset = ctx.onResetIdentity(() => {
				epoch++
				generation++

				for (const store of stores.values()) {
					store.set({ ...IDLE_QUERY_STATE, invalidatedAt: generation })
				}

				tagsByKey.clear()
			})

			releaseChange = ctx.onCacheChange(change => {
				if (change.type === 'set') {
					applySet(change.key, change.data, change.at)

					return
				}

				if (change.target === '*') {
					bumpAll()
				} else if (change.target.startsWith('tag:')) {
					bumpTag(change.target.slice(4))
				} else {
					bumpOne(change.target)
				}
			})

			return {
				observe: <T>(key: string): ReadableStore<QueryState<T>> => {
					const store = getStore(key)
					const existing = wrappers.get(key)

					if (existing !== undefined) {
						return existing as unknown as ReadableStore<QueryState<T>>
					}

					const wrapped: ReadableStore<QueryState<unknown>> = {
						getState: () => store.getState(),
						subscribe: listener => {
							const off = store.subscribe(listener)
							let isReleased = false

							const unsubscribe: Unsubscribe = () => {
								if (isReleased) {
									return
								}

								isReleased = true
								off()
								requestSweep()
							}

							return unsubscribe
						},
					}

					wrappers.set(key, wrapped)

					return wrapped as unknown as ReadableStore<QueryState<T>>
				},
				getObservedCount: (): number => stores.size,
			}
		},
		onDestroy: () => {
			releaseReset?.()
			releaseReset = undefined
			releaseChange?.()
			releaseChange = undefined
			wrappers.clear()
			clearTimeout(sweepTimer)
			sweepTimer = undefined
			stores.clear()
			tagsByKey.clear()
			pending.clear()
		},
	}
}
