# Migrating from `@bkincz/conduit` 2.0 to `@zerosumstudio/conduit` 1.0

1.0 is the first release under `@zerosumstudio`. It is ESM-only on Node 26, renames and splits the error codes, stops caching a tagged `POST` on its own, removes the sticky session terminal state, makes redirects and origins stricter, and renames many options and methods. There is no compatibility layer, so every change below is yours to make. Most are mechanical.

This guide covers `@bkincz/conduit` 2.0.0. Older versions need the 2.0 changes first.

## Checklist

Work through these in order, then run the type checker and your tests.

1. Install `@zerosumstudio/conduit`, remove `@bkincz/conduit`, and change every import and any `declare module '@bkincz/conduit'`. Use Node 26 or newer.
2. Replace error code checks: `'HTTP_ERROR'` is `'HTTP_STATUS'`, `'PARSE'` is `'PARSE_FAILED'`, `'SCHEMA'` is `'VALIDATION_FAILED'`, and `'CONFIG'` is split. See [error codes](#error-codes).
3. Add `identify` to every session adapter, including a cookie adapter. See [session](#session).
4. Rename plugin options: `cache({ ttl, staleWhileRevalidate })` is `{ ttlMs, staleMs }`, `retry` delays take `Ms`, `session({ eager, refreshLeeway })` is `{ autoLoad, refreshLeewayMs }`, and `meta.timeout` is `meta.timeoutMs`. See [plugins](#plugins).
5. Rename client methods and state reads: `keyFor` is `getKey`, `cacheSize` is `getCacheSize`, and every store's `get()` is `getState()`, `api.session.get()` included. See [client](#client).
6. Add `cacheable: true` to every endpoint or request that reads through a `POST`. Tags no longer switch caching on. See [caching](#caching).
7. Rename `sharedClient` options: `{ contract, version }` is `{ apiVersion, clientVersion }`, and `contract()` is `apiVersion()`. See [shared client](#shared-client).
8. Update `redact` and `DEFAULT_REDACTED_HEADERS`. See [redaction](#redaction).
9. If a custom `fetch` or a test matches the request url, match on the pathname, since the url is always absolute. See [origins](#origins-and-urls).
10. Move `clearSharedClients` to `@zerosumstudio/conduit/testing`, and move `onProgress` uploads to `@zerosumstudio/conduit/upload`.
11. Check [behaviour changes](#behaviour-changes) against what your app relies on, especially hooks that used to abort and scopes that were killed by a sign-out.

## Package and runtime

| 2.0                                            | 1.0                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@bkincz/conduit`                              | `@zerosumstudio/conduit`. `@bkincz/conduit` stays on npm at 2.0.0                                      |
| ESM and CommonJS                               | ESM only. `require()` of the package works on Node 26                                                  |
| Node 22.12 or newer                            | Node 26 or newer (`engines.node` is `>=26`)                                                            |
| Entries `.`, `/react`, `/devtools`, `/testing` | Those, plus `/upload`                                                                                  |
| Internals exported from the main entry         | 21 value exports. Internals such as `compose`, `createRequest`, `createStore` and `deriveKey` are gone |
| `Client` a class                               | `Client` a type. Create one with `createClient`                                                        |

Jest setups that transform to CommonJS need `transformIgnorePatterns` to let the package through.

The shared client registry is separate from 2.0's. A page that loads both runs two clients, each with its own cache and session, so move every bundle on a page together.

## Error codes

Codes lose the `_ERROR` suffix and each has one meaning. `ERROR_CODES` is gone, so use the `ConduitErrorCode` type. Errors are not subclassed, so check `error.code`.

```ts
// before
if (error.code !== 'HTTP_ERROR') return null
```

```ts
// after
import type { ConduitError } from '@zerosumstudio/conduit'

const isStatusFailure = (error: ConduitError) => error.code === 'HTTP_STATUS'
```

| 2.0                                                           | 1.0                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| `HTTP_ERROR`                                                  | `HTTP_STATUS`                                         |
| `PARSE`                                                       | `PARSE_FAILED`                                        |
| `SCHEMA`                                                      | `VALIDATION_FAILED`                                   |
| `CONFIG` for misuse, bad params, a body on `GET`              | `INVALID_ARGUMENT`. A `GET` with a body was `NETWORK` |
| `CONFIG` for a rejected origin                                | `ORIGIN_REJECTED`                                     |
| `CONFIG` for a destroyed client                               | `DESTROYED`                                           |
| `CONFIG` for a duplicate plugin                               | `DUPLICATE_PLUGIN`                                    |
| `CONFIG` for an extension name clash                          | `EXTENSION_COLLISION`                                 |
| (none)                                                        | `REDIRECT_BLOCKED`, see [redirects](#redirects)       |
| `NETWORK`, `TIMEOUT`, `ABORTED`, `UNAUTHENTICATED`, `UNKNOWN` | Same                                                  |

A cancelled request keeps `ABORTED`. `ConduitError.retryAfter` is `retryAfterMs`, and `requestId` is new. `toConduitError(value, code?, message?)` can recode an error and keeps the original as `cause`.

Use `isConduitError(value)` for the check, as before. It holds across bundles that carry their own copy of conduit, where `instanceof` doesn't.

## Client

| 2.0                                                              | 1.0                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `api.keyFor(path, options)`                                      | `api.getKey(path, options)`                                                                       |
| `api.cacheSize()`                                                | `api.getCacheSize()`                                                                              |
| `api.inFlight()`                                                 | `api.getInFlightCount()`                                                                          |
| `api.queueDepth(lane?)`, `api.activeRequests()`                  | `api.getQueueDepth(lane?)`, `api.getActiveCount()`                                                |
| `api.observedKeys()`                                             | `api.getObservedCount()`                                                                          |
| `store.get()` on `observe(key)`, `api.session`, `devtools.store` | `store.getState()`                                                                                |
| `api.events` with `emit` and `clear`                             | `api.events` with `on`, `onAny` and `active`. Plugins keep the full bus on `PluginContext.events` |
| `ClientContext`, `EmptyExtension`                                | `PluginContext`, `NoExtension`                                                                    |
| Devtools `stop()`                                                | `detach()`                                                                                        |

```ts
// before
const state = api.session.get()
api.invalidate(api.keyFor('/users/:id', { params: { id } }))
```

```ts
// after
const state = api.session.getState()
api.invalidate(api.getKey('/users/:id', { params: { id: 7 } }))
```

`subscribe(listener)` on every store doesn't call the listener on subscribe, as before. In Svelte, wrap the store: `readable(store.getState(), set => store.subscribe(set))`. 2.0's README said Svelte reads it as is, and it didn't.

### Path params are typed

When the path is a literal, `params` is required and checked. A call that omitted `params`, or passed the wrong name, no longer compiles. Give the result type with `get<User>(path)` and `params` stays loose, and unchecked until run time.

```ts
// after
api.get('/users/:id', { params: { id: 7 } })
api.get('/users/:id', { params: { userId: 7 } }) // compile error: no such param
```

`defineEndpoint` without type arguments reads `Vars` from the path, so `defineEndpoint({ method: 'GET', path: '/users/:id' })` asks for `{ id }`. Give both type arguments to keep the old shape.

### Uploads

`api.upload(path, body, options)` no longer takes `onProgress`. Progress uploads moved to their own entry, which takes the `XMLHttpRequest` path out of the core bundle.

```ts
// before
await api.upload('/avatars', file, { onProgress: event => setProgress(event.percent) })
```

```ts
// after
import { uploadWithProgress } from '@zerosumstudio/conduit/upload'

await uploadWithProgress(api, '/avatars', file, {
	onProgress: event => setProgress(event.percent ?? 0),
})
```

`percent` and `total` are `undefined` when the server reports no length. A progress upload with a custom credential header rejects with `INVALID_ARGUMENT` unless `redirect: 'follow'` is set, and `credentials: 'omit'` is rejected too. See [redirects](#redirects).

## Plugins

| 2.0                                                                       | 1.0                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `cache({ ttl })`                                                          | `cache({ ttlMs })`                                                                |
| `cache({ staleWhileRevalidate: true })`                                   | `cache({ staleMs: Infinity })`. A number of ms is `staleMs` too                   |
| `cache({ shouldCache })`, `dedupe({ shouldDedupe })`                      | Gone. Use `cacheable` on the request or endpoint, or the `bypass` meta            |
| `dedupe(config)`, `defaults({ dedupe })`                                  | `dedupe()` takes no options and `defaults()` has no `dedupe` key                  |
| `retry({ baseDelay, maxDelay })`                                          | `retry({ baseDelayMs, maxDelayMs })`, plus `maxRetryAfterMs` (30 s)               |
| `RetryInfo.delay`, event `delay` and `reason`                             | `delayMs` and `code` (a `ConduitErrorCode`)                                       |
| `ConduitError.retryAfter`                                                 | `retryAfterMs`                                                                    |
| `meta: { timeout: 60_000 }`                                               | `meta: { timeoutMs: 60_000 }`                                                     |
| `CACHE_META`, `DEDUPE_META`, `QUEUE_META`, `SESSION_META`, `TIMEOUT_META` | Gone. Write the key: `meta: { cache: 'bypass' }`. Keys are typed on `ConduitMeta` |
| `contract({ expected })`                                                  | `apiVersion({ expected })`                                                        |
| Event `contract:mismatch`                                                 | `api-version:mismatch`                                                            |

```ts
// before
cache: { ttl: 30_000, staleWhileRevalidate: true }
```

```ts
// after
const api = defaults(createClient({ baseUrl: '/api' }), {
	cache: { ttlMs: 30_000, staleMs: Infinity },
})
```

Event fields changed with the names: `duration` is `durationMs`, `cache:stale`'s `revalidating` is `isRevalidating`, and `session:change`'s `terminal` is `isLost`. Devtools state follows: `duration` is `durationMs` and `sessionTerminal` is `isSessionLost`.

`retry` now also refuses to replay a `POST` or `PATCH` unless it is `cacheable`, and gives up on a `Retry-After` longer than `maxRetryAfterMs` instead of waiting for it.

## Caching

In 2.0 a request with `tags` was cached whatever its method. Two tagged `POST`s or `DELETE`s with the same body became one request at the server, so a tag meant for invalidation silently stopped writes from happening. In 1.0 `tags` are labels for `invalidateTag` and nothing else, and `cacheable` switches caching and request sharing on. It defaults to `true` for `GET` and `HEAD`.

```ts
// before
export const listSubmissions = defineEndpoint<ListVars, ListResponse>({
	method: 'POST',
	path: '/marked-assessments/list-submissions',
	body: vars => vars,
	tags: vars => ['submissions', `submissions:${vars.assessmentId}`],
})
```

```ts
// after
export const listSubmissions = defineEndpoint<{ assessmentId: string }, User[]>({
	method: 'POST',
	path: '/marked-assessments/list-submissions',
	body: vars => vars,
	cacheable: true, // this POST only reads
	tags: vars => ['submissions', `submissions:${vars.assessmentId}`],
})
```

Without `cacheable: true` an endpoint like this stops caching and stops sharing flights, and `useRequest` warns in development. A cacheable `POST` with a `FormData` or `Blob` body never shares an entry. `retry` treats a `cacheable` request as safe to replay.

`isStale` on a hook is now true only when the data was served stale while a refresh runs. It used to be true on any cache hit. Read `updatedAt` for when the data arrived.

## Session

The state is a union on `status`, with no sticky terminal state.

| 2.0                                                                                       | 1.0                                                                                                               |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `identify` optional                                                                       | Required. `session()` throws `INVALID_ARGUMENT` without it                                                        |
| `authorize(request, session \| null)`                                                     | `authorize(request, session)`, called only when signed in. Drop the null check                                    |
| `session({ eager, refreshLeeway })`                                                       | `session({ autoLoad, refreshLeewayMs })`                                                                          |
| `api.session.get()`                                                                       | `api.session.getState()`                                                                                          |
| After a failed renewal every in-scope request rejected `UNAUTHENTICATED` until `reload()` | The session is `anonymous` with `error.code === 'UNAUTHENTICATED'`, and later requests go out without credentials |
| Any 401 on an in-scope request ended the session                                          | Only a 401 on a request that carried credentials, after one renewal, does                                         |
| `reload()` joined a read in flight                                                        | It starts a new read, and the latest wins                                                                         |
| `load()` returned early after a terminal state                                            | It returns a known session without a request, and otherwise joins the read in flight                              |
| A lost session aborted every scope for good                                               | It cancels only the session's own credentialed requests. Scopes stay usable                                       |

```ts
// before
export const nextAuthSession: SessionAdapter<MmwSession> = {
	load: async ctx => {
		const response = await ctx.request<NextAuthSessionResponse>('/auth/session')

		if (!response.user) return null

		return { user: response.user, expires: response.expires ?? '' }
	},
	expiresAt: session => Date.parse(session.expires),
}
```

```ts
// after
import type { SessionAdapter } from '@zerosumstudio/conduit'

interface AppSession {
	user: { id: string }
	expires: string
}

interface SessionResponse {
	user?: { id: string }
	expires?: string
}

export const nextAuthSession: SessionAdapter<AppSession> = {
	load: async ctx => {
		const response = await ctx.request<SessionResponse>('/auth/session')

		if (!response.user) return null

		return { user: response.user, expires: response.expires ?? '' }
	},
	identify: session => session.user.id,
	expiresAt: session => Date.parse(session.expires),
}
```

A cookie adapter has no `authorize`, so it doesn't wait for its first read. Call `api.session.load()` at boot, or pass `autoLoad: true`, before a 401 can mean a lost session. Call `reload()` after signing in. A sign-in or refresh call that must skip `authorize` and 401 handling takes `meta: { session: 'bypass' }`. A failed first read is `UNKNOWN` with the original as `cause`.

`session({ channel })` is new and optional. It makes other tabs re-read when this one signs out or changes user.

## Origins and urls

| 2.0                                                                   | 1.0                                                                                                                               |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A string guard compared origins                                       | Every url resolves with `new URL` and is compared as an origin. What is sent is the checked href                                  |
| `//host/path` rejected with `CONFIG`                                  | A path under `baseUrl`, so it can't reach another host. Only an absolute url can name another origin, and it must be in `origins` |
| `/\host`, `data:` and similar spellings could go out                  | `ORIGIN_REJECTED`                                                                                                                 |
| A relative path could climb out of `baseUrl`'s path                   | It has to stay inside the prefix, or it is `ORIGIN_REJECTED`. A `.` or `..` param is `INVALID_ARGUMENT`                           |
| A path that reads as a scheme (`users:list`)                          | `ORIGIN_REJECTED` with a hint. Write `/users:list`                                                                                |
| `origins` compared as strings                                         | Bare origins, normalised at install. A path, query or non-http scheme is `INVALID_ARGUMENT`                                       |
| A relative `baseUrl` with no page passed through                      | `INVALID_ARGUMENT`. Pass an absolute `baseUrl` on a server or in a node test environment                                          |
| `request.url`, `MockCall.url` and a custom `fetch`'s input as written | Always the absolute href                                                                                                          |

A custom `fetch`, a dev mock or a test double that matched on the written path needs the pathname:

```ts
// before
const isSession = (input: string) => input.startsWith('/api/auth/session')
```

```ts
// after
const isSession = (input: string) => new URL(input).pathname.startsWith('/api/auth/session')
```

A check that used `input.includes('/api/auth/')` keeps working. The mock server matches on the pathname for you.

## Redirects

Node and every browser strip `Authorization` and `cookie` when a redirect crosses origins, and send any other header on. In 2.0 a same-origin download endpoint that answered 302 to a CDN, or an open redirect, therefore received an `x-api-key` or a CSRF token. In 1.0 a request carrying such a credential is sent with `redirect: 'manual'`, and a redirect answer rejects with `REDIRECT_BLOCKED`.

A credential here is a header in `DEFAULT_REDACT.headers`, one in `redact.headers`, or one the session's `authorize` sets. Plain Bearer and cookie setups don't match and keep following redirects. A static header outside the list, such as an `x-mmw-client` marker, isn't a credential.

```ts
// after
api.get('/download', { headers: { 'x-api-key': key }, redirect: 'follow' })
```

An explicit `redirect` on the request or the client always wins. The rule covers same-origin redirects too, so a custom credential on an endpoint that really redirects needs `redirect: 'follow'`. With an explicit `redirect: 'manual'`, a 3xx is an `HTTP_STATUS`.

## Redaction

`redact` is an object with a list for headers and one for query parameters.

```ts
// before
createClient({ redact: ['authorization', 'x-tenant'] })
```

```ts
// after
import { DEFAULT_REDACT, createClient } from '@zerosumstudio/conduit'

createClient({
	redact: { headers: [...DEFAULT_REDACT.headers, 'x-tenant'], query: [...DEFAULT_REDACT.query] },
})
```

- `DEFAULT_REDACTED_HEADERS` is `DEFAULT_REDACT.headers`, and the defaults are wider: `x-api-key`, `x-auth-token`, `x-csrf-token`, `x-xsrf-token`, `x-session-token`, `x-access-token` and `x-amz-security-token` join the three from 2.0.
- Secret query values are hidden too, in error urls, keys and events, from `DEFAULT_REDACT.query`.
- `redact.headers` still replaces the defaults for display only. The redirect and upload guards always use the defaults plus `redact.headers` plus what `authorize` sets.
- `redactRequest` is no longer exported.

## Shared client

```ts
// before
sharedClient('mmw.api', factory, { contract: 'v2', version: 2 })
```

```ts
// after
import { sharedClient } from '@zerosumstudio/conduit'

export const shared = sharedClient('mmw.api', () => createClient({ baseUrl: '/api' }), {
	apiVersion: 'v2',
	clientVersion: 2,
})
```

The options type is `SharedClientConfig`, and the `apiVersion` plugin replaces `contract()`. The mismatch kinds are `'conduit-version'`, `'api-version'` and `'client-version'`. `clearSharedClients` moved to the testing entry:

```ts
// after
import { clearSharedClients } from '@zerosumstudio/conduit/testing'

afterEach(() => {
	clearSharedClients()
})
```

## React

| 2.0                                                                   | 1.0                                                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `useRequest` aborted the previous request on a key change and unmount | It never aborts. A superseded request finishes and fills the cache. Cancel with a `signal` or a scope |
| `refetchOnFocus` fired on `focus` and `visibilitychange`              | `visibilitychange` only, through one shared listener, and it honours a fresh cache entry              |
| `useMutation().mutate` resolved `T \| undefined`, `error: unknown`    | It resolves a `SafeResult<T>`, `error` is `ConduitError \| undefined`, and `status` is new            |
| `useRequest` result                                                   | Adds `updatedAt`                                                                                      |
| `useSession` without the plugin                                       | Throws `INVALID_ARGUMENT`                                                                             |

```ts
// before
const result = await mutate({ name })

if (result === undefined) return showError()
```

```tsx
// after
function NewUser() {
	const { mutate } = useMutation((variables: { name: string }) =>
		api.post<User>('/users', variables),
	)

	async function handleSubmit(name: string) {
		const { data, error } = await mutate({ name })

		if (error !== null) return reportToTelemetry(error.message)

		navigate(`/users/${data.id}`)
	}

	return <Form onSubmit={handleSubmit} busy={false} error={undefined} />
}
```

A mutation that succeeds with no body resolves `{ data, error: null }`, which 2.0's `undefined` couldn't tell apart from a failure.

## Testing

`createMockServer` matches what a real `fetch` does:

| 2.0                                          | 1.0                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A string responder was JSON                  | A string is text. Anything else that isn't a body type is JSON                                    |
| The first matching route won                 | The last one registered wins, and a route used up by `times` falls through                        |
| A responder that threw was a `NETWORK` error | It answers 500 with `{ message }`. Return an `Error` for a network failure                        |
| The request's signal was ignored             | It is honoured, and `MockRequest.signal` is new                                                   |
| Routes matched the written path              | They match the pathname of the absolute url, and `MockRequest` has an absolute `url` and a `path` |
| `clearSharedClients` from the root           | From `@zerosumstudio/conduit/testing`                                                             |

Test environments that run on happy-dom or jsdom have a page, so a relative `baseUrl` keeps working. A node environment needs an absolute `baseUrl`.

## Behaviour changes

- A sign-out, or a lost session, no longer kills every scope. `scope.abort()` cancels what is in flight and the scope stays usable. Use `scope.dispose()` to end one. `api.abortAll()` keeps scopes usable too.
- A change of user and `session.clear()` cancel the session's in-flight credentialed requests with `ABORTED`.
- A 401 on an anonymous session, such as a failed sign-in, is an ordinary `HTTP_STATUS`.
- Messages, errors and events carry the url with secret query values hidden, and devtools strip the query entirely.
- The shared registry key is `Symbol.for('conduit.sharedClients.1')`.
- Logs use the `[conduit]` prefix, and every background failure goes through `config.logger`: a throwing listener, a failed background refresh, a failed renewal and a background session read.
- Sizes: core 6.81 KB and the full entry 12.62 KB brotli, from 6.0 and 11.7 KB. `/upload` is 651 B.

## Types

| 2.0                                                              | 1.0                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ClientContext`                                                  | `PluginContext`, with `notifyCacheChange` and `onCacheChange`       |
| `EmptyExtension`                                                 | `NoExtension`                                                       |
| `SharedClientOptions`                                            | `SharedClientConfig`                                                |
| `ContractMismatch`, `ContractConfig`, `ContractMismatchEvent`    | `ApiVersionMismatch`, `ApiVersionConfig`, `ApiVersionMismatchEvent` |
| `DefaultStack`                                                   | `DefaultClient`                                                     |
| `ConduitErrorCode` from `ERROR_CODES`                            | A union type                                                        |
| Event and devtools fields `duration`, `terminal`, `revalidating` | `durationMs`, `isLost`, `isRevalidating`                            |

## Plugin authors

- A plugin gets a `PluginContext`: `config`, `events` (the full bus), `request`, `dispatch`, `isApiOrigin`, `resetIdentity`, `onResetIdentity`, `notifyCacheChange` and `onCacheChange`. `abortAll` is no longer on it.
- `ConduitRequest.cacheable` is resolved once. Check it instead of method and tags.
- Report a failure nobody awaits through `ctx.config.logger`.
