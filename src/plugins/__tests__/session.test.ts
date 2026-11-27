import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../client/core'
import { defaults } from '../../client/defaults'
import { withRequest } from '../../http/request'
import type { ConduitRequest } from '../../primitives/types'
import { hangingFetch, jsonResponse, stubFetch } from '../../__tests__/helpers'
import { cache } from '../cache'
import { session, type SessionAdapter } from '../session'

interface User {
	name: string
}

const ok = (): Response => jsonResponse({ ok: true })

/** A cookie-style adapter: it reads the session and sends nothing itself. */
function cookieAdapter(load: () => Promise<User | null>): SessionAdapter<User> {
	return { load, identify: user => user.name }
}

function bearer(request: ConduitRequest, user: User): ConduitRequest {
	const headers = new Headers(request.headers)

	headers.set('authorization', `Bearer ${user.name}`)

	return withRequest(request, { headers })
}

/** A token-style adapter: it attaches an Authorization header. */
function tokenAdapter(overrides: Partial<SessionAdapter<User>> = {}): SessionAdapter<User> {
	return {
		load: () => Promise.resolve({ name: 'Ada' }),
		identify: user => user.name,
		authorize: bearer,
		...overrides,
	}
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const unauthorised = (): Response => jsonResponse({}, 401)

describe('session loading', () => {
	it('starts out knowing nothing, rather than guessing', () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(async () => ({ name: 'Ada' })) }),
		)

		expect(client.session.getState().status).toBe('unknown')
	})

	it('loads once for however many callers ask at once', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(load) }),
		)

		const results = await Promise.all([
			client.session.load(),
			client.session.load(),
			client.session.load(),
		])

		expect(load).toHaveBeenCalledOnce()
		expect(results).toEqual([{ name: 'Ada' }, { name: 'Ada' }, { name: 'Ada' }])
		expect(client.session.getState().status).toBe('authenticated')
	})

	it('answers from what it already knows, signed in or not', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(load) }),
		)

		await client.session.load()
		await client.session.load()

		expect(load).toHaveBeenCalledOnce()
	})

	it('re-reads on demand', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(load) }),
		)

		await client.session.load()
		await client.session.reload()

		expect(load).toHaveBeenCalledTimes(2)
	})

	it('treats a null session as signed out, not as a failure', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(async () => null) }),
		)

		await client.session.load()

		expect(client.session.getState()).toMatchObject({
			status: 'anonymous',
			session: null,
			error: null,
		})
	})

	it('keeps a load failure separate from being signed out', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: cookieAdapter(async () => {
					throw new Error('network down')
				}),
			}),
		)

		await expect(client.session.load()).rejects.toMatchObject({ code: 'UNKNOWN' })

		expect(client.session.getState().status).toBe('error')
		expect(client.session.getState().session).toBeNull()
	})

	it('keeps the previous session when a reload fails for a non-auth reason', async () => {
		let fail = false
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: cookieAdapter(async () => {
					if (fail) {
						throw new Error('blip')
					}

					return { name: 'Ada' }
				}),
			}),
		)

		await client.session.load()
		fail = true
		await expect(client.session.reload()).rejects.toThrow()

		expect(client.session.getState()).toMatchObject({
			status: 'error',
			session: { name: 'Ada' },
		})
	})

	it('loads on install when autoLoad is on', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))

		createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(load), autoLoad: true }),
		)

		await settle()

		expect(load).toHaveBeenCalledOnce()
	})

	it('notifies subscribers and stops when they leave', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(async () => ({ name: 'Ada' })) }),
		)
		const seen: string[] = []
		const off = client.session.subscribe(state => seen.push(state.status))

		await client.session.load()
		off()
		client.session.clear()

		expect(seen).toEqual(['loading', 'authenticated'])
	})

	it('keeps going when a subscriber throws, and says so', async () => {
		const logger = { warn: vi.fn(), error: vi.fn() }
		const client = createClient({ fetch: stubFetch(ok).fetch, logger }).with(
			session({ adapter: cookieAdapter(async () => ({ name: 'Ada' })) }),
		)
		const seen: string[] = []

		client.session.subscribe(() => {
			throw new Error('bad listener')
		})
		client.session.subscribe(state => seen.push(state.status))

		await client.session.load()

		expect(seen).toEqual(['loading', 'authenticated'])
		expect(logger.error).toHaveBeenCalled()
	})

	it('reads the session through the pipeline without recursing into itself', async () => {
		const stub = stubFetch(() => jsonResponse({ name: 'Ada' }))
		const client = createClient({ baseUrl: '/api', fetch: stub.fetch }).with(
			session({
				adapter: {
					load: async ctx => ctx.request<User>('/auth/session'),
					identify: user => user.name,
				},
			}),
		)

		await expect(client.session.load()).resolves.toEqual({ name: 'Ada' })
		expect(stub.calls).toHaveLength(1)
	})
})

