import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../client/core'
import { defaults } from '../client/defaults'
import { defineEndpoint } from '../client/endpoint'
import { isConduitError } from '../primitives/errors'
import { createHooks } from '../react'
import { createMockServer } from '../testing'
import { deferredFetch, hangingFetch, jsonResponse, stubFetch } from './helpers'

const ok = (): Response => jsonResponse({ id: 1 })

afterEach(() => {
	cleanup()
})

describe('useRequest', () => {
	it('loads, then reports what it got', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ id: number }>('/me'))

		await waitFor(() => expect(result.current.data).toEqual({ id: 1 }))

		expect(result.current.status).toBe('success')
		expect(result.current.isLoading).toBe(false)
		expect(result.current.isFetching).toBe(false)
	})

	it('reports loading while the answer is still outstanding', async () => {
		const deferred = deferredFetch()
		const api = defaults(createClient({ fetch: deferred.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ id: number }>('/me'))

		await waitFor(() => expect(result.current.isLoading).toBe(true))
		expect(result.current.data).toBeUndefined()

		deferred.resolve(jsonResponse({ id: 1 }))

		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.data).toEqual({ id: 1 })
	})

	it('surfaces a failure as state rather than throwing at the component', async () => {
		const api = defaults(
			createClient({ fetch: () => Promise.resolve(jsonResponse({}, 500)) }),
			{
				retry: false,
			},
		)
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest('/me'))

		await waitFor(() => expect(result.current.error?.status).toBe(500))
		expect(result.current.status).toBe('error')
	})

	it('holds off while disabled', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		const { result, rerender } = renderHook(
			({ enabled }: { enabled: boolean }) => useRequest('/me', { enabled }),
			{ initialProps: { enabled: false } },
		)

		expect(stub.calls).toHaveLength(0)
		expect(result.current.status).toBe('idle')

		rerender({ enabled: true })

		await waitFor(() => expect(stub.calls).toHaveLength(1))
	})

	it('refetches when the key changes, not when the options object does', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttlMs: 0 } })
		const { useRequest } = createHooks(api)

		const { rerender } = renderHook(
			({ id }: { id: number }) => useRequest('/users/:id', { params: { id } }),
			{
				initialProps: { id: 1 },
			},
		)

		await waitFor(() => expect(stub.calls).toHaveLength(1))

		rerender({ id: 1 })
		rerender({ id: 1 })
		expect(stub.calls).toHaveLength(1)

		rerender({ id: 2 })
		await waitFor(() => expect(stub.calls).toHaveLength(2))
	})

	it('issues its request under the key it subscribed to', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useRequest } = createHooks(api)

		const observed: string[] = []
		const issued: (string | undefined)[] = []
		const observe = api.observe.bind(api)
		const request = api.request.bind(api)

		vi.spyOn(api, 'observe').mockImplementation(key => {
			observed.push(key)
			return observe(key)
		})
		vi.spyOn(api, 'request').mockImplementation((path, options) => {
			issued.push(options?.key)
			return request(path, options)
		})

		renderHook(() => useRequest('/me'))

		await waitFor(() => expect(issued).toHaveLength(1))

		expect(issued[0]).toBe(observed[0])
	})

	it('says so when the client names the same query two different things', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		let nonce = 0
		const api = defaults(
			createClient({
				fetch: stubFetch(ok).fetch,
				headers: () => ({ 'x-request-id': String(++nonce) }),
			}),
		)
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me'))

		await waitFor(() => expect(warn).toHaveBeenCalled())
		expect(warn.mock.calls[0]?.[0]).toMatch(/derived two keys/)
	})

	it('stays quiet for a header source that answers the same way twice', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const api = defaults(
			createClient({
				fetch: stubFetch(ok).fetch,
				headers: () => ({ authorization: 'Bearer steady' }),
			}),
		)
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ id: number }>('/me'))

		await waitFor(() => expect(result.current.data).toEqual({ id: 1 }))
		expect(warn).not.toHaveBeenCalled()
	})

	it('refetches on demand', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttlMs: 0 } })
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest('/me'))

		await waitFor(() => expect(stub.calls).toHaveLength(1))

		await act(async () => {
			await result.current.refetch()
		})

		expect(stub.calls).toHaveLength(2)
	})

	it('reads a fresh cached answer without calling it stale', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		await api.get('/me')

		const { result } = renderHook(() => useRequest('/me'))

		await waitFor(() => expect(result.current.data).toEqual({ id: 1 }))

		expect(stub.calls).toHaveLength(1)
		expect(result.current.isStale).toBe(false)
		expect(result.current.updatedAt).toBeGreaterThan(0)
	})

	it('says isStale only for an answer served past its ttl while a refresh runs', async () => {
		let version = 1
		const stub = stubFetch(() => jsonResponse({ version: version++ }))
		const api = defaults(createClient({ fetch: stub.fetch }), {
			cache: { ttlMs: 0, staleMs: Infinity },
		})
		const { useRequest } = createHooks(api)

		await api.get('/me')

		const seen: boolean[] = []

		const { result } = renderHook(() => {
			const query = useRequest<{ version: number }>('/me')

			seen.push(query.isStale)

			return query
		})

		await waitFor(() => expect(result.current.data).toEqual({ version: 2 }))

		expect(seen).toContain(true)
		expect(result.current.isStale).toBe(false)
	})

	it('shares one request between two components rendering the same query', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttlMs: 0 } })
		const { useRequest } = createHooks(api)

		const first = renderHook(() => useRequest('/me'))
		const second = renderHook(() => useRequest('/me'))

		await waitFor(() => expect(first.result.current.data).toEqual({ id: 1 }))
		await waitFor(() => expect(second.result.current.data).toEqual({ id: 1 }))

		expect(stub.calls).toHaveLength(1)
	})

	it('cancels its own request on unmount without taking a sibling down', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttlMs: 0 } })
		const { useRequest } = createHooks(api)

		const leaving = renderHook(() => useRequest('/me'))
		const staying = renderHook(() => useRequest('/me'))

		leaving.unmount()

		await waitFor(() => expect(staying.result.current.data).toEqual({ id: 1 }))
		expect(staying.result.current.error).toBeUndefined()
	})

	it('treats a request that cannot yet be built as disabled, instead of throwing during render', () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useRequest } = createHooks(api)

		expect(() => renderHook(() => useRequest('/users/:id', {}))).not.toThrow()

		const { result } = renderHook(() => useRequest('/users/:id', {}))

		expect(result.current.status).toBe('idle')
		expect(result.current.error).toBeUndefined()
	})

	it('makes refetch a safe no-op while disabled', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest('/me', { enabled: false }))

		await act(async () => {
			await result.current.refetch()
		})

		expect(stub.calls).toHaveLength(0)
	})

	it('combines a caller signal with its own, instead of overwriting it', async () => {
		const hanging = hangingFetch()
		const api = defaults(createClient({ fetch: hanging.fetch }))
		const { useRequest } = createHooks(api)
		const controller = new AbortController()

		renderHook(() => useRequest('/me', { signal: controller.signal }))

		await waitFor(() => expect(hanging.calls).toHaveLength(1))

		act(() => {
			controller.abort()
		})

		await waitFor(() => expect(hanging.calls[0]?.init.signal?.aborted).toBe(true))
	})

	it('refetch forces a network refresh even when the entry is still fresh', async () => {
		let version = 1
		const stub = stubFetch(() => jsonResponse({ version: version++ }))
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ version: number }>('/me'))

		await waitFor(() => expect(result.current.data).toEqual({ version: 1 }))

		await act(async () => {
			await result.current.refetch()
		})

		expect(stub.calls).toHaveLength(2)
		expect(result.current.data).toEqual({ version: 2 })
	})

	it('refetches a mounted query when its tag is invalidated', async () => {
		let version = 1
		const stub = stubFetch(() => jsonResponse({ version: version++ }))
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() =>
			useRequest<{ version: number }>('/me', { tags: ['me'] }),
		)

		await waitFor(() => expect(result.current.data).toEqual({ version: 1 }))

		act(() => {
			api.invalidateTag('me')
		})

		await waitFor(() => expect(result.current.data).toEqual({ version: 2 }))
		expect(stub.calls).toHaveLength(2)
	})

	it('keeps the previous key’s data on screen while a new key loads, with keepPreviousData', async () => {
		const deferred = deferredFetch()
		const api = defaults(createClient({ fetch: deferred.fetch }))
		const { useRequest } = createHooks(api)

		const { result, rerender } = renderHook(
			({ id }: { id: number }) =>
				useRequest<{ id: number }>('/users/:id', {
					params: { id },
					keepPreviousData: true,
				}),
			{ initialProps: { id: 1 } },
		)

		deferred.resolve(jsonResponse({ id: 1 }))
		await waitFor(() => expect(result.current.data).toEqual({ id: 1 }))

		rerender({ id: 2 })

		expect(result.current.data).toEqual({ id: 1 })
		expect(result.current.isFetching).toBe(true)

		deferred.resolve(jsonResponse({ id: 2 }))
		await waitFor(() => expect(result.current.data).toEqual({ id: 2 }))
	})

	it('does not refetch on focus by default', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me'))
		await waitFor(() => expect(stub.calls).toHaveLength(1))

		act(() => {
			window.dispatchEvent(new Event('focus'))
		})

		expect(stub.calls).toHaveLength(1)
	})

	it('reads again when the tab becomes visible, if opted in', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttlMs: 0 } })
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me', { refetchOnFocus: true }))
		await waitFor(() => expect(stub.calls).toHaveLength(1))

		act(() => {
			document.dispatchEvent(new Event('visibilitychange'))
		})

		await waitFor(() => expect(stub.calls).toHaveLength(2))
	})

	// M5: a tab switch fires focus and visibilitychange, and each used to add a request
	it('ignores window focus, so one tab switch is one read', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttlMs: 0 } })
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me', { refetchOnFocus: true }))
		await waitFor(() => expect(stub.calls).toHaveLength(1))

		act(() => {
			window.dispatchEvent(new Event('focus'))
			document.dispatchEvent(new Event('visibilitychange'))
		})

		await waitFor(() => expect(stub.calls).toHaveLength(2))
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(stub.calls).toHaveLength(2)
	})

	it('serves a fresh entry on a visibility read, and only refetch() bypasses it', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttlMs: 60_000 } })
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest('/me', { refetchOnFocus: true }))
		await waitFor(() => expect(result.current.data).toBeDefined())

		act(() => {
			document.dispatchEvent(new Event('visibilitychange'))
		})
		await new Promise(resolve => setTimeout(resolve, 20))

		expect(stub.calls).toHaveLength(1)

		await act(async () => {
			await result.current.refetch()
		})

		expect(stub.calls).toHaveLength(2)
	})

	it('shares one visibility listener between every hook, and removes it with the last', async () => {
		const add = vi.spyOn(document, 'addEventListener')
		const remove = vi.spyOn(document, 'removeEventListener')
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useRequest } = createHooks(api)

		const first = renderHook(() => useRequest('/a', { refetchOnFocus: true }))
		const second = renderHook(() => useRequest('/b', { refetchOnFocus: true }))
		const third = renderHook(() => useRequest('/c', { refetchOnFocus: true }))

		const added = () => add.mock.calls.filter(([type]) => type === 'visibilitychange').length
		const removed = () =>
			remove.mock.calls.filter(([type]) => type === 'visibilitychange').length

		expect(added()).toBe(1)

		first.unmount()
		second.unmount()
		expect(removed()).toBe(0)

		third.unmount()
		expect(removed()).toBe(1)
	})

	it('does not refetch on reconnect by default', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me'))
		await waitFor(() => expect(stub.calls).toHaveLength(1))

		act(() => {
			window.dispatchEvent(new Event('online'))
		})

		expect(stub.calls).toHaveLength(1)
	})

	it('refetches on reconnect when opted in', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttlMs: 0 } })
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me', { refetchOnReconnect: true }))
		await waitFor(() => expect(stub.calls).toHaveLength(1))

		act(() => {
			window.dispatchEvent(new Event('online'))
		})

		await waitFor(() => expect(stub.calls).toHaveLength(2))
	})
})

