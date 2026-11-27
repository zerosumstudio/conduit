import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../client/core'
import { defaults } from '../client/defaults'
import { defineEndpoint } from '../client/endpoint'
import { clearSharedClients, sharedClient } from '../client/shared'
import { withRequest } from '../http/request'
import { cache } from '../plugins/cache'
import { retry } from '../plugins/retry'
import { session } from '../plugins/session'
import { timeout } from '../plugins/timeout'
import type { ConduitError } from '../primitives/errors'
import { hangingFetch, jsonResponse, stubFetch } from './helpers'

const ok = (): Response => jsonResponse({ ok: true })

const PAGE = 'http://localhost:3000'

afterEach(() => {
	clearSharedClients()
	vi.useRealTimers()
	vi.restoreAllMocks()
})

// H1 and SEC-2, N3, N4: the same spellings the QA and security passes sent, through a whole client
describe('origin bypass spellings, end to end', () => {
	const SPELLINGS = [
		'/\\evil.test/x',
		'\\/evil.test/x',
		'\\\\evil.test/x',
		' //evil.test/x',
		'/\t/evil.test/x',
		'\n//evil.test/x',
		'http:\\\\evil.test/x',
		'//evil.test/x',
		'http://evil.test/x',
		'data:text/plain,hi',
		'javascript:alert(1)',
		'blob:http://localhost:3000/abc',
		'file:///etc/passwd',
	]

	it.each(['', '/', '/api'])(
		'sends nothing to another host, with or without a session token, for baseUrl %j',
		async baseUrl => {
			const stub = stubFetch(ok)
			const client = createClient({
				baseUrl,
				fetch: stub.fetch,
				headers: { 'x-api-key': 'k' },
			}).with(
				session({
					adapter: {
						load: async () => ({ id: 'u' }),
						identify: user => user.id,
						authorize: (request, user) => {
							const headers = new Headers(request.headers)

							headers.set('authorization', `Bearer ${user.id}`)

							return withRequest(request, { headers })
						},
					},
				}),
			)

			await client.session.load()

			for (const spelling of SPELLINGS) {
				const { error } = await client.get(spelling).safe()

				if (error !== null) {
					expect(['ORIGIN_REJECTED', 'HTTP_STATUS'], spelling).toContain(error.code)
				}
			}

			for (const call of stub.calls) {
				expect(new URL(call.url).origin, call.url).toBe(PAGE)
			}
		},
	)
})

// M4
describe('dot segments', () => {
	it('rejects . and .. as path params before anything is sent', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: '/api', fetch: stub.fetch })

		for (const name of ['..', '.']) {
			const { error } = await client.get('/files/:name', { params: { name } }).safe()

			expect(error?.code).toBe('INVALID_ARGUMENT')
		}

		expect(stub.calls).toHaveLength(0)
	})

	it('keeps a request under the path of baseUrl however the dots are spelled', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: '/api/v1', fetch: stub.fetch })

		for (const path of ['/../admin', '/%2e%2e/admin', '/a/../../admin']) {
			expect((await client.get(path).safe()).error?.code, path).toBe('ORIGIN_REJECTED')
		}

		expect(stub.calls).toHaveLength(0)
	})
})

// L3
describe('a body on GET or HEAD', () => {
	it('is INVALID_ARGUMENT, not a NETWORK failure that retry would replay', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { retry: { baseDelayMs: 1 } })

		for (const method of ['GET', 'HEAD'] as const) {
			const { error } = await api.request('/x', { method, body: { a: 1 } }).safe()

			expect(error?.code).toBe('INVALID_ARGUMENT')
		}

		expect(stub.calls).toHaveLength(0)
	})

	it('is fine on DELETE', async () => {
		const stub = stubFetch(ok)

		await createClient({ fetch: stub.fetch }).request('/x', {
			method: 'DELETE',
			body: { a: 1 },
		})

		expect(stub.calls).toHaveLength(1)
	})
})

