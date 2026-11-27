import { describe, expect, it, vi } from 'vitest'

import { createClient } from '../../client/core'
import { jsonResponse, stubFetch } from '../../__tests__/helpers'
import { cache } from '../cache'

const ok = (): Response => jsonResponse({ id: 1 })

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('cache', () => {
	it('serves a second read without touching the network', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/me')
		const second = await client.get('/me').response()

		expect(stub.calls).toHaveLength(1)
		expect(second.from).toBe('cache')
		expect(second.data).toEqual({ id: 1 })
	})

	it('refetches once the entry is no longer fresh', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache({ ttlMs: 0 }))

		await client.get('/me')
		await client.get('/me')

		expect(stub.calls).toHaveLength(2)
	})

	it('keeps different queries apart', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/things', { query: { page: 1 } })
		await client.get('/things', { query: { page: 2 } })

		expect(stub.calls).toHaveLength(2)
	})

	it('treats reordered query parameters as the same entry', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/things', { query: { a: 1, b: 2 } })
		await client.get('/things', { query: { b: 2, a: 1 } })

		expect(stub.calls).toHaveLength(1)
	})

	it('does not cache writes', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.post('/things', { a: 1 })
		await client.post('/things', { a: 1 })

		expect(stub.calls).toHaveLength(2)
	})

	it('respects a server that says not to store', async () => {
		const stub = stubFetch(
			() =>
				new Response('{"id":1}', {
					headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
				}),
		)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/me')
		await client.get('/me')

		expect(stub.calls).toHaveLength(2)
	})

	it('serves stale immediately and refreshes behind it', async () => {
		let version = 1
		const stub = stubFetch(() => jsonResponse({ version: version++ }))
		const client = createClient({ fetch: stub.fetch }).with(
			cache({ ttlMs: 0, staleMs: Infinity }),
		)

		expect(await client.get('/me')).toEqual({ version: 1 })

		const stale = await client.get('/me').response()
		expect(stale.from).toBe('stale')
		expect(stale.data).toEqual({ version: 1 })

		await flush()

		const refreshed = await client.get('/me').response()
		expect(refreshed.data).toEqual({ version: 2 })
	})

	it('runs one refresh, not one per reader', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			cache({ ttlMs: 0, staleMs: Infinity }),
		)

		await client.get('/me')
		await Promise.all([client.get('/me'), client.get('/me'), client.get('/me')])

		await flush()

		expect(stub.calls).toHaveLength(2)
	})

	it('keeps serving stale when the refresh fails', async () => {
		let calls = 0
		const stub = stubFetch(() => {
			calls++
			return calls === 1 ? jsonResponse({ id: 1 }) : jsonResponse({}, 500)
		})
		const client = createClient({ fetch: stub.fetch }).with(
			cache({ ttlMs: 0, staleMs: Infinity }),
		)

		await client.get('/me')

		await expect(client.get('/me')).resolves.toEqual({ id: 1 })
		await flush()
		await expect(client.get('/me')).resolves.toEqual({ id: 1 })
	})

	it('evicts the least recently used entry past the cap', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache({ max: 2 }))

		await client.get('/a')
		await client.get('/b')
		await client.get('/c')

		expect(client.getCacheSize()).toBe(2)

		await client.get('/a')
		expect(stub.calls).toHaveLength(4)
	})

	it('counts a read as recent use', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache({ max: 2 }))

		await client.get('/a')
		await client.get('/b')
		await client.get('/a')
		await client.get('/c')

		await client.get('/a')
		expect(stub.calls).toHaveLength(3)

		await client.get('/b')
		expect(stub.calls).toHaveLength(4)
	})

	it('drops one entry by key', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: '/api', fetch: stub.fetch }).with(cache())

		await client.get('/me')

		expect(client.invalidate(client.getKey('/me'))).toBe(true)
		expect(client.invalidate(client.getKey('/me'))).toBe(false)

		await client.get('/me')
		expect(stub.calls).toHaveLength(2)
	})

	it('drops every entry carrying a tag', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/users/1', { tags: ['user'] })
		await client.get('/users/2', { tags: ['user'] })
		await client.get('/settings', { tags: ['settings'] })

		expect(client.invalidateTag('user')).toBe(2)
		expect(client.getCacheSize()).toBe(1)
	})

	it('clears everything', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(cache())

		await client.get('/a')
		await client.get('/b')

		client.clearCache()

		expect(client.getCacheSize()).toBe(0)
	})

	it('freezes what it hands out, so one reader cannot corrupt another', async () => {
		const client = createClient({
			fetch: stubFetch(() => jsonResponse({ user: { name: 'Ada' } })).fetch,
		}).with(cache())

		const data = await client.get<{ user: { name: string } }>('/me')

		expect(() => {
			data.user.name = 'Grace'
		}).toThrow(TypeError)
	})

	it('reports hits, misses and invalidations', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(cache())
		const seen: string[] = []

		client.events.onAny(event => {
			if (event.type.startsWith('cache:')) {
				seen.push(event.type)
			}
		})

		await client.get('/me')
		await client.get('/me')
		client.clearCache()

		expect(seen).toEqual(['cache:miss', 'cache:hit', 'cache:invalidate'])
	})

	it('meta.cache "refresh" skips the read but still stores what comes back', async () => {
		let version = 1
		const stub = stubFetch(() => jsonResponse({ version: version++ }))
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/me')
		expect(stub.calls).toHaveLength(1)

		const refreshed = await client.get('/me', { meta: { cache: 'refresh' } }).response()

		expect(refreshed.from).toBe('network')
		expect(refreshed.data).toEqual({ version: 2 })
		expect(stub.calls).toHaveLength(2)

		const after = await client.get('/me').response()

		expect(after.from).toBe('cache')
		expect(after.data).toEqual({ version: 2 })
		expect(stub.calls).toHaveLength(2)
	})

	it('does not bypass entirely: "refresh" still respects cacheable', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.post('/things', { a: 1 }, { meta: { cache: 'refresh' } })

		expect(client.getCacheSize()).toBe(0)
	})

	it('writes a value directly and returns the previous one for rollback', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/me')

		const previous = client.setData<{ id: number }>(client.getKey('/me'), { id: 99 })

		expect(previous).toEqual({ id: 1 })

		const after = await client.get('/me').response()

		expect(after.from).toBe('cache')
		expect(after.data).toEqual({ id: 99 })
		expect(stub.calls).toHaveLength(1)
	})

	it('setData takes an updater and can create an entry that did not exist', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(cache())

		const previous = client.setData<{ id: number }>('GET /new', current => ({
			id: (current?.id ?? 0) + 1,
		}))

		expect(previous).toBeUndefined()
		expect(client.getCacheSize()).toBe(1)

		const created = client.setData<{ id: number }>('GET /new', current => ({
			id: (current?.id ?? 0) + 1,
		}))

		expect(created).toEqual({ id: 1 })
	})

	it('reports a cache:set event', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(cache())
		const seen = vi.fn()

		client.events.on('cache:set', seen)
		client.setData('GET /x', { id: 1 })

		expect(seen).toHaveBeenCalledOnce()
		expect(seen.mock.calls[0]?.[0]).toMatchObject({ key: 'GET /x', data: { id: 1 } })
	})

	it('reports a stale read separately from a hit', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			cache({ ttlMs: 0, staleMs: Infinity }),
		)
		const stale = vi.fn()

		client.events.on('cache:stale', stale)

		await client.get('/me')
		await client.get('/me')
		await flush()

		expect(stale).toHaveBeenCalledOnce()
		expect(stale.mock.calls[0]?.[0]).toMatchObject({ isRevalidating: true })
	})
})

