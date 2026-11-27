import { describe, expect, it } from 'vitest'

import { createClient } from '../../client/core'
import { defaults } from '../../client/defaults'
import { attachDevtools } from '../../devtools'
import { jsonResponse, stubFetch } from '../../__tests__/helpers'
import { cache } from '../cache'
import { requestId } from '../request-id'
import { retry } from '../retry'

const ok = (): Response => jsonResponse({ ok: true })

describe('requestId', () => {
	it('sends an id with every request, a uuid by default', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(requestId())

		await client.get('/a')
		await client.get('/b')

		const ids = stub.calls.map(call => new Headers(call.init.headers).get('x-request-id'))

		expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
		expect(ids[1]).not.toBe(ids[0])
	})

	it('names the header and the generator', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			requestId({ header: 'x-trace-id', generate: () => 'trace-1' }),
		)

		await client.get('/a')

		expect(new Headers(stub.calls[0]?.init.headers).get('x-trace-id')).toBe('trace-1')
	})

	it('keeps an id the caller already set, and reports that one', async () => {
		const stub = stubFetch(() => jsonResponse({}, 500))
		const client = createClient({ fetch: stub.fetch }).with(requestId())

		const { error } = await client.get('/a', { headers: { 'x-request-id': 'mine' } }).safe()

		expect(new Headers(stub.calls[0]?.init.headers).get('x-request-id')).toBe('mine')
		expect(error?.requestId).toBe('mine')
	})

	it('puts the id on a failure, in its JSON, and on the request a response carries', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({}, 500)).fetch }).with(
			requestId({ generate: () => 'req-9' }),
		)

		const { error } = await client.get('/a').safe()

		expect(error?.requestId).toBe('req-9')
		expect(error?.toJSON().requestId).toBe('req-9')

		const okClient = createClient({ fetch: stubFetch(ok).fetch }).with(
			requestId({ generate: () => 'req-10' }),
		)

		expect((await okClient.get('/a').response()).request.meta.requestId).toBe('req-10')
	})

	it('gives each retry attempt an id of its own, and reports the last', async () => {
		let n = 0
		const stub = stubFetch(() => jsonResponse({}, 503))
		const client = createClient({ fetch: stub.fetch })
			.with(retry({ attempts: 3, baseDelayMs: 1, jitter: false }))
			.with(requestId({ generate: () => `req-${++n}` }))

		const { error } = await client.get('/a').safe()

		expect(stub.calls.map(call => new Headers(call.init.headers).get('x-request-id'))).toEqual([
			'req-1',
			'req-2',
			'req-3',
		])
		expect(error?.requestId).toBe('req-3')
	})

	it('never reaches the cache key when it is installed last', async () => {
		const stub = stubFetch(ok)
		const client = defaults(createClient({ fetch: stub.fetch }), {
			cache: { ttlMs: 60_000 },
		}).with(requestId())

		await client.get('/a')
		await client.get('/a')

		expect(stub.calls).toHaveLength(1)
	})

	it('shows up on devtools entries', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({}, 500)).fetch })
			.with(cache())
			.with(requestId({ generate: () => 'req-d' }))
		const devtools = attachDevtools(client, { expose: false })

		await client.get('/a').safe()
		await new Promise(resolve => queueMicrotask(() => resolve(undefined)))

		expect(devtools.store.getState().entries[0]?.requestId).toBe('req-d')

		devtools.detach()
	})
})
