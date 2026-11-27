# Threat model

What conduit protects, what it deliberately leaves to the app, and what that asks of you. The decisions behind it are in [docs/adr](./adr).

## The setting

One client is shared by every bundle on a page. Bundles are built and deployed separately, and they reach the client through a registry on `globalThis`, not through a framework provider. The session plugin holds whatever credential your adapter gives it and attaches it to requests.

That shape has one consequence worth stating first: **every bundle on the page is trusted with the whole client.** A bundle that runs script in the page can issue authenticated requests, read every response, clear the session, or replace the shared client. conduit doesn't try to stop that, because nothing in a browser can. The boundary is the integrity of the bundles you load: immutable remote urls, a content security policy that names the origins you deploy to, and a build pipeline you control. A federation tool such as [spool](https://github.com/zerosumstudio/spool) owns that side.

## Assets

| Asset                                | Where it lives                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| Credentials                          | The adapter's session (a token), the browser's cookies, and static `headers` on the client   |
| User data                            | Response bodies held in the cache, in observed stores, in flight, and in `ConduitError.body` |
| Secrets in query strings             | Request urls, and so history, referrers and server logs                                      |
| The identity of the signed-in user   | `session` state, and the cache and stores keyed under it                                     |
| Which origin a credential is sent to | The origin policy and the redirect rule                                                      |

conduit writes nothing to storage. It holds the cache, the session and the registry in memory.

## Trust boundaries

- **Remotes on one page.** They share one origin's trust and one client. Treat a remote as able to do whatever the host can through the client. `scope()` is a cancellation boundary, not a permission boundary.
- **The shared client.** Its registry key is `Symbol.for('conduit.sharedClients.1')`, one per major version, so a 1.0 bundle never receives a client built by another major. A remote can listen to `client.events` and nothing else on the bus: it can't clear listeners or publish events.
- **A hostile bundle.** One that runs in the page is out of scope, see above. A hostile response, url or markup is in scope: a server-supplied link, a `<base>` tag, a redirect, or a path param built from user input must not move a credential to another origin.
- **The API and everything it links to.** Origins other than the API's are reachable only when listed in `origins`.

## What conduit enforces

- **Credentials stay on listed origins.** Every url resolves with `new URL` and is compared as an origin. Anything outside `baseUrl`'s origin and `origins` rejects with `ORIGIN_REJECTED` before a plugin runs. Only `http:` and `https:` are sent, and a url with credentials in it is refused. The transport checks again and sends the href it checked, so a middleware that rewrites `url` can't leave the list. Relative paths are joined under `baseUrl` and must stay inside its path prefix, so `//host` is a path and `..` climbs nowhere. Path params are URL-encoded, and `.` and `..` are refused.
- **The session's credentials go to the API origin only.** `authorize` runs for the API origin and for `session({ origins })`, and for nothing else.
- **A credential isn't carried through a redirect.** A request holding a credential the platform doesn't strip itself (any `DEFAULT_REDACT.headers` entry other than `authorization`, `cookie` and `proxy-authorization`, anything in `redact.headers`, and every header `authorize` sets) is sent with `redirect: 'manual'`, and a redirect answer rejects with `REDIRECT_BLOCKED`. The guard list can't be narrowed through `redact`. A progress upload can't be blocked, so it fails closed with `INVALID_ARGUMENT` unless `redirect: 'follow'` is set.
- **Credentials and secrets stay out of the client's own surfaces.** `.response()`, every event and devtools read credential headers as `[redacted]`, including a header an adapter sets in place after the event was built. Secret query values read `[redacted]` in error urls, keys and events. `body` and `headers` on a `ConduitError` are non-enumerable and omitted from `toJSON()`, and messages carry the url without its query.
- **One user's data isn't served to the next.** When `identify` returns a different id, or the session is lost or cleared, the cache, dedupe flights and observed stores reset. The session's in-flight credentialed requests are cancelled, observed state drops writes from reads that began before the reset, and a request that gets its 401 while the user changes is rejected and never replayed under the next user's credentials. Cache keys include the headers `vary` selects, so callers with different headers don't share an entry.
- **A lost session fails toward anonymous.** After a failed renewal, the session is `anonymous` with `UNAUTHENTICATED`, in-flight credentialed requests are cancelled, cached data is dropped and `onUnauthenticated` fires once. Requests then go out without credentials. There is no refresh storm, because renewal is single-flight, and a 401 on a request that carried no credential doesn't end anything.
- **Only reads are shared.** Cache and dedupe serve `cacheable` requests, `GET` and `HEAD` by default. `tags` never switch caching on, so a tagged write can't be collapsed into one request. Responses with `cache-control: no-store` or `no-cache` aren't stored. Shared bodies are deeply frozen.
- **A cross-tab message can't change identity.** The `session({ channel })` message carries no session or user, and only `{ type: 'session:change' }` is acted on. A forged one causes a read from the server.
- **Misuse fails loudly.** A relative `baseUrl` with no page, a malformed `origins` entry, a missing `identify` and a body on `GET` all throw `INVALID_ARGUMENT`.

## What conduit leaves to the app

- **A compromised bundle on the page.** Control the remotes you load: immutable urls, a CSP naming your deploy origins, and `base-uri`.
- **A `<base href>` on another origin.** With a relative `baseUrl` the API origin comes from the page's base url, so injected markup that sets `<base href>` moves the API origin and the credentials with it. Plain `fetch` resolves the same way. Set `base-uri 'self'` or `'none'` in the CSP.
- **Static `headers` on listed origins.** They go on every request, including to third-party origins in `origins`. Only `authorize` is scoped to the API origin. Keep a static credential out of `headers` unless every listed origin may see it.
- **Credentials outside the guard list.** A static header with a name that isn't in `DEFAULT_REDACT.headers` follows a redirect and shows in events. Add its name to `redact.headers`.
- **Where the credential lives.** A token in memory or an `HttpOnly` cookie is the adapter's and the backend's business. conduit never writes either to storage.
- **Secrets in query strings.** They travel in the url, into history, referrers and server logs. conduit hides them in its own messages and events, not in the request, and `response.raw.url` is the platform's real url. Put secrets in headers.
- **What responses contain.** Response bodies are cached, shared between callers and visible to every bundle on the page, and `ConduitError.body` holds the server's error body. Don't log either wholesale.
- **Server-side isolation.** The registry is process-global and so is a module-level client. On a server, one client per process means one cache and one session across requests. Build a client per request there, with an absolute `baseUrl`.
- **A page that mixes majors.** A 2.0 bundle and a 1.0 bundle run two clients, each with its own cache and session.
- **Reachability of the API.** Authorisation is the server's job. A hidden button or a client check isn't access control.

## Defaults that matter

| Default                             | Why                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Other origins rejected              | The list is short and explicit, or empty                                     |
| `vary: '*'`                         | Every header counts toward identity, so no accidental sharing                |
| `credentials` follows `fetch`       | Cross-site cookies need an explicit opt in                                   |
| Display redaction on                | Nobody outside the plugin chain needs the credential                         |
| Custom credentials block redirects  | The platform strips only `authorization`, `cookie` and `proxy-authorization` |
| Devtools handle exposed in dev only | A console handle to the client is a development convenience                  |
| `retry` replays idempotent requests | Replaying a `POST` that writes can double the write                          |

## Reporting

A security issue in conduit itself: open a private advisory on the GitHub repository rather than a public issue.
