// Runs against the built package in dist, through the package's own exports map, so it catches
// what the unit tests can't: build output, entry wiring and ESM/require loading.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const NAME = '@zerosumstudio/conduit'
const require = createRequire(import.meta.url)

const main = await import(NAME)
const react = await import(`${NAME}/react`)
const devtools = await import(`${NAME}/devtools`)
const testing = await import(`${NAME}/testing`)
const upload = await import(`${NAME}/upload`)

const ROOT_EXPORTS = [
	'createClient',
	'defaults',
	'defineEndpoint',
	'sharedClient',
	'getSharedClient',
	'releaseSharedClient',
	'cache',
	'dedupe',
	'retry',
	'timeout',
	'queue',
	'session',
	'observable',
	'apiVersion',
	'requestId',
	'withRequest',
	'ConduitError',
	'isConduitError',
	'isErrorCode',
	'toConduitError',
	'DEFAULT_REDACT',
]

assert.deepEqual(Object.keys(main).sort(), [...ROOT_EXPORTS].sort(), 'main: the root exports')
assert.equal(typeof react.createHooks, 'function', 'react: createHooks')
assert.equal(typeof devtools.attachDevtools, 'function', 'devtools: attachDevtools')
assert.equal(typeof testing.createMockServer, 'function', 'testing: createMockServer')
assert.equal(typeof testing.clearSharedClients, 'function', 'testing: clearSharedClients')
assert.equal(typeof upload.uploadWithProgress, 'function', 'upload: uploadWithProgress')

// A full round trip through the default stack, against the mock server
const server = testing.createMockServer({ baseUrl: 'https://api.test/v1' })

server.get('/ping', { ok: true })
server.post('/search', request => ({ echoed: request.json() }))

const api = main
	.defaults(main.createClient({ baseUrl: 'https://api.test/v1', fetch: server.fetch }))
	.with(main.requestId())
const viewer = devtools.attachDevtools(api, { expose: false })

assert.deepEqual(await api.get('/ping'), { ok: true }, 'round trip')
assert.deepEqual(await api.post('/search', { q: 'a' }, { cacheable: true }), { echoed: { q: 'a' } })
assert.equal(server.calls.length, 2)
assert.equal(server.calls[0]?.url, 'https://api.test/v1/ping', 'urls reach the transport absolute')
assert.match(server.calls[0]?.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/, 'requestId')
assert.equal(viewer.store.getState().counters.requests, 2, 'devtools sees the traffic')

// The origin policy: spellings that name another host are refused before any plugin or fetch
for (const path of ['http:\\\\evil.test/x', 'http://evil.test/x', 'data:text/plain,x']) {
	const { error } = await api.get(path).safe()

	assert.equal(error?.code, 'ORIGIN_REJECTED', `origin: ${path}`)
}

assert.equal(server.calls.length, 2, 'a rejected url never reaches fetch')

// A credential the platform will not strip must not follow a redirect
const redirecting = main.createClient({
	baseUrl: 'https://api.test',
	headers: { 'x-api-key': 'secret' },
	fetch: () =>
		Promise.resolve(
			new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
		),
})
const blocked = await redirecting.get('/download').safe()

assert.equal(blocked.error?.code, 'REDIRECT_BLOCKED', 'redirect rule')
assert.ok(!JSON.stringify(blocked.error).includes('secret'), 'the key is not in the error')

// A request id on a failure, and query secrets out of its url
const failing = main
	.createClient({
		baseUrl: 'https://api.test',
		fetch: () => Promise.resolve(new Response(null, { status: 500 })),
	})
	.with(main.requestId({ generate: () => 'req-1' }))
const failure = await failing.get('/x', { query: { token: 'hunter2' } }).safe()

assert.equal(failure.error?.code, 'HTTP_STATUS')
assert.equal(failure.error?.requestId, 'req-1')
assert.ok(!(failure.error?.url ?? '').includes('hunter2'), 'secret query values are redacted')

// require() of the ESM build gives the same module instance
const required = require(NAME)

assert.equal(typeof required.createClient, 'function', 'require: createClient')
assert.equal(required.ConduitError, main.ConduitError, 'require: same module as import')
assert.equal(typeof require(`${NAME}/upload`).uploadWithProgress, 'function', 'require: upload')

viewer.detach()
api.destroy()

// The public API compiles for a consumer, under the strictest flags and without skipLibCheck
// In the repo the fixture is under test/, and in the tarball consumer CI puts it beside this file.
const fixture = [
	fileURLToPath(new URL('../test/public-api/consumer.ts', import.meta.url)),
	fileURLToPath(new URL('./consumer.ts', import.meta.url)),
].find(candidate => existsSync(candidate))

let tsc

try {
	tsc = require.resolve('typescript/bin/tsc')
} catch {
	tsc = undefined
}

if (fixture === undefined || tsc === undefined) {
	console.log('smoke: the public API type check was skipped (no fixture or no typescript here)')
} else {
	execFileSync(
		process.execPath,
		[
			tsc,
			'--ignoreConfig',
			'--noEmit',
			'--strict',
			'--exactOptionalPropertyTypes',
			'--module',
			'nodenext',
			'--moduleResolution',
			'nodenext',
			'--target',
			'es2022',
			'--lib',
			'es2022,dom,dom.iterable',
			'--jsx',
			'react-jsx',
			'--skipLibCheck',
			'false',
			fixture,
		],
		{ stdio: 'inherit' },
	)
}

console.log('smoke ok')
