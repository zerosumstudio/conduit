import { createRequestError } from '../http/redact'
import { withRequest } from '../http/request'
import { composeSignals } from '../http/signals'
import { MAX_TIMER_DELAY_MS } from '../primitives/timers'
import type { Middleware, Plugin } from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
/** A per-request override goes through `meta: { timeoutMs }`, and `0` turns the timeout off. */
export interface TimeoutConfig {
	/** Milliseconds before a request is cancelled. Defaults to 15 seconds. */
	ms?: number | undefined
}

const DEFAULT_TIMEOUT_MS = 15_000

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Cancels a request that has taken too long, with code `TIMEOUT` rather than a
 * generic abort. Install it innermost so the clock covers one network attempt
 * rather than a whole retry sequence.
 */
export function timeout(config: TimeoutConfig = {}): Plugin {
	const defaultMs = config.ms ?? DEFAULT_TIMEOUT_MS

	const middleware: Middleware = async (request, next) => {
		const ms = request.meta.timeoutMs ?? defaultMs

		if (!Number.isFinite(ms) || ms <= 0) {
			return next(request)
		}

		const controller = new AbortController()

		const timer = setTimeout(
			() => {
				controller.abort(
					createRequestError(request, 'TIMEOUT', `exceeded its ${ms}ms timeout.`),
				)
			},
			Math.min(ms, MAX_TIMER_DELAY_MS),
		)

		try {
			const signal = composeSignals([request.signal, controller.signal])

			return await next(withRequest(request, { signal }))
		} finally {
			clearTimeout(timer)
		}
	}

	return { name: 'timeout', middleware }
}
