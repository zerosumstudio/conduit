import { ConduitError, toConduitError } from '../primitives/errors'
import type { EventBus } from '../primitives/events'
import { stripQuery } from '../http/redact'
import { consoleLogger, type ConduitLogger } from '../primitives/logger'
import type { Middleware, Plugin } from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface ApiVersionMismatch {
	/** What this bundle was built against. */
	readonly expected: string
	/** What the server reported. */
	readonly actual: string
	/** The request url, without its query. */
	readonly url: string
}

export interface ApiVersionConfig {
	/** The API version this bundle was compiled against. */
	expected: string | number
	/** Response header carrying the server's version. Defaults to `x-api-version`. */
	header?: string | undefined
	/** Routes the report somewhere other than the console. */
	onMismatch?: ((report: ApiVersionMismatch) => void) | undefined
}

const DEFAULT_HEADER = 'x-api-version'

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Notices when a bundle is talking to an API it was not built against, and says
 * so once per server version rather than once per request. Error responses
 * count too, since a deployment that moved on often fails first.
 */
export function apiVersion(config: ApiVersionConfig): Plugin {
	const header = config.header ?? DEFAULT_HEADER
	const expected = String(config.expected)
	const reported = new Set<string>()
	let events: EventBus | undefined
	let logger: ConduitLogger | undefined

	if (expected === '') {
		throw new ConduitError({
			code: 'INVALID_ARGUMENT',
			message: 'apiVersion({ expected }) needs a version.',
		})
	}

	const check = (headers: Headers | undefined, url: string, method: string): void => {
		const actual = headers?.get(header) ?? null

		if (actual === null || actual === expected || reported.has(actual)) {
			return
		}

		reported.add(actual)

		const report: ApiVersionMismatch = { expected, actual, url }

		if (events?.active === true) {
			events.emit('api-version:mismatch', {
				type: 'api-version:mismatch',
				...report,
				at: Date.now(),
			})
		}

		if (config.onMismatch !== undefined) {
			config.onMismatch(report)

			return
		}

		;(logger ?? consoleLogger).warn(
			`[conduit] Built against API ${expected}, but ${method} ${url} answered as ${actual}. Deploy the two together.`,
		)
	}

	const middleware: Middleware = async (request, next) => {
		try {
			const response = await next(request)

			check(response.headers, stripQuery(request.url), request.method)

			return response
		} catch (cause) {
			const error = toConduitError(cause)

			check(error.headers, stripQuery(request.url), request.method)

			throw error
		}
	}

	return {
		name: 'apiVersion',
		middleware,
		onInit: ctx => {
			events = ctx.events
			logger = ctx.config.logger
		},
	}
}
