import { formatKey } from '../http/redact'
import { toAbortError } from '../http/abort'
import { toConduitError, type ConduitError } from '../primitives/errors'
import type { EventBus } from '../primitives/events'
import type { ConduitRequest, HttpMethod, Middleware, Plugin } from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface RetryInfo {
	readonly request: ConduitRequest
	readonly error: ConduitError
	/** The attempt that just failed. */
	readonly attempt: number
	readonly delayMs: number
}

export interface RetryConfig {
	/** Total attempts including the first. Defaults to 3. */
	attempts?: number | undefined
	/** First backoff step in milliseconds. Defaults to 300. */
	baseDelayMs?: number | undefined
	/** Ceiling for a single backoff step. Defaults to 5000. */
	maxDelayMs?: number | undefined
	/**
	 * The longest `Retry-After` that is honoured. A server asking for more gets
	 * no retry rather than a clamped one. Defaults to 30 seconds.
	 */
	maxRetryAfterMs?: number | undefined
	/** Spread retries across the window instead of stacking them. Defaults to true. */
	jitter?: boolean | undefined
	/**
	 * Refuse to replay `POST` and `PATCH`, except a request marked `cacheable`,
	 * which only reads. Defaults to true.
	 */
	idempotentOnly?: boolean | undefined
	/** Response statuses worth another attempt. */
	statuses?: readonly number[] | undefined
	/** Replaces the built-in decision entirely. */
	shouldRetry?:
		((error: ConduitError, request: ConduitRequest, attempt: number) => boolean) | undefined
	onRetry?: ((info: RetryInfo) => void) | undefined
}

/** Methods conduit may replay after a failure. `POST` and `PATCH` are absent deliberately. */
const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
	'GET',
	'HEAD',
	'PUT',
	'DELETE',
	'OPTIONS',
])

const RETRYABLE_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504]

const DEFAULT_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 300
const DEFAULT_MAX_DELAY_MS = 5_000
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000

/*
 *   RETRY-AFTER
 ***************************************************************************************************/
function parseRetryAfter(error: ConduitError): number | undefined {
	const header = error.headers?.get('retry-after')

	if (header === undefined || header === null || header.trim() === '') {
		return undefined
	}

	const seconds = Number(header)

	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000)
	}

	const date = Date.parse(header)

	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function isBodyConsumed(request: ConduitRequest): boolean {
	return request.body instanceof ReadableStream && request.body.locked
}

/*
 *   SLEEP
 ***************************************************************************************************/
/** Waits, unless the request is cancelled first. A backoff must not outlive its request. */
function sleep(ms: number, request: ConduitRequest): Promise<void> {
	if (request.signal.aborted) {
		return Promise.reject(toAbortError(request))
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			request.signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)

		function onAbort(): void {
			clearTimeout(timer)
			reject(toAbortError(request))
		}

		request.signal.addEventListener('abort', onAbort, { once: true })
	})
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Replays a failed request with exponential backoff. Install it outside the
 * queue so a replay waits its turn instead of amplifying a failing endpoint.
 */
export function retry(config: RetryConfig = {}): Plugin {
	const attempts = config.attempts ?? DEFAULT_ATTEMPTS
	const baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
	const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
	const maxRetryAfterMs = config.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS
	const jitter = config.jitter ?? true
	const idempotentOnly = config.idempotentOnly ?? true
	const statuses = new Set(config.statuses ?? RETRYABLE_STATUSES)

	let events: EventBus | undefined

	const isRetryable = (
		error: ConduitError,
		request: ConduitRequest,
		attempt: number,
	): boolean => {
		if (isBodyConsumed(request)) {
			return false
		}

		if (config.shouldRetry !== undefined) {
			return config.shouldRetry(error, request, attempt)
		}

		if (idempotentOnly && !IDEMPOTENT_METHODS.has(request.method) && !request.cacheable) {
			return false
		}

		if (error.code === 'NETWORK' || error.code === 'TIMEOUT') {
			return true
		}

		return (
			error.code === 'HTTP_STATUS' && error.status !== undefined && statuses.has(error.status)
		)
	}

	/**
	 * How long to wait before the next attempt, or `undefined` to give up. A
	 * `Retry-After` beyond `maxRetryAfterMs` gives up rather than being clamped,
	 * which would ignore what the server just asked for.
	 */
	const getBackoffMs = (
		attempt: number,
		retryAfterMs: number | undefined,
	): number | undefined => {
		if (retryAfterMs !== undefined) {
			return retryAfterMs > maxRetryAfterMs ? undefined : retryAfterMs
		}

		const window = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))

		return jitter ? Math.random() * window : window
	}

	const middleware: Middleware = async (request, next) => {
		let attempt = 1

		for (;;) {
			request.meta.attempt = attempt

			try {
				return await next(request)
			} catch (cause) {
				const error = toConduitError(cause)
				const retryAfterMs = parseRetryAfter(error)

				if (retryAfterMs !== undefined) {
					error.retryAfterMs = retryAfterMs
				}

				if (attempt >= attempts || !isRetryable(error, request, attempt)) {
					throw error
				}

				const delay = getBackoffMs(attempt, retryAfterMs)

				if (delay === undefined) {
					throw error
				}

				if (events?.active === true) {
					events.emit('retry:attempt', {
						type: 'retry:attempt',
						key: formatKey(request),
						owner: request.owner,
						attempt,
						delayMs: delay,
						code: error.code,
						at: Date.now(),
					})
				}

				config.onRetry?.({ request, error, attempt, delayMs: delay })

				await sleep(delay, request)
				attempt++
			}
		}
	}

	return {
		name: 'retry',
		middleware,
		onInit: ctx => {
			events = ctx.events
		},
	}
}
