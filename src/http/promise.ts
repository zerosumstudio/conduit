import { toConduitError } from '../primitives/errors'
import type { ConduitPromise, ConduitResponse, SafeResult } from '../primitives/types'

const swallow = (): void => {}

/*
 *   CONDUIT PROMISE
 ***************************************************************************************************/
/**
 * `view` shapes the record `.response()` hands out, so work like redaction is
 * only done for callers that ask for it.
 */
export function createConduitPromise<T>(
	run: Promise<ConduitResponse<T>>,
	view: (response: ConduitResponse<T>) => ConduitResponse<T> = response => response,
): ConduitPromise<T> {
	const promise = run.then(response => response.data) as ConduitPromise<T>

	promise.response = (): Promise<ConduitResponse<T>> => {
		promise.catch(swallow)

		return run.then(view)
	}

	promise.safe = (): Promise<SafeResult<T>> => {
		promise.catch(swallow)

		return run.then(
			(response): SafeResult<T> => ({ data: response.data, error: null }),
			(error: unknown): SafeResult<T> => ({ data: null, error: toConduitError(error) }),
		)
	}

	return promise
}
