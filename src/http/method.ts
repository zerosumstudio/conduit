import type { HttpMethod } from '../primitives/types'

/*
 *   CACHEABLE
 ***************************************************************************************************/
const READ_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['GET', 'HEAD'])

/** Whether a request reads: what it says, else whether the method is `GET` or `HEAD`. */
export function isCacheable(method: HttpMethod, cacheable?: boolean): boolean {
	return cacheable ?? READ_METHODS.has(method)
}

/** Whether the method can carry no body at all. */
export function isBodyless(method: HttpMethod): boolean {
	return READ_METHODS.has(method)
}