// L4
describe('a response function or schema that fails', () => {
	const failing = defineEndpoint<void, number>({
		method: 'GET',
		path: '/n',
		response: () => {
			throw new Error('shape is wrong')
		},
	})

	it('is VALIDATION_FAILED with the cause, the method and the url', async () => {
		const client = createClient({ baseUrl: 'https://api.test', fetch: stubFetch(ok).fetch })

		const { error } = await client.call(failing, undefined).safe()

		expect(error?.code).toBe('VALIDATION_FAILED')
		expect(error?.method).toBe('GET')
		expect(error?.url).toBe('https://api.test/n')
		expect((error?.cause as Error).message).toBe('shape is wrong')
	})

	it('carries the url on a schema failure too, with the issues as the body', async () => {
		const strict = defineEndpoint<void, number>({
			method: 'GET',
			path: '/n',
			response: {
				'~standard': {
					version: 1,
					vendor: 'test',
					validate: () => ({ issues: [{ message: 'expected a number' }] }),
				},
			},
		})
		const client = createClient({ baseUrl: 'https://api.test', fetch: stubFetch(ok).fetch })

		const { error } = await client.call(strict, undefined).safe()

		expect(error?.code).toBe('VALIDATION_FAILED')
		expect(error?.url).toBe('https://api.test/n')
		expect(error?.body).toEqual([{ message: 'expected a number' }])
	})
})

// L5
describe('origins', () => {
	it('normalises a trailing slash instead of never matching', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch, origins: ['https://cdn.test/'] })

		await client.get('https://cdn.test/x')

		expect(stub.calls).toHaveLength(1)
	})

	it.each(['https://cdn.test/path', 'cdn.test', 'ftp://cdn.test'])(
		'refuses %j at install, since a bad entry would silently never match',
		entry => {
			expect(() => createClient({ origins: [entry] })).toThrow(/not an origin/)
		},
	)
})

describe('a relative baseUrl without a page', () => {
	it('is INVALID_ARGUMENT on the first request, and an absolute one still works', async () => {
		const location = globalThis.location
		const documentRef = globalThis.document

		Object.defineProperty(globalThis, 'document', { value: undefined, configurable: true })
		Object.defineProperty(globalThis, 'location', { value: undefined, configurable: true })

		try {
			const relative = createClient({ baseUrl: '/api', fetch: stubFetch(ok).fetch })
			const absolute = createClient({
				baseUrl: 'https://api.test',
				fetch: stubFetch(ok).fetch,
			})

			expect((await relative.get('/x').safe()).error?.code).toBe('INVALID_ARGUMENT')
			await expect(absolute.get('/x')).resolves.toEqual({ ok: true })
		} finally {
			Object.defineProperty(globalThis, 'document', {
				value: documentRef,
				configurable: true,
			})
			Object.defineProperty(globalThis, 'location', { value: location, configurable: true })
		}
	})
})

// L6, N9
describe('events and redaction cost nothing without a listener', () => {
	it('is inactive under defaults(), which no longer listens to itself', () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))

		expect(api.events.active).toBe(false)

		const off = api.events.on('request:start', () => {})

		expect(api.events.active).toBe(true)

		off()
		expect(api.events.active).toBe(false)
	})

	it('builds no redacted copies until someone listens or asks for the response', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const define = vi.spyOn(Object, 'defineProperties')
		const redactions = (): number =>
			define.mock.calls.filter(([, descriptors]) => 'redactUrl' in descriptors).length

		await api.get('/x')

		expect(redactions()).toBe(0)

		const response = await api.get('/y').response()

		expect(redactions()).toBe(0)

		expect(response.request.headers.get('x-none')).toBeNull()

		expect(redactions()).toBeGreaterThan(0)
	})

	it('still tells observers about invalidations through the client, with no listener on the bus', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const key = api.getKey('/x')

		await api.get('/x')

		const seen: number[] = []
		const off = api.observe(key).subscribe(state => seen.push(state.invalidatedAt))

		api.invalidate(key)
		await Promise.resolve()
		off()

		expect(seen.length).toBeGreaterThan(0)
		expect(api.events.active).toBe(false)
	})
})