describe('cache defaults', () => {
	// M3: tags used to switch caching on, so a tagged POST never reached the server twice
	it('does not store a tagged POST, since tags only label', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.post('/toggle', { x: 1 }, { tags: ['t'] })
		await client.post('/toggle', { x: 1 }, { tags: ['t'] })

		expect(stub.calls).toHaveLength(2)
		expect(client.getCacheSize()).toBe(0)
	})

	it('does not store a tagged DELETE either', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.delete('/things/1', { tags: ['things'] })
		await client.delete('/things/1', { tags: ['things'] })

		expect(stub.calls).toHaveLength(2)
	})

	it('stores a POST that says it reads, and lets its tag invalidate it', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())
		const search = { tags: ['search'], cacheable: true }

		await client.post('/search', { q: 'a' }, search)
		await client.post('/search', { q: 'a' }, search)
		expect(stub.calls).toHaveLength(1)

		client.invalidateTag('search')
		await client.post('/search', { q: 'a' }, search)
		expect(stub.calls).toHaveLength(2)
	})

	it('can turn caching off for a GET', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/live', { cacheable: false })
		await client.get('/live', { cacheable: false })

		expect(stub.calls).toHaveLength(2)
	})

	it('labels a stale answer apart from a fresh hit', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			cache({ ttlMs: 60_000, staleMs: Infinity }),
		)

		await client.get('/me')

		expect((await client.get('/me').response()).from).toBe('cache')
	})
})
