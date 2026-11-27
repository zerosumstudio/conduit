import type { ConduitError } from './errors'
import type { EventBus, Unsubscribe } from './events'
import type { ConduitLogger } from './logger'
import type { RedactRules } from '../http/redact'

/*
 *   UTILITY
 ***************************************************************************************************/
// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- a plugin with no API extends the client by nothing
export type NoExtension = Record<never, never>

/** A union that still autocompletes, where `T | string` would collapse to `string`. */
export type LiteralUnion<T extends string> = T | (string & Record<never, never>)

/*
 *   HTTP
 ***************************************************************************************************/
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/*
 *   SCHEDULING
 ***************************************************************************************************/
/** Scheduling priority for the queue plugin. The three shipped are a suggestion, not a limit. */
export type Lane = LiteralUnion<'critical' | 'default' | 'prefetch'>

/*
 *   IDENTITY
 ***************************************************************************************************/
/**
 * Which headers take part in a request's identity. `'*'` is every header, `[]`
 * is none. Headers a session attaches never take part, since an identity change
 * already clears everything held for the previous one.
 *
 * A header that is unique per request, such as a trace id, gives every request
 * its own key under `'*'`, so nothing hits the cache or shares a flight.
 */
export type Vary = '*' | readonly string[]

/*
 *   REQUEST INPUT
 ***************************************************************************************************/
export type QueryValue =
	string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>

export type Query = Readonly<Record<string, QueryValue>>

export type PathParams = Readonly<Record<string, string | number>>

/** How to decode a response body. `auto` reads the content type. */
export type ParseMode = 'auto' | 'json' | 'text' | 'blob' | 'arrayBuffer' | 'formData' | 'none'

/*
 *   PATH PARAMS, FROM THE PATH LITERAL
 ***************************************************************************************************/
type Letter =
	| 'a'
	| 'b'
	| 'c'
	| 'd'
	| 'e'
	| 'f'
	| 'g'
	| 'h'
	| 'i'
	| 'j'
	| 'k'
	| 'l'
	| 'm'
	| 'n'
	| 'o'
	| 'p'
	| 'q'
	| 'r'
	| 's'
	| 't'
	| 'u'
	| 'v'
	| 'w'
	| 'x'
	| 'y'
	| 'z'
	| 'A'
	| 'B'
	| 'C'
	| 'D'
	| 'E'
	| 'F'
	| 'G'
	| 'H'
	| 'I'
	| 'J'
	| 'K'
	| 'L'
	| 'M'
	| 'N'
	| 'O'
	| 'P'
	| 'Q'
	| 'R'
	| 'S'
	| 'T'
	| 'U'
	| 'V'
	| 'W'
	| 'X'
	| 'Y'
	| 'Z'
	| '_'

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'

type TakeName<S extends string, Name extends string = ''> = S extends `${infer C}${infer Rest}`
	? C extends Letter | Digit
		? TakeName<Rest, `${Name}${C}`>
		: Name
	: Name

/** A name starts with a letter or an underscore, as the runtime pattern requires. */
type ValidName<Name extends string> = Name extends ''
	? never
	: Name extends `${Digit}${string}`
		? never
		: Name

type SegmentParam<Segment extends string> = Segment extends `::${string}`
	? never
	: Segment extends `:${infer Rest}`
		? ValidName<TakeName<Rest>>
		: never

/**
 * The `:name` placeholders in a path literal. `::name` is a literal colon, and
 * a colon in the middle of a segment is not a placeholder.
 */
export type PathParamNames<P extends string> = P extends `${infer Head}?${string}`
	? PathParamNames<Head>
	: P extends `${infer Segment}/${infer Rest}`
		? SegmentParam<Segment> | PathParamNames<Rest>
		: SegmentParam<P>

/** `params` for a path literal: `PathParamsOf<'/users/:id'>` is `{ id: string | number }`. */
export type PathParamsOf<P extends string> = string extends P
	? PathParams
	: { readonly [K in PathParamNames<P>]: string | number }

/**
 * The trailing arguments of a verb. A literal path with placeholders makes the
 * options, and `params` inside them, required. Anything else keeps them optional.
 *
 * TypeScript cannot infer the path when the result type is given explicitly, as
 * in `get<User>('/users/:id')`, so `params` stays loose there.
 */