describe('authorized requests', () => {
	it('attaches credentials and waits for the session to be known first', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			session({ adapter: tokenAdapter() }),
		)

		await client.get('/a')

		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBe('Bearer Ada')
	})

	it('does not make a cookie-style adapter wait on anything', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(load) }),
		)

		await client.get('/a')

		expect(load).not.toHaveBeenCalled()
	})

	it('sends nothing for a session that found nobody, and never calls authorize', async () => {
		const authorize = vi.fn(bearer)
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			session({ adapter: tokenAdapter({ load: async () => null, authorize }) }),
		)

		await client.get('/a')

		expect(authorize).not.toHaveBeenCalled()
		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBeNull()
	})

	it('marks what authorize added as credentials, so they read as redacted', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: tokenAdapter({
					authorize: (request, user) => {
						const headers = new Headers(request.headers)

						headers.set('x-session-token', user.name)

						return withRequest(request, { headers })
					},
				}),
			}),
		)

		const response = await client.get('/a').response()

		expect(response.request.headers.get('x-session-token')).toBe('[redacted]')
		expect(response.request.meta.credentialHeaders).toEqual(['x-session-token'])
	})
})

// M2: a failed first read used to send the request with no credentials, then sign the user out
describe('a token adapter whose first read fails', () => {
	it('rejects the request with the load error instead of sending it unauthorised', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			session({
				adapter: tokenAdapter({
					load: async () => {
						throw new Error('session store is down')
					},
				}),
			}),
		)

		const { error } = await client.get('/a').safe()

		expect(error?.code).toBe('UNKNOWN')
		expect(error?.message).toBe('The session could not be read: session store is down')
		expect(stub.calls).toHaveLength(0)
		expect(client.session.getState().status).toBe('error')
	})

	it('does not clear the session, so a later request can recover', async () => {
		let fail = true
		const onClear = vi.fn()
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			session({
				adapter: tokenAdapter({
					load: async () => {
						if (fail) {
							throw new Error('blip')
						}

						return { name: 'Ada' }
					},
					onClear,
				}),
			}),
		)

		await client.get('/a').safe()
		fail = false

		await expect(client.get('/b')).resolves.toEqual({ ok: true })
		expect(onClear).not.toHaveBeenCalled()
		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBe('Bearer Ada')
	})

	it('keeps authorizing with the previous session when a later read fails', async () => {
		let fail = false
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			session({
				adapter: tokenAdapter({
					load: async () => {
						if (fail) {
							throw new Error('blip')
						}

						return { name: 'Ada' }
					},
				}),
			}),
		)

		await client.session.load()
		fail = true
		await client.session.reload().catch(() => {})

		await client.get('/a')

		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBe('Bearer Ada')
	})
})

