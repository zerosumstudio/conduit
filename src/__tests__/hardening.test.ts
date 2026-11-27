import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../client/core'
import { defaults } from '../client/defaults'
import { clearSharedClients, sharedClient } from '../client/shared'
import { withRequest } from '../http/request'
import { createXhrFetch } from '../http/xhr'
import { apiVersion } from '../plugins/api-version'
import { cache } from '../plugins/cache'
import { observable } from '../plugins/observable'
import { session, type SessionAdapter } from '../plugins/session'
import type { ConduitRequest, FetchLike } from '../primitives/types'
import { uploadWithProgress } from '../upload'
import { jsonResponse, stubFetch } from './helpers'

interface User {
	id: string
	token: string
}

const ok: FetchLike = () => Promise.resolve(jsonResponse({ ok: true }))

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function bearer(request: ConduitRequest, user: User): ConduitRequest {
	const headers = new Headers(request.headers)

	headers.set('authorization', `Bearer ${user.token}`)

	return withRequest(request, { headers })
}

/** A server where alice's GET waits to be answered and everyone else's is answered at once. */
function profileServer(): {
	fetch: (url: string, init: RequestInit) => Promise<Response>
	calls: Array<{ auth: string | null; url: string }>
	answerAlice: () => void
} {
	const calls: Array<{ auth: string | null; url: string }> = []
	let release: (() => void) | undefined

	return {
		calls,
		answerAlice: () => release?.(),
		fetch: (url, init) => {
			const auth = new Headers(init.headers).get('authorization')

			calls.push({ auth, url })

			if (auth === 'Bearer alice') {
				return new Promise<Response>((resolve, reject) => {
					release = () => resolve(jsonResponse({ owner: 'alice', ssn: 'alice-PRIVATE' }))
					init.signal?.addEventListener('abort', () => {
						reject(init.signal?.reason as Error)
					})
				})
			}

			return Promise.resolve(jsonResponse({ owner: auth }))
		},
	}
}

function signedInClient(
	server: ReturnType<typeof profileServer>,
	who: { current: User },
	extra: Partial<SessionAdapter<User>> = {},
	channel?: string,
): ReturnType<typeof defaults<User>> {
	return defaults(createClient({ baseUrl: 'https://api.test', fetch: server.fetch }), {
		retry: false,
		session: {
			adapter: {
				load: () => Promise.resolve(who.current),
				identify: user => user.id,
				authorize: bearer,
				...extra,
			},
			...(channel === undefined ? {} : { channel }),
		},
	})
}

afterEach(() => {
	clearSharedClients()
	vi.useRealTimers()
})

// Fix 1: one user's data must never reach the next user's observed state
describe('observed state across an identity change', () => {
	it('drops the previous user’s late response after a reload to another user', async () => {
		const server = profileServer()
		const who = { current: { id: 'alice', token: 'alice' } }
		const api = signedInClient(server, who)

		await api.session.load()

		const key = api.getKey('/profile')
		const aliceRequest = api.get('/profile').safe()
		await settle()

		who.current = { id: 'bob', token: 'bob' }
		await api.session.reload()
		await api.get('/profile')

		server.answerAlice()

		expect((await aliceRequest).error?.code).toBe('ABORTED')
		await settle()

		expect(api.observe(key).getState().data).toEqual({ owner: 'Bearer bob' })
		expect(JSON.stringify(api.observe(key).getState())).not.toContain('alice-PRIVATE')
	})

	it('drops it after clear() followed by the next user’s read', async () => {
		const server = profileServer()
		const who = { current: { id: 'alice', token: 'alice' } }
		const api = signedInClient(server, who)

		await api.session.load()

		const key = api.getKey('/profile')
		const aliceRequest = api.get('/profile').safe()
		await settle()

		api.session.clear()
		who.current = { id: 'bob', token: 'bob' }
		await api.session.reload()
		await api.get('/profile')

		server.answerAlice()

		expect((await aliceRequest).error?.code).toBe('ABORTED')
		await settle()

		expect(JSON.stringify(api.observe(key).getState())).not.toContain('alice-PRIVATE')
		expect(api.observe(key).getState().data).toEqual({ owner: 'Bearer bob' })
	})

	it('drops it after a peer tab announces another user', async () => {
		const channels: Array<{ onmessage: ((message: { data: unknown }) => void) | null }> = []
		const original = globalThis.BroadcastChannel

		globalThis.BroadcastChannel = class {
			onmessage: ((message: { data: unknown }) => void) | null = null

			constructor() {
				channels.push(this)
			}

			postMessage(): void {}

			close(): void {}
		} as unknown as typeof BroadcastChannel

		try {
			const server = profileServer()
			const who = { current: { id: 'alice', token: 'alice' } }
			const api = signedInClient(server, who, {}, 'auth')

			await api.session.load()

			const key = api.getKey('/profile')
			const aliceRequest = api.get('/profile').safe()
			await settle()

			who.current = { id: 'bob', token: 'bob' }
			channels[0]?.onmessage?.({ data: { type: 'session:change' } })
			await settle()
			await api.get('/profile')

			server.answerAlice()

			expect((await aliceRequest).error?.code).toBe('ABORTED')
			await settle()

			expect(JSON.stringify(api.observe(key).getState())).not.toContain('alice-PRIVATE')
		} finally {
			globalThis.BroadcastChannel = original
		}
	})

	it('also drops a late write for a request nobody cancelled, by itself', async () => {
		let release: (() => void) | undefined
		let reset: (() => void) | undefined
		const client = createClient({
			baseUrl: 'https://api.test',
			fetch: () =>
				new Promise<Response>(resolve => {
					release = () => resolve(jsonResponse({ owner: 'alice' }))
				}),
		})
			.with(observable())
			.with({
				name: 'reset',
				onInit: ctx => {
					reset = () => {
						ctx.resetIdentity()
					}
				},
			})
		const key = client.getKey('/profile')
		const pending = client.get('/profile')

		reset?.()
		release?.()
		await pending

		expect(client.observe(key).getState().status).toBe('idle')
		expect(client.observe(key).getState().data).toBeUndefined()
	})

	it('does not cancel requests when the same user reloads', async () => {
		const server = profileServer()
		const who = { current: { id: 'alice', token: 'alice' } }
		const api = signedInClient(server, who)

		await api.session.load()

		const pending = api.get('/profile').safe()

		await api.session.reload()
		server.answerAlice()

		expect((await pending).error).toBeNull()
	})
})