describe('useRequest with a defined endpoint', () => {
	it('runs it and keys it the same way client.call would', async () => {
		const stub = stubFetch(() => jsonResponse({ id: '7' }))
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)
		const getUser = defineEndpoint<{ id: string }, { id: string }>({
			method: 'GET',
			path: '/users/:id',
		})

		const { result } = renderHook(() => useRequest(getUser, { id: '7' }))

		await waitFor(() => expect(result.current.data).toEqual({ id: '7' }))
	})

	it('treats an endpoint whose vars cannot yet fill its path as disabled', () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useRequest } = createHooks(api)
		const getUser = defineEndpoint<{ id: string }, { id: string }>({
			method: 'GET',
			path: '/users/:id',
		})

		expect(() => renderHook(() => useRequest(getUser, {} as { id: string }))).not.toThrow()

		const { result } = renderHook(() => useRequest(getUser, {} as { id: string }))

		expect(result.current.status).toBe('idle')
		expect(result.current.error).toBeUndefined()
	})
})

describe('useMutation', () => {
	it('runs, reports pending, then reports the result', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useMutation } = createHooks(api)

		const { result } = renderHook(() =>
			useMutation<{ id: number }, { name: string }>(variables =>
				api.post('/users', variables),
			),
		)

		expect(result.current.isPending).toBe(false)

		await act(async () => {
			await result.current.mutate({ name: 'Ada' })
		})

		expect(result.current.data).toEqual({ id: 1 })
		expect(result.current.isPending).toBe(false)
	})

	it('reports a failure as state instead of rejecting', async () => {
		const api = defaults(createClient({ fetch: () => Promise.resolve(jsonResponse({}, 422)) }))
		const { useMutation } = createHooks(api)

		const { result } = renderHook(() => useMutation(() => api.post('/users', {})))

		await act(async () => {
			const outcome = await result.current.mutate()

			expect(outcome.data).toBeNull()
			expect(outcome.error?.status).toBe(422)
		})

		expect(result.current.status).toBe('error')
		expect(isConduitError(result.current.error) && result.current.error.status).toBe(422)
	})

	it('resets', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useMutation } = createHooks(api)

		const { result } = renderHook(() => useMutation(() => api.post('/users', {})))

		await act(async () => {
			await result.current.mutate()
		})

		act(() => {
			result.current.reset()
		})

		expect(result.current.data).toBeUndefined()
	})

	it('invalidates tags passed via options, for the function form', async () => {
		let version = 1
		const server = createMockServer()
		server.get('/me', () => ({ version: version++ }))
		server.post('/touch', {})

		const api = defaults(createClient({ fetch: server.fetch }))
		const { useRequest, useMutation } = createHooks(api)

		const query = renderHook(() => useRequest<{ version: number }>('/me', { tags: ['me'] }))
		await waitFor(() => expect(query.result.current.data).toEqual({ version: 1 }))

		const mutation = renderHook(() =>
			useMutation(() => api.post('/touch', {}), { invalidates: ['me'] }),
		)

		await act(async () => {
			await mutation.result.current.mutate()
		})

		await waitFor(() => expect(query.result.current.data).toEqual({ version: 2 }))
	})

	it('invalidates an endpoint’s own tags on success', async () => {
		let version = 1
		const server = createMockServer()
		server.get('/me', () => ({ version: version++ }))
		server.post('/touch', {})

		const api = defaults(createClient({ fetch: server.fetch }))
		const { useRequest, useMutation } = createHooks(api)

		const getMe = defineEndpoint<void, { version: number }>({
			method: 'GET',
			path: '/me',
			tags: ['me'],
		})
		const touchMe = defineEndpoint({
			method: 'POST',
			path: '/touch',
			invalidates: ['me'],
		})

		const query = renderHook(() => useRequest(getMe, undefined))
		await waitFor(() => expect(query.result.current.data).toEqual({ version: 1 }))

		const mutation = renderHook(() => useMutation(touchMe))

		await act(async () => {
			await mutation.result.current.mutate(undefined)
		})

		await waitFor(() => expect(query.result.current.data).toEqual({ version: 2 }))
	})

	it('wraps a non-conduit error, keeping the original as the cause', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useMutation } = createHooks(api)
		const boom = { reason: 'not a ConduitError' }

		const { result } = renderHook(() => useMutation(() => Promise.reject(boom)))

		await act(async () => {
			await result.current.mutate()
		})

		expect(isConduitError(result.current.error)).toBe(true)
		expect(result.current.error?.code).toBe('UNKNOWN')
		expect(result.current.error?.cause).toBe(boom)
	})

	// N8: a failure used to resolve undefined, which a success returning undefined also did
	it('resolves a SafeResult, so a failure cannot pass for a success', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useMutation } = createHooks(api)

		const succeeds = renderHook(() => useMutation<undefined>(() => Promise.resolve(undefined)))
		const fails = renderHook(() =>
			useMutation<undefined>(() => Promise.reject(new Error('no'))),
		)

		await act(async () => {
			expect(await succeeds.result.current.mutate()).toEqual({ data: undefined, error: null })
			expect((await fails.result.current.mutate()).error?.message).toBe('no')
		})

		expect(succeeds.result.current.status).toBe('success')
		expect(fails.result.current.status).toBe('error')
	})

	it('lets the latest call own the state, whichever settles last', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useMutation } = createHooks(api)
		const gates: Array<(value: string) => void> = []

		const { result } = renderHook(() =>
			useMutation<string>(
				() =>
					new Promise<string>(resolve => {
						gates.push(resolve)
					}),
			),
		)

		let first: Promise<unknown> = Promise.resolve()
		let second: Promise<unknown> = Promise.resolve()

		act(() => {
			first = result.current.mutate()
			second = result.current.mutate()
		})

		await act(async () => {
			gates[1]?.('second')
			await second
			gates[0]?.('first')
			await first
		})

		expect(result.current.data).toBe('second')
		expect(result.current.status).toBe('success')
	})

	it('invalidates its tags before mutate resolves', async () => {
		const server = createMockServer()
		server.get('/me', { id: 1 })
		server.post('/touch', {})
		const api = defaults(createClient({ fetch: server.fetch }))
		const { useMutation } = createHooks(api)

		await api.get('/me', { tags: ['me'] })

		const { result } = renderHook(() =>
			useMutation(() => api.post('/touch', {}), { invalidates: ['me'] }),
		)

		await act(async () => {
			await result.current.mutate()
		})

		expect(api.getCacheSize()).toBe(0)
	})
})