// H2: a 401 on an anonymous session, a bad login for one, used to brick the client
describe('a 401 without credentials', () => {
	it('is an ordinary HTTP_STATUS and never ends anything', async () => {
		const onUnauthenticated = vi.fn()
		const stub = stubFetch(({ url }) =>
			url.endsWith('/login') ? unauthorised() : jsonResponse({ public: true }),
		)
		const client = createClient({ fetch: stub.fetch }).with(
			session({ adapter: cookieAdapter(async () => null), onUnauthenticated }),
		)

		await client.session.load()

		expect((await client.post('/login', { pw: 'x' }).safe()).error?.code).toBe('HTTP_STATUS')
		expect((await client.post('/login', { pw: 'y' }).safe()).error?.code).toBe('HTTP_STATUS')
		await expect(client.get('/public')).resolves.toEqual({ public: true })

		expect(stub.calls).toHaveLength(3)
		expect(onUnauthenticated).not.toHaveBeenCalled()
		expect(client.session.getState().status).toBe('anonymous')
	})

	it('is not a lost session while the session is still unknown either', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({ fetch: () => Promise.resolve(unauthorised()) }).with(
			session({ adapter: cookieAdapter(async () => ({ name: 'Ada' })), onUnauthenticated }),
		)

		await client.get('/a').safe()

		expect(onUnauthenticated).not.toHaveBeenCalled()
		expect(client.session.getState().status).toBe('unknown')
	})

	it('can opt a sign-in call out with meta.session: bypass, even when signed in', async () => {
		const onUnauthenticated = vi.fn()
		const stub = stubFetch(unauthorised)
		const client = createClient({ fetch: stub.fetch }).with(
			session({ adapter: tokenAdapter(), onUnauthenticated }),
		)

		await client.session.load()

		const { error } = await client.post('/refresh', {}, { meta: { session: 'bypass' } }).safe()

		expect(error?.code).toBe('HTTP_STATUS')
		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBeNull()
		expect(onUnauthenticated).not.toHaveBeenCalled()
		expect(client.session.getState().status).toBe('authenticated')
	})
})