export type OptionsArgs<
	P extends string,
	O extends { params?: PathParams | undefined },
> = string extends P
	? [options?: O]
	: [PathParamNames<P>] extends [never]
		? [options?: Omit<O, 'params'> & { params?: undefined }]
		: [options: Omit<O, 'params'> & { params: PathParamsOf<P> }]

/*
 *   META
 ***************************************************************************************************/
/**
 * Plugin scratch space, carried through the pipeline untouched by the core.
 * Declaration-merge to give your own keys a real type instead of `unknown`:
 *
 * ```ts
 * declare module '@zerosumstudio/conduit' {
 * 	interface ConduitMeta {
 * 		'my-plugin.skip'?: boolean
 * 	}
 * }
 * ```
 */
export interface ConduitMeta {
	/** `bypass` skips the cache. `refresh` skips a stored entry and replaces it. */
	cache?: 'bypass' | 'refresh' | undefined
	/** `bypass` skips flight sharing. */
	dedupe?: 'bypass' | undefined
	/** `bypass` skips the queue. */
	queue?: 'bypass' | undefined
	/** `bypass` skips authorize, and 401 handling. Use it for sign-in calls. */
	session?: 'bypass' | undefined
	/** Overrides the timeout plugin's default for one request. `0` turns it off. */
	timeoutMs?: number | undefined
	/** Which attempt this is. Written by the retry plugin. */
	attempt?: number | undefined
	/** Set by the `requestId` plugin: the id this attempt went out with. */
	requestId?: string | undefined
	/** Header names the session attached, which the transport treats as credentials. */
	credentialHeaders?: readonly string[] | undefined
	/** Sends this one request through another fetch. `/upload` uses it for XHR progress. */
	fetch?: FetchLike | undefined
	[key: string]: unknown
}

/**
 * `RequestInit` fields conduit passes straight through rather than deriving
 * itself. Shared by `ClientConfig` and `RequestOptions`; a request sets a
 * field, the client supplies a default. `duplex` is excluded: it is inferred
 * from the body, not something a caller sets.
 */
export interface RequestInitPassthrough {
	mode?: RequestMode | undefined
	/**
	 * Conduit sends a request that carries a credential the platform will not
	 * strip itself (an `x-api-key`, a session header) with `manual`, and fails it
	 * with `REDIRECT_BLOCKED` when the answer is a redirect. Set this to opt out.
	 */
	redirect?: RequestRedirect | undefined
	cache?: RequestCache | undefined
	keepalive?: boolean | undefined
	priority?: RequestPriority | undefined
	referrerPolicy?: ReferrerPolicy | undefined
	integrity?: string | undefined
}

export interface RequestOptions extends RequestInitPassthrough {
	method?: HttpMethod | undefined
	/** Fills `:name` placeholders. A missing one is an `INVALID_ARGUMENT`, not a 404. */
	params?: PathParams | undefined
	query?: Query | undefined
	/** JSON-encoded with a matching content type unless it is already a `BodyInit`. */
	body?: unknown
	headers?: HeadersInit | undefined
	signal?: AbortSignal | undefined
	/** Overrides the derived cache and dedupe key. */
	key?: string | undefined
	lane?: Lane | undefined
	owner?: string | undefined
	/** Labels for `invalidateTag`. They never switch caching on, `cacheable` does. */
	tags?: readonly string[] | undefined
	/** Whether this request reads, so cache and dedupe may serve it. Defaults to `GET` and `HEAD`. */
	cacheable?: boolean | undefined
	parse?: ParseMode | undefined
	credentials?: RequestCredentials | undefined
	meta?: ConduitMeta | undefined
}

/** `RequestOptions` minus the parts a method helper already decides for you. */
export type MethodOptions = Omit<RequestOptions, 'method' | 'body'>

/*
 *   REQUEST RECORD
 ***************************************************************************************************/
