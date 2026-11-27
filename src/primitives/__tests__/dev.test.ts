import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 *   IS_DEVELOPMENT FLAG
 ***************************************************************************************************/
describe('IS_DEVELOPMENT', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.resetModules()
	})

	it('is true when NODE_ENV is not production', async () => {
		vi.stubGlobal('process', { env: { NODE_ENV: 'development' } })

		const { IS_DEVELOPMENT } = await import('../dev')

		expect(IS_DEVELOPMENT).toBe(true)
	})

	it('is false when NODE_ENV is production', async () => {
		vi.stubGlobal('process', { env: { NODE_ENV: 'production' } })

		const { IS_DEVELOPMENT } = await import('../dev')

		expect(IS_DEVELOPMENT).toBe(false)
	})

	it('is true when NODE_ENV is unset', async () => {
		vi.stubGlobal('process', { env: {} })

		const { IS_DEVELOPMENT } = await import('../dev')

		expect(IS_DEVELOPMENT).toBe(true)
	})

	it('falls back to false when reading process throws, rather than a typeof guard', async () => {
		vi.stubGlobal('process', undefined)

		const { IS_DEVELOPMENT } = await import('../dev')

		expect(IS_DEVELOPMENT).toBe(false)
	})
})
