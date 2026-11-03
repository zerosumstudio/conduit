# Changelog

## Unreleased

### Breaking

- **Published as `@zerosumstudio/conduit`.** The repo moved to
  [zerosumstudio/conduit](https://github.com/zerosumstudio/conduit). Swap the package
  name, the imports and any `declare module` augmentation. `@bkincz/conduit` stays on
  npm at 2.0.0.

### Fixed

- CommonJS consumers get their own type declarations.

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
