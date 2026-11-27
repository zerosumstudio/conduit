import { encodeBody, type EncodedBody } from '../http/body'
import { resolveEndpointTags, type Endpoint, type EndpointDefinition } from './endpoint'
import { ConduitError, toConduitError } from '../primitives/errors'
import {
	createEventBus,
	getMonotonicTime,
	type ClientEvents,
	type EventBus,
	type Unsubscribe,
} from '../primitives/events'
import { consoleLogger, reportError } from '../primitives/logger'
import { isBodyless, isCacheable } from '../http/method'
import { deriveKey, deriveVariance } from '../http/keys'
import { bodyOptions } from './methods'
import { compose } from '../http/pipeline'
import { createConduitPromise } from '../http/promise'
import { createRequest } from '../http/request'
import { createOriginPolicy, parseOrigin, type OriginPolicy } from '../http/origin'
import {
	createUrlRedactor,
	createRequestError,
	redactRequest,
	redactResponse,
	resolveCredentialHeaders,
	resolveRedact,
} from '../http/redact'
import { createScope, type Scope } from './scopes'
import { composeSignals } from '../http/signals'
import { createFetchTransport } from '../http/transport'
import { appendQuery, applyPathParams, hasPlaceholders } from '../http/url'
import type {
	CacheChange,
	ClientConfig,
	PluginContext,
	ConduitPromise,
	ConduitRequest,
	ConduitResponse,
	FetchLike,
	HttpMethod,
	MethodOptions,
	Middleware,
	Next,
	OptionsArgs,
	ParseMode,
	PathParams,
	Plugin,
	RequestInitPassthrough,
	RequestMethods,
	RequestOptions,
	ResolvedClientConfig,
} from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
const EMPTY_TAGS: readonly string[] = Object.freeze([])

function getDefaultFetch(): FetchLike {
	if (typeof globalThis.fetch !== 'function') {
		throw new ConduitError({
			code: 'INVALID_ARGUMENT',
			message: 'No global fetch was found. Pass one as config.fetch.',
		})
	}

	return (input, init) => globalThis.fetch(input, init)
}

function resolveHeaders(headers: ClientConfig['headers']): (() => HeadersInit) | undefined {
	if (headers === undefined || typeof headers === 'function') {
		return headers
	}

	return () => headers
}

function resolveConfig(config: ClientConfig): ResolvedClientConfig {
	const vary = config.vary ?? '*'

	return {
		baseUrl: config.baseUrl ?? '',
		headers: resolveHeaders(config.headers),
		credentials: config.credentials,
		vary: vary === '*' ? vary : vary.map(name => name.toLowerCase()),
		owner: config.owner,
		lane: config.lane ?? 'default',
		parse: config.parse ?? 'auto',
		fetch: config.fetch ?? getDefaultFetch(),
		mode: config.mode,
		redirect: config.redirect,
		cache: config.cache,
		keepalive: config.keepalive,
		priority: config.priority,
		referrerPolicy: config.referrerPolicy,
		integrity: config.integrity,
		origins: (config.origins ?? []).map(parseOrigin),
		redact: resolveRedact(config.redact),
		credentialHeaders: resolveCredentialHeaders(config.redact),
		logger: config.logger ?? consoleLogger,
	}
}

function buildHeaders(
	configHeaders: HeadersInit | undefined,
	optionHeaders: HeadersInit | undefined,
	contentType: string | undefined,
): Headers {
	const headers = new Headers(configHeaders)

	if (optionHeaders !== undefined) {
		new Headers(optionHeaders).forEach((value, name) => {
			headers.set(name, value)
		})
	}

	if (contentType !== undefined && !headers.has('content-type')) {
		headers.set('content-type', contentType)
	}

	return headers
}

/** A request's own `RequestInit` fields, with the client's as the default for each. */
function mergePassthrough(
	options: RequestInitPassthrough,
	config: RequestInitPassthrough,
): Required<{ [K in keyof RequestInitPassthrough]: RequestInitPassthrough[K] | undefined }> {
	return {
		mode: options.mode ?? config.mode,
		redirect: options.redirect ?? config.redirect,
		cache: options.cache ?? config.cache,
		keepalive: options.keepalive ?? config.keepalive,
		priority: options.priority ?? config.priority,
		referrerPolicy: options.referrerPolicy ?? config.referrerPolicy,
		integrity: options.integrity ?? config.integrity,
	}
}

