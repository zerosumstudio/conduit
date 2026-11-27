import { describe, expect, it } from 'vitest'

import { createClient } from '../core'
import { defaults } from '../defaults'
import { deferredFetch, hangingFetch, jsonResponse, stubFetch } from '../../__tests__/helpers'

const ok = (): Response => jsonResponse({ ok: true })

describe('scope.abort', () => {
	it('cancels what is in flight and stays usable', async () => {
		const deferred = deferredFetch()
		const stub = stubFetch(ok)
		let useStub = false
		const client = createClient({
			fetch: (url, init) => (useStub ? stub.fetch(url, init) : deferred.fetch(url, init)),
		})
		const scope = client.scope('remote')

		const pending = scope.get('/slow').safe()

		scope.abort('unmounted')

		expect((await pending).error?.code).toBe('ABORTED')

		useStub = true

		await expect(scope.get('/again')).resolves.toEqual({ ok: true })
	})

	it('hands out a new signal for each generation, and keeps the old one aborted', () => {
		const scope = createClient({ fetch: stubFetch(ok).fetch }).scope('remote')
		const first = scope.signal

		scope.abort('first')
		scope.abort('second')

		expect(first.aborted).toBe(true)
		expect((first.reason as Error).message).toBe('first')
		expect(scope.signal).not.toBe(first)
		expect(scope.signal.aborted).toBe(false)
	})
})

describe('scope.dispose', () => {
	it('ends the scope for good', async () => {
		const scope = createClient({ fetch: hangingFetch().fetch }).scope('remote')

		scope.dispose()
		scope.dispose()

		const { error } = await scope.get('/x').safe()

		expect(error?.code).toBe('ABORTED')
		expect(scope.signal.aborted).toBe(true)
	})

	it('is what client.destroy does to every scope', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
		const scope = client.scope('remote')

		client.destroy()

		expect(scope.signal.aborted).toBe(true)
	})
})

describe('client.abortAll', () => {
	it('cancels every scope in flight and leaves them usable', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch })
		const scope = client.scope('remote')

		const pending = scope.get('/slow').safe()

		client.abortAll('sign-out')

		expect((await pending).error?.code).toBe('ABORTED')
		expect(scope.signal.aborted).toBe(false)
	})
})

// N1: one 401 on a signed-in session used to abort every scope on the client for good
describe('a lost session', () => {
	it('leaves every scope usable once the session recovers', async () => {
		let signedIn = true
		const stub = stubFetch(({ init }) => {
			const headers = new Headers(init.headers)

			if (headers.get('authorization') === null) {
				return jsonResponse({ public: true })
			}

			return signedIn ? jsonResponse({ ok: true }) : jsonResponse({}, 401)
		})
		const api = defaults(createClient({ baseUrl: 'http://api.test', fetch: stub.fetch }), {
			retry: false,
			session: {
				adapter: {
					load: () => Promise.resolve(signedIn ? { id: 'u1' } : null),
					identify: user => user.id,
					authorize: (request, user) => {
						request.headers.set('authorization', `Bearer ${user.id}`)

						return request
					},
				},
			},
		})
		const scope = api.scope('remote')

		await api.session.load()

		signedIn = false

		expect((await scope.get('/me').safe()).error?.code).toBe('UNAUTHENTICATED')
		expect(scope.signal.aborted).toBe(false)

		signedIn = true
		await api.session.reload()

		await expect(scope.get('/me')).resolves.toEqual({ ok: true })
	})
})
