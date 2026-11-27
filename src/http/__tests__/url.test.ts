import { describe, expect, it, vi } from 'vitest'

import { ConduitError } from '../../primitives/errors'

import { appendQuery, applyPathParams } from '../url'

describe('applyPathParams', () => {
	it('substitutes and encodes placeholders', () => {
		expect(applyPathParams('/users/:id/posts/:slug', { id: 7, slug: 'a b/c' })).toBe(
			'/users/7/posts/a%20b%2Fc',
		)
	})

	it('leaves a path without placeholders alone', () => {
		expect(applyPathParams('/users', undefined)).toBe('/users')
	})

	it('fails loudly when a value is missing rather than requesting a literal placeholder', () => {
		expect(() => applyPathParams('/users/:id', {})).toThrow(ConduitError)
		expect(() => applyPathParams('/users/:id', {})).toThrow(/needs params: \{ id/)
	})

	it('rejects a dot segment, which would climb out of the path', () => {
		expect(() => applyPathParams('/files/:name', { name: '..' })).toThrow(/dot segment/)
		expect(() => applyPathParams('/files/:name', { name: '.' })).toThrow(/dot segment/)
	})

	it('encodes a value that only looks like a dot segment', () => {
		expect(applyPathParams('/files/:name', { name: '%2e%2e' })).toBe('/files/%252e%252e')
		expect(applyPathParams('/files/:name', { name: '../x' })).toBe('/files/..%2Fx')
	})

	it('rejects an empty value rather than collapsing the segment', () => {
		expect(() => applyPathParams('/users/:id', { id: '' })).toThrow(/empty ":id"/)
	})

	it('rejects a whitespace-only value the same way', () => {
		expect(() => applyPathParams('/users/:id', { id: '   ' })).toThrow(/empty ":id"/)
	})

	it('does not resolve a name through Object.prototype instead of failing', () => {
		expect(() => applyPathParams('/users/:constructor', {})).toThrow(
			/needs params: \{ constructor/,
		)
	})

	it('warns when params were passed but the path has no placeholders', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		applyPathParams('/users', { id: 1 })

		expect(warn).toHaveBeenCalledOnce()
		expect(warn.mock.calls[0]?.[0]).toMatch(/no ":name" placeholders/)
		warn.mockRestore()
	})

	it('routes its warning through a supplied logger instead of the console', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const logger = { warn: vi.fn(), error: vi.fn() }

		applyPathParams('/users', { id: 1 }, logger)

		expect(logger.warn).toHaveBeenCalledOnce()
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})
})

describe('appendQuery', () => {
	it('drops undefined and null instead of stringifying them', () => {
		expect(appendQuery('/x', { a: 1, b: undefined, c: null, d: false })).toBe('/x?a=1&d=false')
	})

	it('repeats the key for arrays', () => {
		expect(appendQuery('/x', { tag: ['a', 'b'] })).toBe('/x?tag=a&tag=b')
	})

	it('joins onto an existing query string', () => {
		expect(appendQuery('/x?page=1', { size: 20 })).toBe('/x?page=1&size=20')
	})

	it('returns the url untouched when nothing survives', () => {
		expect(appendQuery('/x', {})).toBe('/x')
		expect(appendQuery('/x', { a: undefined })).toBe('/x')
		expect(appendQuery('/x', undefined)).toBe('/x')
	})

	it('inserts the query before the fragment rather than after it', () => {
		expect(appendQuery('/x#section', { a: 1 })).toBe('/x?a=1#section')
	})

	it('extends an existing query and keeps the fragment last', () => {
		expect(appendQuery('/x?page=1#section', { size: 20 })).toBe('/x?page=1&size=20#section')
	})
})
