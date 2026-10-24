// Vite config for the Editor (BLUEPRINT.md §3.7). Dev port 4120 (API_SPECIFICATION.md §1); never 3000/4000.
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  // Two vite copies are installed (root + apps/ui); the plugins are typed against the root copy, hence the cast.
  plugins: [react(), tailwindcss()] as unknown as PluginOption[],
  // Workspace packages expose their TypeScript sources under the "source" export condition (no prebuilt dist needed).
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  // Bundled fonts (Inter, JetBrains Mono, …) live in the Engine's public folder; the Player resolves staticFile() against it.
  publicDir: fileURLToPath(new URL('../../packages/engine/public', import.meta.url)),
  server: { host: '127.0.0.1', port: 4120, strictPort: true },
  preview: { host: '127.0.0.1', port: 4120, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2500, sourcemap: false },
});
