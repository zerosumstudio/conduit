import { afterEach, describe, expect, it } from 'vitest'

import { ConduitError } from '../../primitives/errors'
import { createOriginPolicy, parseOrigin } from '../origin'

const PAGE = 'http://localhost:3000'

afterEach(() => {
	document.head.querySelectorAll('base').forEach(base => {
		base.remove()
	})
})

describe('parseOrigin', () => {
	it('reduces an origin and drops a trailing slash', () => {
		expect(parseOrigin('https://cdn.test/')).toBe('https://cdn.test')
		expect(parseOrigin('https://cdn.test:8443')).toBe('https://cdn.test:8443')
	})

	it.each(['https://cdn.test/path', 'https://cdn.test?x=1', 'ftp://cdn.test', 'cdn.test', ''])(
		'rejects %j as INVALID_ARGUMENT',
		entry => {
			expect(() => parseOrigin(entry)).toThrow(ConduitError)
			expect(() => parseOrigin(entry)).toThrow(/not an origin/)
		},
	)

	it('rejects userinfo', () => {
		expect(() => parseOrigin('https://user:pw@cdn.test')).toThrow(/not an origin/)
	})
})

describe('resolve', () => {
	it('joins with exactly one slash, under a relative or an absolute base', () => {
		const relative = createOriginPolicy('/api/', [])
		const absolute = createOriginPolicy('https://api.test/v1', [])

		expect(relative.resolve('users').href).toBe(`${PAGE}/api/users`)
		expect(relative.resolve('/users').href).toBe(`${PAGE}/api/users`)
		expect(absolute.resolve('/users').href).toBe('https://api.test/v1/users')
	})

	it('treats an empty and a slash base as the page root', () => {
		expect(createOriginPolicy('', []).resolve('/users').href).toBe(`${PAGE}/users`)
		expect(createOriginPolicy('/', []).resolve('/users').href).toBe(`${PAGE}/users`)
	})

	it('lets an absolute url on the api origin skip the prefix', () => {
		const policy = createOriginPolicy('/api', [])

		expect(policy.resolve(`${PAGE}/elsewhere`).href).toBe(`${PAGE}/elsewhere`)
	})

	it('rejects a foreign origin, and allows it once it is listed', () => {
		expect(() => createOriginPolicy('/api', []).resolve('https://other.test/x')).toThrow(
			/leaves the origins/,
		)
		expect(
			createOriginPolicy('/api', ['https://other.test']).resolve('https://other.test/x').href,
		).toBe('https://other.test/x')
	})

	it('reports a rejection as ORIGIN_REJECTED without the query in its message', () => {
		try {
			createOriginPolicy('/api', []).resolve('https://other.test/x?token=secret')
			expect.unreachable('expected a rejection')
		} catch (error) {
			expect(error).toBeInstanceOf(ConduitError)
			expect((error as ConduitError).code).toBe('ORIGIN_REJECTED')
			expect((error as ConduitError).message).not.toContain('secret')
		}
	})

	it('rejects userinfo, which fetch would turn into a TypeError', () => {
		const policy = createOriginPolicy('/api', ['https://a.test'])

		expect(() => policy.resolve('https://u:p@a.test/')).toThrow(/credentials in the url/)
	})

	it('needs a page for a relative base, and says so', () => {
		const location = globalThis.location
		const documentRef = globalThis.document

		Object.defineProperty(globalThis, 'document', { value: undefined, configurable: true })
		Object.defineProperty(globalThis, 'location', { value: undefined, configurable: true })

		try {
			const policy = createOriginPolicy('/api', [])

			expect(() => policy.resolve('/x')).toThrow(/needs a page/)
			expect(createOriginPolicy('https://api.test', []).resolve('/x').href).toBe(
				'https://api.test/x',
			)
		} finally {
			Object.defineProperty(globalThis, 'document', {
				value: documentRef,
				configurable: true,
			})
			Object.defineProperty(globalThis, 'location', { value: location, configurable: true })
		}
	})
})

