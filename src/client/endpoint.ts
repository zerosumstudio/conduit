import type {
	HttpMethod,
	PathParamNames,
	PathParamsOf,
	Query,
	RequestOptions,
} from '../primitives/types'

/*
 *   STANDARD SCHEMA
 ***************************************************************************************************/
/**
 * The subset of the Standard Schema contract (https://standardschema.dev)
 * conduit needs. Duplicated rather than depended on, since conduit ships zero
 * dependencies, and any validator that implements the real spec satisfies this too.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly '~standard': {
		readonly version: 1
		readonly vendor: string
		validate(
			value: unknown,
		):
			| { readonly value: Output }
			| { readonly issues: ReadonlyArray<{ readonly message: string }> }
			| Promise<
					| { readonly value: Output }
					| { readonly issues: ReadonlyArray<{ readonly message: string }> }
			  >
	}
}

/*
 *   ENDPOINT
 ***************************************************************************************************/
export interface EndpointDefinition<Vars = void, Result = unknown> {
	method: HttpMethod
	/** May contain `:name` placeholders, filled from `vars` by name. */
	path: string
	/** Validates and reshapes the decoded body. A plain function works too. */
	response?: StandardSchemaV1<unknown, Result> | ((data: unknown) => Result) | undefined
	query?: ((vars: Vars) => Query) | undefined
	/** Write methods only: JSON-encoded unless it is already a `BodyInit`. */
	body?: ((vars: Vars) => unknown) | undefined
	/** Labels for `invalidateTag`. They never switch caching on, `cacheable` does. */
	tags?: readonly string[] | ((vars: Vars) => readonly string[]) | undefined
	invalidates?: readonly string[] | ((vars: Vars) => readonly string[]) | undefined
	/** Whether this endpoint reads, so cache and dedupe may serve it. Defaults to `GET` and `HEAD`. */
	cacheable?: boolean | undefined
	options?: Partial<RequestOptions> | undefined
}

/** Branded so a call site can tell an endpoint from a bare `RequestOptions` object. */
export type Endpoint<Vars = void, Result = unknown> = EndpointDefinition<Vars, Result> & {
	readonly kind: 'conduit.endpoint'
}

/** `vars` for a path literal: its `:name` placeholders, or `void` when it has none. */
export type PathVars<P extends string> = [PathParamNames<P>] extends [never]
	? void
	: PathParamsOf<P>

/**
 * Names a request once, so it can be called and keyed without repeating its
 * shape. `defineEndpoint` does no work beyond branding, so everything it
 * describes runs when `client.call()` reads it.
 *
 * Without type arguments, `vars` is read from the path literal, so
 * `/users/:id` asks for `{ id }`. Give `Vars` and `Result` yourself when the
 * variables carry more than the path params.
 *
 * ```ts
 * const getUser = defineEndpoint({
 * 	method: 'GET',
 * 	path: '/users/:id',
 * 	response: userSchema,
 * 	tags: ['users'],
 * })
 *
 * const user = await api.call(getUser, { id: '7' })
 * ```
 */
export function defineEndpoint<const P extends string, Result = unknown>(
	def: EndpointDefinition<PathVars<P>, Result> & { path: P },
): Endpoint<PathVars<P>, Result>
export function defineEndpoint<Vars = void, Result = unknown>(
	def: EndpointDefinition<Vars, Result>,
): Endpoint<Vars, Result>
export function defineEndpoint(def: EndpointDefinition<never>): Endpoint<never> {
	return { ...def, kind: 'conduit.endpoint' }
}

/*
 *   TAGS
 ***************************************************************************************************/
/** Endpoints accept a static list or a function of `vars`. It reads either. */
export function resolveEndpointTags<Vars>(
	tags: readonly string[] | ((vars: Vars) => readonly string[]) | undefined,
	vars: Vars,
): readonly string[] | undefined {
	if (tags === undefined) {
		return undefined
	}

	return typeof tags === 'function' ? tags(vars) : tags
}
