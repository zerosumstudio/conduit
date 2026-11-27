# <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zerosumstudio/conduit/main/.github/assets/zerosum-on-dark.png"><img src="https://raw.githubusercontent.com/zerosumstudio/conduit/main/.github/assets/zerosum-on-light.png" alt="" height="32"></picture> Conduit

[![npm version](https://badge.fury.io/js/@zerosumstudio%2Fconduit.svg)](https://badge.fury.io/js/@zerosumstudio%2Fconduit)
[![Release](https://github.com/zerosumstudio/conduit/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/zerosumstudio/conduit/actions/workflows/release.yml)
[![codecov](https://codecov.io/gh/zerosumstudio/conduit/branch/main/graph/badge.svg)](https://codecov.io/gh/zerosumstudio/conduit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A data-fetching client for micro frontends. One client is shared by every bundle on the page, so four remotes asking for the same thing make one request, read one cache and share one session. Sharing goes through a global registry rather than a framework provider, so it works whichever framework each bundle is built with. Caching, request sharing, retry, queueing, timeouts and a session are plugins you add with `.with()`, and each one adds its methods to the client's type.

Coming from `@bkincz/conduit` 2.0? See the [migration guide](./docs/migration-1.0.md).

## Install

```bash
pnpm add @zerosumstudio/conduit
```

Requires Node 26 or newer, and the package is ESM-only. It has no dependencies. React 18 or newer is an optional peer, needed only for `@zerosumstudio/conduit/react`.

Up to 2.0.0 this was published as `@bkincz/conduit`.

## Quick start

```ts
import { createClient, defaults } from '@zerosumstudio/conduit'

interface User {
	id: number
	name: string
}

export const api = defaults(createClient({ baseUrl: '/api' }), {
	cache: { ttlMs: 30_000, staleMs: Infinity },
})

const user = await api.get<User>('/users/:id', { params: { id: 7 } })

await api.post('/users', { name: 'Ada' })
```

`defaults()` installs the standard stack in the order the layers need to be in. Reach for `.with()` only for something it can't express. `session` is installed only when you pass it, and `retry: false` or `timeout: false` leaves those two out.

```
observable → cache → dedupe → session → retry → queue → timeout → transport
```

The entries are `@zerosumstudio/conduit`, `/react`, `/devtools`, `/testing` and `/upload`.

## Requests

`get`, `head`, `delete`, `post`, `put`, `patch` and `request` for anything else. `post`, `put` and `patch` take the body as the second argument. A string or a `BodyInit` is sent as it is, and anything else is JSON-encoded with a matching `content-type`. A body on `GET` or `HEAD` rejects with `INVALID_ARGUMENT`.

```ts
const users = await api.get<User[]>('/users', { query: { role: ['admin', 'staff'], page: 2 } })
const { status, headers, from } = await api.get<User[]>('/users').response()
const { data, error } = await api.get<User[]>('/users').safe() // never throws
```

`.response()` resolves the whole record: `status`, `headers`, `data`, `from` (`'network' | 'cache' | 'stale' | 'dedupe'`), `attempt`, `raw` and `request`. `.safe()` resolves `{ data, error: null }` or `{ data: null, error }`, so `error === null` narrows `data`. A bare request that nobody awaits and that fails is an unhandled rejection. `.safe()` and `.response()` stay silent.

| Option        | Description                                                                    |
| ------------- | ------------------------------------------------------------------------------ |
| `params`      | Fills `:name` placeholders in the path                                         |
| `query`       | Query values. Arrays repeat the key, and `null` and `undefined` are skipped    |
| `headers`     | Per request headers, merged over the client's                                  |
| `signal`      | Your own `AbortSignal`                                                         |
| `key`         | Override the derived cache and dedupe key                                      |
| `lane`        | `critical`, `default`, `prefetch`, or your own. See [queue](#queue)            |
| `owner`       | Who issued it, surfaced in devtools and on errors                              |
| `tags`        | Labels for `invalidateTag`. They never switch caching on                       |
| `cacheable`   | Whether cache and dedupe may serve it. Defaults to `true` for `GET` and `HEAD` |
| `parse`       | How to decode the body, see below                                              |
| `credentials` | Fetch credential mode                                                          |
| `meta`        | Per request switches for plugins, such as `{ timeoutMs: 60_000 }`              |

`mode`, `redirect`, `cache`, `keepalive`, `priority`, `referrerPolicy` and `integrity` pass straight through to `fetch`, per request or as a client default. See [Redirects](#redirects) before setting `redirect`.

On the client:

| Option        | Description                                                                      |
| ------------- | -------------------------------------------------------------------------------- |
| `baseUrl`     | Prefixed to relative paths. A relative one needs a page, see [Origins](#origins) |
| `headers`     | An object, or a function read fresh on every request                             |
| `vary`        | Which headers count toward request identity. Defaults to `'*'`                   |
| `credentials` | Default credential mode                                                          |
| `owner`       | Default owner for this bundle                                                    |
| `lane`        | Default lane                                                                     |
| `parse`       | Default decode mode                                                              |
| `fetch`       | Swap the network implementation, for tests or instrumentation                    |
| `origins`     | Extra origins this client may call, see [Origins](#origins)                      |
| `redact`      | What events and `.response()` hide, see [Redaction](#redaction)                  |
| `logger`      | Where conduit's own diagnostics go. Defaults to `console`, see [Logger](#logger) |

### Path params

`:name` placeholders take a string or a number, URL-encoded. When the path is a literal, `params` is required and checked against it.

```ts
api.get('/users/:id', { params: { id: 7 } })
api.post('/orgs/:org/users', { name: 'Ada' }, { params: { org: 'acme' } })
api.get('/users/:id') // compile error: params is required
api.get('/users/:id', { params: { userId: 7 } }) // compile error: no such param
api.get('/users', { params: { id: 7 } }) // compile error: the path has no placeholders
```

A missing, empty, `null` or non-primitive param rejects with `INVALID_ARGUMENT` instead of producing `/users//invoices`, as do `.` and `..`. A colon that doesn't start a segment is literal (`/models/gemini:generate`), and `::name` is a literal segment that begins with a colon. Params are read as own properties only.

When you give the result type, as in `get<User>('/users/:id')`, TypeScript can't infer the path from the same call, so `params` stays optional and unchecked there and a missing one fails at run time. Use [`defineEndpoint`](#typed-endpoints) when you want the types to hold.

### Parse modes

`parse` is `auto` by default. Set it on the client, or per request, when the server's `content-type` can't be trusted.

| Mode          | Result                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| `auto`        | `none` for 204, 205 and 304. Else `json`, `text` or `blob` from the content type |
| `json`        | Parsed JSON. An empty body is `null`                                             |
| `text`        | A string                                                                         |
| `blob`        | A `Blob`                                                                         |
| `arrayBuffer` | An `ArrayBuffer`                                                                 |
| `formData`    | A `FormData`                                                                     |
| `none`        | `null`, without reading the body                                                 |

`auto` reads `json` when the content type contains `json`, `text` for `text/*`, XML and a missing content type, and `blob` for everything else. A body that doesn't decode as declared rejects with `PARSE_FAILED`. An error response never does: a 503 carrying an HTML page under a JSON content type keeps its status, and the text is its `body`.

## Typed endpoints

`defineEndpoint` names a request once, with its path params, query, body, tags and response schema, so it can be called and keyed without repeating any of that. `response` takes any [Standard Schema](https://standardschema.dev) validator, such as zod or valibot, or a plain function.

```ts
import { z } from 'zod'
import { defineEndpoint } from '@zerosumstudio/conduit'

const userSchema = z.object({ id: z.number(), name: z.string() })

export const getUser = defineEndpoint({
	method: 'GET',
	path: '/users/:id',
	response: userSchema,
	tags: vars => [`user:${vars.id}`],
})

const user = await api.call(getUser, { id: '7' }) // { id: number, name: string }
api.invalidate(api.getKey(getUser, { id: '7' }))
api.call(getUser, { userId: '7' }) // compile error: the path asks for { id }
```

Without type arguments, `vars` is read from the path literal: `{ id }` for `/users/:id`, and `void` for a path with none. Give `Vars` and `Result` yourself when the variables carry more than path params, and then `query` and `body` build the request from them.

```ts
export const searchUsers = defineEndpoint<{ term: string }, User[]>({
	method: 'POST',
	path: '/users/search',
	body: vars => vars,
	cacheable: true, // a POST that only reads
	tags: ['users'],
})
```

A failing schema or `response` function rejects with `VALIDATION_FAILED`, carrying the schema's issues as `body`, and the original as `cause` when a function threw. `invalidates` names the tags to invalidate after a mutation through [`useMutation`](#react).

## Cancelling

A scope is a cancellation boundary with the full request surface. Hand one to a remote on mount, and nothing it started outlives it.

```ts
const scope = api.scope('remote:profile')

scope.get('/settings')
scope.abort() // everything in flight through it stops, and the scope stays usable
scope.dispose() // the same, and the scope ends for good
```

Requests made through a scope carry its name as their `owner`. `api.abortAll()` aborts every scope and every request, and the client stays usable. A sign-out cancels only the session's own credentialed requests, never a scope.

## Request identity

Entries are keyed on method, url, body, decode mode, credentials mode, and the headers `vary` selects. Headers count by default, because two remotes calling `/me` under different tokens must not share an entry. Headers a session attaches never count, since an identity change already clears everything.

```ts
createClient({ vary: '*' }) // default, every header
createClient({ vary: ['x-tenant'] }) // only what changes the response
createClient({ vary: [] }) // url alone
```

Narrow it if you send a header that is unique per request, like a trace id. Under `'*'` that gives every request its own key, so nothing hits the cache or shares a flight. `api.getKey(path, options)` returns the key a request would get.

## Plugins

Each plugin is middleware that can also extend the client, and the extension shows up in the type. `api.invalidate()` doesn't compile until `cache()` is installed.

| Plugin       | Adds to the client                                                     | What it does                                                                       |
| ------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `observable` | `observe`, `getObservedCount`                                          | Per key state for framework bindings                                               |
| `cache`      | `invalidate`, `invalidateTag`, `clearCache`, `getCacheSize`, `setData` | LRU with a freshness window and optional stale serving, tag invalidation           |
| `dedupe`     | `getInFlightCount`                                                     | One request per key. Unmounting cancels your wait, not everyone else's             |
| `session`    | `session`                                                              | One session for the page, single-flight recovery, behind an adapter                |
| `retry`      |                                                                        | Backoff with jitter, honours `Retry-After`, idempotent requests only by default    |
| `queue`      | `getQueueDepth`, `getActiveCount`                                      | Bounded concurrency with priority lanes                                            |
| `timeout`    |                                                                        | A deadline per attempt, failing with `TIMEOUT`                                     |
| `apiVersion` |                                                                        | Reports once when this bundle and the API disagree on version. Not in `defaults()` |
| `requestId`  |                                                                        | Sends an id with every attempt and puts it on errors. Not in `defaults()`          |

A request can step around a layer through `meta`:

```ts
api.get('/live', { meta: { cache: 'bypass', dedupe: 'bypass' } })
api.get('/fresh', { meta: { cache: 'refresh' } }) // skip the read, keep the result
api.get('/slow', { meta: { timeoutMs: 60_000 } }) // 0 turns the timeout off
api.get('/urgent', { meta: { queue: 'bypass' } })
api.post('/auth/sign-in', { email: 'ada@example.com' }, { meta: { session: 'bypass' } })
```

### cache

| Option    | Description                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ttlMs`   | How long a response is fresh. Defaults to `30_000`                                                                                                   |
| `staleMs` | How long past `ttlMs` a response is still served, as `from: 'stale'`, while one refresh runs behind it. Defaults to `0`, and `Infinity` means always |
| `max`     | Entry cap. Defaults to `200`, and the least recently read entry goes first                                                                           |

```ts
const previous = api.setData(api.getKey('/users/:id', { params: { id: 7 } }), (user?: User) => ({
	id: 7,
	name: 'Ada',
	...user,
}))

api.invalidate(api.getKey('/users/:id', { params: { id: 7 } })) // one entry
api.invalidateTag('users') // every entry carrying the tag, returns how many
api.clearCache()
```

The cache stores what `cacheable` allows, which is `GET` and `HEAD` unless a request or endpoint says otherwise. Set `cacheable: true` on a `POST` that only reads, such as a search, and `false` to keep a `GET` out. `tags` are labels for `invalidateTag` and nothing else, so a tagged `POST` that writes is never cached or shared. A response with `cache-control: no-store` or `no-cache` is not stored.

Invalidating an entry or a tag reaches every mounted hook that shows it, and they refetch. `setData` writes the entry and those hooks directly, and hands back the previous value for a rollback. Cached and shared bodies are deeply frozen, since every reader holds the same object.

### dedupe

One request per key, however many callers ask for it, for every `cacheable` request. It takes no options. The shared request is cancelled only when its last participant leaves, so one remote unmounting cancels its own wait and nobody else's. `getInFlightCount()` reports the distinct requests in flight.

### retry

Replays a failed request with exponential backoff. It retries `NETWORK` and `TIMEOUT` failures, and `HTTP_STATUS` failures with a status in `statuses`.

| Option            | Description                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `attempts`        | Total attempts including the first. Defaults to `3`                                                       |
| `baseDelayMs`     | First backoff step. Defaults to `300`, and doubles each attempt                                           |
| `maxDelayMs`      | Ceiling for one step. Defaults to `5000`                                                                  |
| `maxRetryAfterMs` | The longest `Retry-After` honoured. A server asking for more gets no retry. Defaults to `30_000`          |
| `jitter`          | Spread each wait across its window. Defaults to `true`                                                    |
| `idempotentOnly`  | Replay only `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS` and `cacheable` requests. Defaults to `true`        |
| `statuses`        | Statuses worth another attempt. Defaults to `408`, `425`, `429`, `500`, `502`, `503` and `504`            |
| `shouldRetry`     | `(error, request, attempt) => boolean`. Replaces the built-in decision, except for a consumed stream body |
| `onRetry`         | Called with `{ request, error, attempt, delayMs }` before each wait                                       |

`Retry-After` seconds or a date is read into `error.retryAfterMs`. A `ReadableStream` body that was already consumed is never replayed.

### queue

Bounded concurrency with priority lanes, so a remote's speculative prefetching can't queue ahead of the host's boot path.

| Option        | Description                                                                      |
| ------------- | -------------------------------------------------------------------------------- |
| `concurrency` | Requests in flight at once. Defaults to `6`                                      |
| `lanes`       | Lane names, most urgent first. Defaults to `['critical', 'default', 'prefetch']` |
| `limits`      | Per lane ceilings, so one lane can't take the whole pool. Each at least `1`      |

Pick a lane per request or as a client default, and read `getQueueDepth(lane?)` and `getActiveCount()` for what is waiting and running. A `concurrency` or limit that isn't a whole number of at least `1` throws `INVALID_ARGUMENT`.

### timeout

`timeout({ ms })` cancels a request that takes longer than `ms` (`15_000` by default) with `TIMEOUT` instead of a generic abort. It sits innermost, so each retry attempt gets its own clock. Override it with `meta: { timeoutMs }`, and `0` turns it off. `api.upload()` has no timeout by default, since a slow connection is not a hung one.

### session

conduit owns the hard parts, and the adapter owns whatever is specific to your backend. A cookie backend implements `load` and `identify`. A token backend adds `authorize` and `renew`.

```ts
import { createClient, defaults, withRequest, type SessionAdapter } from '@zerosumstudio/conduit'

interface Session {
	id: string
	token: string
	exp: number
}

const adapter: SessionAdapter<Session> = {
	load: async ctx => (await ctx.request<{ session: Session | null }>('/auth/session')).session,
	identify: session => session.id, // a different id resets everything held for the last one
	authorize: (request, session) => {
		const headers = new Headers(request.headers)

		headers.set('authorization', `Bearer ${session.token}`)

		return withRequest(request, { headers })
	},
	renew: async ctx =>
		(await ctx.request('/auth/refresh', { method: 'POST' }).safe()).error === null,
	expiresAt: session => session.exp * 1000,
	onClear: () => tokens.clear(), // whatever you hold outside conduit
}

const api = defaults(createClient({ baseUrl: '/api' }), {
	session: { adapter, channel: 'app.session' },
})

api.session.getState() // { status, session, error, updatedAt }
api.session.subscribe(state => render(state))
await api.session.load()
```

| Adapter method      | Called                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `load`              | To read the session. `null` means signed out, which is not an error                                           |
| `identify`          | After every read. Required, and a changed value resets cache, dedupe and observed state                       |
| `authorize`         | On every request to the API origin or `session({ origins })`, and never elsewhere. Only called with a session |
| `renew`             | Once per 401 on a credentialed request, however many hit it together. `false` gives up                        |
| `expiresAt`         | Epoch milliseconds, to schedule a read `refreshLeewayMs` before the session lapses                            |
| `isUnauthenticated` | Optional. Whether a failure means the session is at fault. Defaults to HTTP 401                               |
| `onClear`           | After `session.clear()` and after a session is lost, once local state is gone                                 |

`session()` throws `INVALID_ARGUMENT` at install when the adapter has no `identify`. The adapter's `ctx.request` skips the session, the cache and dedupe, and runs in the `critical` lane.

| Option              | Description                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `adapter`           | The adapter above                                                                                           |
| `autoLoad`          | Read the session when the plugin installs. Defaults to `false`                                              |
| `refreshLeewayMs`   | Read again this long before `expiresAt`. Defaults to `60_000`                                               |
| `origins`           | Extra origins that receive credentials. They must be in the client's `origins` too                          |
| `channel`           | A `BroadcastChannel` name that makes other tabs and bundles re-read when this one signs out or changes user |
| `onUnauthenticated` | Called once per lost session                                                                                |

The state is a union on `status`:

| `status`        | `session`   | Meaning                                                                                  |
| --------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `unknown`       | `null`      | Never read, or `clear()` ran                                                             |
| `loading`       | kept        | A read is in flight. The previous session and error stay visible                         |
| `authenticated` | the session | A read found one                                                                         |
| `anonymous`     | `null`      | A read found nobody, or the session was lost, and then `error.code` is `UNAUTHENTICATED` |
| `error`         | kept        | A read failed. A previous session keeps being used                                       |

Nothing about the session is sticky. A 401 on a credentialed request triggers one renewal, however many requests hit it together, and then a replay. When renewal fails, the session is `anonymous` with `UNAUTHENTICATED`, the session's in-flight credentialed requests are cancelled and reject `UNAUTHENTICATED`, cached data is dropped, and `onUnauthenticated` fires once. Later requests go out without credentials until a read finds a session. A 401 on a request that carried none, such as a failed sign-in, is an ordinary `HTTP_STATUS`.

`load()` returns a known session, signed in or not, without a request, and otherwise joins the read in flight. `reload()` always starts a new read, the latest wins, and older results are dropped. Call `reload()` after signing in. `clear()` drops local state without telling the server and cancels the session's credentialed requests with `ABORTED`, as does a change of user. A token adapter waits for its first read, and a request rejects with the load error if that fails with no previous session. A cookie adapter has no `authorize`, so it doesn't wait. Call `load()` at boot, or pass `autoLoad: true`, before a 401 can mean a lost session. A failed read is `UNKNOWN` with the original as `cause`.

Pass `meta: { session: 'bypass' }` on sign-in, sign-up and refresh calls so they skip `authorize` and 401 handling. With a `channel`, a sign-out, a lost session or a change of user in one tab makes every other tab re-read. Without it each tab learns on its next rejected request. A message carries no session or identity, so a forged one only causes a read.

### observable

`observe(key)` returns the live [store](#any-other-framework) of one key, created on first call and shared by every watcher, so two remotes rendering the same query watch one object. `max` (default `200`) caps the keys held, and a watched key is never evicted.

```ts
const store = api.observe<User>(api.getKey('/users/:id', { params: { id: 1 } }))

store.getState() // { status, data, error, from, isFetching, updatedAt, invalidatedAt }
```

`status` is `idle`, `loading`, `success` or `error`. `from` is where the last answer came from, and `stale` means it was served past its ttl while a refresh ran.

### apiVersion

`apiVersion({ expected })` reports once per server version when a response's `x-api-version` header isn't `expected`, including on error responses, since a deployment that moved on often fails first. Pass `header` to read another header, and `onMismatch` to route the report. The default report goes through `config.logger`, and the `api-version:mismatch` event carries it as well.

```ts
import { apiVersion } from '@zerosumstudio/conduit'

export const api = defaults(createClient({ baseUrl: '/api' })).with(apiVersion({ expected: 'v2' }))
```

This is separate from the `apiVersion` option of [`sharedClient`](#one-client-across-bundles), which compares what two bundles were built against.

### requestId

`requestId()` sends an id with every attempt and records it, so a failure on screen leads to the server's log line. Install it after `defaults()`, so it sits innermost: the id never reaches a cache key, and each retry goes out with its own. A header the caller already set is kept.

```ts
import { requestId } from '@zerosumstudio/conduit'

const traced = api.with(requestId({ header: 'x-request-id' }))

const { error } = await traced.get('/users').safe()

error?.requestId // the id the failing attempt went out with
```

`header` defaults to `x-request-id` and `generate` to `crypto.randomUUID()`. The id is on `ConduitError.requestId`, `request.meta.requestId` and each devtools entry.

## One client across bundles

Each federated bundle gets its own module instance, so a client built in the host is invisible to a remote. A registry on `globalThis` fixes that.

```ts
import { createClient, defaults, sharedClient } from '@zerosumstudio/conduit'

export const api = sharedClient('app.api', () => defaults(createClient({ baseUrl: '/api' })), {
	apiVersion: 'v1',
	clientVersion: 1,
})
```

The first caller builds the client, and everyone else gets that instance. A later caller's factory never runs, which is what `apiVersion` and `clientVersion` warn you about: they report a bundle built against another API version, another client shape, or another conduit version, through `onMismatch` or the logger. With Module Federation, share `@zerosumstudio/conduit` as a singleton so only one copy loads.

The registry key includes the major version, so a 1.0 bundle never receives a client built by 2.0. A page that mixes the two runs two clients, each with its own cache and session.

Tearing one down means deregistering it too, or the next bundle to ask gets a replacement and a warning:

```ts
api.destroy()
releaseSharedClient('app.api')
```

`getSharedClient(key)` reads one without creating it. Under Vite, pass `hot` so a reload during development gets a fresh client:

```ts
export const api = sharedClient('app.api', () => defaults(createClient({ baseUrl: '/api' })), {
	hot: import.meta.hot,
})
```

`hot.dispose` runs `destroy()` and `releaseSharedClient()` for you. A shared client lets every bundle on the page use it, with its session. See [Security](#security).

## React

```ts
// api.ts
import { createHooks } from '@zerosumstudio/conduit/react'

export const { useRequest, useMutation, usePrefetch, useSession } = createHooks(api)
```

```tsx
function Profile({ id }: { id: string }) {
	const { data, error, isLoading } = useRequest<User>('/users/:id', { params: { id } })

	if (isLoading) return <Spinner />
	if (error) return <ErrorCard code={error.code} />

	return <Card user={data!} />
}
```

`createHooks` takes a client with `observable()` installed, which `defaults()` does. There is no provider: the hooks bind to a client at module scope, so every remote importing them shares it.

| Field           | Description                                                           |
| --------------- | --------------------------------------------------------------------- |
| `data`, `error` | The current answer, and a `ConduitError` when it failed               |
| `status`        | `idle`, `loading`, `success` or `error`                               |
| `isLoading`     | Nothing on screen yet and a request is in the air                     |
| `isFetching`    | A request is in the air, with or without data showing                 |
| `isStale`       | The data on screen was served stale, and a refresh is running         |
| `updatedAt`     | When the data arrived, in epoch milliseconds. `0` before anything has |
| `refetch()`     | Fetch again, past the cache, and store the answer                     |

Options are the request's own, plus these:

| Option               | Description                                                             |
| -------------------- | ----------------------------------------------------------------------- |
| `enabled`            | Hold off until a dependency is ready. Defaults to `true`                |
| `keepPreviousData`   | Keep showing the last answer while a new key loads. Defaults to `false` |
| `refetchOnFocus`     | Refetch when the tab becomes visible. Defaults to `false`               |
| `refetchOnReconnect` | Refetch when the browser comes back online. Defaults to `false`         |

The hooks never abort. A request that was superseded by a new key, or that outlived its component, finishes and fills the cache, so unmounting is cheap and StrictMode's second effect joins the first run instead of putting a duplicate on the wire. To cancel, pass your own `signal` or make the request through a [scope](#cancelling).

Two components rendering the same query share one store and one request, and the second to mount renders what the first already fetched. When an entry is invalidated, every hook showing it refetches. The hook re-subscribes when the key changes, not when the options object does, so a fresh `params` object every render costs nothing. `refetchOnFocus` and `refetchOnReconnect` read from the cache when its entry is fresh, and only `refetch()` goes past it.

`enabled` is how one query waits on another, and a missing param leaves the hook idle:

```tsx
function Invoices() {
	const { data: user } = useRequest<User>('/me')

	const { data: invoices, isFetching } = useRequest<Invoice[]>('/users/:id/invoices', {
		params: user ? { id: user.id } : undefined,
		enabled: user !== undefined,
	})

	return <List rows={invoices ?? []} busy={isFetching} />
}
```

Endpoints work everywhere a path does: `useRequest(getUser, { id })` and `useMutation(updateUser)`, with the endpoint's `tags` and `invalidates` applied. Give `useRequest` an endpoint that isn't `cacheable` and development warns.

`useMutation` takes the request to run rather than a path, so a scope, a lane or two calls in one mutation are all fair game. `mutate` never rejects. It resolves the same `SafeResult` as `.safe()`, after the tags in `invalidates` are invalidated, and the latest call owns the hook's state.

```tsx
function NewUser() {
	const { mutate, isPending, error } = useMutation(
		(variables: { name: string }) => api.post<User>('/users', variables),
		{ invalidates: ['users'] },
	)

	async function handleSubmit(name: string) {
		const { data, error } = await mutate({ name })

		if (error === null) navigate(`/users/${data.id}`)
	}

	return <Form onSubmit={handleSubmit} busy={isPending} error={error?.message} />
}
```

It returns `mutate`, `status` (`idle`, `pending`, `success` or `error`), `data`, `error`, `isPending` and `reset`.

`usePrefetch` returns a function that warms the cache in the `prefetch` lane, so the queue serves it behind anything on screen:

```tsx
function UserRow({ id }: { id: string }) {
	const prefetch = usePrefetch()

	return <Row onMouseEnter={() => prefetch('/users/:id', { params: { id } })} />
}
```

`useSession` returns the page's one session state, typed as your session. Every remote calling it follows the same state, so a lost session signs the whole page out at once. It throws `INVALID_ARGUMENT` when the client has no `session` plugin.

```tsx
function Nav() {
	const { status, session } = useSession()

	if (status === 'unknown' || status === 'loading') return <Spinner />
	if (status === 'anonymous') return <SignIn />
	if (status === 'error') return <Retry onClick={() => void api.session.reload()} />

	return <Avatar name={session.id} />
}
```

## Any other framework

Everything observable is a store with two methods, `getState()` and `subscribe(listener)`. `subscribe` returns an unsubscribe function and does not call the listener on subscribe, so read `getState()` first. That is `useSyncExternalStore`'s contract, and not Svelte's, which expects the current value on subscribe. In Svelte, wrap the store:

```ts
import { readable } from 'svelte/store'

const store = api.observe<User>(api.getKey('/users/:id', { params: { id: 1 } }))

export const user = readable(store.getState(), set => store.subscribe(set))
```

`api.session`, `api.observe(key)` and `devtools.store` are all this shape.

## Uploads

`api.upload(path, body, options)` posts a `FormData` or `Blob` with no default timeout, through the same middleware stack and `config.fetch` as any request, mock servers included.

```ts
await api.upload('/avatars', file)
```

For progress events, use `uploadWithProgress` from `@zerosumstudio/conduit/upload`. `fetch` has no event for upload progress, so this one request goes through `XMLHttpRequest`, and session, retry, the queue and the origin check still apply.

```ts
import { uploadWithProgress } from '@zerosumstudio/conduit/upload'

await uploadWithProgress(api, '/avatars', file, {
	onProgress: ({ loaded, total, percent }) => setProgress(percent ?? 0),
})
```

`total` and `percent` are `undefined` when the server doesn't report a length. `XMLHttpRequest` can't refuse a redirect and can't leave out same-origin cookies, so a progress upload rejects with `INVALID_ARGUMENT` when it carries a custom credential header and `redirect` isn't `'follow'`, and when `credentials` is `'omit'`. `Authorization` and cookies are fine. See [Redirects](#redirects).

## Events and devtools

One shared client sees traffic from every remote on the page, which is what makes "who issued this" answerable. Request, cache, dedupe, retry, queue, session and API version events publish on `api.events`, and nothing is built while nothing is listening. A remote can listen and nothing else: it can't clear another bundle's listeners or publish events.

```ts
api.events.on('request:error', ({ request, error }) => {
	reportToTelemetry(`${request.owner} ${error.code} ${error.requestId}`)
})
```

`on(type, listener)` and `onAny(listener)` return an unsubscribe function. A listener that throws is reported through the logger and never fails a request.

```ts
import { attachDevtools } from '@zerosumstudio/conduit/devtools'

const devtools = attachDevtools(api)

devtools.store.subscribe(state => render(state)) // entries, inFlight, counters, session, isSessionLost
devtools.detach()
```

Devtools read the event stream and nothing else. Entries carry the owner, lane, status, `durationMs` and `requestId`, and query strings are stripped from urls and keys. In a development build the handle also lands on `globalThis.__CONDUIT_DEVTOOLS__` for console poking, and `getDevtools()` reads it. Pass `expose: false` to opt out, or `expose: true` to keep it in production. `max` (default `100`) caps the finished entries kept.

## Errors

Everything rejects with a `ConduitError` carrying a `code`, plus `status`, `url`, `method`, `owner`, `requestId`, `retryAfterMs` and `cause` where they apply. Errors are not subclassed, so check `error.code`.

```ts
import { isConduitError, isErrorCode } from '@zerosumstudio/conduit'

const { error } = await api.get<User[]>('/users').safe()

if (isErrorCode(error, 'TIMEOUT')) retryLater()
if (isErrorCode(error, 'HTTP_STATUS') && error.status === 404) showEmptyState()
```

Use `isConduitError(value)` and not `instanceof ConduitError`. Two bundles that each carry a copy of conduit have two `ConduitError` classes, and `instanceof` is false across them. `isConduitError` checks a brand that holds across copies.

| Code                  | Raised when                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `HTTP_STATUS`         | The server answered with a failing status. `status`, `headers` and the decoded `body` are set                  |
| `NETWORK`             | The request never reached a server: DNS, offline, CORS or TLS                                                  |
| `TIMEOUT`             | The request exceeded its deadline                                                                              |
| `ABORTED`             | A caller, a scope, `abortAll`, a change of user or a destroyed client cancelled it                             |
| `PARSE_FAILED`        | A body arrived that doesn't decode as the parse mode says                                                      |
| `VALIDATION_FAILED`   | An endpoint's `response` schema or function rejected the body. The issues are the error's `body`               |
| `UNAUTHENTICATED`     | The session was lost and could not be recovered                                                                |
| `REDIRECT_BLOCKED`    | A request carrying a credential was answered with a redirect, see [Redirects](#redirects)                      |
| `ORIGIN_REJECTED`     | A url resolved outside the origins this client may call, see [Origins](#origins)                               |
| `INVALID_ARGUMENT`    | conduit was used wrong: a bad param, a body on `GET`, a bad `origins` entry, a relative `baseUrl` with no page |
| `DESTROYED`           | The client was destroyed                                                                                       |
| `DUPLICATE_PLUGIN`    | A plugin was installed twice                                                                                   |
| `EXTENSION_COLLISION` | A plugin tried to add a name the client already has                                                            |
| `UNKNOWN`             | Something threw that conduit can't classify                                                                    |

`body` and `headers` are readable but not enumerable, so a logger that walks properties doesn't print them. `toJSON()` omits them as well, and messages carry the url without its query string. `toConduitError(value, code?, message?)` coerces anything thrown. A conduit error passes through, and a recode keeps the original as `cause`. `ConduitErrorCode` is the type of `code`.

### Logger

`logger` is where conduit reports what nobody is awaiting: a listener that threw, a background cache refresh that failed, a failed renewal, a background session read, and development warnings. Every message is prefixed `[conduit]`.

```ts
createClient({
	baseUrl: '/api',
	logger: {
		warn: message => telemetry.warn(message),
		error: message => telemetry.error(message),
	},
})
```

## Testing

`@zerosumstudio/conduit/testing` mocks at the transport, so cache, dedupe, retry, the queue and session recovery all run for real, and the request's `signal` is honoured the way `fetch` honours it.

```ts
import {
	clearSharedClients,
	createMockServer,
	delay,
	networkError,
	status,
} from '@zerosumstudio/conduit/testing'

const server = createMockServer({ baseUrl: 'https://api.example.com' })

server.get('/users/:id', request => ({ id: request.params.id }))
server.post('/users', status(201, { id: 2 }))
server.get('/flaky', status(503), { times: 1 }) // fails once, then falls through
server.get('/slow', delay(500, { ok: true }))
server.get('/down', networkError())

const api = defaults(createClient({ baseUrl: 'https://api.example.com', fetch: server.fetch }))

afterEach(() => {
	server.reset()
	clearSharedClients()
})
```

A responder is a function or a value: a `Response` as it is, an `Error` as a network failure, `undefined` as a 204, a string, `Blob`, `FormData` or stream as the body, and anything else as JSON. One that throws answers 500 with `{ message }`. Routes match the request's pathname, the last route registered wins, and a route used up by `times` falls through to the earlier ones.

Unmatched requests fail where they were made and name what is registered, unless you pass `onUnmatched: 'notFound'` to `createMockServer`. `server.calls` has everything that arrived, with an absolute `url`. A custom `fetch` you write yourself also receives an absolute url, so match on `new URL(input).pathname`, not on `input.startsWith('/api')`.

A relative `baseUrl` needs a page. In a node test environment, pass an absolute one as above, or use jsdom. Testing the hooks while conduit is linked from a sibling checkout (`link:` or `pnpm link`) needs `resolve.dedupe: ['react', 'react-dom']` in the consumer's vite or vitest config, or React resolves twice and every hook call fails.

## Security

What conduit enforces and what it leaves to the app is in [docs/threat-model.md](./docs/threat-model.md). The short version is below.

### Origins

Every url is resolved with `new URL` and compared as an origin, and what is sent is the url that was checked. A request may go to `baseUrl`'s origin, or the page's when `baseUrl` is relative, or an origin listed in `origins`. Anything else rejects with `ORIGIN_REJECTED` before a plugin runs, and the transport checks again, so a middleware that rewrites `url` can't leave the list either.

```ts
const api = createClient({ baseUrl: '/api', origins: ['https://cdn.example.com'] })

api.get('https://cdn.example.com/assets/logo.png') // fine, listed
api.get('https://evil.example.com/x') // rejected: ORIGIN_REJECTED
api.get('data:text/plain,hi') // rejected: ORIGIN_REJECTED, only http and https are sent
api.get('/../other') // rejected: ORIGIN_REJECTED, outside baseUrl's path
```

A relative path is always joined under `baseUrl`, so `//host/x` is a path on the API origin and never a host. Only an absolute url can name another origin, and it must be listed. A relative path has to stay inside `baseUrl`'s path prefix, a url with credentials in it is refused, and a path that reads as a scheme (`users:list`) is rejected with a hint to write `/users:list`. `origins` takes bare origins such as `https://host:8443`. A path, a query or a non-http scheme is `INVALID_ARGUMENT`, and a trailing slash is dropped.

A relative `baseUrl` (`'/api'`) means the page's own origin and needs a page. Without one, the first request fails with `INVALID_ARGUMENT`, so on a server pass an absolute `baseUrl`.

Static `headers` on the client go on every request, including those to a listed third-party origin. Only the session's `authorize` is scoped to the API origin, or to `session({ origins })`. Put a static credential in `headers` only when every origin in `origins` may see it, and attach it with `authorize` otherwise.

With a relative `baseUrl`, the API origin comes from the page's base url, so a `<base href>` that points at another origin moves it, and the session's credentials go with it. Plain `fetch` resolves the same way. Block it with a `base-uri 'self'` or `base-uri 'none'` directive in your content security policy.

### Redirects

A request that carries a credential the platform won't strip itself is sent with `redirect: 'manual'`, and a redirect answer rejects with `REDIRECT_BLOCKED`. Browsers and Node strip `Authorization` and `cookie` when a redirect crosses origins, and send every other header on, so a download endpoint that answers 302 to a CDN, or an open redirect, would receive an `x-api-key`.

A credential here is a header in the guard list: `DEFAULT_REDACT.headers`, anything in `redact.headers`, and every header the session's `authorize` adds or changes. Plain Bearer and cookie setups don't match, because the platform handles them, and keep following redirects.

```ts
api.get('/export', { headers: { 'x-api-key': key } }) // REDIRECT_BLOCKED on a 301, 302, 303, 307 or 308
api.get('/download', { headers: { 'x-api-key': key }, redirect: 'follow' }) // follows, on purpose
```

The rule covers same-origin redirects too, so a custom credential on an endpoint that really redirects needs `redirect: 'follow'`. The error carries `status` and `headers`, and the status is `0` in a browser, where a manual redirect is an opaque response. Retry never replays it. An explicit `redirect` on the request or the client always wins, and with `'manual'` a 3xx is an `HTTP_STATUS`. conduit never follows a redirect itself. A progress upload can't be blocked and fails closed, see [Uploads](#uploads).

### Redaction

Credentials are visible to the plugin chain that attaches them and to nothing else. `.response()`, every event, devtools and error urls show a credential header as `[redacted]` and the value of a secret query parameter as `[redacted]`. A header the session's `authorize` sets is hidden too, whatever the list says.

```ts
import { DEFAULT_REDACT } from '@zerosumstudio/conduit'

const api = createClient({
	baseUrl: '/api',
	redact: { headers: [...DEFAULT_REDACT.headers, 'x-tenant-token'], query: ['ticket'] },
})

const response = await api
	.get('/me?ticket=abc', { headers: { 'x-tenant-token': 'secret' } })
	.response()

response.request.headers.get('x-tenant-token') // '[redacted]'
response.request.url // '…/api/me?ticket=[redacted]'
```

`redact.headers` and `redact.query` each replace the defaults for what is displayed, and `[]` turns display redaction off for that list. The redirect and upload guards are not affected: their list is always `DEFAULT_REDACT.headers` plus `redact.headers` plus what `authorize` adds, so narrowing `redact` can't turn them off. Query names are matched case-insensitively, and a trailing `*` matches a prefix.

| List                     | Defaults                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_REDACT.headers` | `authorization`, `cookie`, `proxy-authorization`, `x-api-key`, `x-auth-token`, `x-csrf-token`, `x-xsrf-token`, `x-session-token`, `x-access-token`, `x-amz-security-token`                                                      |
| `DEFAULT_REDACT.query`   | `token`, `access_token`, `refresh_token`, `id_token`, `code`, `key`, `api_key`, `apikey`, `password`, `secret`, `signature`, `sig`, `client_secret`, `access-token`, `jwt`, `private_token`, `sessionid`, `x-amz-*`, `x-goog-*` |

`response.raw` is the platform's `Response`, with its real url. Don't log it. Secrets in a query string still travel in the url, into history, referrers and server logs, so put them in a header.

## Size

Minified and brotli compressed, including dependencies, from `pnpm size`. Plugins you don't import are tree-shaken away.

| Import                                                            | Size     |
| ----------------------------------------------------------------- | -------- |
| `{ createClient }` only                                           | 6.81 KB  |
| Core with `sharedClient`, cache, dedupe, retry, timeout and queue | 9.85 KB  |
| Everything from the main entry                                    | 12.62 KB |
| Errors only (`ConduitError`, `isConduitError`)                    | 291 B    |
| React bindings (`/react`)                                         | 2.18 KB  |
| Devtools (`/devtools`)                                            | 1.12 KB  |
| Testing (`/testing`)                                              | 1.63 KB  |
| Progress uploads (`/upload`)                                      | 651 B    |

## TypeScript

Types are inferred from the plugins you install, and each `.with()` widens the client's type with the plugin's API. `defaults()` returns the standard stack, and `DefaultClient & SessionApi<Session>` names it when a function takes the client.

```ts
import type { CacheApi, Client, SessionApi } from '@zerosumstudio/conduit'

function refresh(client: Client & CacheApi) {
	client.invalidateTag('users')
}

type AppClient = typeof api // Client & ObservableApi & CacheApi & DedupeApi & QueueApi & SessionApi<Session>
```

`ConduitMeta` takes your own `meta` keys through declaration merging, and `ConduitEventMap` takes your own events:

```ts
declare module '@zerosumstudio/conduit' {
	interface ConduitMeta {
		'my-plugin.skip'?: boolean
	}
}
```

`Client` is exported as a type. Create one with `createClient`. Also exported: `Plugin`, `PluginContext`, `Middleware`, `ConduitRequest`, `ConduitResponse`, `SafeResult`, `RequestOptions`, `PathParamsOf`, `PathVars`, `Endpoint`, `StandardSchemaV1`, `SessionAdapter`, `SessionState`, `QueryState`, `ConduitErrorCode`, `ConduitLogger`, `ClientEvents` and every event type.

## Upgrading to 1.0

1.0 is the first release under `@zerosumstudio`. Coming from `@bkincz/conduit` 2.0, the package is ESM-only on Node 26, error codes are renamed and split, a tagged `POST` is no longer cached on its own, the session has no sticky terminal state, and many options and methods are renamed. The [migration guide](./docs/migration-1.0.md) opens with a checklist and covers every change with a before and after. The full list is in the [changelog](./CHANGELOG.md).

## License

MIT © zerosum studio