// Fix 3: a request is only replayed for the user it was sent for
describe('a 401 that is still being recovered when the user changes', () => {
	it('rejects the old user’s request instead of replaying it with the new user’s credentials', async () => {
		let finishRenew: (() => void) | undefined
		const calls: Array<string | null> = []
		const who = { current: { id: 'alice', token: 'alice' } }
		const api = defaults(
			createClient({
				baseUrl: 'https://api.test',
				fetch: (_url, init) => {
					const auth = new Headers(init.headers).get('authorization')

					calls.push(auth)

					return Promise.resolve(
						auth === 'Bearer alice'
							? jsonResponse({}, 401)
							: jsonResponse({ transferred: true }),
					)
				},
			}),
			{
				retry: false,
				session: {
					adapter: {
						load: () => Promise.resolve(who.current),
						identify: user => user.id,
						authorize: bearer,
						renew: () =>
							new Promise<boolean>(resolve => {
								finishRenew = () => resolve(true)
							}),
					},
				},
			},
		)

		await api.session.load()

		const transfer = api.post('/transfer', { to: 'mallory' }).safe()

		await settle()
		who.current = { id: 'bob', token: 'bob' }
		await api.session.reload()
		finishRenew?.()

		const { error } = await transfer

		expect(error?.code).toBe('UNAUTHENTICATED')
		expect(error?.message).toContain('was not replayed')
		expect(calls).toEqual(['Bearer alice'])
	})
})

// Fix 4: redact only adds to what the guards treat as credentials
describe('the credential list behind the redirect and upload guards', () => {
	const redirect = (): Response =>
		new Response(null, { status: 302, headers: { location: 'https://evil.test/' } })

	it.each([
		['a list that leaves the default out', { headers: ['authorization'] }],
		['a list of something else', { headers: ['x-session-token'] }],
		['an empty list', { headers: [] }],
	])('still blocks a redirect for x-api-key with %s', async (_name, redact) => {
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-api-key': 'k' },
			redact,
			fetch: () => Promise.resolve(redirect()),
		})

		expect((await client.get('/x').safe()).error?.code).toBe('REDIRECT_BLOCKED')
	})

	it('still applies the upload guard with an empty redact list', async () => {
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-api-key': 'k' },
			redact: { headers: [] },
			fetch: ok,
		})

		const { error } = await uploadWithProgress(client, '/files', new Blob(['x']), {
			onProgress: () => {},
		}).safe()

		expect(error?.code).toBe('INVALID_ARGUMENT')
	})

	it('treats a header added through redact as a credential as well', async () => {
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-tenant-token': 't' },
			redact: { headers: ['x-tenant-token'] },
			fetch: () => Promise.resolve(redirect()),
		})

		expect((await client.get('/x').safe()).error?.code).toBe('REDIRECT_BLOCKED')
	})

	it('still lets redaction itself be narrowed, for what is displayed', async () => {
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-api-key': 'visible' },
			redact: { headers: ['authorization'] },
			fetch: ok,
		})

		const response = await client.get('/x').response()

		expect(response.request.headers.get('x-api-key')).toBe('visible')
	})
})