/** The resolved request every middleware sees. */
export interface ConduitRequest {
	/** Always absolute: it is what the transport sends. */
	readonly url: string
	readonly method: HttpMethod
	readonly headers: Headers
	readonly body: BodyInit | null
	readonly signal: AbortSignal
	readonly key: string
	/** Pre-hashed identity beyond method, url and body, so a rewrite can recompute its key. */
	readonly variance: string
	readonly lane: Lane
	readonly owner: string | undefined
	readonly tags: readonly string[]
	/** Whether cache and dedupe may serve this request. */
	readonly cacheable: boolean
	readonly parse: ParseMode
	readonly credentials: RequestCredentials | undefined
	readonly mode: RequestMode | undefined
	readonly redirect: RequestRedirect | undefined
	readonly cache: RequestCache | undefined
	readonly keepalive: boolean | undefined
	readonly priority: RequestPriority | undefined
	readonly referrerPolicy: ReferrerPolicy | undefined
	readonly integrity: string | undefined
	/** Mutable by design: plugins stash state here across the onion. */
	readonly meta: ConduitMeta
	/** Hides this client's secret query values in a url, for messages and logs. */
	readonly redactUrl: (url: string) => string
}

/**
 * Fields a middleware may rewrite before passing the request on.
 *
 * Patching `url`, `method`, `body`, `variance` or `parse` re-derives `key`
 * unless the patch sets one. `meta` is replaced wholesale rather than merged.
 */
export type RequestPatch = Partial<
	Pick<
		ConduitRequest,
		| 'url'
		| 'method'
		| 'body'
		| 'signal'
		| 'key'
		| 'variance'
		| 'lane'
		| 'owner'
		| 'tags'
		| 'cacheable'
		| 'parse'
		| 'meta'
	>
> & {
	headers?: Headers
}

/*
 *   RESPONSE
 ***************************************************************************************************/
/**
 * Where an answer came from. `stale` is a stored entry served past its ttl
 * while a refresh runs behind it, and `cache` is a fresh one.
 */
export type ResponseSource = 'network' | 'cache' | 'stale' | 'dedupe'

export interface ConduitResponse<T = unknown> {
	readonly status: number
	readonly headers: Headers
	readonly data: T
	/** Absent for anything served from cache or dedupe. */
	readonly raw: Response | undefined
	readonly from: ResponseSource
	/** 1 for a first attempt. The retry plugin raises it on each replay. */
	readonly attempt: number
	readonly request: ConduitRequest
}

/** Discriminated on `error`, so `error === null` narrows `data` to non-null. */
export type SafeResult<T> =
	| { readonly data: T; readonly error: null }
	| { readonly data: null; readonly error: ConduitError }

/*
 *   PIPELINE
 ***************************************************************************************************/
export type Next = (request: ConduitRequest) => Promise<ConduitResponse>

/** An onion layer. Return without calling `next` to short-circuit. */
export type Middleware = (request: ConduitRequest, next: Next) => Promise<ConduitResponse>

export interface Plugin<Ext extends object = NoExtension> {
	readonly name: string
	readonly middleware?: Middleware | undefined
	/** Merged onto the client by `.with()`, and shows up in its type. */
	onInit?(ctx: PluginContext): Ext | void
	onDestroy?(): void
}

/*
 *   CLIENT
 ***************************************************************************************************/
export type { ConduitLogger }

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface RedactConfig {
	/** Header names hidden from `.response()`, events and devtools. Defaults to `DEFAULT_REDACT.headers`. */
	headers?: readonly string[] | undefined
	/** Query parameters whose values are hidden in errors, events and `.response()`. Defaults to `DEFAULT_REDACT.query`. */
	query?: readonly string[] | undefined
}

export interface ClientConfig extends RequestInitPassthrough {
	/**
	 * Prefixed to every relative path. A relative `baseUrl` (`''`, `'/api'`) means
	 * the page's own origin and needs a page, so pass an absolute one on a server.
	 */
	baseUrl?: string | undefined
	/** Pass a function for anything that changes at runtime. It is read per request. */
	headers?: HeadersInit | (() => HeadersInit) | undefined
	credentials?: RequestCredentials | undefined
	/** Which headers take part in request identity. Defaults to `'*'`, see {@link Vary}. */
	vary?: Vary | undefined
	/** Names the app or remote issuing requests, in devtools and on errors. */
	owner?: string | undefined
	lane?: Lane | undefined
	parse?: ParseMode | undefined
	/** Swap the network implementation, for tests, instrumentation or a non-browser host. */
	fetch?: FetchLike | undefined
	/**
	 * Extra origins this client may call besides its own, as `https://host` with no
	 * path. `baseUrl`'s origin is always allowed. Every other url is rejected with
	 * `ORIGIN_REJECTED` before any plugin runs.
	 */
	origins?: readonly string[] | undefined
	/** What is hidden from errors, events and `.response()`. Spread `DEFAULT_REDACT` to widen it. */
	redact?: RedactConfig | undefined
	/** Where conduit's own diagnostics go. Defaults to `console`. */
	logger?: ConduitLogger | undefined
}