describe('a lost session', () => {
	it('hands over once, however many requests fail together', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({ fetch: () => Promise.resolve(unauthorised()) }).with(
			session({ adapter: tokenAdapter(), onUnauthenticated }),
		)

		await client.session.load()

		await Promise.all([
			client.get('/a').safe(),
			client.get('/b').safe(),
			client.get('/c').safe(),
		])

		expect(onUnauthenticated).toHaveBeenCalledOnce()
		expect(client.session.getState()).toMatchObject({ status: 'anonymous', session: null })
		expect(client.session.getState().error?.code).toBe('UNAUTHENTICATED')
	})

	// L1: the trigger and what was in flight used to reject ABORTED, which isErrorCode(e, 'UNAUTHENTICATED') missed
	it('rejects the trigger and what was in flight with UNAUTHENTICATED, not ABORTED', async () => {
		const client = createClient({
			fetch: (url, init) =>
				url.endsWith('/dead')
					? Promise.resolve(unauthorised())
					: hangingFetch().fetch(url, init),
		}).with(session({ adapter: tokenAdapter() }))

		await client.session.load()

		const hanging = client.get('/hanging').safe()
		const trigger = await client.get('/dead').safe()

		expect(trigger.error?.code).toBe('UNAUTHENTICATED')
		expect(trigger.error?.status).toBe(401)
		expect((await hanging).error?.code).toBe('UNAUTHENTICATED')
	})

	it('leaves requests that carried no credentials alone', async () => {
		const client = createClient({
			fetch: (url, init) =>
				url.endsWith('/dead')
					? Promise.resolve(unauthorised())
					: hangingFetch().fetch(url, init),
		}).with(session({ adapter: tokenAdapter() }))

		await client.session.load()

		const controller = new AbortController()
		const outside = client
			.get('/public', { meta: { session: 'bypass' }, signal: controller.signal })
			.safe()

		await client.get('/dead').safe()
		controller.abort()

		expect((await outside).error?.code).toBe('ABORTED')
	})

	it('leaves an ordinary failure alone', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({ fetch: () => Promise.resolve(jsonResponse({}, 500)) }).with(
			session({ adapter: tokenAdapter(), onUnauthenticated }),
		)

		await client.session.load()

		expect((await client.get('/a').safe()).error?.status).toBe(500)
		expect(onUnauthenticated).not.toHaveBeenCalled()
	})

	it('does not treat a 403 as a lost session by default', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({ fetch: () => Promise.resolve(jsonResponse({}, 403)) }).with(
			session({ adapter: tokenAdapter(), onUnauthenticated }),
		)

		await client.session.load()
		await client.get('/a').safe()

		expect(onUnauthenticated).not.toHaveBeenCalled()
	})

	it('takes the adapter at its word on what counts, and shows it the request', async () => {
		const onUnauthenticated = vi.fn()
		const isUnauthenticated = vi.fn(
			(error: { status?: number | undefined }, _request: ConduitRequest) =>
				error.status === 419,
		)
		const client = createClient({ fetch: () => Promise.resolve(jsonResponse({}, 419)) }).with(
			session({ adapter: tokenAdapter({ isUnauthenticated }), onUnauthenticated }),
		)

		await client.session.load()
		await client.get('/a').safe()

		expect(onUnauthenticated).toHaveBeenCalledOnce()
		expect(isUnauthenticated.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' })
	})

	// H2/M1: nothing is sticky, so the next request goes out as anonymous
	it('sends later requests without credentials instead of failing before the network', async () => {
		let calls = 0
		const stub = stubFetch(({ url }) => {
			calls++

			return url.endsWith('/dead') ? unauthorised() : jsonResponse({ public: true })
		})
		const client = createClient({ fetch: stub.fetch }).with(
			session({ adapter: tokenAdapter() }),
		)

		await client.session.load()

		expect((await client.get('/dead').safe()).error?.code).toBe('UNAUTHENTICATED')
		await expect(client.get('/public')).resolves.toEqual({ public: true })

		expect(calls).toBe(2)
		expect(new Headers(stub.calls[1]?.init.headers).get('authorization')).toBeNull()
	})

	it('resolves load() with null without a request, because the answer is known', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: () => Promise.resolve(unauthorised()) }).with(
			session({ adapter: tokenAdapter({ load }) }),
		)

		await client.session.load()
		await client.get('/a').safe()

		await expect(client.session.load()).resolves.toBeNull()
		expect(load).toHaveBeenCalledOnce()
	})

	it('resumes once a reload finds a session', async () => {
		let signedIn = true
		const client = createClient({
			fetch: () => Promise.resolve(signedIn ? jsonResponse({ ok: true }) : unauthorised()),
		}).with(
			session({
				adapter: tokenAdapter({ load: async () => (signedIn ? { name: 'Ada' } : null) }),
			}),
		)

		await client.session.load()
		signedIn = false
		await client.get('/a').safe()

		signedIn = true
		await client.session.reload()

		await expect(client.get('/b')).resolves.toEqual({ ok: true })
	})

	it('calls onClear once it is lost, and again on an explicit clear', async () => {
		const onClear = vi.fn()
		const client = createClient({ fetch: () => Promise.resolve(unauthorised()) }).with(
			session({ adapter: tokenAdapter({ onClear }) }),
		)

		await client.session.load()
		await client.get('/a').safe()
		expect(onClear).toHaveBeenCalledOnce()

		client.session.clear()
		expect(onClear).toHaveBeenCalledTimes(2)
		expect(client.session.getState().status).toBe('unknown')
	})

	it('recovers when a request that was sent under an older session fails late', async () => {
		let release: (() => void) | undefined
		let current = 'old'
		const stub = stubFetch(({ init }) => {
			const token = new Headers(init.headers).get('authorization')

			if (token === 'Bearer old') {
				return new Promise<Response>(resolve => {
					release = () => resolve(unauthorised())
				})
			}

			return jsonResponse({ token })
		})
		const renew = vi.fn(async () => true)
		const client = createClient({ fetch: stub.fetch }).with(
			session({
				adapter: tokenAdapter({
					load: async () => ({ name: 'u', token: current }),
					identify: () => 'u',
					authorize: (request, user) => {
						const headers = new Headers(request.headers)

						headers.set(
							'authorization',
							`Bearer ${(user as unknown as { token: string }).token}`,
						)

						return withRequest(request, { headers })
					},
					renew,
				}),
			}),
		)

		await client.session.load()

		const late = client.get('/a')

		await settle()
		current = 'new'
		await client.session.reload()
		release?.()

		await expect(late).resolves.toEqual({ token: 'Bearer new' })
		expect(renew).not.toHaveBeenCalled()
	})
})

