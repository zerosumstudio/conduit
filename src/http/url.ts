import { IS_DEVELOPMENT } from '../primitives/dev'
import { ConduitError } from '../primitives/errors'
import { consoleLogger, type ConduitLogger } from '../primitives/logger'
import type { PathParams, Query } from '../primitives/types'
import { stripQuery } from './redact'

/*
 *   PATH PARAMS
 ***************************************************************************************************/
/**
 * A placeholder starts a segment. A colon anywhere else is literal, which keeps
 * `/v1/models/gemini-pro:generateContent` and `//user:pass@host` working. Write
 * `::name` for a literal segment that has to begin with one.
 */
const PARAM_PATTERN = /(^|\/)(::?)([A-Za-z_][A-Za-z0-9_]*)/g

const DOT_SEGMENTS: ReadonlySet<string> = new Set(['.', '..'])

/** Whether a path has a `:name` placeholder, which a literal `::name` does not count as. */
export function hasPlaceholders(path: string): boolean {
	const head = stripQuery(path)

	return [...head.matchAll(PARAM_PATTERN)].some(match => match[2] === ':')
}

/** Turns one param value into a path segment, or says which rule it broke. */
function formatParam(label: string, name: string, value: unknown): string {
	const fail = (detail: string): ConduitError =>
		new ConduitError({ code: 'INVALID_ARGUMENT', message: `Path "${label}" ${detail}` })

	if (value === undefined) {
		throw fail(`needs params: { ${name}: … }.`)
	}

	if (typeof value !== 'string' && typeof value !== 'number') {
		throw fail(
			`was given ${value === null ? 'null' : typeof value} for ":${name}". Pass a string or a number.`,
		)
	}

	const text = String(value).trim()

	if (text === '') {
		throw fail(`was given an empty ":${name}". Pass a value.`)
	}

	if (DOT_SEGMENTS.has(text)) {
		throw fail(`was given "${text}" for ":${name}". A dot segment climbs out of the path.`)
	}

	return encodeURIComponent(String(value))
}

/** Substitutes `:name` placeholders. A missing value is an `INVALID_ARGUMENT`, not a 404. */
export function applyPathParams(
	path: string,
	params: PathParams | undefined,
	logger: ConduitLogger = consoleLogger,
): string {
	const label = stripQuery(path)
	const mark = path.indexOf('?')
	const head = mark === -1 ? path : path.slice(0, mark)
	const tail = mark === -1 ? '' : path.slice(mark)

	if (head.search(PARAM_PATTERN) === -1) {
		if (IS_DEVELOPMENT && params !== undefined && Object.keys(params).length > 0) {
			logger.warn(
				`[conduit] "${label}" was given params ${JSON.stringify(Object.keys(params))} but has no ":name" placeholders. Did you mean query?`,
			)
		}

		return path
	}

	const substituted = head.replace(
		PARAM_PATTERN,
		(_match, prefix: string, colons: string, name: string) => {
			if (colons === '::') {
				return `${prefix}:${name}`
			}

			const value: unknown =
				params !== undefined && Object.hasOwn(params, name) ? params[name] : undefined

			return `${prefix}${formatParam(label, name, value)}`
		},
	)

	return substituted + tail
}

/*
 *   QUERY
 ***************************************************************************************************/
function serialiseQuery(query: Query): string {
	const search = new URLSearchParams()

	for (const key of Object.keys(query)) {
		const value = query[key]

		if (value === undefined || value === null) {
			continue
		}

		for (const entry of Array.isArray(value) ? value : [value]) {
			search.append(key, String(entry))
		}
	}

	return search.toString()
}

export function appendQuery(url: string, query: Query | undefined): string {
	const serialised = query === undefined ? '' : serialiseQuery(query)

	if (serialised === '') {
		return url
	}

	// The query belongs before the fragment, not after it: "#x?y" would send
	// the query as part of the fragment instead of the wire.
	const hashMark = url.indexOf('#')
	const head = hashMark === -1 ? url : url.slice(0, hashMark)
	const hash = hashMark === -1 ? '' : url.slice(hashMark)

	return head + (head.includes('?') ? '&' : '?') + serialised + hash
}
