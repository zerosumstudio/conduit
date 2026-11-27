import { describe, expect, it, vi } from 'vitest'

import { createClient } from '../../client/core'
import { defaults } from '../../client/defaults'
import { createOriginPolicy } from '../origin'
import { createRequest, withRequest } from '../request'
import { resolveCredentialHeaders, resolveRedact } from '../redact'
import { session } from '../../plugins/session'
import { consoleLogger } from '../../primitives/logger'
import type { ResolvedClientConfig } from '../../primitives/types'
import { createFetchTransport } from '../transport'
import { jsonResponse, stubFetch } from '../../__tests__/helpers'

const FOREIGN = 'https://evil.test/collect'

const redirect = (status = 302): Response =>
	new Response(null, { status, headers: { location: FOREIGN } })

const ok = (): Response => jsonResponse({ ok: true })

// SEC-1: a custom credential header followed a same-origin redirect to another origin
describe('the credential redirect rule', () => {
	it('sends a request with a custom credential through redirect: manual, and blocks the answer', async () => {
		const stub = stubFetch(() => redirect())
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-api-key': 'k-123' },
			fetch: stub.fetch,
		})

		const { error } = await client.get('/download').safe()

		expect(stub.calls[0]?.init.redirect).toBe('manual')
		expect(error?.code).toBe('REDIRECT_BLOCKED')
		expect(error?.status).toBe(302)
		expect(error?.headers?.get('location')).toBe(FOREIGN)
		expect(JSON.stringify(error)).not.toContain('k-123')
	})

	it.each([301, 303, 307, 308])('blocks a %d too', async status => {
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-api-key': 'k' },
			fetch: () => Promise.resolve(redirect(status)),
		})

		expect((await client.get('/x').safe()).error?.code).toBe('REDIRECT_BLOCKED')
	})

	it('blocks what a browser reports as an opaque redirect', async () => {
		const opaque = Object.defineProperty(new Response(null, { status: 200 }), 'type', {
			value: 'opaqueredirect',
		})
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-api-key': 'k' },
			fetch: () => Promise.resolve(opaque),
		})

		expect((await client.get('/x').safe()).error?.code).toBe('REDIRECT_BLOCKED')
	})

	it('does not mistake 304 Not Modified for a redirect', async () => {
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-api-key': 'k' },
			fetch: () => Promise.resolve(new Response(null, { status: 304 })),
		})

		const { error } = await client.get('/x').safe()

		expect(error?.code).toBe('HTTP_STATUS')
		expect(error?.status).toBe(304)
	})

	it('leaves a plain Bearer or cookie setup following redirects', async () => {
		const stub = stubFetch(ok)
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { authorization: 'Bearer t', cookie: 'a=b' },
			fetch: stub.fetch,
		})

		await client.get('/x')

		expect(stub.calls[0]?.init).not.toHaveProperty('redirect')
	})

	it('lets an explicit redirect win, on the client or the request', async () => {
		const stub = stubFetch(ok)
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-api-key': 'k' },
			redirect: 'follow',
			fetch: stub.fetch,
		})

		await client.get('/a')
		await client.get('/b', { redirect: 'error' })

		expect(stub.calls[0]?.init.redirect).toBe('follow')
		expect(stub.calls[1]?.init.redirect).toBe('error')
	})

	it('keeps an explicit manual as it was: a 3xx is an ordinary HTTP_STATUS', async () => {
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-api-key': 'k' },
			redirect: 'manual',
			fetch: () => Promise.resolve(redirect()),
		})

		expect((await client.get('/x').safe()).error?.code).toBe('HTTP_STATUS')
	})

	it('treats a header the session attached as a credential too', async () => {
		const stub = stubFetch(() => redirect())
		const client = createClient({ baseUrl: 'https://api.test', fetch: stub.fetch }).with(
			session({
				adapter: {
					load: async () => ({ token: 'T' }),
					identify: user => user.token,
					authorize: (request, user) => {
						const headers = new Headers(request.headers)

						headers.set('x-session-token', user.token)

						return withRequest(request, { headers })
					},
				},
			}),
		)

		await client.session.load()

		const { error } = await client.get('/dl').safe()

		expect(stub.calls[0]?.init.redirect).toBe('manual')
		expect(error?.code).toBe('REDIRECT_BLOCKED')
	})

	it('does not treat an Authorization header from the session as one', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: 'https://api.test', fetch: stub.fetch }).with(
			session({
				adapter: {
					load: async () => ({ token: 'T' }),
					identify: user => user.token,
					authorize: (request, user) => {
						const headers = new Headers(request.headers)

						headers.set('authorization', `Bearer ${user.token}`)

						return withRequest(request, { headers })
					},
				},
			}),
		)

		await client.session.load()
		await client.get('/dl')

		expect(stub.calls[0]?.init).not.toHaveProperty('redirect')
	})

	it('is never replayed by retry', async () => {
		const stub = stubFetch(() => redirect())
		const client = defaults(
			createClient({
				baseUrl: 'https://api.test',
				headers: { 'x-api-key': 'k' },
				fetch: stub.fetch,
			}),
			{ retry: { baseDelayMs: 1 } },
		)

		await client.get('/x').safe()

		expect(stub.calls).toHaveLength(1)
	})

	it('honours the redact list: a header you add to it becomes a credential', async () => {
		const stub = stubFetch(() => redirect())
		const client = createClient({
			baseUrl: 'https://api.test',
			headers: { 'x-tenant-token': 't' },
			redact: { headers: ['x-tenant-token'] },
			fetch: stub.fetch,
		})

		expect((await client.get('/x').safe()).error?.code).toBe('REDIRECT_BLOCKED')
	})
})