// Fix 5: a 1.0 bundle is never handed a 2.0 client
describe('the shared client registry', () => {
	it('keeps 2.0’s registry apart, so its clients are never returned', () => {
		const legacy = createClient({ fetch: ok })
		const registry = new Map([
			[
				'app.api',
				{
					client: legacy,
					conduitVersion: '2.0.0',
					contract: undefined,
					version: undefined,
				},
			],
		])
		const key = Symbol.for('conduit.sharedClients') as unknown as string

		;(globalThis as Record<string, unknown>)[key] = registry

		try {
			const logger = { warn: vi.fn(), error: vi.fn() }
			const fresh = sharedClient('app.api', () => createClient({ fetch: ok }), { logger })

			expect(fresh).not.toBe(legacy)
			expect(registry.get('app.api')?.client).toBe(legacy)
			expect(logger.warn).not.toHaveBeenCalled()
		} finally {
			Reflect.deleteProperty(globalThis, key)
		}
	})

	it('still shares between 1.x bundles', () => {
		const first = sharedClient('app.api', () => createClient({ fetch: ok }))

		expect(sharedClient('app.api', () => createClient({ fetch: ok }))).toBe(first)
	})
})

// Fix 6 and 7: what events and .response() show is worked out when they are read
describe('redaction in events', () => {
	it('hides a credential an adapter set in place, in settle and error events', async () => {
		const seen: Array<string | null> = []
		let fail = false
		const client = createClient({
			baseUrl: 'https://api.test',
			fetch: () => Promise.resolve(fail ? jsonResponse({}, 500) : jsonResponse({ ok: true })),
		}).with(
			session({
				adapter: {
					load: async () => ({ id: 'u', token: 'SESSION-CUSTOM' }),
					identify: user => user.id,
					authorize: (request, user) => {
						request.headers.set('x-custom-cred', user.token)

						return request
					},
				},
			}),
		)

		client.events.on('request:start', event =>
			seen.push(event.request.headers.get('x-custom-cred')),
		)
		client.events.on('request:settle', event =>
			seen.push(event.request.headers.get('x-custom-cred')),
		)
		client.events.on('request:error', event =>
			seen.push(event.request.headers.get('x-custom-cred')),
		)

		await client.session.load()
		await client.get('/a')
		fail = true
		await client.get('/b').safe()

		expect(seen.filter(value => value !== null)).toEqual(['[redacted]', '[redacted]'])
		expect(JSON.stringify(seen)).not.toContain('SESSION-CUSTOM')
	})

	it('hides query secrets in the key every event and .response() shows, but keeps the cache exact', async () => {
		const stub = stubFetch(() => jsonResponse({ ok: true }))
		const client = defaults(createClient({ baseUrl: 'https://api.test', fetch: stub.fetch }))
		const keys: string[] = []

		client.events.onAny(event => {
			if ('key' in event) {
				keys.push(event.key)
			}

			if ('request' in event) {
				keys.push(event.request.key)
			}
		})

		const first = await client.get('/x', { query: { token: 'SECRET', page: 2 } }).response()

		await client.get('/x', { query: { token: 'SECRET', page: 2 } })

		expect(first.request.key).not.toContain('SECRET')
		expect(first.request.key).toContain('page=2')
		expect(keys.length).toBeGreaterThan(3)
		expect(keys.join(' ')).not.toContain('SECRET')
		expect(stub.calls).toHaveLength(1)
	})
})

