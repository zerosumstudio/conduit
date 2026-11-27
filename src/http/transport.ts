import { toAbortError } from './abort'
import type { OriginPolicy } from './origin'
import { createRequestError } from './redact'
import { isConduitError, type ConduitError } from '../primitives/errors'
import type {
	ConduitRequest,
	ConduitResponse,
	Next,
	ParseMode,
	ResolvedClientConfig,
} from '../primitives/types'

/*
 *   FETCH SHIM
 ***************************************************************************************************/
declare global {
	interface RequestInit {
		/**
		 * Required by the fetch spec when `body` is a `ReadableStream`. TS's DOM
		 * lib does not know this field yet, so it is declared here rather than
		 * left as a cast at the one place that needs it.
		 */
		duplex?: 'half'
	}
}

/*
 *   DECODE
 ***************************************************************************************************/
const EMPTY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304])

function resolveMode(response: Response, mode: ParseMode): Exclude<ParseMode, 'auto'> {
	if (mode !== 'auto') {
		return mode
	}

	if (EMPTY_STATUSES.has(response.status)) {
		return 'none'
	}

	const contentType = response.headers.get('content-type') ?? ''

	if (contentType.includes('json')) {
		return 'json'
	}

	if (contentType.startsWith('text/') || contentType.includes('xml')) {
		return 'text'
	}

	return contentType === '' ? 'text' : 'blob'
}

async function readAs(
	response: Response,
	mode: Exclude<ParseMode, 'auto' | 'none'>,
): Promise<unknown> {
	switch (mode) {
		case 'json': {
			const text = await response.text()

			return text === '' ? null : (JSON.parse(text) as unknown)
		}
		case 'text':
			return response.text()
		case 'blob':
			return response.blob()
		case 'arrayBuffer':
			return response.arrayBuffer()
		case 'formData':
			return response.formData()
	}
}

async function decodeBody(response: Response, request: ConduitRequest): Promise<unknown> {
	const mode = resolveMode(response, request.parse)

	if (mode === 'none') {
		return null
	}

	try {
		return await readAs(response, mode)
	} catch (cause) {
		// The signal can abort mid-read. That is a cancellation, not a body that failed to parse.
		if (request.signal.aborted) {
			throw toAbortError(request, cause)
		}

		throw createRequestError(
			request,
			'PARSE_FAILED',
			`returned a body that is not ${mode}. Set parse to match it.`,
			{ status: response.status, cause },
		)
	}
}

/**
 * Reads an error response, where a 503 carrying an HTML page under a JSON content
 * type must not become a parse failure and lose the status.
 */
async function decodeErrorBody(response: Response, request: ConduitRequest): Promise<unknown> {
	const mode = resolveMode(response, request.parse)

	if (mode === 'none') {
		return null
	}

	try {
		if (mode !== 'json') {
			return await readAs(response, mode)
		}

		const text = await response.text()

		if (text === '') {
			return null
		}

		try {
			return JSON.parse(text) as unknown
		} catch {
			return text
		}
	} catch {
		return undefined
	}
}

/*
 *   FAILURE MAPPING
 ***************************************************************************************************/
function toTransportError(cause: unknown, request: ConduitRequest): ConduitError {
	if (isConduitError(cause)) {
		return cause
	}

	const name = cause instanceof Error ? cause.name : ''

	if (name === 'TimeoutError') {
		return createRequestError(request, 'TIMEOUT', 'timed out.', { cause })
	}

	if (name === 'AbortError' || request.signal.aborted) {
		return toAbortError(request, cause)
	}

	return createRequestError(
		request,
		'NETWORK',
		'never reached a server. Check the network, DNS, CORS and TLS.',
		{ cause },
	)
}

/*
 *   REDIRECTS
 ***************************************************************************************************/
