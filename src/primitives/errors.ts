/*
 *   CODES
 ***************************************************************************************************/
/**
 * Closed set of failure modes, discriminating `ConduitError`.
 *
 * - `HTTP_STATUS`: the server answered with a failing status.
 * - `NETWORK`: the request never reached a server (DNS, offline, CORS, TLS).
 * - `TIMEOUT`: the request exceeded its own deadline.
 * - `ABORTED`: a caller, a scope, or a superseding request cancelled it.
 * - `PARSE_FAILED`: a body arrived but could not be decoded as declared.
 * - `VALIDATION_FAILED`: an endpoint's `response` schema or function rejected the decoded body.
 * - `UNAUTHENTICATED`: the session is gone and could not be recovered.
 * - `REDIRECT_BLOCKED`: a request carrying a credential was answered with a redirect.
 * - `ORIGIN_REJECTED`: a url resolved outside the origins this client may call.
 * - `INVALID_ARGUMENT`: conduit was used wrong. Always a developer error.
 * - `DESTROYED`: the client was destroyed.
 * - `DUPLICATE_PLUGIN`: a plugin was installed twice.
 * - `EXTENSION_COLLISION`: a plugin tried to add a name the client already has.
 * - `UNKNOWN`: something threw that conduit cannot classify.
 */
export type ConduitErrorCode =
	| 'HTTP_STATUS'
	| 'NETWORK'
	| 'TIMEOUT'
	| 'ABORTED'
	| 'PARSE_FAILED'
	| 'VALIDATION_FAILED'
	| 'UNAUTHENTICATED'
	| 'REDIRECT_BLOCKED'
	| 'ORIGIN_REJECTED'
	| 'INVALID_ARGUMENT'
	| 'DESTROYED'
	| 'DUPLICATE_PLUGIN'
	| 'EXTENSION_COLLISION'
	| 'UNKNOWN'

/*
 *   TYPES
 ***************************************************************************************************/
export interface ConduitErrorInit {
	code: ConduitErrorCode
	message: string
	method?: string | undefined
	/** Already query-redacted. Build it with `formatErrorUrl`. */
	url?: string | undefined
	status?: number | undefined
	/** Which app or remote issued the request. Absent when conduit cannot attribute it. */
	owner?: string | undefined
	/** Set by the `requestId` plugin, so a failure can be matched to a server log line. */
	requestId?: string | undefined
	/** Response headers, when there was a response. Carries `Retry-After` and rate-limit hints. */
	headers?: Headers | undefined
	/** Decoded response body, when the failure came from a response conduit could read. */
	body?: unknown
	/** Milliseconds the server asked to wait, when the response carried `Retry-After`. */
	retryAfterMs?: number | undefined
	cause?: unknown
}

/** Log-safe projection. Omits `body`, which routinely carries user data. */
export interface ConduitErrorJson {
	name: string
	code: ConduitErrorCode
	message: string
	method: string | undefined
	url: string | undefined
	status: number | undefined
	owner: string | undefined
	requestId: string | undefined
}

/*
 *   ERROR
 ***************************************************************************************************/
export class ConduitError extends Error {
	public override readonly name: string = 'ConduitError'

	/** Cross-realm brand. Two bundles carrying their own copy break `instanceof`. */
	public readonly conduitError = true as const

	public readonly code: ConduitErrorCode
	public readonly method: string | undefined
	/** The request url with secret query values replaced, never the raw one. */
	public readonly url: string | undefined
	public readonly status: number | undefined
	/** The app or remote that issued the request, which the shared stack trace cannot say. */
	public readonly owner: string | undefined
	/** Milliseconds the server asked to wait, from `Retry-After`. The retry plugin fills it in. */
	public retryAfterMs: number | undefined
	/** The id the `requestId` plugin sent with the failing attempt. */
	public requestId: string | undefined
	/**
	 * Kept off {@link ConduitError.toJSON}, with `body`. Both can carry user
	 * data, so both are also non-enumerable: still readable directly, but
	 * absent from `{...error}`, `console.table`, and anything else that walks
	 * enumerable properties instead of naming them.
	 */
	declare readonly headers: Headers | undefined
	declare readonly body: unknown

	constructor(init: ConduitErrorInit) {
		super(init.message, init.cause === undefined ? undefined : { cause: init.cause })

		this.code = init.code
		this.method = init.method
		this.url = init.url
		this.status = init.status
		this.owner = init.owner
		this.retryAfterMs = init.retryAfterMs
		this.requestId = init.requestId

		Object.defineProperty(this, 'headers', { value: init.headers, configurable: true })
		Object.defineProperty(this, 'body', { value: init.body, configurable: true })
	}

	public toJSON(): ConduitErrorJson {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			method: this.method,
			url: this.url,
			status: this.status,
			owner: this.owner,
			requestId: this.requestId,
		}
	}
}

/*
 *   GUARDS
 ***************************************************************************************************/
/** Brand check rather than `instanceof`, so it holds across federation boundaries. */
export function isConduitError(value: unknown): value is ConduitError {
	return typeof value === 'object' && value !== null && 'conduitError' in value
}

/** Narrows to a specific failure mode. `isConduitError(e) && e.code === 'TIMEOUT'` in one call. */
export function isErrorCode<C extends ConduitErrorCode>(
	value: unknown,
	code: C,
): value is ConduitError & { code: C } {
	return isConduitError(value) && value.code === code
}

/*
 *   NORMALISE
 ***************************************************************************************************/
/**
 * Coerces anything thrown into a `ConduitError`. A conduit error passes through
 * untouched unless a `code` or `message` asks for a different one, and then it is
 * copied, with the original as its `cause`.
 */
export function toConduitError(
	value: unknown,
	code?: ConduitErrorCode,
	message?: string,
): ConduitError {
	if (isConduitError(value)) {
		if (code === undefined && message === undefined) {
			return value
		}

		return new ConduitError({
			code: code ?? value.code,
			message: message ?? value.message,
			method: value.method,
			url: value.url,
			status: value.status,
			owner: value.owner,
			requestId: value.requestId,
			headers: value.headers,
			body: value.body,
			cause: value,
		})
	}

	const detail = value instanceof Error ? value.message : String(value)

	return new ConduitError({
		code: code ?? 'UNKNOWN',
		message: message ?? detail,
		cause: value,
	})
}
