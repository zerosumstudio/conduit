import type { Unsubscribe } from './events'

/*
 *   STORE
 ***************************************************************************************************/
/**
 * The framework seam. Every piece of changing state conduit exposes is one of
 * these, and `useSyncExternalStore` consumes the shape directly.
 */
export interface ReadableStore<T> {
	getState: () => T
	subscribe: (listener: (value: T) => void) => Unsubscribe
}

export interface WritableStore<T> extends ReadableStore<T> {
	set: (value: T) => void
	update: (recipe: (current: T) => T) => void
	/** How many listeners are attached. Lets an owner drop a store nobody is watching. */
	readonly listeners: number
}

const schedule: (task: () => void) => void =
	typeof queueMicrotask === 'function'
		? queueMicrotask
		: task => void Promise.resolve().then(task)

/**
 * A value with subscribers. `getState()` is always current, and only the fan-out is
 * batched onto a microtask, so one request settling is one render.
 */
export function createStore<T>(initial: T): WritableStore<T> {
	const listeners = new Set<(value: T) => void>()
	let value = initial
	let isScheduled = false

	const notify = (): void => {
		if (isScheduled || listeners.size === 0) {
			return
		}

		isScheduled = true

		schedule(() => {
			isScheduled = false
			const snapshot = value

			for (const listener of [...listeners]) {
				if (listeners.has(listener)) {
					listener(snapshot)
				}
			}
		})
	}

	return {
		getState: () => value,

		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},

		set: next => {
			if (Object.is(next, value)) {
				return
			}

			value = next
			notify()
		},

		update: recipe => {
			const next = recipe(value)

			if (Object.is(next, value)) {
				return
			}

			value = next
			notify()
		},

		get listeners(): number {
			return listeners.size
		},
	}
}
