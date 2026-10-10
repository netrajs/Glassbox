import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the side panel into dist/index.js + dist/index.css with fixed names,
// so the extension can load them without reading a manifest.
export default defineConfig({
	plugins: [react()],
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		sourcemap: false,
		rollupOptions: {
			input: 'src/main.tsx',
			output: {
				entryFileNames: 'index.js',
				assetFileNames: 'index[extname]',
			},
		},
	},
});