describe('recoverable sessions', () => {
	it('recovers once and replays what failed', async () => {
		let authorised = false
		let calls = 0
		const renew = vi.fn(async () => {
			authorised = true

			return true
		})

		const client = createClient({
			fetch: () => {
				calls++

				return Promise.resolve(authorised ? jsonResponse({ ok: true }) : unauthorised())
			},
		}).with(session({ adapter: tokenAdapter({ renew }) }))

		await client.session.load()

		await expect(client.get('/a')).resolves.toEqual({ ok: true })
		expect(calls).toBe(2)
	})

	it('recovers once for a whole wave of failures', async () => {
		let authorised = false
		const renew = vi.fn(async () => {
			await settle()
			authorised = true

			return true
		})

		const client = createClient({
			fetch: () => Promise.resolve(authorised ? jsonResponse({ ok: true }) : unauthorised()),
		}).with(session({ adapter: tokenAdapter({ renew }) }))

		await client.session.load()

		const results = await Promise.all([
			client.get('/a').safe(),
			client.get('/b').safe(),
			client.get('/c').safe(),
		])

		expect(renew).toHaveBeenCalledOnce()
		expect(results.every(result => result.error === null)).toBe(true)
	})

	it('gives up when recovery fails', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({ fetch: () => Promise.resolve(unauthorised()) }).with(
			session({ adapter: tokenAdapter({ renew: async () => false }), onUnauthenticated }),
		)

		await client.session.load()

		expect((await client.get('/a').safe()).error?.status).toBe(401)
		expect(onUnauthenticated).toHaveBeenCalledOnce()
	})

	it('does not replay forever when the replay fails too', async () => {
		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++

				return Promise.resolve(unauthorised())
			},
		}).with(session({ adapter: tokenAdapter({ renew: async () => true }) }))

		await client.session.load()
		await client.get('/a').safe()

		expect(calls).toBe(2)
	})

	it('treats a renew that throws the same as one that resolves false', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({ fetch: () => Promise.resolve(unauthorised()) }).with(
			session({
				adapter: tokenAdapter({
					renew: async () => {
						throw new Error('boom')
					},
				}),
				onUnauthenticated,
			}),
		)

		await client.session.load()

		expect((await client.get('/a').safe()).error?.status).toBe(401)
		expect(onUnauthenticated).toHaveBeenCalledOnce()
	})
})

describe('session events', () => {
	it('reports each transition, and says when the session was lost', async () => {
		const client = createClient({ fetch: () => Promise.resolve(unauthorised()) }).with(
			session({ adapter: tokenAdapter() }),
		)
		const seen: Array<[string, boolean]> = []

		client.events.on('session:change', event => seen.push([event.status, event.isLost]))

		await client.session.load()
		await client.get('/a').safe()

		expect(seen).toEqual([
			['loading', false],
			['authenticated', false],
			['anonymous', true],
		])
	})
})

describe('origin scope', () => {
	it('does not authorize a foreign origin, even one the client itself may call', async () => {
		const stub = stubFetch(ok)
		const client = createClient({
			baseUrl: 'https://api.example.com',
			origins: ['https://cdn.example.com'],
			fetch: stub.fetch,
		}).with(session({ adapter: tokenAdapter() }))

		await client.session.load()
		await client.get('https://cdn.example.com/asset')

		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBeNull()
	})

	it('authorizes the client’s own absolute origin', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: 'https://api.example.com', fetch: stub.fetch }).with(
			session({ adapter: tokenAdapter() }),
		)

		await client.session.load()
		await client.get('/me')

		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBe('Bearer Ada')
	})

	it('authorizes an origin that is listed on both the client and the session', async () => {
		const stub = stubFetch(ok)
		const client = createClient({
			baseUrl: 'https://api.example.com',
			origins: ['https://partner.example.com'],
			fetch: stub.fetch,
		}).with(session({ adapter: tokenAdapter(), origins: ['https://partner.example.com/'] }))

		await client.session.load()
		await client.get('https://partner.example.com/shared')

		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBe('Bearer Ada')
	})

	it('warns once about a session origin the client would reject anyway', () => {
		const logger = { warn: vi.fn(), error: vi.fn() }

		createClient({
			baseUrl: 'https://api.example.com',
			fetch: stubFetch(ok).fetch,
			logger,
		}).with(session({ adapter: tokenAdapter(), origins: ['https://partner.example.com'] }))

		expect(logger.warn).toHaveBeenCalledOnce()
		expect(String(logger.warn.mock.calls[0]?.[0])).toMatch(/not in the client's origins/)
	})

	it('refuses a session origin that is not an origin', () => {
		expect(() =>
			session({ adapter: tokenAdapter(), origins: ['https://x.test/path'] }),
		).toThrow(/not an origin/)
	})

	// H1, session half: a url the client resolved to a foreign host never carries the token
	it('never attaches a token to any spelling that resolves off the api origin', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			session({ adapter: tokenAdapter() }),
		)

		await client.session.load()

		for (const path of [
			'/\\evil.test/x',
			'\\/evil.test/x',
			' //evil.test/x',
			'//evil.test/x',
		]) {
			await client.get(path).safe()
		}

		for (const call of stub.calls) {
			expect(new URL(call.url).origin).toBe('http://localhost:3000')
		}

		expect(stub.calls.every(call => !call.url.includes('evil.test/x?'))).toBe(true)
	})
})

