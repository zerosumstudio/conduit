import { formatKey } from '../http/redact'
import { toAbortError } from '../http/abort'
import { ConduitError } from '../primitives/errors'
import type { EventBus } from '../primitives/events'
import type { ConduitRequest, Lane, Middleware, Plugin } from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface QueueConfig {
	/** How many requests may be in flight at once. Defaults to 6. */
	concurrency?: number | undefined
	/** Lanes in priority order, most urgent first. */
	lanes?: readonly Lane[] | undefined
	/** Per-lane ceilings, so one lane cannot take the whole pool. Minimum 1. */
	limits?: Readonly<Record<string, number>> | undefined
}

export interface QueueApi {
	/** Requests waiting for a slot, optionally in one lane. */
	getQueueDepth(lane?: Lane): number
	/** Requests currently holding a slot. */
	getActiveCount(): number
}

const DEFAULT_CONCURRENCY = 6

const DEFAULT_LANES: readonly Lane[] = ['critical', 'default', 'prefetch']

function assertPositive(what: string, value: number): void {
	if (Number.isInteger(value) && value >= 1) {
		return
	}

	throw new ConduitError({
		code: 'INVALID_ARGUMENT',
		message: `queue({ ${what}: ${String(value)} }) must be a whole number of at least 1.`,
	})
}

/*
 *   WAITER
 ***************************************************************************************************/
interface Waiter {
	lane: Lane
	priority: number
	resolve: () => void
	detach: () => void
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Bounded concurrency with priority lanes, so a remote's speculative
 * prefetching cannot queue ahead of the host's boot path down in the browser's
 * connection pool.
 */
export function queue(config: QueueConfig = {}): Plugin<QueueApi> {
	const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY
	const lanes = config.lanes ?? DEFAULT_LANES
	const limits = config.limits ?? {}
	const priorities = new Map<string, number>(lanes.map((lane, index) => [lane, index]))

	assertPositive('concurrency', concurrency)

	for (const [lane, limit] of Object.entries(limits)) {
		assertPositive(`limits.${lane}`, limit)
	}

	const waiting: Waiter[] = []
	const laneActive = new Map<string, number>()
	let active = 0
	let events: EventBus | undefined

	const getPriority = (lane: Lane): number => priorities.get(lane) ?? lanes.length
	const getLimit = (lane: Lane): number => limits[lane] ?? concurrency
	const countActive = (lane: Lane): number => laneActive.get(lane) ?? 0

	const canRun = (lane: Lane): boolean =>
		active < concurrency && countActive(lane) < getLimit(lane)

	const acquire = (lane: Lane): void => {
		active++
		laneActive.set(lane, countActive(lane) + 1)
	}

	const release = (lane: Lane): void => {
		active--
		laneActive.set(lane, countActive(lane) - 1)
	}

	const pump = (): void => {
		for (;;) {
			let chosen = -1

			for (let index = 0; index < waiting.length; index++) {
				const waiter = waiting[index]
				const best = chosen === -1 ? undefined : waiting[chosen]

				if (waiter === undefined || !canRun(waiter.lane)) {
					continue
				}

				if (best === undefined || waiter.priority < best.priority) {
					chosen = index
				}
			}

			if (chosen === -1) {
				return
			}

			const [waiter] = waiting.splice(chosen, 1)

			if (waiter === undefined) {
				return
			}

			waiter.detach()
			acquire(waiter.lane)
			waiter.resolve()
		}
	}

	const wait = (request: ConduitRequest): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				lane: request.lane,
				priority: getPriority(request.lane),
				resolve,
				detach: () => {},
			}

			const onAbort = (): void => {
				const index = waiting.indexOf(waiter)

				if (index !== -1) {
					waiting.splice(index, 1)
				}

				waiter.detach()
				reject(toAbortError(request))
			}

			request.signal.addEventListener('abort', onAbort, { once: true })
			waiter.detach = () => request.signal.removeEventListener('abort', onAbort)

			waiting.push(waiter)
		})

	const middleware: Middleware = async (request, next) => {
		if (request.meta.queue === 'bypass') {
			return next(request)
		}

		if (request.signal.aborted) {
			throw toAbortError(request)
		}

		if (canRun(request.lane)) {
			acquire(request.lane)
		} else {
			if (events?.active === true) {
				events.emit('queue:enqueue', {
					type: 'queue:enqueue',
					key: formatKey(request),
					owner: request.owner,
					lane: request.lane,
					depth: waiting.length,
					at: Date.now(),
				})
			}

			await wait(request)
		}

		try {
			return await next(request)
		} finally {
			release(request.lane)
			pump()
		}
	}

	return {
		name: 'queue',
		middleware,
		onInit: ctx => {
			events = ctx.events

			return {
				getQueueDepth: (lane?: Lane): number =>
					lane === undefined
						? waiting.length
						: waiting.reduce(
								(count, waiter) => count + (waiter.lane === lane ? 1 : 0),
								0,
							),
				getActiveCount: (): number => active,
			}
		},
		onDestroy: () => {
			waiting.length = 0
			laneActive.clear()
			active = 0
		},
	}
}