/*
 *   ENDPOINTS
 ***************************************************************************************************/
/** Folds an endpoint's `query`/`body`/`tags` and its own `vars` into ordinary request options. */
function resolveEndpointOptions<Vars, Result>(
	endpoint: EndpointDefinition<Vars, Result>,
	vars: Vars,
	options: Partial<RequestOptions> | undefined,
): RequestOptions {
	const tags = resolveEndpointTags(endpoint.tags, vars)
	const query = endpoint.query?.(vars)
	const body = endpoint.body?.(vars)

	// Each optional field is spread only when it is set, since an undefined one would
	// override what the endpoint's own `options` already say.
	return {
		...endpoint.options,
		method: endpoint.method,
		...(vars === undefined || !hasPlaceholders(endpoint.path)
			? {}
			: { params: vars as unknown as PathParams }),
		...(query === undefined ? {} : { query }),
		...(body === undefined ? {} : { body }),
		...(tags === undefined ? {} : { tags }),
		...(endpoint.cacheable === undefined ? {} : { cacheable: endpoint.cacheable }),
		...options,
	}
}

/** Runs an endpoint's `response` schema, or plain function, against a decoded body. */
async function decodeEndpointResponse<Result>(
	schema: NonNullable<EndpointDefinition<unknown, Result>['response']>,
	response: ConduitResponse,
): Promise<Result> {
	const { request } = response
	const failure = (detail: string, extra: { body?: unknown; cause?: unknown }): ConduitError =>
		createRequestError(request, 'VALIDATION_FAILED', detail, {
			status: response.status,
			...extra,
		})

	if (typeof schema === 'function') {
		try {
			return schema(response.data)
		} catch (cause) {
			throw failure('failed its response function.', { cause })
		}
	}

	const outcome = await schema['~standard'].validate(response.data)

	if ('issues' in outcome) {
		throw failure('failed its response schema.', { body: outcome.issues })
	}

	return outcome.value
}

/*
 *   CLIENT
 ***************************************************************************************************/
interface PreparedRequest {
	method: HttpMethod
	url: string
	encoded: EncodedBody
	variance: string
	credentials: RequestCredentials | undefined
	parse: ParseMode
	configHeaders: HeadersInit | undefined
	isCacheable: boolean
	key: string
}

export class Client implements RequestMethods {
	readonly #config: ResolvedClientConfig
	readonly #policy: OriginPolicy
	readonly #transport: Next
	readonly #context: PluginContext
	readonly #events: EventBus
	readonly #redactUrl: (url: string) => string
	readonly #plugins: Plugin<object>[] = []
	readonly #middlewares: Middleware[] = []
	readonly #scopes = new Set<Scope>()
	readonly #resetListeners = new Set<() => void>()
	readonly #changeListeners = new Set<(change: CacheChange) => void>()
	#dispatch: Next
	#root = new AbortController()
	#isDestroyed = false