describe('the reload timer', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('does not read anything on install, even when the expiry is already close', async () => {
		vi.useFakeTimers()

		const load = vi.fn(async () => ({ name: 'Ada' }))

		createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: { ...tokenAdapter({ load }), expiresAt: () => Date.now() + 30_000 },
				refreshLeewayMs: 60_000,
			}),
		)

		await vi.advanceTimersByTimeAsync(0)

		expect(load).not.toHaveBeenCalled()
	})

	it('reloads once at the hard expiry and then stops, rather than looping every tick', async () => {
		vi.useFakeTimers()

		const expiresAt = Date.now() + 30_000
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: { ...tokenAdapter({ load }), expiresAt: () => expiresAt },
				refreshLeewayMs: 60_000,
			}),
		)

		await client.session.load()
		expect(load).toHaveBeenCalledOnce()

		await vi.advanceTimersByTimeAsync(30_000)
		expect(load).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(1_000_000)
		expect(load).toHaveBeenCalledTimes(2)
	})

	it('arms at expiry minus leeway when that is still ahead', async () => {
		vi.useFakeTimers()

		const expiresAt = Date.now() + 120_000
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: { ...tokenAdapter({ load }), expiresAt: () => expiresAt },
				refreshLeewayMs: 60_000,
			}),
		)

		await client.session.load()
		expect(load).toHaveBeenCalledOnce()

		await vi.advanceTimersByTimeAsync(59_000)
		expect(load).toHaveBeenCalledOnce()

		await vi.advanceTimersByTimeAsync(2_000)
		expect(load).toHaveBeenCalledTimes(2)
	})

	it('does not arm at all once expiry is already in the past', async () => {
		vi.useFakeTimers()

		const past = Date.now() - 5_000
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: { ...tokenAdapter({ load }), expiresAt: () => past } }),
		)

		await client.session.load()

		expect(vi.getTimerCount()).toBe(0)

		await vi.advanceTimersByTimeAsync(1_000_000)
		expect(load).toHaveBeenCalledOnce()
	})
})

describe('identity', () => {
	it('resets identity-scoped state when the adapter reports a different user', async () => {
		let name = 'Ada'
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(cache())
			.with(session({ adapter: cookieAdapter(async () => ({ name })) }))

		await client.get('/shared')
		await client.session.load()

		expect(client.getCacheSize()).toBe(1)

		name = 'Grace'
		await client.session.reload()

		expect(client.getCacheSize()).toBe(0)
	})

	it('does not reset when the same identity reloads', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(cache())
			.with(session({ adapter: cookieAdapter(async () => ({ name: 'Ada' })) }))

		await client.get('/shared')
		await client.session.load()
		await client.session.reload()

		expect(client.getCacheSize()).toBe(1)
	})

	it('resets on the signed-in to signed-out flip', async () => {
		let signedIn = true
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(cache())
			.with(
				session({
					adapter: cookieAdapter(async () => (signedIn ? { name: 'Ada' } : null)),
				}),
			)

		await client.get('/shared')
		await client.session.load()
		await client.session.reload()

		expect(client.getCacheSize()).toBe(1)

		signedIn = false
		await client.session.reload()

		expect(client.getCacheSize()).toBe(0)
	})

	// S4: without a required identify, user A to user B kept A's cache
	it('needs identify, so a direct switch between two users cannot keep the first one’s cache', () => {
		const adapter: SessionAdapter<User> = {
			load: async () => ({ name: 'Ada' }),
			// @ts-expect-error identify is required
			identify: undefined,
		}

		expect(adapter.identify).toBeUndefined()
	})
})