describe('usePrefetch', () => {
	it('warms the cache in the prefetch lane', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { usePrefetch } = createHooks(api)
		const lanes: string[] = []

		api.events.on('request:start', event => lanes.push(event.request.lane))

		const { result } = renderHook(() => usePrefetch())

		act(() => {
			result.current('/me')
		})

		await waitFor(() => expect(stub.calls).toHaveLength(1))
		expect(lanes).toEqual(['prefetch'])

		await api.get('/me')
		expect(stub.calls).toHaveLength(1)
	})
})

describe('useSession', () => {
	it('follows the shared session', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }), {
			session: {
				adapter: { load: async () => ({ name: 'Ada' }), identify: user => user.name },
			},
		})
		const { useSession } = createHooks(api)

		const { result } = renderHook(() => useSession())

		expect(result.current.status).toBe('unknown')

		await act(async () => {
			await api.session.load()
		})

		expect(result.current.status).toBe('authenticated')
		expect(result.current.session).toEqual({ name: 'Ada' })
	})

	it('explains itself when the plugin is missing', () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const hooks = createHooks(api) as unknown as { useSession(): unknown }
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})

		expect(() => renderHook(() => hooks.useSession())).toThrow(/needs the session plugin/)

		error.mockRestore()
	})
})

describe('useMutation with an endpoint and options', () => {
	it('invalidates the endpoint tags and the ones passed in', async () => {
		const server = createMockServer({ baseUrl: '/api' })
		server.get('/users', () => [{ id: 1 }])
		server.get('/teams', () => [{ id: 1 }])
		server.post('/users', () => ({ id: 2 }))
		const api = defaults(createClient({ baseUrl: '/api', fetch: server.fetch }))
		const { useRequest, useMutation } = createHooks(api)
		const create = defineEndpoint<{ name: string }, { id: number }>({
			method: 'POST',
			path: '/users',
			body: vars => vars,
			invalidates: ['users'],
		})

		const { result } = renderHook(() => ({
			users: useRequest<{ id: number }[]>('/users', { tags: ['users'] }),
			teams: useRequest<{ id: number }[]>('/teams', { tags: ['teams'] }),
			mutation: useMutation(create, { invalidates: ['teams'] }),
		}))
		await waitFor(() => expect(result.current.users.data).toBeDefined())
		await waitFor(() => expect(result.current.teams.data).toBeDefined())
		const before = server.calls.length

		await act(async () => {
			await result.current.mutation.mutate({ name: 'Ada' })
		})

		await waitFor(() => expect(server.calls.length).toBe(before + 3))
	})
})

