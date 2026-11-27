/*
 *   PUBLIC API
 *
 *   Compiled by scripts/smoke.mjs against dist, with exactOptionalPropertyTypes and
 *   skipLibCheck off. Anything that stops compiling here is a break for consumers.
 ***************************************************************************************************/
import {
	ConduitError,
	DEFAULT_REDACT,
	apiVersion,
	createClient,
	defaults,
	defineEndpoint,
	isConduitError,
	isErrorCode,
	requestId,
	sharedClient,
	withRequest,
	type ConduitErrorCode,
	type Endpoint,
	type PathParamsOf,
	type SessionAdapter,
	type StandardSchemaV1,
} from '@zerosumstudio/conduit'
import { attachDevtools } from '@zerosumstudio/conduit/devtools'
import { createHooks } from '@zerosumstudio/conduit/react'
import { clearSharedClients, createMockServer, status } from '@zerosumstudio/conduit/testing'
import { uploadWithProgress } from '@zerosumstudio/conduit/upload'

interface User {
	id: string
	name: string
}

/*
 *   ERRORS ARE VALUES
 ***************************************************************************************************/
const error = new ConduitError({ code: 'HTTP_STATUS', message: 'nope', status: 401 })
const code: ConduitErrorCode = error.code
const retryAfterMs: number | undefined = error.retryAfterMs
const requestIdOnError: string | undefined = error.requestId
const narrowed: boolean = isConduitError(error) && isErrorCode(error, 'UNAUTHENTICATED')

// @ts-expect-error the old suffixed code is gone
const retired: ConduitErrorCode = 'HTTP_ERROR'

/*
 *   CLIENT OPTIONS
 ***************************************************************************************************/
const adapter: SessionAdapter<User> = {
	load: async ctx => (await ctx.request<{ user: User | null }>('/auth/session')).user,
	authorize: (request, user) =>
		withRequest(request, { headers: new Headers({ authorization: user.id }) }),
	renew: async () => true,
	expiresAt: () => Date.now() + 60_000,
	identify: user => user.id,
	isUnauthenticated: (failure, request) => failure.status === 401 && request.method !== 'POST',
	onClear: () => undefined,
}

// The README's hot-reload setup under exactOptionalPropertyTypes: the value can be undefined
const hot: { dispose(callback: () => void): void } | undefined = undefined
const apiVersionValue: string | undefined = undefined as string | undefined

const api = sharedClient(
	'public-api.test',
	() =>
		defaults(
			createClient({
				baseUrl: 'https://api.example.com/v1',
				origins: ['https://cdn.example.com'],
				redact: { headers: [...DEFAULT_REDACT.headers, 'x-tenant-token'] },
				logger: console,
				credentials: 'same-origin',
				keepalive: true,
				owner: undefined,
			}),
			{
				cache: { ttlMs: 1_000, staleMs: Infinity },
				session: { adapter, origins: ['https://api.example.com'], channel: 'auth' },
			},
		)
			.with(apiVersion({ expected: 'v1' }))
			.with(requestId({ header: 'x-trace-id' })),
	{ apiVersion: apiVersionValue, clientVersion: 1, hot },
)

const stateStatus = api.session.getState().status
const isErrorState: boolean = stateStatus === 'error'
const sessionClear: () => void = () => {
	api.session.clear()
}
const sessionLoad: () => Promise<User | null> = () => api.session.load()

/*
 *   ENDPOINTS AND SCHEMAS
 ***************************************************************************************************/
const userSchema: StandardSchemaV1<unknown, User> = {
	'~standard': {
		version: 1,
		vendor: 'public-api',
		validate: value => ({ value: value as User }),
	},
}

// Vars come from the path literal: this endpoint asks for { id }
const getUser = defineEndpoint({
	method: 'GET',
	path: '/users/:id',
	response: userSchema,
	tags: vars => [`user:${vars.id}`],
})

const updateUser = defineEndpoint<{ id: string; name: string }, User>({
	method: 'PATCH',
	path: '/users/:id',
	body: vars => ({ name: vars.name }),
	invalidates: vars => [`user:${vars.id}`],
})

const search = defineEndpoint({ method: 'POST', path: '/search', cacheable: true })

const typedGetUser: Endpoint<{ readonly id: string | number }, User> = getUser

async function endpoints(file: Blob): Promise<void> {
	const user: User = await api.call(getUser, { id: '7' })
	const key: string = api.getKey(getUser, { id: '7' })

	api.invalidate(key)
	api.setData<User>(key, current => ({ ...(current ?? user), name: 'Ada' }))
	await api.get('/fresh', { meta: { cache: 'refresh', timeoutMs: 1_000 } })
	await api.post('/sign-in', { user: 'ada' }, { meta: { session: 'bypass' } })
	await api.call(search, undefined, { tags: ['search'] })
	await uploadWithProgress(api, '/avatars', file, { onProgress: event => event.percent })
	await api.upload('/avatars', file)

	const count: number = api.getCacheSize() + api.getInFlightCount() + api.getQueueDepth()
	const active: number = api.getActiveCount() + api.getObservedCount()

	void [count, active, typedGetUser]
}

/*
 *   PATH PARAMS
 ***************************************************************************************************/
async function pathParams(): Promise<void> {
	await api.get('/users/:id', { params: { id: 7 } })
	await api.get('/users/:id/posts/:postId', { params: { id: 7, postId: 'a' } })
	await api.get('/health')
	// @ts-expect-error a path with no placeholders takes no params
	await api.get('/health', { params: { id: 1 } })
	await api.get('/models/gemini-pro:generate')
	await api.get('/tags/::literal')
	await api.post('/users/:id', { name: 'Ada' }, { params: { id: 7 } })

	// @ts-expect-error a placeholder with no value is a compile error
	await api.get('/users/:id')
	// @ts-expect-error the wrong name is too
	await api.get('/users/:id', { params: { userId: 7 } })
	// @ts-expect-error a second placeholder is required as well
	await api.get('/users/:id/posts/:postId', { params: { id: 7 } })
}

const params: PathParamsOf<'/a/:b/:c'> = { b: 1, c: 'two' }

/*
 *   REACT
 ***************************************************************************************************/
const hooks = createHooks(api)

function component(id: string) {
	const query = hooks.useRequest(
		getUser,
		{ id },
		{ keepPreviousData: true, refetchOnFocus: true },
	)
	const fresh: boolean = !query.isStale
	const updatedAt: number = query.updatedAt
	const mutation = hooks.useMutation(updateUser)
	const fallback = hooks.useMutation<User, { name: string }>(
		vars => api.post<User>('/users', vars),
		{ invalidates: ['users'] },
	)
	const message: string | undefined = mutation.error?.message
	const outcome = async (): Promise<string> => {
		const result = await fallback.mutate({ name: 'Ada' })

		return result.error === null ? result.data.name : result.error.code
	}
	const session = hooks.useSession()

	return { fresh, updatedAt, message, outcome, status: session.status }
}

/*
 *   TOOLING ENTRIES
 ***************************************************************************************************/
const devtools = attachDevtools(api, { expose: false })
const server = createMockServer({ baseUrl: 'https://api.example.com/v1' })

server.post('/users', status(201, { id: '2', name: 'Ada' }))
devtools.detach()
clearSharedClients()

export {
	code,
	retryAfterMs,
	requestIdOnError,
	narrowed,
	retired,
	isErrorState,
	sessionClear,
	sessionLoad,
	endpoints,
	pathParams,
	params,
	component,
	devtools,
	server,
}
