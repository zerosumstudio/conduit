import type { ConduitError } from '../primitives/errors'
import type { ResponseSource } from '../primitives/types'

/*
 *   QUERY STATE
 ***************************************************************************************************/
export type QueryStatus = 'idle' | 'loading' | 'success' | 'error'

export interface QueryState<T> {
	readonly status: QueryStatus
	readonly data: T | undefined
	readonly error: ConduitError | undefined
	/** Where the last answer came from. `stale` means it was served past its ttl while a refresh ran. */
	readonly from: ResponseSource | undefined
	/** A request for this key is in the air, whether or not there is already data. */
	readonly isFetching: boolean
	readonly updatedAt: number
	/** Bumped whenever a cache invalidation or identity reset targets this key. */
	readonly invalidatedAt: number
}

/** What a key that nothing has asked for yet, or a disabled query, reads as. */
export const IDLE_QUERY_STATE: QueryState<never> = {
	status: 'idle',
	data: undefined,
	error: undefined,
	from: undefined,
	isFetching: false,
	updatedAt: 0,
	invalidatedAt: 0,
}