// L7
describe('hot reload', () => {
	it('does not let a stale module release the client a newer one registered', () => {
		let disposeOld: (() => void) | undefined

		const first = sharedClient('app.api', () => createClient({ fetch: stubFetch(ok).fetch }), {
			hot: {
				dispose: callback => {
					disposeOld = callback
				},
			},
		})

		first.destroy()

		const second = sharedClient('app.api', () => createClient({ fetch: stubFetch(ok).fetch }), {
			logger: { warn: () => {}, error: () => {} },
		})

		disposeOld?.()

		const third = sharedClient('app.api', () => createClient({ fetch: stubFetch(ok).fetch }))

		expect(third).toBe(second)
		expect(second.isDestroyed()).toBe(false)
	})

	it('still releases its own client when it is the one registered', () => {
		let dispose: (() => void) | undefined
		const client = sharedClient('app.api', () => createClient({ fetch: stubFetch(ok).fetch }), {
			hot: {
				dispose: callback => {
					dispose = callback
				},
			},
		})

		dispose?.()

		expect(client.isDestroyed()).toBe(true)
		expect(
			sharedClient('app.api', () => createClient({ fetch: stubFetch(ok).fetch })),
		).not.toBe(client)
	})
})

// L8, S3
describe('secrets in urls', () => {
	const query = {
		token: 'SECRET',
		access_token: 'SECRET2',
		'x-amz-signature': 'SECRET3',
		page: 2,
	}

	it('hides secret values on the error url, in toJSON and in messages, and keeps the rest', async () => {
		const client = createClient({
			baseUrl: 'https://api.test',
			fetch: stubFetch(() => jsonResponse({}, 500)).fetch,
		})

		const { error } = await client.get('/x', { query }).safe()

		expect(error?.url).toBe(
			'https://api.test/x?token=[redacted]&access_token=[redacted]&x-amz-signature=[redacted]&page=2',
		)
		expect(JSON.stringify(error)).not.toMatch(/SECRET/)
		expect(error?.message).not.toContain('token')
		expect(error?.message).toBe('GET https://api.test/x failed with 500')
	})

	it('hides them in events and on .response().request, while the pipeline keeps the real url', async () => {
		const client = createClient({ baseUrl: 'https://api.test', fetch: stubFetch(ok).fetch })
		const seen: string[] = []
		let real = ''

		client.with({
			name: 'watch',
			middleware: (request, next) => {
				real = request.url

				return next(request)
			},
		})
		client.events.on('request:start', event => seen.push(event.request.url))
		client.events.on('request:settle', event => seen.push(event.request.url))

		const response = await client.get('/x', { query }).response()

		expect(real).toContain('token=SECRET')
		expect(seen.every(url => !url.includes('SECRET'))).toBe(true)
		expect(response.request.url).not.toContain('SECRET')
		expect(response.request.url).toContain('page=2')
	})

	it('follows the configured list, and an empty one turns it off', async () => {
		const narrow = createClient({
			baseUrl: 'https://api.test',
			redact: { query: ['page'] },
			fetch: stubFetch(() => jsonResponse({}, 500)).fetch,
		})
		const off = createClient({
			baseUrl: 'https://api.test',
			redact: { query: [] },
			fetch: stubFetch(() => jsonResponse({}, 500)).fetch,
		})

		expect((await narrow.get('/x', { query }).safe()).error?.url).toContain('token=SECRET')
		expect((await narrow.get('/x', { query }).safe()).error?.url).toContain('page=[redacted]')
		expect((await off.get('/x', { query }).safe()).error?.url).toContain('token=SECRET')
	})

	it('keeps the query out of a timeout message too', async () => {
		vi.useFakeTimers()

		const client = createClient({
			baseUrl: 'https://api.test',
			fetch: hangingFetch().fetch,
		}).with(timeout({ ms: 50 }))

		const pending = client.get('/slow', { query: { token: 'SECRET' } }).safe()

		await vi.advanceTimersByTimeAsync(50)

		const { error } = await pending

		expect(error?.code).toBe('TIMEOUT')
		expect(error?.message).toBe('GET https://api.test/slow exceeded its 50ms timeout.')
		expect(error?.url).toBe('https://api.test/slow?token=[redacted]')
	})

	it('keeps the query out of an abort message', async () => {
		const controller = new AbortController()
		const client = createClient({ baseUrl: 'https://api.test', fetch: hangingFetch().fetch })

		const pending = client
			.get('/x', { query: { token: 'SECRET' }, signal: controller.signal })
			.safe()

		controller.abort()

		const { error } = await pending

		expect(error?.code).toBe('ABORTED')
		expect(`${error?.message} ${error?.url}`).not.toContain('SECRET')
	})
})

