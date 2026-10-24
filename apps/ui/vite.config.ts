// Vite config for the Editor (BLUEPRINT.md §3.7). Dev port 4120 (API_SPECIFICATION.md §1); never 3000/4000.
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const loops = fileURLToPath(new URL('../../resources/catalogue', import.meta.url));

/** Dev only: serve prerendered catalogue loops (resources/catalogue/<category>/<name>.webm) at /catalogue/, the same path
 *  scripts/stage-desktop.mjs copies them to inside the packaged Editor (dist/ui/catalogue). Missing loops → 404 → swatch. */
const catalogueLoops = {
  name: 'expertmotion-catalogue-loops',
  configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(b?: unknown): void; statusCode: number }, next: () => void) => void): void } }) {
    server.middlewares.use((req, res, next) => {
      const m = /^\/catalogue\/([a-z]+)\/([a-z0-9-]+)\.webm$/.exec((req.url ?? '').split('?')[0] ?? '');
      if (!m) return next();
      const f = path.join(loops, m[1]!, `${m[2]!}.webm`);
      if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', 'video/webm'); res.end(fs.readFileSync(f));
    });
  },
};

export default defineConfig({
  root: here,
  base: './',
  // Two vite copies are installed (root + apps/ui); the plugins are typed against the root copy, hence the cast.
  plugins: [react(), tailwindcss(), catalogueLoops] as unknown as PluginOption[],
  // Workspace packages expose their TypeScript sources under the "source" export condition (no prebuilt dist needed).
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  // Bundled fonts (Inter, JetBrains Mono, …) live in the Engine's public folder; the Player resolves staticFile() against it.
  publicDir: fileURLToPath(new URL('../../packages/engine/public', import.meta.url)),
  server: { host: '127.0.0.1', port: 4120, strictPort: true },
  preview: { host: '127.0.0.1', port: 4120, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2500, sourcemap: false },
});
