# 1. ESM only, on Node 26

Status: accepted

## Context

The package shipped ESM and CJS from a build that renamed private fields with terser and shipped source maps. Two copies of the package in one app break `instanceof ConduitError` and the shared client registry's version check. Development and CI run on Node 26, and that is the only version tested.

## Decision

- Build with tsdown to ESM only, unminified, with no property mangling and no source maps. Consumers minify, and stack traces stay readable. Private state uses `#` fields, so `Object.keys(client)` lists only what plugins added.
- `platform: 'neutral'`, because conduit runs in browsers and in Node. React is never bundled.
- `exports` lists `.`, `./react`, `./devtools`, `./testing`, `./upload`, each with `types` and `default`, and `./package.json`.
- `engines.node` is `>=26` and `.nvmrc` is 26. A smoke test runs against `dist` and `require()`s the ESM build.

## Consequences

- No dual-package hazard. `isConduitError` stays the brand check across federated copies.
- Jest setups that transform to CJS need `transformIgnorePatterns` for the package.
- Installs on an older Node warn, or fail where the package manager enforces `engines`.
- `/upload` is its own entry, which takes the XHR progress path (about 0.68 KB) out of the core bundle.