// Fix 2: a progress upload settles whatever the server answers
describe('a progress upload and a null-body status', () => {
	class FakeXhr extends EventTarget {
		static last: FakeXhr | undefined

		readonly upload = new EventTarget()
		status = 0
		statusText = ''
		response: unknown = null
		responseType = ''
		withCredentials = false

		constructor() {
			super()
			FakeXhr.last = this
		}

		open(): void {}
		setRequestHeader(): void {}
		getAllResponseHeaders(): string {
			return ''
		}

		send(): void {}
		abort(): void {}
	}

	const original = globalThis.XMLHttpRequest

	beforeEach(() => {
		globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
	})

	afterEach(() => {
		globalThis.XMLHttpRequest = original
	})

	it.each([204, 205, 304])('resolves a %d instead of hanging', async status => {
		const pending = createXhrFetch(() => {})('https://api.test/files', { method: 'POST' })

		FakeXhr.last!.status = status
		FakeXhr.last!.response = new Blob([])
		FakeXhr.last?.dispatchEvent(new Event('load'))

		const response = await Promise.race([
			pending,
			new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 200)),
		])

		expect(response).not.toBe('hung')
		expect((response as Response).status).toBe(status)
	})

	it('rejects, rather than hanging, when reading the response throws', async () => {
		const pending = createXhrFetch(() => {})('https://api.test/files', { method: 'POST' })

		FakeXhr.last!.status = 200
		FakeXhr.last!.getAllResponseHeaders = () => {
			throw new Error('headers are unreadable')
		}
		FakeXhr.last?.dispatchEvent(new Event('load'))

		await expect(pending).rejects.toThrow('headers are unreadable')
	})

	it('reaches the caller as a settled result through the client', async () => {
		const client = createClient({ baseUrl: 'https://api.test' })

		const pending = uploadWithProgress(client, '/files', new Blob(['x']), {
			onProgress: () => {},
		}).safe()

		await settle()
		FakeXhr.last!.status = 204
		FakeXhr.last?.dispatchEvent(new Event('load'))

		const result = await Promise.race([
			pending,
			new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 200)),
		])

		expect(result).not.toBe('hung')
	})
})

describe('smaller fixes', () => {
	it('sends apiVersion warnings through the client logger', async () => {
		const logger = { warn: vi.fn(), error: vi.fn() }
		const console_ = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const client = createClient({
			baseUrl: 'https://api.test',
			logger,
			fetch: () =>
				Promise.resolve(new Response('{}', { headers: { 'x-api-version': 'v2' } })),
		}).with(apiVersion({ expected: 'v1' }))

		await client.get('/x')

		expect(logger.warn).toHaveBeenCalledOnce()
		expect(console_).not.toHaveBeenCalled()
		console_.mockRestore()
	})

	it('refuses a null or boolean path param, which would have become /files/null', async () => {
		const client = createClient({ baseUrl: 'https://api.test', fetch: ok })

		for (const value of [null, false, {}]) {
			const { error } = await client
				.get('/files/:id', { params: { id: value as unknown as string } })
				.safe()

			expect(error?.code).toBe('INVALID_ARGUMENT')
		}
	})

	it('keeps the query of a path template out of param messages', async () => {
		const client = createClient({ baseUrl: 'https://api.test', fetch: ok })

		const template: string = '/users/:id?token=SECRET'
		const { error } = await client.get(template).safe()

		expect(error?.message).toContain('needs params')
		expect(error?.message).not.toContain('SECRET')
	})

	it('hints that a scheme-looking path needs a slash', async () => {
		const client = createClient({ baseUrl: 'https://api.test', fetch: ok })

		const { error } = await client.get('users:list').safe()

		expect(error?.code).toBe('ORIGIN_REJECTED')
		expect(error?.message).toContain('start it with a slash')
	})

	it('names the failed first read, and keeps the original as the cause', async () => {
		const client = createClient({ baseUrl: 'https://api.test', fetch: ok }).with(
			session({
				adapter: {
					load: () => Promise.reject(new Error('boom')),
					identify: () => 'x',
					authorize: request => request,
				},
			}),
		)

		const { error } = await client.get('/x').safe()

		expect(error?.message).toBe('The session could not be read: boom')
		expect((error?.cause as Error).message).toBe('boom')
	})

	it('refuses an adapter without identify at install', () => {
		expect(() =>
			session({
				adapter: { load: () => Promise.resolve(null) } as unknown as SessionAdapter<User>,
			}),
		).toThrow(/needs identify/)
	})

	it('fails closed for a progress upload that asks to omit credentials', async () => {
		const client = createClient({ baseUrl: 'https://api.test', fetch: ok })

		const { error } = await uploadWithProgress(client, '/files', new Blob(['x']), {
			credentials: 'omit',
			onProgress: () => {},
		}).safe()

		expect(error?.code).toBe('INVALID_ARGUMENT')
		expect(error?.message).toContain('cannot honour')
	})

	it('redacts the newly listed query names and headers', async () => {
		const client = createClient({
			baseUrl: 'https://api.test',
			fetch: () => Promise.resolve(jsonResponse({}, 500)),
		})

		const { error } = await client
			.get('/x', { query: { client_secret: 'S1', 'X-Goog-Signature': 'S2', jwt: 'S3' } })
			.safe()

		expect(error?.url).not.toMatch(/S[123]/)
	})

	it('stays quiet about a cache hit key with no query', async () => {
		const client = createClient({ baseUrl: 'https://api.test', fetch: ok }).with(cache())

		await client.get('/x')

		expect(client.getCacheSize()).toBe(1)
	})
})
