import type {
	ConduitPromise,
	HttpMethod,
	MethodOptions,
	RequestMethods,
	RequestOptions,
} from '../primitives/types'

/*
 *   EXECUTOR
 ***************************************************************************************************/
/** What a set of method helpers delegates to. The client and each scope supply their own. */
export type Executor = <T>(path: string, options: RequestOptions) => ConduitPromise<T>

/*
 *   OPTIONS
 ***************************************************************************************************/
/** Folds a positional body argument into options without ever setting `body: undefined`. */
export function bodyOptions(
	method: HttpMethod,
	body: unknown,
	options: MethodOptions | undefined,
): RequestOptions {
	return body === undefined ? { ...options, method } : { ...options, method, body }
}

/*
 *   FACTORY
 ***************************************************************************************************/
/**
 * Builds the shared verb surface, so a scope offers exactly what the client does.
 * The loose signatures here are what the typed `RequestMethods` compiles down to.
 */
export function createMethods(execute: Executor): RequestMethods {
	const methods = {
		request: <T>(path: string, options?: RequestOptions): ConduitPromise<T> =>
			execute<T>(path, options ?? {}),
		get: <T>(path: string, options?: MethodOptions): ConduitPromise<T> =>
			execute<T>(path, { ...options, method: 'GET' }),
		head: <T>(path: string, options?: MethodOptions): ConduitPromise<T> =>
			execute<T>(path, { ...options, method: 'HEAD' }),
		delete: <T>(path: string, options?: MethodOptions): ConduitPromise<T> =>
			execute<T>(path, { ...options, method: 'DELETE' }),
		post: <T>(path: string, body?: unknown, options?: MethodOptions): ConduitPromise<T> =>
			execute<T>(path, bodyOptions('POST', body, options)),
		put: <T>(path: string, body?: unknown, options?: MethodOptions): ConduitPromise<T> =>
			execute<T>(path, bodyOptions('PUT', body, options)),
		patch: <T>(path: string, body?: unknown, options?: MethodOptions): ConduitPromise<T> =>
			execute<T>(path, bodyOptions('PATCH', body, options)),
	}

	return methods
}
