// Per-app Vitest config so .tsx tests run with jsdom without touching the root config:
//   bash scripts/run-capped.sh npx vitest run --config apps/ui/vitest.config.ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  resolve: { conditions: ['source'] },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
