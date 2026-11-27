import { describe, expect, it } from 'vitest'

import {
	fingerprintBody,
	toCanonicalUrl,
	deriveKey,
	deriveVariance,
	fingerprintHeaders,
	hashText,
} from '../keys'
import type { HttpMethod } from '../../primitives/types'

const key = (
	method: HttpMethod,
	url: string,
	body: BodyInit | null = null,
	variance = '',
): string => deriveKey({ method, url, body, variance })

describe('hashText', () => {
	it('is stable and differs for different input', () => {
		expect(hashText('abc')).toBe(hashText('abc'))
		expect(hashText('abc')).not.toBe(hashText('abd'))
	})

	it('handles the empty string', () => {
		expect(typeof hashText('')).toBe('string')
	})
})

describe('toCanonicalUrl', () => {
	it('sorts query parameters so ordering does not split the cache', () => {
		expect(toCanonicalUrl('/x?b=2&a=1')).toBe(toCanonicalUrl('/x?a=1&b=2'))
		expect(toCanonicalUrl('/x?b=2&a=1')).toBe('/x?a=1&b=2')
	})

	it('keeps a url without a query untouched', () => {
		expect(toCanonicalUrl('/x')).toBe('/x')
	})

	it('drops a trailing question mark', () => {
		expect(toCanonicalUrl('/x?')).toBe('/x')
	})

	it('keeps the caller order of a repeated key, which the server may read as meaningful', () => {
		expect(toCanonicalUrl('/x?sort=name&sort=age')).toBe('/x?sort=name&sort=age')
		expect(toCanonicalUrl('/x?sort=age&sort=name')).toBe('/x?sort=age&sort=name')
	})

	it('still sorts a repeated key relative to other keys', () => {
		expect(toCanonicalUrl('/x?z=1&tag=b&tag=a')).toBe('/x?tag=b&tag=a&z=1')
	})
})

describe('fingerprintBody', () => {
	it('is empty for no body', () => {
		expect(fingerprintBody(null)).toBe('')
	})

	it('hashes text-like bodies by value', () => {
		expect(fingerprintBody('{"a":1}')).toBe(fingerprintBody('{"a":1}'))
		expect(fingerprintBody('{"a":1}')).not.toBe(fingerprintBody('{"a":2}'))
	})

	it('hashes URLSearchParams by value', () => {
		expect(fingerprintBody(new URLSearchParams('a=1'))).toBe(
			fingerprintBody(new URLSearchParams('a=1')),
		)
	})

	it('gives unreadable bodies a per-instance identity, so two are never treated as equal', () => {
		const first = new FormData()
		const second = new FormData()

		expect(fingerprintBody(first)).toBe(fingerprintBody(first))
		expect(fingerprintBody(first)).not.toBe(fingerprintBody(second))
	})
})

describe('fingerprintHeaders', () => {
	it('is empty when there are no headers', () => {
		expect(fingerprintHeaders(undefined, undefined, '*')).toBe('')
	})

	it('distinguishes different values of the same header', () => {
		expect(fingerprintHeaders({ authorization: 'a' }, undefined, '*')).not.toBe(
			fingerprintHeaders({ authorization: 'b' }, undefined, '*'),
		)
	})

	it('ignores header order and casing', () => {
		expect(fingerprintHeaders({ A: '1', b: '2' }, undefined, '*')).toBe(
			fingerprintHeaders({ B: '2', a: '1' }, undefined, '*'),
		)
	})

	it('reads every HeadersInit shape the same way', () => {
		const expected = fingerprintHeaders({ 'x-tenant': 'acme' }, undefined, '*')

		expect(fingerprintHeaders([['x-tenant', 'acme']], undefined, '*')).toBe(expected)
		expect(fingerprintHeaders(new Headers({ 'x-tenant': 'acme' }), undefined, '*')).toBe(
			expected,
		)
	})

	it('lets request headers override client headers, as the merge does', () => {
		expect(fingerprintHeaders({ 'x-tenant': 'a' }, { 'x-tenant': 'b' }, '*')).toBe(
			fingerprintHeaders(undefined, { 'x-tenant': 'b' }, '*'),
		)
	})

	it('narrows to the named headers', () => {
		expect(fingerprintHeaders({ 'x-trace': '1' }, undefined, ['authorization'])).toBe('')
		expect(fingerprintHeaders({ 'x-trace': '1' }, undefined, [])).toBe('')
		expect(fingerprintHeaders({ authorization: 'a' }, undefined, ['Authorization'])).not.toBe(
			'',
		)
	})
})

describe('deriveVariance', () => {
	it('is empty when nothing varies', () => {
		expect(deriveVariance(undefined, undefined, '*', undefined)).toBe('')
	})

	it('separates credential modes, which decide whether a cookie rides along', () => {
		expect(deriveVariance(undefined, undefined, '*', 'include')).not.toBe(
			deriveVariance(undefined, undefined, '*', 'omit'),
		)
	})
})

describe('deriveKey', () => {
	it('stays readable', () => {
		expect(key('GET', '/users?b=2&a=1')).toBe('GET /users?a=1&b=2')
	})

	it('separates methods', () => {
		expect(key('GET', '/users')).not.toBe(key('HEAD', '/users'))
	})

	it('includes the body when there is one', () => {
		const withBody = key('POST', '/users', '{"a":1}')

		expect(withBody).not.toBe(key('POST', '/users', null))
		expect(withBody).not.toBe(key('POST', '/users', '{"a":2}'))
		expect(withBody).toBe(key('POST', '/users', '{"a":1}'))
	})

	it('separates requests that differ only by variance', () => {
		const a = deriveVariance({ authorization: 'Bearer A' }, undefined, '*', undefined)
		const b = deriveVariance({ authorization: 'Bearer B' }, undefined, '*', undefined)

		expect(key('GET', '/me', null, a)).not.toBe(key('GET', '/me', null, b))
	})
})