export interface ResolvedClientConfig {
	readonly baseUrl: string
	readonly headers: (() => HeadersInit) | undefined
	readonly credentials: RequestCredentials | undefined
	readonly vary: Vary
	readonly owner: string | undefined
	readonly lane: Lane
	readonly parse: ParseMode
	readonly fetch: FetchLike
	readonly mode: RequestMode | undefined
	readonly redirect: RequestRedirect | undefined
	readonly cache: RequestCache | undefined
	readonly keepalive: boolean | undefined
	readonly priority: RequestPriority | undefined
	readonly referrerPolicy: ReferrerPolicy | undefined
	readonly integrity: string | undefined
	/** `origins`, normalised to bare origins. */
	readonly origins: readonly string[]
	/** What events and `.response()` hide. Setting `redact` replaces the defaults here. */
	readonly redact: RedactRules
	/**
	 * Header names that count as credentials for the redirect and upload guards:
	 * the defaults plus anything configured, always. Narrowing `redact` cannot shrink it.
	 */
	readonly credentialHeaders: readonly string[]
	readonly logger: ConduitLogger
}

/** A change to what the cache holds, for the plugins that mirror it. */
export type CacheChange =
	| {
			readonly type: 'invalidate'
			/** A key, a `tag:name`, or `*` for everything. */
			readonly target: string
	  }
	| {
			readonly type: 'set'
			readonly key: string
			readonly data: unknown
			readonly at: number
	  }

/** What a plugin is handed at install time. */
export interface PluginContext {
	readonly config: ResolvedClientConfig
	readonly events: EventBus
	/** Re-enters the full pipeline from a path. Guard against recursion via `meta`. */
	request<T = unknown>(path: string, options?: RequestOptions): ConduitPromise<T>
	/**
	 * Re-enters the pipeline from the outside with a request that already exists,
	 * so layers above yours see the response. Mark it or your middleware loops.
	 */
	readonly dispatch: Next
	/** Whether an absolute url sits on the client's own API origin. */
	isApiOrigin(url: string): boolean
	/**
	 * Drops everything held on behalf of whoever was signed in. Identity is
	 * derived before credentials are attached, so cached responses outlive them.
	 */
	resetIdentity(): void
	/** Registers state to drop when {@link PluginContext.resetIdentity} runs. */
	onResetIdentity(listener: () => void): Unsubscribe
	/** Tells the plugins that mirror the cache about a change to it. */
	notifyCacheChange(change: CacheChange): void
	/** Registers for {@link PluginContext.notifyCacheChange}. */
	onCacheChange(listener: (change: CacheChange) => void): Unsubscribe
}

/*
 *   PROMISE
 ***************************************************************************************************/
/** A promise of the decoded body, with two other ways to take the same outcome. */
export interface ConduitPromise<T> extends Promise<T> {
	/** The full response record rather than just the body. */
	response(): Promise<ConduitResponse<T>>
	/** Never rejects. Returns the failure as a value instead. */
	safe(): Promise<SafeResult<T>>
}

export interface RequestMethods {
	request<T = unknown, const P extends string = string>(
		path: P,
		...args: OptionsArgs<P, RequestOptions>
	): ConduitPromise<T>
	get<T = unknown, const P extends string = string>(
		path: P,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T>
	head<T = unknown, const P extends string = string>(
		path: P,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T>
	delete<T = unknown, const P extends string = string>(
		path: P,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T>
	post<T = unknown, const P extends string = string>(
		path: P,
		body?: unknown,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T>
	put<T = unknown, const P extends string = string>(
		path: P,
		body?: unknown,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T>
	patch<T = unknown, const P extends string = string>(
		path: P,
		body?: unknown,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T>
}
