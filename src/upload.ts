import type { Client } from './client/core'
import { createXhrFetch, type UploadProgressEvent } from './http/xhr'
import type { ConduitPromise, MethodOptions } from './primitives/types'

/*
 *   UPLOAD
 ***************************************************************************************************/
export type { UploadProgressEvent }

export interface UploadProgressOptions extends MethodOptions {
	/** Fires as the body is sent, which `fetch` has no way to report. */
	onProgress: (event: UploadProgressEvent) => void
}

/**
 * Posts a `FormData` or `Blob` with upload progress. It goes through
 * `XMLHttpRequest`, since `fetch` has no event for it, but still runs through
 * the client's middleware: session, retry, the queue and the origin check apply.
 *
 * `XMLHttpRequest` cannot refuse a redirect, so a request that carries a custom
 * credential header fails with `INVALID_ARGUMENT` unless it sets
 * `redirect: 'follow'`. Credentials in `Authorization` and cookies are fine.
 *
 * ```ts
 * await uploadWithProgress(api, '/files', form, { onProgress: e => setPercent(e.percent) })
 * ```
 */
export function uploadWithProgress<T = unknown>(
	client: Client,
	path: string,
	body: FormData | Blob,
	options: UploadProgressOptions,
): ConduitPromise<T> {
	const { onProgress, meta, ...rest } = options

	return client.upload<T>(path, body, {
		...rest,
		meta: { ...meta, fetch: createXhrFetch(onProgress) },
	})
}
