# 4. `cacheable` switches caching on, and tags are only labels

Status: accepted

## Context

A request with `tags` was cached whatever its method. Two tagged `POST`s or `DELETE`s with the same body became one request at the server, so a tag meant for invalidation silently stopped writes from happening.

## Decision

- `ConduitRequest.cacheable` is resolved once: the request's or endpoint's `cacheable`, else whether the method is `GET` or `HEAD`. Cache and dedupe serve exactly the requests that are cacheable. `shouldCache` and `shouldDedupe` are gone.
- A `POST` that only reads, such as a search, sets `cacheable: true`. Retry's `idempotentOnly` allows a cacheable request, since replaying a read is safe.
- `tags` attach entries and observed state to `invalidateTag` and nothing else.
- `useRequest` warns in development when it is given an endpoint that is not cacheable.
- A cacheable `POST` with a `FormData` or `Blob` body never shares an entry, because the body is fingerprinted per instance.

## Consequences

- An endpoint that relied on tags to cache a `POST` adds `cacheable: true`.
- The cache labels a response served past its ttl `stale` and a fresh one `cache`, so `isStale` means a stale-while-revalidate serve.
