# Changelog

## 1.0.0 - 2026-11-27

First release under `@zerosumstudio`. Everything below is a change from `@bkincz/conduit` 2.0.0, and the [migration guide](./docs/migration-1.0.md) opens with a checklist. The versions after this one are `@bkincz/conduit`.

### Breaking

- **Published as `@zerosumstudio/conduit`.** Swap the package name, the imports and any `declare module`. `@bkincz/conduit` stays on npm at 2.0.0.
- **ESM only, Node 26 or newer.** There is no CommonJS build. `require()` of the package works on Node 26.
- **Error codes are renamed and split.** `HTTP_ERROR` is `HTTP_STATUS`, `PARSE` is `PARSE_FAILED`, `SCHEMA` is `VALIDATION_FAILED`, and `CONFIG` becomes `INVALID_ARGUMENT`, `ORIGIN_REJECTED`, `DESTROYED`, `DUPLICATE_PLUGIN` or `EXTENSION_COLLISION`. `ERROR_CODES` is gone, so use the `ConduitErrorCode` type.
- **`cacheable` switches caching on, and `tags` are labels.** A tagged `POST` is no longer cached, so add `cacheable: true` to a `POST` that only reads. `shouldCache` and `shouldDedupe` are gone.
- **Stores read with `getState()`.** `get()` is renamed on `observe(key)`, `api.session` and `devtools.store`. `subscribe` doesn't call the listener, so Svelte needs `readable(store.getState(), set => store.subscribe(set))`.
- **Session `identify` is required**, and `authorize(request, session)` is only called with a session. `session()` throws `INVALID_ARGUMENT` without `identify`. `eager` is `autoLoad` and `refreshLeeway` is `refreshLeewayMs`.
- **The session has no sticky terminal state.** A lost session is `anonymous` with `error.code === 'UNAUTHENTICATED'`, and later requests go out without credentials. Only a 401 on a credentialed request, after one renewal, loses it. `reload()` starts a new read.
- **A sign-out no longer kills scopes.** `scope.abort()` cancels what is in flight and the scope stays usable. `scope.dispose()` ends it.
- **Redirects with a custom credential are blocked.** A request carrying a credential header the platform doesn't strip is sent with `redirect: 'manual'`, and a redirect rejects with `REDIRECT_BLOCKED`. Set `redirect: 'follow'` on an endpoint that really redirects.
- **Urls resolve through one origin policy.** Every url is checked as an origin and sent as the checked href, so `request.url` is always absolute and a custom `fetch` should match on the pathname. A relative path must stay under `baseUrl`, and `//host` is a path under it. A relative `baseUrl` with no page is `INVALID_ARGUMENT`.
- **Hooks never abort.** `useRequest` lets a superseded request finish and fill the cache, and `refetchOnFocus` listens to `visibilitychange` only. `useMutation().mutate` resolves a `SafeResult`.
- **`isStale` means served stale.** It is true only for a stale-while-revalidate serve, and `updatedAt` is new.
- **Options and methods are renamed.** `cache({ ttlMs, staleMs })`, `retry({ baseDelayMs, maxDelayMs })`, `meta.timeoutMs`, `getKey`, `getCacheSize`, `getInFlightCount`, `getQueueDepth`, `getActiveCount`, `getObservedCount` and devtools `detach()`. The `*_META` constants are gone.
- **`contract` is `apiVersion`.** `sharedClient` takes `{ apiVersion, clientVersion }`, and the `contract()` plugin is `apiVersion()`.
- **`redact` is `{ headers, query }`.** `DEFAULT_REDACTED_HEADERS` is `DEFAULT_REDACT.headers`, with a wider default, and `redactRequest` is no longer exported.
- **Progress uploads moved to `@zerosumstudio/conduit/upload`.** `api.upload()` no longer takes `onProgress`.
- **`clearSharedClients` is exported from `@zerosumstudio/conduit/testing`.** The shared registry is separate from 2.0's, so a page that mixes the two runs two clients.
- **The mock server follows `fetch`.** A string responder is text, the last route wins, a responder that throws answers 500, and the request's `signal` is honoured.
- **The main entry exports 21 values.** Internals such as `compose`, `createRequest` and `createStore` are gone, and `Client` is a type.

### Added

- **Typed path params.** With a literal path, `params` is required and checked. `defineEndpoint` reads `vars` from its path.
- **`requestId()` plugin.** Sends an id with every attempt and sets `ConduitError.requestId`, `request.meta.requestId` and the devtools entry.
- **`session({ channel })`.** A sign-out, a lost session or a change of user in one tab makes the others re-read.
- **`meta: { session: 'bypass' }`** skips `authorize` and 401 handling for sign-in and refresh calls.
- **`cacheable`** on requests and endpoints, and `maxRetryAfterMs` on `retry`.
- **`toConduitError(value, code?, message?)`** recodes an error and keeps the original as `cause`.
- **Secret query values are redacted** in error urls, keys and events, with a default list and a `redact.query` option. The default header list adds `x-api-key`, `x-auth-token`, `x-csrf-token`, `x-xsrf-token`, `x-session-token`, `x-access-token` and `x-amz-security-token`.

### Changed