describe('useRequest first render', () => {
	it('reports loading before the first fetch starts', () => {
		const deferred = deferredFetch()
		const api = defaults(createClient({ fetch: deferred.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ id: number }>('/me'))

		expect(result.current.isLoading).toBe(true)
		deferred.resolve(jsonResponse({ id: 1 }))
	})
})

// M5: the hooks used to abort their own requests, so StrictMode and focus put duplicates on the wire
describe('useRequest never aborts what it started', () => {
	it('sends one request under StrictMode, where the effect runs twice', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ id: number }>('/me'), {
			wrapper: StrictMode,
		})

		await waitFor(() => expect(result.current.data).toEqual({ id: 1 }))

		expect(stub.calls).toHaveLength(1)
		expect(stub.calls[0]?.init.signal?.aborted).toBe(false)
	})

	it('sends one request for a POST read that dedupe does not cover, under StrictMode', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)
		const search = defineEndpoint<{ q: string }, { id: number }>({
			method: 'POST',
			path: '/search',
			body: vars => vars,
			cacheable: false,
		})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		const { result } = renderHook(() => useRequest(search, { q: 'a' }), { wrapper: StrictMode })

		await waitFor(() => expect(result.current.data).toEqual({ id: 1 }))

		expect(stub.calls).toHaveLength(1)
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not cacheable/))
		warn.mockRestore()
	})

	it('lets a request finish and fill the cache after its component unmounts', async () => {
		const deferred = deferredFetch()
		const api = defaults(createClient({ fetch: deferred.fetch }))
		const { useRequest } = createHooks(api)

		const { unmount } = renderHook(() => useRequest('/me'))

		await waitFor(() => expect(deferred.calls).toHaveLength(1))
		unmount()

		expect(deferred.aborted()).toBe(false)

		deferred.resolve(jsonResponse({ id: 1 }))
		await waitFor(() => expect(api.getCacheSize()).toBe(1))
	})

	it('shows the new key and ignores the old one landing late, without cancelling it', async () => {
		const resolvers = new Map<string, (response: Response) => void>()
		const signals: AbortSignal[] = []
		const api = defaults(
			createClient({
				fetch: (url, init) =>
					new Promise<Response>(resolve => {
						resolvers.set(new URL(url).pathname, resolve)
						signals.push(init.signal as AbortSignal)
					}),
			}),
		)
		const { useRequest } = createHooks(api)

		const { result, rerender } = renderHook(
			({ id }) => useRequest<{ id: string }>(`/users/${id}`),
			{
				initialProps: { id: 'a' },
			},
		)

		await waitFor(() => expect(resolvers.has('/users/a')).toBe(true))
		rerender({ id: 'b' })
		await waitFor(() => expect(resolvers.has('/users/b')).toBe(true))

		resolvers.get('/users/b')?.(jsonResponse({ id: 'b' }))
		await waitFor(() => expect(result.current.data).toEqual({ id: 'b' }))

		resolvers.get('/users/a')?.(jsonResponse({ id: 'a' }))
		await new Promise(resolve => setTimeout(resolve, 10))

		expect(result.current.data).toEqual({ id: 'b' })
		expect(signals.every(signal => !signal.aborted)).toBe(true)
	})

	it('makes one request when several hooks react to the same invalidation', async () => {
		let version = 1
		const server = createMockServer()

		server.get('/me', () => ({ version: version++ }))

		const api = defaults(createClient({ fetch: server.fetch }))
		const { useRequest } = createHooks(api)

		const first = renderHook(() => useRequest<{ version: number }>('/me', { tags: ['me'] }))
		const second = renderHook(() => useRequest<{ version: number }>('/me', { tags: ['me'] }))

		await waitFor(() => expect(first.result.current.data).toEqual({ version: 1 }))
		await waitFor(() => expect(second.result.current.data).toEqual({ version: 1 }))
		expect(server.calls).toHaveLength(1)

		act(() => {
			api.invalidateTag('me')
		})

		await waitFor(() => expect(first.result.current.data).toEqual({ version: 2 }))
		await waitFor(() => expect(second.result.current.data).toEqual({ version: 2 }))
		expect(server.calls).toHaveLength(2)
	})

	it('still honours the caller’s own signal', async () => {
		const controller = new AbortController()
		const api = defaults(createClient({ fetch: hangingFetch().fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest('/me', { signal: controller.signal }))

		await waitFor(() => expect(result.current.isFetching).toBe(true))
		act(() => {
			controller.abort()
		})

		await waitFor(() => expect(result.current.isFetching).toBe(false))
	})
})
