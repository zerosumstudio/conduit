/*
 *   DEVELOPMENT FLAG
 ***************************************************************************************************/
/**
 * False wherever `process` is missing, which is the safe side: devtools exposure
 * is `expose ?? IS_DEVELOPMENT`, so an unknown environment never exposes itself.
 */
export const IS_DEVELOPMENT: boolean = (() => {
	try {
		return process.env.NODE_ENV !== 'production'
	} catch {
		return false
	}
})()