describe('load and reload', () => {
	// N5: reload() used to join a read that started before sign-in and resolve with its stale answer
	it('starts a new read, and the latest one wins over an older one in flight', async () => {
		const releases: Array<(value: User | null) => void> = []
		const load = vi.fn(
			() =>
				new Promise<User | null>(resolve => {
					releases.push(resolve)
				}),
		)
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(load) }),
		)

		const boot = client.session.load()
		const afterSignIn = client.session.reload()

		expect(load).toHaveBeenCalledTimes(2)

		releases[1]?.({ name: 'Ada' })
		releases[0]?.(null)

		await expect(afterSignIn).resolves.toEqual({ name: 'Ada' })
		await expect(boot).resolves.toEqual({ name: 'Ada' })
		expect(client.session.getState()).toMatchObject({
			status: 'authenticated',
			session: { name: 'Ada' },
		})
	})

	it('drops an older failure once a newer read has won', async () => {
		const settlers: Array<{ ok: (value: User | null) => void; fail: (error: Error) => void }> =
			[]
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: cookieAdapter(
					() =>
						new Promise<User | null>((resolve, reject) => {
							settlers.push({ ok: resolve, fail: reject })
						}),
				),
			}),
		)

		const first = client.session.load()
		const second = client.session.reload()

		settlers[1]?.ok({ name: 'Ada' })
		settlers[0]?.fail(new Error('too late'))

		await expect(second).resolves.toEqual({ name: 'Ada' })
		await expect(first).resolves.toEqual({ name: 'Ada' })
		expect(client.session.getState().status).toBe('authenticated')
	})

	it('does not let a read that started before clear() put a session back', async () => {
		let release: ((value: User | null) => void) | undefined
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: cookieAdapter(
					() =>
						new Promise<User | null>(resolve => {
							release = resolve
						}),
				),
			}),
		)

		const pending = client.session.load()

		client.session.clear()
		release?.({ name: 'Ada' })
		await pending

		expect(client.session.getState().status).toBe('unknown')
	})

	it('re-reads after a failed load instead of joining nothing', async () => {
		let fail = true
		const load = vi.fn(async () => {
			if (fail) {
				throw new Error('blip')
			}

			return { name: 'Ada' }
		})
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(load) }),
		)

		await client.session.load().catch(() => {})
		fail = false

		await expect(client.session.load()).resolves.toEqual({ name: 'Ada' })
		expect(load).toHaveBeenCalledTimes(2)
	})
})

describe('shared recovery flight', () => {
	it('lets an in-flight reload satisfy a concurrent renew instead of calling the adapter twice', async () => {
		let releaseLoad: ((value: User | null) => void) | undefined
		let calls = 0
		const load = vi.fn(() => {
			calls++

			return calls === 1
				? Promise.resolve({ name: 'Ada' })
				: new Promise<User | null>(resolve => {
						releaseLoad = resolve
					})
		})
		const renew = vi.fn(async () => true)

		let authorised = false
		const client = createClient({
			fetch: () => Promise.resolve(authorised ? jsonResponse({ ok: true }) : unauthorised()),
		}).with(session({ adapter: tokenAdapter({ load, renew }) }))

		await client.session.load()

		const reloading = client.session.reload()
		const pending = client.get('/a').safe()

		await settle()

		authorised = true
		releaseLoad?.({ name: 'Ada' })

		await reloading
		expect((await pending).error).toBeNull()
		expect(renew).not.toHaveBeenCalled()
	})

	it('does not race the leeway timer against an in-flight renew', async () => {
		vi.useFakeTimers()

		interface Expiring {
			name: string
			exp: number
		}

		const load = vi.fn(async (): Promise<Expiring> => ({
			name: 'Ada',
			exp: Date.now() + 30_000,
		}))

		let releaseRenew: (() => void) | undefined
		const renew = vi.fn(
			() =>
				new Promise<boolean>(resolve => {
					releaseRenew = () => resolve(true)
				}),
		)

		let authorised = false
		const client = createClient({
			fetch: () => Promise.resolve(authorised ? jsonResponse({ ok: true }) : unauthorised()),
		}).with(
			session({
				adapter: {
					load,
					renew,
					identify: user => user.name,
					authorize: (request, user) => bearer(request, user),
					expiresAt: user => user.exp,
				},
				refreshLeewayMs: 60_000,
			}),
		)

		await client.session.load()
		expect(load).toHaveBeenCalledOnce()

		const pending = client.get('/a').safe()

		await vi.advanceTimersByTimeAsync(0)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(load).toHaveBeenCalledOnce()

		authorised = true
		releaseRenew?.()

		await pending
		expect(load).toHaveBeenCalledTimes(2)

		vi.useRealTimers()
	})
})

