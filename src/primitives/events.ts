import type { ConduitError, ConduitErrorCode } from './errors'
import type { ApiVersionMismatch } from '../plugins/api-version'
import type { SessionStatus } from '../plugins/session'
import { consoleLogger, reportError, type ConduitLogger } from './logger'
import type { ConduitRequest, ConduitResponse, Lane } from './types'

/*
 *   EVENTS
 ***************************************************************************************************/
export interface RequestStartEvent {
	readonly type: 'request:start'
	/** The request as issued. Middleware may rewrite it further in; see `response.request`. */
	readonly request: ConduitRequest
	readonly at: number
}

export interface RequestSettleEvent {
	readonly type: 'request:settle'
	readonly request: ConduitRequest
	readonly response: ConduitResponse
	/** Milliseconds across the whole pipeline, not just the network. */
	readonly durationMs: number
	readonly at: number
}

export interface RequestErrorEvent {
	readonly type: 'request:error'
	readonly request: ConduitRequest
	readonly error: ConduitError
	readonly durationMs: number
	readonly at: number
}

export interface ClientDestroyEvent {
	readonly type: 'client:destroy'
	readonly at: number
}

/*
 *   PLUGIN EVENTS
 ***************************************************************************************************/

export interface CacheHitEvent {
	readonly type: 'cache:hit'
	readonly key: string
	readonly owner: string | undefined
	readonly at: number
}

export interface CacheMissEvent {
	readonly type: 'cache:miss'
	readonly key: string
	readonly owner: string | undefined
	readonly at: number
}

export interface CacheStaleEvent {
	readonly type: 'cache:stale'
	readonly key: string
	readonly owner: string | undefined
	/** Whether a background refresh was started, or one was already running. */
	readonly isRevalidating: boolean
	readonly at: number
}

export interface CacheInvalidateEvent {
	readonly type: 'cache:invalidate'
	/** A key, a `tag:name`, or `*` for a full clear. */
	readonly target: string
	readonly removed: number
	readonly at: number
}

export interface CacheSetEvent {
	readonly type: 'cache:set'
	readonly key: string
	readonly data: unknown
	readonly at: number
}

export interface DedupeJoinEvent {
	readonly type: 'dedupe:join'
	readonly key: string
	/** The remote that joined an existing flight rather than starting one. */
	readonly owner: string | undefined
	readonly at: number
}

export interface QueueEnqueueEvent {
	readonly type: 'queue:enqueue'
	readonly key: string
	readonly owner: string | undefined
	readonly lane: Lane
	/** How many were already waiting when this one joined. */
	readonly depth: number
	readonly at: number
}

export interface SessionChangeEvent {
	readonly type: 'session:change'
	readonly status: SessionStatus
	/** True when the session was lost: signed out by a failed renewal, not by a read that found nobody. */
	readonly isLost: boolean
	readonly at: number
}

export interface ApiVersionMismatchEvent extends ApiVersionMismatch {
	readonly type: 'api-version:mismatch'
	readonly at: number
}

export interface RetryAttemptEvent {
	readonly type: 'retry:attempt'
	readonly key: string
	readonly owner: string | undefined
	/** The attempt that just failed. */
	readonly attempt: number
	readonly delayMs: number
	readonly code: ConduitErrorCode
	readonly at: number
}

/**
 * The event surface. Plugins extend it by declaration merging:
 *
 * ```ts
 * declare module '@zerosumstudio/conduit' {
 * 	interface ConduitEventMap {
 * 		'cache:hit': { type: 'cache:hit'; key: string; at: number }
 * 	}
 * }
 * ```
 */
export interface ConduitEventMap {
	'request:start': RequestStartEvent
	'request:settle': RequestSettleEvent
	'request:error': RequestErrorEvent
	'client:destroy': ClientDestroyEvent
	'cache:hit': CacheHitEvent
	'cache:miss': CacheMissEvent
	'cache:stale': CacheStaleEvent
	'cache:invalidate': CacheInvalidateEvent
	'cache:set': CacheSetEvent
	'dedupe:join': DedupeJoinEvent
	'retry:attempt': RetryAttemptEvent
	'queue:enqueue': QueueEnqueueEvent
	'session:change': SessionChangeEvent
	'api-version:mismatch': ApiVersionMismatchEvent
}

export type ConduitEventType = keyof ConduitEventMap
export type ConduitEvent = ConduitEventMap[ConduitEventType]

export type Unsubscribe = () => void

/** What a remote sees of the bus: it can listen, and nothing else. Plugins get the whole `EventBus`. */
export type ClientEvents = Pick<EventBus, 'active' | 'on' | 'onAny'>

export interface EventBus {
	/** Whether anything is listening. Guard emission with it, rather than building events for nobody. */
	readonly active: boolean
	on<K extends ConduitEventType>(
		type: K,
		listener: (event: ConduitEventMap[K]) => void,
	): Unsubscribe
	/** Every event, whatever its type. What devtools and telemetry bridges want. */
	onAny(listener: (event: ConduitEvent) => void): Unsubscribe
	emit<K extends ConduitEventType>(type: K, event: ConduitEventMap[K]): void
	clear(): void
}

/*
 *   BUS
 ***************************************************************************************************/
type AnyListener = (event: ConduitEvent) => void

export function createEventBus(logger: ConduitLogger = consoleLogger): EventBus {
	const typed = new Map<ConduitEventType, Map<number, AnyListener>>()
	const all = new Map<number, AnyListener>()
	let nextId = 0
	let count = 0

	const dispatch = (listener: AnyListener, event: ConduitEvent): void => {
		try {
			listener(event)
		} catch (error) {
			reportError(logger, 'An event listener threw. The request is unaffected.', error)
		}
	}

	const subscribe = (bucket: Map<number, AnyListener>, listener: AnyListener): Unsubscribe => {
		const id = nextId++
		bucket.set(id, listener)
		count++

		let isRemoved = false

		return () => {
			if (isRemoved || !bucket.delete(id)) {
				return
			}

			isRemoved = true
			count--
		}
	}

	return {
		get active(): boolean {
			return count > 0
		},

		on<K extends ConduitEventType>(
			type: K,
			listener: (event: ConduitEventMap[K]) => void,
		): Unsubscribe {
			let listeners = typed.get(type)

			if (listeners === undefined) {
				listeners = new Map()
				typed.set(type, listeners)
			}

			return subscribe(listeners, listener as AnyListener)
		},

		onAny(listener: AnyListener): Unsubscribe {
			return subscribe(all, listener)
		},

		emit<K extends ConduitEventType>(type: K, event: ConduitEventMap[K]): void {
			const listeners = typed.get(type)

			if (listeners !== undefined) {
				for (const [id, listener] of [...listeners]) {
					if (listeners.has(id)) {
						dispatch(listener, event)
					}
				}
			}

			for (const [id, listener] of [...all]) {
				if (all.has(id)) {
					dispatch(listener, event)
				}
			}
		},

		clear(): void {
			for (const bucket of typed.values()) {
				bucket.clear()
			}

			typed.clear()
			all.clear()
			count = 0
		},
	}
}

/*
 *   TIMING
 ***************************************************************************************************/
/** Monotonic milliseconds, for durations. */
export function getMonotonicTime(): number {
	return performance.now()
}
