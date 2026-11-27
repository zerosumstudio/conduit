import { describe, expect, it } from 'vitest'

import { createClient } from '../client/core'
import { defaults } from '../client/defaults'
import { clearSharedClients, createMockServer, delay, networkError } from '../testing'

// M7: the mock ignored init.signal, so timeouts, aborts and scopes never reached it
describe('a mock server that is a real fetch', () => {
	it('lets a timeout cut a slow route, and frees the delay timer', async () => {
		const server = createMockServer()
		server.get('/slow', delay(5_000, { ok: true }))

		const api = defaults(createClient({ fetch: server.fetch }), {
			timeout: { ms: 30 },
			retry: false,
		})
		const started = Date.now()

		const { error } = await api.get('/slow').safe()

		expect(error?.code).toBe('TIMEOUT')
		expect(Date.now() - started).toBeLessThan(1_000)
	})

	it('rejects with the signal reason on abort, the way fetch does', async () => {
		const server = createMockServer()
		server.get('/slow', delay(5_000, { ok: true }))

		const controller = new AbortController()
		const pending = server.fetch('http://localhost:3000/slow', { signal: controller.signal })

		controller.abort(new Error('stop'))

		await expect(pending).rejects.toThrow('stop')
	})

	it('rejects at once for a signal that was already aborted', async () => {
		const server = createMockServer()
		server.get('/x', { ok: true })

		await expect(
			server.fetch('http://localhost:3000/x', {
				signal: AbortSignal.abort(new Error('early')),
			}),
		).rejects.toThrow('early')
	})

	it('hands the responder the signal, so it can stop what it started', async () => {
		const server = createMockServer()
		const seen: boolean[] = []

		server.get('/watch', request => {
			request.signal.addEventListener('abort', () => seen.push(true))

			return new Promise(() => {})
		})

		const client = createClient({ fetch: server.fetch })
		const scope = client.scope('remote')
		const pending = scope.get('/watch').safe()

		await new Promise(resolve => setTimeout(resolve, 5))
		scope.abort('unmounted')

		expect((await pending).error?.code).toBe('ABORTED')
		expect(seen).toEqual([true])
	})

	it('cancels a mock request with a scope, as it would a real one', async () => {
		const server = createMockServer()
		server.get('/slow', delay(5_000, { ok: true }))

		const client = createClient({ fetch: server.fetch })
		const scope = client.scope('remote')
		const pending = scope.get('/slow').safe()

		scope.dispose()

		expect((await pending).error?.code).toBe('ABORTED')
	})
})

// L12
describe('mock responses and requests', () => {
	it('answers a string as text, not JSON', async () => {
		const server = createMockServer()
		server.get('/note', 'hello')

		const response = await createClient({ fetch: server.fetch }).get('/note').response()

		expect(response.headers.get('content-type')).toMatch(/^text\/plain/)
		expect(response.data).toBe('hello')
	})

	it('answers undefined as 204, and the other body types as themselves', async () => {
		const server = createMockServer()
		server.get('/none', undefined)
		server.get('/params', new URLSearchParams({ a: '1' }))
		server.get('/bytes', new Uint8Array([1, 2]).buffer)

		const client = createClient({ fetch: server.fetch })

		expect((await client.get('/none').response()).status).toBe(204)
		expect((await client.get('/params').response()).headers.get('content-type')).toMatch(
			/x-www-form-urlencoded/,
		)
		expect(await client.get('/bytes', { parse: 'arrayBuffer' })).toBeInstanceOf(ArrayBuffer)
	})

	it('still answers other values as JSON, and returned errors as network failures', async () => {
		const server = createMockServer()
		server.get('/obj', { a: 1 })
		server.get('/list', [1, 2])
		server.get('/down', networkError())

		const client = createClient({ fetch: server.fetch })

		await expect(client.get('/obj')).resolves.toEqual({ a: 1 })
		await expect(client.get('/list')).resolves.toEqual([1, 2])
		expect((await client.get('/down').safe()).error?.code).toBe('NETWORK')
	})

	it('answers a responder that throws with a 500 carrying the message, not a network failure', async () => {
		const server = createMockServer()
		server.get('/boom', () => {
			throw new Error('responder broke')
		})
		server.get('/boom-async', () => Promise.reject(new Error('async broke')))

		const client = createClient({ fetch: server.fetch })
		const first = await client.get('/boom').safe()
		const second = await client.get('/boom-async').safe()

		expect(first.error?.code).toBe('HTTP_STATUS')
		expect(first.error?.status).toBe(500)
		expect(first.error?.body).toEqual({ message: 'responder broke' })
		expect(second.error?.body).toEqual({ message: 'async broke' })
	})

	it('derives the content type from the body, as fetch does', async () => {
		const server = createMockServer()
		server.post('/echo', { ok: true })

		const client = createClient({ fetch: server.fetch })

		await client.post('/echo', 'plain text')
		await client.post('/echo', new URLSearchParams({ a: '1' }))
		await client.post('/echo', { json: true })

		const types = server.calls.map(call => call.headers.get('content-type'))

		expect(types[0]).toBe('text/plain;charset=UTF-8')
		expect(types[1]).toMatch(/^application\/x-www-form-urlencoded/)
		expect(types[2]).toBe('application/json')
	})

	it('reports urls as absolute, and matches the pathname under an absolute base url', async () => {
		const server = createMockServer({ baseUrl: 'https://api.test/v1' })
		server.get('/users/:id', request => ({ url: request.url, path: request.path }))

		const client = createClient({ baseUrl: 'https://api.test/v1', fetch: server.fetch })

		await expect(
			client.get('/users/:id', { params: { id: 3 }, query: { a: 1 } }),
		).resolves.toEqual({
			url: 'https://api.test/v1/users/3?a=1',
			path: '/v1/users/3',
		})
		expect(server.calls[0]).toMatchObject({
			url: 'https://api.test/v1/users/3?a=1',
			path: '/v1/users/3',
		})
	})

	it('pins the origin of an absolute base url', async () => {
		const server = createMockServer({ baseUrl: 'https://api.test', onUnmatched: 'notFound' })
		server.get('/x', { ok: true })

		const client = createClient({
			baseUrl: 'https://api.test',
			origins: ['https://other.test'],
			fetch: server.fetch,
		})

		await expect(client.get('/x')).resolves.toEqual({ ok: true })
		expect((await client.get('https://other.test/x').safe()).error?.status).toBe(404)
	})

	it('lets the last registered route win, and a used-up one fall through', async () => {
		const server = createMockServer()
		server.get('/x', { from: 'default' })
		server.get('/x', { from: 'override' }, { times: 1 })

		const client = createClient({ fetch: server.fetch })

		await expect(client.get('/x')).resolves.toEqual({ from: 'override' })
		await expect(client.get('/x')).resolves.toEqual({ from: 'default' })
	})

	it('lists the routes in match order when nothing matches', async () => {
		const server = createMockServer()
		server.get('/a', {})
		server.get('/b', {})

		const { error } = await createClient({ fetch: server.fetch }).get('/c').safe()

		expect(error?.code).toBe('INVALID_ARGUMENT')
		expect(error?.message).toMatch(/GET \/b, GET \/a/)
	})

	it('exports clearSharedClients, which moved here from the root', () => {
		expect(typeof clearSharedClients).toBe('function')
	})
})
