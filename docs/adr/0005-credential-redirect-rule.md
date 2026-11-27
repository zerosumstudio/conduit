# 5. A request with a loose credential does not follow redirects

Status: accepted

## Context

`redirect` fell through to fetch's `follow`. Node, Chromium, Firefox and WebKit strip `Authorization` and `cookie` when a redirect crosses origins, but send any other header on. A same-origin download endpoint that answers 302 to a CDN, or an open redirect, therefore received `x-api-key`, `x-session-token` and CSRF tokens.

## Decision

- A credential is a header in `DEFAULT_REDACT.headers`, one named in `redact.headers`, or one the session's `authorize` added or changed. The session records those names on `meta.credentialHeaders`. The list is `config.credentialHeaders`, always the defaults plus anything configured. Setting `redact.headers` can narrow what events and `.response()` display, and never what the redirect and upload guards protect.
- When the request has a credential other than `authorization`, `cookie` and `proxy-authorization`, and `redirect` is unset, the transport sends it with `redirect: 'manual'`. A `301`, `302`, `303`, `307` or `308`, or an `opaqueredirect`, rejects with `REDIRECT_BLOCKED`, carrying the status and `Location` where readable. Retry never replays it.
- An explicit `redirect`, on the client or the request, always wins. An explicit `manual` keeps the old behaviour of a 3xx being `HTTP_STATUS`.
- Conduit never follows a redirect itself. That would mean re-implementing 303 method changes and body replay.
- XHR cannot refuse a redirect. A progress upload carrying such a credential fails with `INVALID_ARGUMENT` unless the caller sets `redirect: 'follow'`.

## Consequences

- Plain Bearer and cookie setups are unaffected.
- A download endpoint that really redirects, with a custom credential, sets `redirect: 'follow'` on that request.
- The Fetch spec makes `manual` an opaque `status: 0` response in browsers, so the status on `REDIRECT_BLOCKED` is `0` there.
