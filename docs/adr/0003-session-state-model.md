# 3. The session state model has no sticky terminal state

Status: accepted

## Context

Any 401 on any in-scope request ended the session, including one that carried no credentials, such as a failed sign-in. After that every in-scope request failed before the network until `reload()`, `load()` returned early, a failed first read became a sign-out, a terminal 401 aborted every scope for good, and `reload()` could join a read that started before sign-in.

## Decision

- States are `unknown`, `loading`, `authenticated`, `anonymous` and `error`, as a discriminated union. A lost session is `anonymous` with `error.code === 'UNAUTHENTICATED'`.
- A request carries credentials when the session holds one. Only a rejection of a credentialed request, after one renewal, loses the session. A 401 for an anonymous or unknown session is an ordinary `HTTP_STATUS`.
- Every successful read raises a generation, and a request records the one it was sent under. A 401 for an older generation is replayed with the current credentials and never renews.
- Losing the session cancels only the session's own in-flight credentialed requests, through one controller per request, with the `UNAUTHENTICATED` error as the reason. Those requests and the trigger reject `UNAUTHENTICATED`. Scopes and the client stay usable, and nothing fails before the network afterwards.
- A change of user, and `clear()`, cancel the in-flight credentialed requests as well, with `ABORTED`. Observed state also drops any write from a read that started before an identity reset. A request that gets its 401 while the user changes is rejected `UNAUTHENTICATED`, never replayed under the next user's credentials.
- `load()` returns a known session, signed in or not, without a request, and otherwise joins a read in flight. `reload()` always starts a new read, the latest wins, and older results are dropped. `clear()` supersedes any read in flight.
- A token adapter waits for its first read. If that fails with no previous session the request rejects with the load error instead of going out unauthorised, and with a previous session it keeps using it.
- `identify` is required, so a switch from one user to another always resets what was held for the first.
- `meta: { session: 'bypass' }` skips authorize and 401 handling for sign-in, sign-up and refresh calls.
- `session({ channel })` tells other tabs to re-read when this one signs out, loses the session or sees a different user.

## Consequences

- After sign-out, requests go out anonymous until a read finds a session. Apps call `reload()` after sign-in.
- A cookie adapter needs `load()` at boot or `autoLoad: true` before a 401 can mean a lost session.
- `scope.abort()` cancels in flight and keeps the scope. Only `scope.dispose()` ends it.
