import { formatKey } from '../http/redact'
import { toAbortError } from '../http/abort'
import type { EventBus } from '../primitives/events'
import { protect } from '../primitives/freeze'
import { withRequest } from '../http/request'
import type { ConduitRequest, ConduitResponse, Middleware, Plugin } from '../primitives/types'

/*
 *   API
 ***************************************************************************************************/
export interface DedupeApi {
	/** Distinct requests currently in flight and shareable. */
	getInFlightCount(): number
}

/*
 *   FLIGHT
 ***************************************************************************************************/
interface Flight {
	promise: Promise<ConduitResponse>
	/** Drives the single underlying request, so no one participant's signal owns it. */
	controller: AbortController
	participants: number
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * One request per key, however many callers ask for it. It shares a flight for
 * every request that is `cacheable`.
 *
 * Cancellation is reference-counted. The flight runs on its own controller and
 * aborts when the last participant leaves, so one remote unmounting cancels its
 * own wait and nobody else's.
 */
export function dedupe(): Plugin<DedupeApi> {
	const flights = new Map<string, Flight>()
	let events: EventBus | undefined

	const join = async (
		flight: Flight,
		request: ConduitRequest,
		isJoined: boolean,
	): Promise<ConduitResponse> => {
		flight.participants++

		let hasLeft = false
		let rejectOnAbort: (error: unknown) => void = () => {}

		const leave = (isAborted: boolean): void => {
			if (hasLeft) {
				return
			}

			hasLeft = true
			request.signal.removeEventListener('abort', onAbort)
			flight.participants--

			if (isAborted && flight.participants === 0) {
				if (flights.get(request.key) === flight) {
					flights.delete(request.key)
				}

				flight.controller.abort(request.signal.reason)
			}
		}

		function onAbort(): void {
			const error = toAbortError(request)
			leave(true)
			rejectOnAbort(error)
		}

		request.signal.addEventListener('abort', onAbort, { once: true })

		const abandoned = new Promise<never>((_resolve, reject) => {
			rejectOnAbort = reject
		})

		try {
			const response = await Promise.race([flight.promise, abandoned])

			protect(response.data)

			return isJoined ? { ...response, from: 'dedupe', request } : response
		} finally {
			leave(false)
		}
	}

	const middleware: Middleware = async (request, next) => {
		if (request.meta.dedupe === 'bypass' || !request.cacheable) {
			return next(request)
		}

		if (request.signal.aborted) {
			throw toAbortError(request)
		}

		const existing = flights.get(request.key)

		if (existing !== undefined && !existing.controller.signal.aborted) {
			if (events?.active === true) {
				events.emit('dedupe:join', {
					type: 'dedupe:join',
					key: formatKey(request),
					owner: request.owner,
					at: Date.now(),
				})
			}

			return join(existing, request, true)
		}

		const controller = new AbortController()
		const flight: Flight = {
			controller,
			participants: 0,
			promise: next(withRequest(request, { signal: controller.signal })),
		}

		flights.set(request.key, flight)

		const forget = (): void => {
			if (flights.get(request.key) === flight) {
				flights.delete(request.key)
			}
		}

		flight.promise.then(forget, forget)

		return join(flight, request, false)
	}

	let release: (() => void) | undefined

	return {
		name: 'dedupe',
		middleware,
		onInit: ctx => {
			events = ctx.events

			release = ctx.onResetIdentity(() => {
				flights.clear()
			})

			return { getInFlightCount: () => flights.size }
		},
		onDestroy: () => {
			release?.()
			release = undefined
			flights.clear()
		},
	}
}
