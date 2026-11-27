import { CONDUIT_VERSION } from '../primitives/version'
import { consoleLogger, type ConduitLogger } from '../primitives/logger'

/*
 *   TYPES
 ***************************************************************************************************/
export interface HotContext {
	dispose(callback: () => void): void
}

export interface SharedClientConfig {
	/** The API version this bundle was built against. Compared, never reconciled. */
	apiVersion?: number | string | undefined
	/** This bundle's own expectation of the shared client's shape. */
	clientVersion?: number | undefined
	/** Routes disagreements somewhere other than the console. */
	onMismatch?: ((report: SharedMismatch) => void) | undefined
	/** Where the registry's own diagnostics go. Defaults to `console`. */
	logger?: ConduitLogger | undefined
	/**
	 * Tears the client down and deregisters it when this module is about to be
	 * replaced, so a reload during development gets a fresh client rather than
	 * a destroyed one wedged in the registry.
	 *
	 * ```ts
	 * sharedClient('acme.api', factory, { hot: import.meta.hot })
	 * ```
	 */
	hot?: HotContext | undefined
}

export type SharedMismatchKind = 'conduit-version' | 'api-version' | 'client-version'

export interface SharedMismatch {
	readonly key: string
	readonly kind: SharedMismatchKind
	readonly existing: string | number | undefined
	readonly joining: string | number | undefined
	readonly message: string
}

interface SharedEntry {
	client: unknown
	conduitVersion: string
	apiVersion: number | string | undefined
	clientVersion: number | undefined
}

/*
 *   REGISTRY
 ***************************************************************************************************/
// One registry per major, so a bundle never gets a client built by another major.
const REGISTRY_KEY = Symbol.for('conduit.sharedClients.1')

type SharedScope = typeof globalThis & {
	[REGISTRY_KEY]?: Map<string, SharedEntry>
}

function getRegistry(): Map<string, SharedEntry> {
	const scope = globalThis as SharedScope

	const existing = scope[REGISTRY_KEY]

	if (existing !== undefined) {
		return existing
	}

	const created = new Map<string, SharedEntry>()

	scope[REGISTRY_KEY] = created

	return created
}

/*
 *   LIVENESS
 ***************************************************************************************************/
interface Destroyable {
	isDestroyed?: () => boolean
	destroy?: () => void
}

/** Duck-typed, since two bundles shipping their own copy have separate class identities. */
function isSpent(client: unknown): boolean {
	const candidate = client as Destroyable | null

	return typeof candidate?.isDestroyed === 'function' && candidate.isDestroyed()
}

/*
 *   SHARED CLIENT
 ***************************************************************************************************/
/**
 * One client per key for the whole page, built by whoever asks first. A later
 * caller's factory never runs, so pass `apiVersion` and `clientVersion` to be
 * told when bundles disagree rather than finding out through a wrong response.
 *
 * ```ts
 * export const api = sharedClient(
 * 	'acme.api',
 * 	() => createClient({ baseUrl: '/api' }).with(cache()),
 * 	{ apiVersion: 'v1', clientVersion: 1 }
 * )
 * ```
 */
export function sharedClient<C>(key: string, factory: () => C, config: SharedClientConfig = {}): C {
	const logger = config.logger ?? consoleLogger
	const entries = getRegistry()
	const existing = entries.get(key)

	if (existing !== undefined && !isSpent(existing.client)) {
		reconcile(key, existing, config)

		return existing.client as C
	}

	if (existing !== undefined) {
		logger.warn(
			`[conduit] Shared client "${key}" was destroyed, so a new one was built. Call releaseSharedClient("${key}") when you destroy it.`,
		)
	}

	const client = factory()

	entries.set(key, {
		client,
		conduitVersion: CONDUIT_VERSION,
		apiVersion: config.apiVersion,
		clientVersion: config.clientVersion,
	})

	config.hot?.dispose(() => {
		// A newer module may have registered its own client under the key by now.
		if (getRegistry().get(key)?.client !== client) {
			return
		}

		const destroyable = client as Destroyable

		destroyable.destroy?.()
		releaseSharedClient(key)
	})

	return client
}

/** Reads a shared client without creating one. `undefined` if nobody has registered it, or it was destroyed. */
// The caller names the client type, the way response.json<T>() names a body.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function getSharedClient<C>(key: string): C | undefined {
	const existing = getRegistry().get(key)

	return existing !== undefined && !isSpent(existing.client) ? (existing.client as C) : undefined
}

/** Deregisters one key. Pair it with `destroy()`, or the next bundle gets the dead client. */
export function releaseSharedClient(key: string): boolean {
	return getRegistry().delete(key)
}

/** Empties the registry. For tests: in an app it strands whoever already holds a client. */
export function clearSharedClients(): void {
	getRegistry().clear()
}

/*
 *   RECONCILE
 ***************************************************************************************************/
function reconcile(key: string, existing: SharedEntry, config: SharedClientConfig): void {
	const logger = config.logger ?? consoleLogger

	const report = (
		kind: SharedMismatchKind,
		from: string | number | undefined,
		to: string | number | undefined,
		message: string,
	): void => {
		const mismatch: SharedMismatch = { key, kind, existing: from, joining: to, message }

		if (config.onMismatch !== undefined) {
			config.onMismatch(mismatch)

			return
		}

		logger.warn(`[conduit] ${message}`)
	}

	if (existing.conduitVersion !== CONDUIT_VERSION) {
		report(
			'conduit-version',
			existing.conduitVersion,
			CONDUIT_VERSION,
			`Shared client "${key}" was created by conduit ${existing.conduitVersion}, and this bundle ships ${CONDUIT_VERSION}. Align the versions, or share conduit as a singleton.`,
		)
	}

	if (config.apiVersion !== undefined && existing.apiVersion !== config.apiVersion) {
		report(
			'api-version',
			existing.apiVersion,
			config.apiVersion,
			`Shared client "${key}" was built against API ${String(existing.apiVersion)}, and this bundle expects ${String(config.apiVersion)}. Deploy the apps together.`,
		)
	}

	if (config.clientVersion !== undefined && existing.clientVersion !== config.clientVersion) {
		report(
			'client-version',
			existing.clientVersion,
			config.clientVersion,
			`Shared client "${key}" is version ${String(existing.clientVersion)}, and this bundle expects ${config.clientVersion}. The existing client stays in use. Deploy the apps together.`,
		)
	}
}