describe('cross-tab sync', () => {
	class FakeChannel {
		static all: FakeChannel[] = []
		onmessage: ((message: { data: unknown }) => void) | null = null
		closed = false

		constructor(readonly name: string) {
			FakeChannel.all.push(this)
		}

		postMessage(message: unknown): void {
			for (const other of FakeChannel.all) {
				if (other !== this && other.name === this.name && !other.closed) {
					other.onmessage?.({ data: message })
				}
			}
		}

		close(): void {
			this.closed = true
		}
	}

	const original = globalThis.BroadcastChannel

	afterEach(() => {
		globalThis.BroadcastChannel = original
		FakeChannel.all = []
	})

	function install(): void {
		FakeChannel.all = []
		globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel
	}

	it('makes the other tab re-read when this one signs out', async () => {
		install()

		const loadA = vi.fn(async () => ({ name: 'Ada' }))
		const loadB = vi.fn(async () => ({ name: 'Ada' }))
		const a = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(loadA), channel: 'auth' }),
		)
		const b = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(loadB), channel: 'auth' }),
		)

		await a.session.load()
		await b.session.load()

		a.session.clear()
		await settle()

		expect(loadB).toHaveBeenCalledTimes(2)
		expect(loadA).toHaveBeenCalledOnce()
	})

	it('broadcasts a user change, and does not echo the re-read it causes', async () => {
		install()

		let name = 'Ada'
		const loadA = vi.fn(async () => ({ name }))
		const loadB = vi.fn(async () => ({ name }))
		const a = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(loadA), channel: 'auth' }),
		)
		const b = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(loadB), channel: 'auth' }),
		)

		await a.session.load()
		await b.session.load()

		name = 'Grace'
		await a.session.reload()
		await settle()

		expect(loadB).toHaveBeenCalledTimes(2)
		expect(loadA).toHaveBeenCalledTimes(2)
		expect(b.session.getState().session).toEqual({ name: 'Grace' })
	})

	it('does not broadcast an ordinary re-read of the same user', async () => {
		install()

		const loadB = vi.fn(async () => ({ name: 'Ada' }))
		const a = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(async () => ({ name: 'Ada' })), channel: 'auth' }),
		)

		createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(loadB), channel: 'auth' }),
		)

		await a.session.load()
		await a.session.reload()
		await settle()

		expect(loadB).not.toHaveBeenCalled()
	})

	it('closes its channel on destroy, and works without BroadcastChannel at all', () => {
		install()

		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: cookieAdapter(async () => null), channel: 'auth' }),
		)

		client.destroy()
		expect(FakeChannel.all[0]?.closed).toBe(true)

		// @ts-expect-error simulating a runtime without it
		globalThis.BroadcastChannel = undefined

		expect(() =>
			createClient({ fetch: stubFetch(ok).fetch }).with(
				session({ adapter: cookieAdapter(async () => null), channel: 'auth' }),
			),
		).not.toThrow()
	})
})

describe('through defaults()', () => {
	it('keeps a public endpoint working after the session is lost', async () => {
		const stub = stubFetch(({ url }) =>
			url.endsWith('/private') ? unauthorised() : jsonResponse({ public: true }),
		)
		const api = defaults(createClient({ fetch: stub.fetch }), {
			retry: false,
			session: { adapter: tokenAdapter() },
		})

		await api.session.load()

		expect((await api.get('/private').safe()).error?.code).toBe('UNAUTHENTICATED')
		await expect(api.get('/public')).resolves.toEqual({ public: true })
	})
})

describe('teardown', () => {
	it('clears its timer and subscribers on destroy, without throwing', async () => {
		vi.useFakeTimers()

		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: {
					load: async () => ({ name: 'Ada', exp: Date.now() + 60_000 }),
					identify: user => user.name,
					expiresAt: user => user.exp,
				},
			}),
		)

		await client.session.load()
		client.session.subscribe(() => {})

		expect(() => {
			client.destroy()
		}).not.toThrow()
		expect(vi.getTimerCount()).toBe(0)

		vi.useRealTimers()
	})
})
