import { toConduitError } from '../primitives/errors'
import { withRequest } from '../http/request'
import type { Middleware, Plugin } from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface RequestIdConfig {
	/** The header that carries the id. Defaults to `x-request-id`. */
	header?: string | undefined
	/** Makes an id. Defaults to `crypto.randomUUID()`. */
	generate?: (() => string) | undefined
}

const DEFAULT_HEADER = 'x-request-id'

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Sends an id with every attempt, and records it on `ConduitError.requestId`,
 * on `response.request.meta.requestId` and on devtools entries, so a failure in
 * the UI leads straight to the server's log line.
 *
 * Install it last, inside cache and dedupe. The id then never reaches a key,
 * and each retry goes out with an id of its own. A header the caller already
 * set is kept and reported as it is.
 */
export function requestId(config: RequestIdConfig = {}): Plugin {
	const header = config.header ?? DEFAULT_HEADER
	const generate = config.generate ?? ((): string => crypto.randomUUID())

	const middleware: Middleware = async (request, next) => {
		const headers = new Headers(request.headers)
		const id = headers.get(header) ?? generate()

		headers.set(header, id)
		request.meta.requestId = id

		try {
			return await next(withRequest(request, { headers }))
		} catch (cause) {
			const error = toConduitError(cause)

			error.requestId = id

			throw error
		}
	}

	return { name: 'requestId', middleware }
}
