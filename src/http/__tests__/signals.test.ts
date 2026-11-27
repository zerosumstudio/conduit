import { describe, expect, it } from 'vitest'

import { composeSignals } from '../signals'

describe('composeSignals', () => {
	it('produces a never-aborting signal when given none', () => {
		expect(composeSignals([undefined, undefined]).aborted).toBe(false)
	})

	it('passes a lone signal straight through', () => {
		const controller = new AbortController()

		expect(composeSignals([controller.signal, undefined])).toBe(controller.signal)
	})

	it('aborts when any source aborts, carrying its reason', () => {
		const first = new AbortController()
		const second = new AbortController()
		const composed = composeSignals([first.signal, second.signal])

		second.abort('second went first')

		expect(composed.aborted).toBe(true)
		expect(composed.reason).toBe('second went first')
	})

	it('is already aborted when a source was aborted before composing', () => {
		const spent = new AbortController()

		spent.abort('gone')

		const composed = composeSignals([new AbortController().signal, spent.signal])

		expect(composed.aborted).toBe(true)
		expect(composed.reason).toBe('gone')
	})

	it('aborts with the reason of whichever source went first', () => {
		const first = new AbortController()
		const second = new AbortController()
		const composed = composeSignals([first.signal, second.signal])

		first.abort('one')
		second.abort('two')

		expect(composed.reason).toBe('one')
	})
})
