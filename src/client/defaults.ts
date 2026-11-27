import type { Client } from './core'
import { cache, type CacheApi, type CacheConfig } from '../plugins/cache'
import { dedupe, type DedupeApi } from '../plugins/dedupe'
import { observable, type ObservableApi, type ObservableConfig } from '../plugins/observable'
import { queue, type QueueApi, type QueueConfig } from '../plugins/queue'
import { retry, type RetryConfig } from '../plugins/retry'
import { session, type SessionApi, type SessionConfig } from '../plugins/session'
import { timeout, type TimeoutConfig } from '../plugins/timeout'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface DefaultsConfig {
	observable?: ObservableConfig | undefined
	cache?: CacheConfig | undefined
	queue?: QueueConfig | undefined
	/** `false` leaves retry out. */
	retry?: RetryConfig | false | undefined
	/** `false` leaves the timeout out. */
	timeout?: TimeoutConfig | false | undefined
}

export interface DefaultsWithSession<S> extends DefaultsConfig {
	session: SessionConfig<S>
}

export type DefaultClient = Client & ObservableApi & CacheApi & DedupeApi & QueueApi

/*
 *   PRESET
 ***************************************************************************************************/
/**
 * Installs the standard stack, in the order the layers need to be in.
 *
 * ```
 * observable → cache → dedupe → session → retry → queue → timeout → transport
 * ```
 *
 * Only `retry` and `timeout` can be left out. The rest add methods to the
 * client, so a preset that sometimes returned them would lie in its own type.
 * Compose `.with()` by hand for a stack this cannot express. Install
 * `requestId()` after this, so it sits innermost.
 *
 * ```ts
 * const api = defaults(createClient({ baseUrl: '/api' }), {
 * 	cache: { ttlMs: 30_000, staleMs: Infinity },
 * 	session: { adapter: mySessionAdapter },
 * })
 * ```
 */
export function defaults<S>(
	client: Client,
	config: DefaultsWithSession<S>,
): DefaultClient & SessionApi<S>
export function defaults(client: Client, config?: DefaultsConfig): DefaultClient
export function defaults(
	client: Client,
	config: DefaultsConfig & { session?: SessionConfig } = {},
): DefaultClient {
	let stack: Client = client
		.with(observable(config.observable))
		.with(cache(config.cache))
		.with(dedupe())

	if (config.session !== undefined) {
		stack = stack.with(session(config.session))
	}

	if (config.retry !== false) {
		stack = stack.with(retry(config.retry))
	}

	stack = stack.with(queue(config.queue))

	if (config.timeout !== false) {
		stack = stack.with(timeout(config.timeout))
	}

	return stack as DefaultClient
}