- The core is 6.81 KB brotli and the full entry 12.62 KB. The output is unminified, with no source maps.
- `client.events` can listen and nothing else, so one remote can't clear another's listeners.
- Every background failure goes through `config.logger` with a `[conduit]` prefix.
- Error messages are one sentence: what failed and the fix.

### Fixed

- One 401 on a signed-in session no longer kills every scope until a page reload.
- Spellings such as `/\host` and `data:`, and a path climbing out of `baseUrl`, can't reach another origin.
- Two tagged `POST`s with the same body are no longer collapsed into one request.
- StrictMode no longer puts a duplicate request on the wire, and one tab switch is one refetch.
- A credential an adapter sets is hidden in every event, and a change of user never replays a request under the next user.

## 2.0.0 - 2026-09-09

### Breaking

- **Other origins are rejected.** Requests to another origin reject with `CONFIG`
  unless it is listed in `origins`, and `//host` urls are always rejected. Session
  credentials go only to the API origin or `session({ origins })`.
- **Empty path params are rejected.** An empty or whitespace path param rejects with
  `CONFIG` instead of producing `/users//invoices`. Params are read as own
  properties only.
- **Sensitive headers are redacted.** `.response()` and every `request:*` event see
  `authorization`, `cookie` and `proxy-authorization` as `[redacted]`. `redact` on
  the client changes the list, and `[]` turns it off.
- **`ConduitError.body` and `.headers` are non-enumerable.** They stay readable but
  don't appear in spreads, `console.table` or loggers. Error messages carry the url
  without its query string.
- **Session `status` gains `'error'`.** A load that fails for a reason other than
  authentication keeps the previous session and sets `error`. A terminal failure sets
  `error.code` to `UNAUTHENTICATED`, which requests needing credentials fail with.
- **`useMutation` reports `error` as `unknown`.** Narrow it with `isConduitError`.
- **Cancelled requests are distinct.** Each gets their own error with their own
  `url`, `method` and `owner`. A timeout stays `TIMEOUT`.
- **The shared client registry key is `Symbol.for('conduit.sharedClients')`.**
- **Unencodable bodies are rejected.** Bodies that can't be encoded (functions,
  symbols, bigint, cycles) reject with `CONFIG`.

### Added

- **`defineEndpoint({ method, path, response, query, body, tags, invalidates })`**
  with `client.call` and `client.keyFor`. `response` takes a Standard Schema or a
  function, and a failing schema rejects with the new `SCHEMA` code.
- **`useRequest(endpoint, vars, options)` and `useMutation(endpoint, options)`.** A
  successful mutation invalidates the endpoint's tags, or those passed as
  `invalidates`.
- **`client.upload(path, body, { onProgress })`**, over `XMLHttpRequest` when
  progress is wanted.
- **`meta.cache: 'refresh'` and `api.setData(key, data | updater)`**, which writes
  the cache and mounted stores and returns the previous value for rollback.
- `keepPreviousData`, `refetchOnFocus` and `refetchOnReconnect` on `useRequest`, all
  off by default.
- Session adapter `identify(session)` and `onClear()`, and `session({ origins })`.
- `origins`, `redact` and `logger` on the client. `mode`, `redirect`, `cache`,
  `keepalive`, `priority`, `referrerPolicy` and `integrity` pass through to fetch
  from the client or a request.
- `sharedClient(key, factory, { hot: import.meta.hot })` releases the client on hot
  module replacement.

### Fixed

- The proactive session reload no longer loops. Inside the leeway window it arms
  once at the hard expiry, and past expiry it waits for the next 401.
- A session that changes subject without passing through anonymous resets the
  cache, dedupe and observable state. Adapters declare `identify(session)`.
- `invalidate`, `invalidateTag`, `clearCache` and an identity reset reach mounted
  `useRequest` hooks, which refetch.
- `refetch()` bypasses the cache read and stores the result.
- A request with `tags` is cached whatever its method, so `invalidates` on a `POST`
  that lists reaches it.
- `useMutation(endpoint, { invalidates })` applies both the endpoint's tags and the
  ones passed in.
- An endpoint whose path has no `:name` placeholders no longer warns on every call.
- `useRequest` reports `isLoading` on its first render when a fetch is about to
  start.
- `DEV` is true in bundled dev builds, so deep-freezing of shared bodies and the dev
  warnings work in the browser.
- `useRequest` doesn't throw during render when a param is missing or `enabled` is
  false. A caller's `signal` is combined with the hook's own.
- A body read aborted mid-stream reports `ABORTED`, not `PARSE`.
- `ReadableStream` bodies send `duplex: 'half'`.
- Subscribing the same listener twice and unsubscribing once no longer leaves the
  event bus active.
- Observable stores created during a render are not evicted before the component
  subscribes.
- `getSharedClient` skips a destroyed client, like `sharedClient`.
- A fire-and-forget request failure surfaces as an unhandled rejection. `.safe()`
  and `.response()` stay silent.
- Query strings go before the fragment. A missing `content-type` with a body decodes
  as `blob` under `parse: 'auto'`.
- Retry ignores an empty `Retry-After`, never replays a consumed stream, and puts
  `retryAfter` (ms) on the final error when the header was present.
- The mock server clones a `Response` responder per match.
- Devtools `expose` defaults to dev builds only, and query strings are stripped from
  urls and keys.

## 1.0.0 - 2026-08-12

- First release.
