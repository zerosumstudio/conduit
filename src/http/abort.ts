import { createRequestError, formatErrorUrl } from './redact'
import { ConduitError, isConduitError } from '../primitives/errors'
import type { ConduitRequest } from '../primitives/types'

/*
 *   ABORT
 ***************************************************************************************************/
export function toAbortError(request: ConduitRequest, cause?: unknown): ConduitError {
	const reason: unknown = request.signal.reason

	if (isConduitError(reason)) {
		// The reason keeps its own message and code: a timeout stays a timeout.
		return new ConduitError({
			code: reason.code,
			message: reason.message,
			method: request.method,
			url: formatErrorUrl(request),
			status: reason.status,
			owner: request.owner,
			cause: cause ?? reason,
		})
	}

	return createRequestError(request, 'ABORTED', 'was aborted.', { cause: cause ?? reason })
}
