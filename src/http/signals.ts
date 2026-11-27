/*
 *   COMPOSE
 ***************************************************************************************************/
/**
 * Merges caller, scope and timeout signals into the one the transport listens
 * to. First to abort wins and its `reason` carries through, so the failure says
 * which one it was.
 */
export function composeSignals(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
	const present: AbortSignal[] = []

	for (const signal of signals) {
		if (signal !== undefined) {
			present.push(signal)
		}
	}

	const only = present[0]

	if (present.length === 0) {
		return new AbortController().signal
	}

	return present.length === 1 && only !== undefined ? only : AbortSignal.any(present)
}