	constructor(config: ClientConfig = {}) {
		this.#config = resolveConfig(config)
		this.#policy = createOriginPolicy(this.#config.baseUrl, this.#config.origins)
		this.#redactUrl = createUrlRedactor(this.#config.redact.query)
		this.#events = createEventBus(this.#config.logger)
		this.#transport = createFetchTransport(this.#config, this.#policy)
		this.#dispatch = this.#transport
		this.#context = {
			config: this.#config,
			events: this.#events,
			request: <T>(path: string, options?: RequestOptions): ConduitPromise<T> =>
				this.#execute<T>(path, options ?? {}),
			dispatch: (request): Promise<ConduitResponse> => this.#dispatch(request),
			isApiOrigin: (url): boolean => this.#policy.isApiOrigin(url),
			resetIdentity: (): void => {
				this.#resetIdentity()
			},
			onResetIdentity: (listener): Unsubscribe =>
				this.#subscribe(this.#resetListeners, listener),
			notifyCacheChange: (change): void => {
				this.#notify(this.#changeListeners, listener => {
					listener(change)
				})
			},
			onCacheChange: (listener): Unsubscribe =>
				this.#subscribe(this.#changeListeners, listener),
		}
	}

	public get config(): ResolvedClientConfig {
		return this.#config
	}

	/** Whether {@link Client.destroy} has run. */
	public isDestroyed(): boolean {
		return this.#isDestroyed
	}

	/** Every request start, settle and failure, plus whatever plugins publish. */
	public get events(): ClientEvents {
		return this.#events
	}

	/**
	 * The key a request would get, without issuing it.
	 *
	 * ```ts
	 * api.invalidate(api.getKey('/users/:id', { params: { id } }))
	 * api.invalidate(api.getKey(getUser, { id: '7' }))
	 * ```
	 */
	public getKey(path: string, options?: RequestOptions): string
	public getKey<Vars, Result>(endpoint: Endpoint<Vars, Result>, vars: Vars): string
	public getKey(pathOrEndpoint: string | Endpoint<unknown>, second?: unknown): string {
		if (typeof pathOrEndpoint === 'string') {
			return this.#prepare(pathOrEndpoint, (second as RequestOptions | undefined) ?? {}).key
		}

		const options = resolveEndpointOptions(pathOrEndpoint, second, undefined)

		return this.#prepare(pathOrEndpoint.path, options).key
	}

	/*
	 * PLUGINS
	 */
	/**
	 * Installs a plugin and merges what it returns onto the client, so the
	 * extension shows up in the type. `client.invalidate()` does not compile
	 * until `cache()` is installed.
	 */
	public with<Ext extends object>(plugin: Plugin<Ext>): this & Ext {
		this.#assertAlive()

		if (this.#plugins.some(installed => installed.name === plugin.name)) {
			throw new ConduitError({
				code: 'DUPLICATE_PLUGIN',
				message: `Plugin "${plugin.name}" is already installed.`,
			})
		}

		this.#plugins.push(plugin)

		if (plugin.middleware !== undefined) {
			this.#middlewares.push(plugin.middleware)
			this.#dispatch = compose(this.#middlewares, this.#transport)
		}

		const extension = plugin.onInit?.(this.#context)

		if (extension) {
			for (const key of Object.keys(extension)) {
				if (key in this) {
					throw new ConduitError({
						code: 'EXTENSION_COLLISION',
						message: `Plugin "${plugin.name}" adds "${key}", which the client already has. Rename it.`,
					})
				}
			}

			Object.assign(this, extension)
		}

		return this as this & Ext
	}

	/*
	 * REQUESTS
	 */
	public request<T = unknown, const P extends string = string>(
		path: P,
		...args: OptionsArgs<P, RequestOptions>
	): ConduitPromise<T> {
		return this.#execute<T>(path, (args[0] as RequestOptions | undefined) ?? {})
	}

	public get<T = unknown, const P extends string = string>(
		path: P,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T> {
		return this.#execute<T>(path, { ...(args[0] as MethodOptions | undefined), method: 'GET' })
	}

	public head<T = unknown, const P extends string = string>(
		path: P,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T> {
		return this.#execute<T>(path, { ...(args[0] as MethodOptions | undefined), method: 'HEAD' })
	}

	public delete<T = unknown, const P extends string = string>(
		path: P,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T> {
		return this.#execute<T>(path, {
			...(args[0] as MethodOptions | undefined),
			method: 'DELETE',
		})
	}

	public post<T = unknown, const P extends string = string>(
		path: P,
		body?: unknown,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T> {
		return this.#execute<T>(path, bodyOptions('POST', body, args[0]))
	}

	public put<T = unknown, const P extends string = string>(
		path: P,
		body?: unknown,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T> {
		return this.#execute<T>(path, bodyOptions('PUT', body, args[0]))
	}

	public patch<T = unknown, const P extends string = string>(
		path: P,
		body?: unknown,
		...args: OptionsArgs<P, MethodOptions>
	): ConduitPromise<T> {
		return this.#execute<T>(path, bodyOptions('PATCH', body, args[0]))
	}

	/**
	 * Runs a {@link defineEndpoint | typed endpoint}: `vars` fill its path
	 * params, build its query and body, and its `response` schema, if it has
	 * one, validates the decoded body before this resolves. A failing schema
	 * rejects with code `VALIDATION_FAILED`, carrying the issues as `body`.
	 *
	 * ```ts
	 * const user = await api.call(getUser, { id: '7' })
	 * ```
	 */
	public call<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		vars: Vars,
		options?: Partial<RequestOptions>,
	): ConduitPromise<Result> {
		const requestOptions = resolveEndpointOptions(endpoint, vars, options)
		const schema = endpoint.response

		const run = async (): Promise<ConduitResponse<Result>> => {
			const response = await this.#run<unknown>(endpoint.path, requestOptions)

			if (schema === undefined) {
				return response as ConduitResponse<Result>
			}

			return { ...response, data: await decodeEndpointResponse(schema, response) }
		}

		return createConduitPromise(run(), response =>
			redactResponse(response, this.#config.redact),
		)
	}

	/**
	 * Posts a `FormData` or `Blob`, with no default timeout, since a slow
	 * connection is not a hung one. It is a `post` that defaults its method and
	 * skips the timeout, and it runs through the same middleware stack as
	 * everything else. For progress events use `uploadWithProgress` from the
	 * `/upload` entry.
	 */
	public upload<T = unknown>(
		path: string,
		body: FormData | Blob,
		options: MethodOptions = {},
	): ConduitPromise<T> {
		const { meta, ...rest } = options

		return this.#execute<T>(path, {
			...rest,
			method: 'POST',
			body,
			meta: { timeoutMs: 0, ...meta },
		})
	}

	/*
	 * SCOPES
	 */
	/** Opens a cancellation boundary. Requests made through it carry `name` as their owner. */
	public scope(name: string): Scope {
		this.#assertAlive()

		const scope = createScope({
			name,
			createExecutor:
				(getSignal, owner) =>
				<T>(path: string, options: RequestOptions): ConduitPromise<T> =>
					this.#execute<T>(path, options, getSignal(), owner),
			onDispose: released => {
				this.#scopes.delete(released)
			},
		})

		this.#scopes.add(scope)

		return scope
	}

	/** Cancels everything in flight, across every scope. The client and its scopes stay usable. */
	public abortAll(reason?: string): void {
		const message = reason ?? 'Every in-flight request was aborted.'

		this.#root.abort(new ConduitError({ code: 'ABORTED', message }))
		this.#root = new AbortController()

		for (const scope of this.#scopes) {
			scope.abort(message)
		}
	}

	/*
	 * TEARDOWN
	 */
	public destroy(): void {
		if (this.#isDestroyed) {
			return
		}

		this.#isDestroyed = true

		this.#root.abort(
			new ConduitError({ code: 'ABORTED', message: 'The client was destroyed.' }),
		)

		for (const scope of [...this.#scopes]) {
			scope.dispose()
		}

		for (let index = this.#plugins.length - 1; index >= 0; index--) {
			this.#plugins[index]?.onDestroy?.()
		}

		this.#plugins.length = 0
		this.#middlewares.length = 0
		this.#resetListeners.clear()
		this.#changeListeners.clear()
		this.#dispatch = this.#transport

		if (this.#events.active) {
			this.#events.emit('client:destroy', { type: 'client:destroy', at: Date.now() })
		}

		this.#events.clear()
	}

	/*
	 * INTERNALS
	 */
	#subscribe<L>(listeners: Set<L>, listener: L): Unsubscribe {
		listeners.add(listener)

		return () => {
			listeners.delete(listener)
		}
	}

	/** Separate from `abortAll`: a sign-out has to forget what the client already holds. */
	#resetIdentity(): void {
		this.#notify(this.#resetListeners, listener => {
			listener()
		})
	}

	/** Runs every listener, and reports one that throws without stopping the rest. */
	#notify<L>(listeners: ReadonlySet<L>, run: (listener: L) => void): void {
		for (const listener of [...listeners]) {
			try {
				run(listener)
			} catch (error) {
				reportError(this.#config.logger, 'A plugin listener threw.', error)
			}
		}
	}

	#assertAlive(): void {
		if (this.#isDestroyed) {
			throw new ConduitError({
				code: 'DESTROYED',
				message: 'This client was destroyed. Create a new one.',
			})
		}
	}

	/** Everything a request's identity depends on, derived once and shared with `getKey`. */
	#prepare(path: string, options: RequestOptions): PreparedRequest {
		const config = this.#config
		const method = options.method ?? 'GET'
		const resolved = this.#policy.resolve(applyPathParams(path, options.params, config.logger))
		const url = appendQuery(resolved.href, options.query)
		const encoded = encodeBody(options.body)
		const credentials = options.credentials ?? config.credentials
		const parse = options.parse ?? config.parse

		if (encoded.body !== null && isBodyless(method)) {
			throw new ConduitError({
				code: 'INVALID_ARGUMENT',
				message: `${method} ${resolved.origin}${resolved.pathname} cannot carry a body. Drop it or use another method.`,
			})
		}

		const configHeaders = config.headers?.()
		const variance = deriveVariance(configHeaders, options.headers, config.vary, credentials)

		return {
			method,
			url,
			encoded,
			variance,
			credentials,
			parse,
			configHeaders,
			isCacheable: isCacheable(method, options.cacheable),
			key: options.key ?? deriveKey({ method, url, body: encoded.body, variance, parse }),
		}
	}

	#execute<T>(
		path: string,
		options: RequestOptions,
		scopeSignal?: AbortSignal,
		scopeOwner?: string,
	): ConduitPromise<T> {
		const run = this.#run<T>(path, options, scopeSignal, scopeOwner)

		return createConduitPromise(run, response => redactResponse(response, this.#config.redact))
	}

	#buildRequest(
		path: string,
		options: RequestOptions,
		scopeSignal: AbortSignal | undefined,
		scopeOwner: string | undefined,
	): ConduitRequest {
		const config = this.#config
		const prepared = this.#prepare(path, options)
		const signal = composeSignals([this.#root.signal, scopeSignal, options.signal])

		return createRequest({
			url: prepared.url,
			method: prepared.method,
			body: prepared.encoded.body,
			signal,
			key: prepared.key,
			variance: prepared.variance,
			lane: options.lane ?? config.lane,
			owner: options.owner ?? scopeOwner ?? config.owner,
			tags: options.tags ?? EMPTY_TAGS,
			cacheable: prepared.isCacheable,
			parse: prepared.parse,
			credentials: prepared.credentials,
			...mergePassthrough(options, config),
			meta: options.meta === undefined ? {} : { ...options.meta },
			redactUrl: this.#redactUrl,
			buildHeaders: () =>
				buildHeaders(prepared.configHeaders, options.headers, prepared.encoded.contentType),
		})
	}

	async #run<T>(
		path: string,
		options: RequestOptions,
		scopeSignal?: AbortSignal,
		scopeOwner?: string,
	): Promise<ConduitResponse<T>> {
		this.#assertAlive()

		const config = this.#config
		const request = this.#buildRequest(path, options, scopeSignal, scopeOwner)
		const isWatched = this.#events.active
		const started = isWatched ? getMonotonicTime() : 0
		const exposed = isWatched ? redactRequest(request, config.redact) : request

		if (isWatched) {
			this.#events.emit('request:start', {
				type: 'request:start',
				request: exposed,
				at: Date.now(),
			})
		}

		try {
			const response = (await this.#dispatch(request)) as ConduitResponse<T>

			if (isWatched) {
				this.#events.emit('request:settle', {
					type: 'request:settle',
					request: exposed,
					response: redactResponse(response, config.redact),
					durationMs: getMonotonicTime() - started,
					at: Date.now(),
				})
			}

			return response
		} catch (cause) {
			const error = toConduitError(cause)

			error.requestId ??= request.meta.requestId

			if (isWatched) {
				this.#events.emit('request:error', {
					type: 'request:error',
					request: exposed,
					error,
					durationMs: getMonotonicTime() - started,
					at: Date.now(),
				})
			}

			throw error
		}
	}
}

/*
 *   FACTORY
 ***************************************************************************************************/
export function createClient(config?: ClientConfig): Client {
	return new Client(config)
}