/** Credentials a platform strips itself when a redirect crosses origins. */
const STRIPPED_HEADERS: ReadonlySet<string> = new Set([
	'authorization',
	'cookie',
	'proxy-authorization',
])

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** Whether the request holds a credential that a redirect would carry to another origin. */
function carriesLooseCredential(request: ConduitRequest, config: ResolvedClientConfig): boolean {
	const names = [...config.credentialHeaders, ...(request.meta.credentialHeaders ?? [])]

	return names.some(name => !STRIPPED_HEADERS.has(name) && request.headers.has(name))
}

function isBlockedRedirect(response: Response): boolean {
	return response.type === 'opaqueredirect' || REDIRECT_STATUSES.has(response.status)
}

/**
 * Decides how a request treats redirects. A custom credential means `manual`,
 * unless the caller chose, and XHR cannot do `manual` at all, so it fails closed.
 */
function planRedirect(
	request: ConduitRequest,
	config: ResolvedClientConfig,
): { redirect: RequestRedirect | undefined; isGuarded: boolean } {
	const isCredentialed = carriesLooseCredential(request, config)
	const canBlock = request.meta.fetch === undefined

	if (!canBlock && request.credentials === 'omit') {
		throw createRequestError(
			request,
			'INVALID_ARGUMENT',
			"asks for credentials: 'omit', which XMLHttpRequest cannot honour. Drop onProgress or the option.",
		)
	}

	if (!canBlock && isCredentialed && request.redirect !== 'follow') {
		throw createRequestError(
			request,
			'INVALID_ARGUMENT',
			"sends a credential through XMLHttpRequest, which cannot refuse a redirect. Set redirect: 'follow', or drop onProgress.",
		)
	}

	const isGuarded = canBlock && isCredentialed && request.redirect === undefined

	return { redirect: isGuarded ? 'manual' : request.redirect, isGuarded }
}

/*
 *   TRANSPORT
 ***************************************************************************************************/
/** Request fields that go to fetch under their own names, when the request sets them. */
const PASSTHROUGH_FIELDS = [
	'credentials',
	'mode',
	'cache',
	'keepalive',
	'priority',
	'referrerPolicy',
	'integrity',
] as const

function buildInit(request: ConduitRequest): RequestInit {
	const init: RequestInit = {
		method: request.method,
		headers: request.headers,
		signal: request.signal,
	}

	if (request.body !== null) {
		init.body = request.body

		if (request.body instanceof ReadableStream) {
			init.duplex = 'half'
		}
	}

	for (const field of PASSTHROUGH_FIELDS) {
		if (request[field] !== undefined) {
			Object.assign(init, { [field]: request[field] })
		}
	}

	return init
}

/** The terminal handler: everything inside the onion ends here, at the network. */
export function createFetchTransport(config: ResolvedClientConfig, policy: OriginPolicy): Next {
	return async (request: ConduitRequest): Promise<ConduitResponse> => {
		// The last check, on whatever url the middleware stack ended up with.
		// What was checked is what is sent, never the string it came from.
		const target = policy.assertAllowed(request.url)
		const init = buildInit(request)
		const send = request.meta.fetch ?? config.fetch
		const { redirect, isGuarded } = planRedirect(request, config)

		if (redirect !== undefined) {
			init.redirect = redirect
		}

		let response: Response

		try {
			response = await send(target.href, init)
		} catch (cause) {
			throw toTransportError(cause, request)
		}

		if (isGuarded && isBlockedRedirect(response)) {
			throw createRequestError(
				request,
				'REDIRECT_BLOCKED',
				"was answered with a redirect while carrying a credential. Set redirect: 'follow' on the request if that is intended.",
				{ status: response.status, headers: response.headers },
			)
		}

		if (!response.ok) {
			throw createRequestError(
				request,
				'HTTP_STATUS',
				`failed with ${response.status} ${response.statusText}`.trimEnd(),
				{
					status: response.status,
					headers: response.headers,
					body: await decodeErrorBody(response, request),
				},
			)
		}

		return {
			status: response.status,
			headers: response.headers,
			data: await decodeBody(response, request),
			raw: response,
			from: 'network',
			attempt: request.meta.attempt ?? 1,
			request,
		}
	}
}
