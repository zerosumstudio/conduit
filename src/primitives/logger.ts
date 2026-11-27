/*
 *   LOGGER
 ***************************************************************************************************/
/** What `ClientConfig.logger` must implement. Defaults to `console`. */
export interface ConduitLogger {
	warn(message: string): void
	error(message: string): void
}

/** Calls through to `console` fresh on every message, so a test spy still sees it. */
export const consoleLogger: ConduitLogger = {
	warn: message => {
		console.warn(message)
	},
	error: message => {
		console.error(message)
	},
}

/**
 * The one way conduit reports a failure nobody is awaiting: a listener that
 * threw, a refresh in the background, a renewal that failed. It always goes
 * through the client's logger.
 */
function describeCause(cause: unknown): string {
	if (cause === undefined) {
		return ''
	}

	if (cause instanceof Error) {
		return cause.message
	}

	return typeof cause === 'string' ? cause : JSON.stringify(cause)
}

export function reportError(logger: ConduitLogger, message: string, cause?: unknown): void {
	const detail = describeCause(cause)

	logger.error(`[conduit] ${message}${detail === '' ? '' : ` ${detail}`}`)
}
