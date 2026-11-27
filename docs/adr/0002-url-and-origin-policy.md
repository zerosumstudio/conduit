# 2. One URL policy: resolve with `new URL`, send what was checked

Status: accepted

## Context

The origin guard and the session's scope check both used string heuristics. Only `scheme://` and `//` counted as absolute, so with a relative `baseUrl` spellings such as `/\host`, `/<TAB>/host` and `http:\host` reached another origin carrying the static and the session credentials. fetch also resolves relative urls against the document base, which a `<base href>` can move away from `location`. Path params of `..` climbed out of `baseUrl`'s path.

## Decision

- `createOriginPolicy(baseUrl, origins)` is the only place that decides where a request may go. A path is joined onto `baseUrl` as text, resolved with `new URL` against the document base, and compared as an origin. Only `http:` and `https:` pass, and userinfo is refused.
- A relative path has to stay inside `baseUrl`'s path prefix. An absolute url may be on the API origin or in `origins`, and skips the prefix check.
- What gets sent is `url.href`, never the input string. `request.url` is always absolute. The transport re-checks it with `assertAllowed`, so a middleware that rewrites `url` cannot leave the allowlist either.
- A relative `baseUrl` needs a page. Without one the first request fails with `INVALID_ARGUMENT`, and server code passes an absolute `baseUrl`.
- `origins` and `session({ origins })` go through `parseOrigin` at install. A path, query or non-http scheme is `INVALID_ARGUMENT`, and a trailing slash is normalised away.
- Rejections are `ORIGIN_REJECTED`. `.` and `..` as path params are `INVALID_ARGUMENT`.
- Session scope asks the same policy, so there is no `''` case that counts as in scope.

## Consequences

- A path that reads as a scheme (`users:list`) is rejected with a hint to start it with a slash. Write `/users:list`.
- One `new URL` per request in `prepare`, and one in the transport.
- `request.url` and `MockCall.url` are absolute. A custom `fetch` that matched on `input.startsWith('/api')` matches on the pathname instead.
- A leading space, or a path that does not start with a slash, resolves under `baseUrl` on the same origin rather than being rejected, since the join adds the slash.