// H1, S2, N3, N4: one resolution, one comparison, and the checked href is what gets sent
describe('origin bypass spellings', () => {
	const FOREIGN = '127.0.0.1:6531'
	const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
		['backslash after the slash', `/\\${FOREIGN}/x`],
		['backslash before the slash', `\\/${FOREIGN}/x`],
		['two backslashes', `\\\\${FOREIGN}/x`],
		['leading space', ` //${FOREIGN}/x`],
		['tab between the slashes', `/\t/${FOREIGN}/x`],
		['leading newline', `\n//${FOREIGN}/x`],
		['backslash scheme', `http:\\\\${FOREIGN}/x`],
		['protocol-relative', `//${FOREIGN}/x`],
		['scheme with one slash', `http:/${FOREIGN}/x`],
		['absolute', `http://${FOREIGN}/x`],
		['absolute with userinfo', `http://user:pw@${FOREIGN}/x`],
		['data url', 'data:text/plain,hello'],
		['javascript url', 'javascript:alert(1)'],
		['blob url', 'blob:http://localhost:3000/abc'],
		['file url', 'file:///etc/passwd'],
	]

	it.each(['', '/', '/api'])(
		'never resolves a foreign host for baseUrl %j, and only ever yields a page-origin href',
		baseUrl => {
			const policy = createOriginPolicy(baseUrl, [])

			for (const [name, spelling] of SPELLINGS) {
				let href: string | undefined

				try {
					href = policy.resolve(spelling).href
				} catch (error) {
					expect(error, name).toBeInstanceOf(ConduitError)
					expect((error as ConduitError).code, name).toBe('ORIGIN_REJECTED')
				}

				if (href !== undefined) {
					expect(new URL(href).origin, name).toBe(PAGE)
				}
			}
		},
	)

	it('rejects the spellings that reach another host for a bare page base', () => {
		const policy = createOriginPolicy('', [])

		for (const spelling of [
			`/\\${FOREIGN}/x`,
			`\\/${FOREIGN}/x`,
			`\\\\${FOREIGN}/x`,
			`/\t/${FOREIGN}/x`,
			`\n//${FOREIGN}/x`,
			`http:\\\\${FOREIGN}/x`,
			`//${FOREIGN}/x`,
		]) {
			expect(() => policy.resolve(spelling), JSON.stringify(spelling)).toThrow(ConduitError)
		}
	})

	it('keeps a backslash host spelling on the page origin under a path base', () => {
		const policy = createOriginPolicy('/api', [])

		expect(policy.resolve(`/\\${FOREIGN}/x`).origin).toBe(PAGE)
		expect(policy.resolve(`//${FOREIGN}/x`).origin).toBe(PAGE)
	})

	it('keeps a leading space, fullwidth slashes and an encoded backslash on the page origin', () => {
		const policy = createOriginPolicy('', [])

		expect(policy.resolve(` //${FOREIGN}/x`).origin).toBe(PAGE)
		expect(policy.resolve('／／host/x').origin).toBe(PAGE)
		expect(policy.resolve('/%5Chost/x').origin).toBe(PAGE)
	})

	it('rejects a non-http scheme as such, not as a parse accident', () => {
		const policy = createOriginPolicy('', [])

		for (const spelling of [
			'data:text/plain,hi',
			'javascript:alert(1)',
			'blob:x',
			'file:///x',
		]) {
			expect(() => policy.resolve(spelling)).toThrow(/only http and https are sent/)
		}
	})
})

// M4: a dot segment in the path cannot leave baseUrl's path, however it is spelled
describe('baseUrl path prefix', () => {
	const policy = createOriginPolicy('/api/v1', [])

	it.each([
		'/../admin',
		'/%2e%2e/admin',
		'/%2E%2E/admin',
		'/./../admin',
		'/..%2fadmin',
		'/a/../../admin',
		'/..',
	])('keeps %j under /api/v1, or rejects it', path => {
		try {
			expect(policy.resolve(path).pathname.startsWith('/api/v1')).toBe(true)
		} catch (error) {
			expect((error as ConduitError).code).toBe('ORIGIN_REJECTED')
		}
	})

	it('rejects a path that climbs out of the base', () => {
		expect(() => policy.resolve('/../admin')).toThrow(/outside baseUrl's path/)
		expect(() => policy.resolve('/%2e%2e/admin')).toThrow(/outside baseUrl's path/)
	})

	it('accepts the base path itself and anything under it', () => {
		expect(policy.resolve('').pathname).toBe('/api/v1/')
		expect(policy.resolve('/x/y').pathname).toBe('/api/v1/x/y')
	})
})

// N3: fetch resolves against the document's base, so that is what is checked
describe('<base href>', () => {
	it('checks and sends against the document base, not against location', () => {
		const base = document.createElement('base')

		base.href = 'https://cdn.test/'
		document.head.append(base)

		const policy = createOriginPolicy('/api', [])
		const resolved = policy.resolve('/x')

		expect(resolved.href).toBe('https://cdn.test/api/x')
		expect(policy.isApiOrigin(resolved.href)).toBe(true)
		expect(policy.isApiOrigin(`${PAGE}/api/x`)).toBe(false)
	})
})

describe('assertAllowed', () => {
	it('returns the parsed url, so the caller sends exactly what was checked', () => {
		const policy = createOriginPolicy('https://api.test', ['https://cdn.test'])

		expect(policy.assertAllowed('https://api.test/a b').href).toBe('https://api.test/a%20b')
		expect(policy.assertAllowed('https://cdn.test/x').origin).toBe('https://cdn.test')
	})

	it('rejects a relative or foreign url a middleware handed down', () => {
		const policy = createOriginPolicy('https://api.test', [])

		expect(() => policy.assertAllowed('/relative')).toThrow(/not a url conduit can send/)
		expect(() => policy.assertAllowed('https://evil.test/x')).toThrow(/leaves the origins/)
	})
})
