import { ConduitError } from '../primitives/errors'
import { createMethods, type Executor } from './methods'
import type { RequestMethods } from '../primitives/types'

/*
 *   TYPES
 ***************************************************************************************************/
/**
 * A cancellation boundary with the client's full request surface. Hand one to a
 * remote on mount and dispose it on unmount, and nothing it started outlives it.
 */
export interface Scope extends RequestMethods {
	readonly name: string
	/** The signal of the current generation. It changes each time {@link Scope.abort} runs. */
	readonly signal: AbortSignal
	/** Cancels everything in flight through this scope. The scope stays usable. */
	abort(reason?: string): void
	/** Cancels everything in flight and ends the scope for good. Safe to call twice. */
	dispose(): void
}

export interface ScopeInit {
	name: string
	createExecutor(getSignal: () => AbortSignal, owner: string): Executor
	onDispose(scope: Scope): void
}

/*
 *   CREATE
 ***************************************************************************************************/
export function createScope(init: ScopeInit): Scope {
	let controller = new AbortController()
	let isDisposed = false

	const cancel = (reason: string): void => {
		controller.abort(new ConduitError({ code: 'ABORTED', message: reason, owner: init.name }))
	}

	const scope: Scope = {
		...createMethods(init.createExecutor(() => controller.signal, init.name)),
		name: init.name,
		get signal(): AbortSignal {
			return controller.signal
		},
		abort(reason) {
			if (isDisposed) {
				return
			}

			cancel(reason ?? `Scope "${init.name}" was aborted.`)
			controller = new AbortController()
		},
		dispose() {
			if (isDisposed) {
				return
			}

			isDisposed = true
			cancel(`Scope "${init.name}" was disposed.`)
			init.onDispose(scope)
		},
	}

	return scope
}