describe('progress uploads and credentials', () => {
	const xhr = (): Response => jsonResponse({ ok: true })

	function transportFor(
		fetch: ResolvedClientConfig['fetch'],
	): ReturnType<typeof createFetchTransport> {
		const config: ResolvedClientConfig = {
			baseUrl: 'https://api.test',
			headers: undefined,
			credentials: undefined,
			vary: '*',
			owner: undefined,
			lane: 'default',
			parse: 'auto',
			fetch,
			mode: undefined,
			redirect: undefined,
			cache: undefined,
			keepalive: undefined,
			priority: undefined,
			referrerPolicy: undefined,
			integrity: undefined,
			origins: [],
			redact: resolveRedact(),
			credentialHeaders: resolveCredentialHeaders(),
			logger: consoleLogger,
		}

		return createFetchTransport(config, createOriginPolicy('https://api.test', []))
	}

	function request(
		headers: Record<string, string>,
		over: { redirect?: RequestRedirect } = {},
		meta: Record<string, unknown> = {},
	): ReturnType<typeof createRequest> {
		return createRequest({
			url: 'https://api.test/files',
			method: 'POST',
			body: 'x',
			signal: new AbortController().signal,
			key: 'k',
			variance: '',
			lane: 'default',
			owner: undefined,
			tags: [],
			cacheable: false,
			parse: 'auto',
			credentials: undefined,
			mode: undefined,
			redirect: over.redirect,
			cache: undefined,
			keepalive: undefined,
			priority: undefined,
			referrerPolicy: undefined,
			integrity: undefined,
			meta,
			buildHeaders: () => new Headers(headers),
		})
	}

	it('fails closed with INVALID_ARGUMENT when a custom credential would ride XHR', async () => {
		const send = vi.fn(() => Promise.resolve(xhr()))
		const transport = transportFor(vi.fn())

		await expect(
			transport(request({ 'x-api-key': 'k' }, {}, { fetch: send })),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		expect(send).not.toHaveBeenCalled()
	})

	it('goes ahead when the caller opts into redirect: follow', async () => {
		const send = vi.fn(() => Promise.resolve(xhr()))
		const transport = transportFor(vi.fn())

		await transport(request({ 'x-api-key': 'k' }, { redirect: 'follow' }, { fetch: send }))

		expect(send).toHaveBeenCalledOnce()
	})

	it('goes ahead for Authorization and cookies, which the platform strips itself', async () => {
		const send = vi.fn(() => Promise.resolve(xhr()))
		const transport = transportFor(vi.fn())

		await transport(request({ authorization: 'Bearer t', cookie: 'a=b' }, {}, { fetch: send }))

		expect(send).toHaveBeenCalledOnce()
	})

	it('names the way out in the message', async () => {
		const transport = transportFor(vi.fn())

		await expect(
			transport(request({ 'x-api-key': 'k' }, {}, { fetch: vi.fn() })),
		).rejects.toThrow(/Set redirect: 'follow', or drop onProgress/)
	})
})

describe('the transport re-check', () => {
	it('rejects a url a middleware rewrote to another origin, before fetch', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: 'https://api.test', fetch: stub.fetch }).with({
			name: 'rewrite',
			middleware: (request, next) =>
				next(withRequest(request, { url: 'https://evil.test/steal' })),
		})

		const { error } = await client.get('/x').safe()

		expect(error?.code).toBe('ORIGIN_REJECTED')
		expect(stub.calls).toHaveLength(0)
	})

	it('rejects a relative url a middleware handed down', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: 'https://api.test', fetch: stub.fetch }).with({
			name: 'rewrite',
			middleware: (request, next) => next(withRequest(request, { url: '/x' })),
		})

		expect((await client.get('/x').safe()).error?.code).toBe('ORIGIN_REJECTED')
		expect(stub.calls).toHaveLength(0)
	})

	it('sends exactly the href it checked', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: 'https://api.test', fetch: stub.fetch }).with({
			name: 'rewrite',
			middleware: (request, next) =>
				next(withRequest(request, { url: 'HTTPS://API.test:443/a b/../c' })),
		})

		await client.get('/x')

		expect(stub.calls[0]?.url).toBe('https://api.test/c')
	})
})