// L9
describe('Retry-After', () => {
	function limited(seconds: number): {
		client: ReturnType<typeof createClient>
		calls: () => number
	} {
		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++

				return Promise.resolve(
					calls === 1
						? new Response('', {
								status: 503,
								headers: { 'retry-after': String(seconds) },
							})
						: jsonResponse({ ok: true }),
				)
			},
		}).with(retry({ maxDelayMs: 5_000, jitter: false }))

		return { client, calls: () => calls }
	}

	it('is honoured up to maxRetryAfterMs, which is separate from the backoff ceiling', async () => {
		vi.useFakeTimers()

		const { client, calls } = limited(30)
		const pending = client.get('/x')

		await vi.advanceTimersByTimeAsync(30_000)

		await expect(pending).resolves.toEqual({ ok: true })
		expect(calls()).toBe(2)
	})

	it('gives up on a longer ask rather than clamping it', async () => {
		const { client, calls } = limited(120)

		expect((await client.get('/x').safe()).error?.retryAfterMs).toBe(120_000)
		expect(calls()).toBe(1)
	})

	it('lets maxRetryAfterMs be raised', async () => {
		vi.useFakeTimers()

		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++

				return Promise.resolve(
					calls === 1
						? new Response('', { status: 503, headers: { 'retry-after': '60' } })
						: jsonResponse({ ok: true }),
				)
			},
		}).with(retry({ maxRetryAfterMs: 90_000 }))

		const pending = client.get('/x')

		await vi.advanceTimersByTimeAsync(60_000)

		await expect(pending).resolves.toEqual({ ok: true })
	})

	it('replays a POST that says it reads, and still refuses a plain one', async () => {
		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++

				return Promise.resolve(jsonResponse({}, 503))
			},
		}).with(retry({ baseDelayMs: 1, attempts: 2 }))

		await client.post('/search', { q: 1 }, { cacheable: true }).safe()
		expect(calls).toBe(2)

		await client.post('/things', { q: 1 }).safe()
		expect(calls).toBe(3)
	})
})

describe('cacheable endpoints', () => {
	it('lets a POST endpoint opt into caching, with its tags still labelling', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())
		const search = defineEndpoint({
			method: 'POST',
			path: '/search',
			body: (vars: { q: string }) => vars,
			cacheable: true,
			tags: ['search'],
		})

		await client.call(search, { q: 'a' })
		await client.call(search, { q: 'a' })

		expect(stub.calls).toHaveLength(1)
		expect(client.invalidateTag('search')).toBe(1)
	})

	it('leaves an endpoint without it uncached even when it has tags', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())
		const write = defineEndpoint({ method: 'POST', path: '/write', tags: ['x'] })

		await client.call(write, undefined)
		await client.call(write, undefined)

		expect(stub.calls).toHaveLength(2)
	})
})

describe('the error code set', () => {
	it('names setup mistakes apart, as clutch does', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
		const codes: string[] = []

		const collect = (run: () => unknown): void => {
			try {
				run()
			} catch (error) {
				codes.push((error as ConduitError).code)
			}
		}

		client.with({ name: 'twice' })
		collect(() => client.with({ name: 'twice' }))
		collect(() => client.with({ name: 'collides', onInit: () => ({ get: 1 }) }))
		client.destroy()
		collect(() => client.scope('late'))

		expect(codes).toEqual(['DUPLICATE_PLUGIN', 'EXTENSION_COLLISION', 'DESTROYED'])
	})
})
