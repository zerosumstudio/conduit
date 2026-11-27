# 7. Error codes, one error channel and the family names

Status: accepted

## Context

Error codes mixed `HTTP_ERROR`, `PARSE` and `SCHEMA` with a catch-all `CONFIG` that meant misuse, a destroyed client, a duplicate plugin and a rejected origin. Failures that nobody awaits, such as a throwing listener or a background refresh, went to four different places or nowhere. Names for the same ideas differed from clutch.

## Decision

- `ConduitErrorCode` is a union with no `_ERROR` suffix, and `ConduitError` is not subclassed, so callers check `error.code`: `HTTP_STATUS`, `NETWORK`, `TIMEOUT`, `ABORTED`, `PARSE_FAILED`, `VALIDATION_FAILED`, `UNAUTHENTICATED`, `REDIRECT_BLOCKED`, `ORIGIN_REJECTED`, `INVALID_ARGUMENT`, `DESTROYED`, `DUPLICATE_PLUGIN`, `EXTENSION_COLLISION` and `UNKNOWN`. `HTTP_ERROR` became `HTTP_STATUS`.
- `toConduitError(value, code?, message?)` coerces anything thrown. A conduit error passes through untouched, and a recode copies its fields and keeps the original as `cause`.
- `logger` is the one channel for what nobody is awaiting. `reportError(logger, message, cause)` always goes through `config.logger` with the `[conduit]` prefix: a listener that threw, a background cache refresh, a failed renewal and a background session read. Nothing is swallowed and nothing calls `console` directly.
- Names follow clutch: `PluginContext`, `NoExtension`, `getState()` on every store, `is`/`has` booleans, and units in names (`retryAfterMs`, `durationMs`).
- `client.events` is a `ClientEvents`, which can listen and nothing else. Plugins get the whole bus on `PluginContext.events`.

## Consequences

- Code that checked `'HTTP_ERROR'`, `'PARSE'`, `'SCHEMA'` or `'CONFIG'` changes. The migration guide maps each.
- A shared client cannot have its listeners cleared, or `session:change` forged, by another remote.
