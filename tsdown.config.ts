import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		react: 'src/react.ts',
		devtools: 'src/devtools.ts',
		testing: 'src/testing.ts',
		upload: 'src/upload.ts',
	},
	format: 'esm',
	platform: 'neutral',
	target: 'es2022',
	dts: true,
	clean: true,
	minify: false,
	sourcemap: false,
	outDir: 'dist',
})
