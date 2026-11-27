# 6. React hooks never abort their own requests

Status: accepted

## Context

`useRequest` aborted the previous flight on every effect run and cleanup, then reissued. Under StrictMode that put a duplicate on the wire, since the aborted request had already left. `focus` and `visibilitychange` each refetched past the cache, so one tab switch was two requests. `useMutation` resolved `undefined` on failure, which a successful mutation returning nothing also did.

## Decision

- State lives in the per-key observable store, and a hook only reads the store for its current key. A request that was superseded or outlived its component finishes and fills the cache. Cancellation belongs to the caller's `signal` or a scope.
- `createHooks` keeps a map of runs the hooks started, keyed by key and invalidation generation. A second effect for the same run, from StrictMode or from several hooks watching one invalidation, joins it. That holds for a request dedupe does not cover.
- There is one `visibilitychange` listener and one `online` listener per `createHooks`, attached with the first subscriber and removed with the last. Window `focus` is not listened to. A focus or reconnect read honours a fresh cache entry, and only `refetch()` bypasses the cache.
- `isStale` is true only for a stale-while-revalidate serve. `updatedAt` reports when the data arrived.
- `mutate` resolves a `SafeResult` and never rejects, and the latest call owns the hook's state. Tags are invalidated before it resolves.

## Consequences

- Unmounting no longer cancels. A remote that must stop its requests disposes a scope.
- A development-only warning covers `useRequest` given a non-cacheable endpoint.
