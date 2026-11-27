/*
 *   CLIENT
 ***************************************************************************************************/
export { createClient } from './client/core'
export type { Client } from './client/core'
export { defaults } from './client/defaults'
export type { DefaultClient, DefaultsConfig, DefaultsWithSession } from './client/defaults'
export type { Scope } from './client/scopes'
export { sharedClient, getSharedClient, releaseSharedClient } from './client/shared'
export type {
	HotContext,
	SharedClientConfig,
	SharedMismatch,
	SharedMismatchKind,
} from './client/shared'
export { defineEndpoint } from './client/endpoint'
export type { Endpoint, EndpointDefinition, PathVars, StandardSchemaV1 } from './client/endpoint'

/*
 *   PLUGINS
 ***************************************************************************************************/
export { cache } from './plugins/cache'
export type { CacheApi, CacheConfig } from './plugins/cache'
export { dedupe } from './plugins/dedupe'
export type { DedupeApi } from './plugins/dedupe'
export { retry } from './plugins/retry'
export type { RetryConfig, RetryInfo } from './plugins/retry'
export { timeout } from './plugins/timeout'
export type { TimeoutConfig } from './plugins/timeout'
export { queue } from './plugins/queue'
export type { QueueApi, QueueConfig } from './plugins/queue'
export { session } from './plugins/session'
export type {
	AdapterContext,
	SessionAdapter,
	SessionApi,
	SessionConfig,
	SessionHandle,
	SessionState,
	SessionStatus,
} from './plugins/session'
export { apiVersion } from './plugins/api-version'
export type { ApiVersionConfig, ApiVersionMismatch } from './plugins/api-version'
export { observable } from './plugins/observable'
export type { ObservableApi, ObservableConfig, QueryState, QueryStatus } from './plugins/observable'
export { requestId } from './plugins/request-id'
export type { RequestIdConfig } from './plugins/request-id'

/*
 *   HTTP
 ***************************************************************************************************/
export { withRequest } from './http/request'
export { DEFAULT_REDACT } from './http/redact'
export type { RedactRules } from './http/redact'

/*
 *   ERRORS
 ***************************************************************************************************/
export { ConduitError, isConduitError, isErrorCode, toConduitError } from './primitives/errors'
export type { ConduitErrorCode, ConduitErrorInit, ConduitErrorJson } from './primitives/errors'

/*
 *   TYPES
 ***************************************************************************************************/
export type {
	ApiVersionMismatchEvent,
	CacheHitEvent,
	CacheInvalidateEvent,
	CacheMissEvent,
	CacheSetEvent,
	CacheStaleEvent,
	ClientDestroyEvent,
	ClientEvents,
	ConduitEvent,
	ConduitEventMap,
	ConduitEventType,
	DedupeJoinEvent,
	EventBus,
	QueueEnqueueEvent,
	RequestErrorEvent,
	RequestSettleEvent,
	RequestStartEvent,
	RetryAttemptEvent,
	SessionChangeEvent,
	Unsubscribe,
} from './primitives/events'
export type { ReadableStore } from './primitives/stores'
export type {
	CacheChange,
	ClientConfig,
	ConduitLogger,
	ConduitMeta,
	ConduitPromise,
	ConduitRequest,
	ConduitResponse,
	FetchLike,
	HttpMethod,
	Lane,
	MethodOptions,
	Middleware,
	NoExtension,
	PluginContext,
	Next,
	OptionsArgs,
	ParseMode,
	PathParamNames,
	PathParams,
	PathParamsOf,
	Plugin,
	Query,
	QueryValue,
	RedactConfig,
	RequestInitPassthrough,
	RequestMethods,
	RequestOptions,
	RequestPatch,
	ResolvedClientConfig,
	ResponseSource,
	SafeResult,
	Vary,
} from './primitives/types'
