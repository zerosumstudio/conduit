import { defineConfig } from 'vitest/config'

/*
 *   VITEST CONFIG
 ***************************************************************************************************/
export default defineConfig({
	test: {
		globals: false,
		environment: 'jsdom',
		include: ['src/**/*.{test,spec}.ts'],
		clearMocks: true,
		restoreMocks: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html', 'lcov'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/__tests__/**', 'src/**/*.d.ts', 'src/index.ts'],
			thresholds: {
				statements: 90,
				branches: 90,
				functions: 90,
				lines: 90,
			},
		},
	},
})
