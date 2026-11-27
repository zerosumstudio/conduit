import { ConduitError } from '../primitives/errors'

/*
 *   ENCODE
 ***************************************************************************************************/
export interface EncodedBody {
	readonly body: BodyInit | null
	/** Set only when conduit chose the encoding; a caller-supplied body keeps whatever it declares. */
	readonly contentType: string | undefined
}

const EMPTY: EncodedBody = { body: null, contentType: undefined }

/** Kinds that were never going to survive JSON, so trying only produces a confusing engine error. */
const UNENCODABLE: ReadonlySet<string> = new Set(['function', 'symbol', 'bigint'])

function isBodyInit(value: unknown): value is BodyInit {
	return (
		value instanceof Blob ||
		value instanceof FormData ||
		value instanceof URLSearchParams ||
		value instanceof ArrayBuffer ||
		value instanceof ReadableStream ||
		ArrayBuffer.isView(value)
	)
}

/** Anything the platform already accepts passes through untouched. Everything else is JSON. */
export function encodeBody(value: unknown): EncodedBody {
	if (value === undefined || value === null) {
		return EMPTY
	}

	if (typeof value === 'string') {
		return { body: value, contentType: undefined }
	}

	if (typeof value === 'object' && isBodyInit(value)) {
		return { body: value, contentType: undefined }
	}

	if (UNENCODABLE.has(typeof value)) {
		throw new ConduitError({
			code: 'INVALID_ARGUMENT',
			message: `A ${typeof value} cannot be a request body. Pass a plain value or a BodyInit.`,
		})
	}

	try {
		return { body: JSON.stringify(value), contentType: 'application/json' }
	} catch (cause) {
		throw new ConduitError({
			code: 'INVALID_ARGUMENT',
			message: 'The request body is not JSON-encodable. Remove the circular reference.',
			cause,
		})
	}
}
