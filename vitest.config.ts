import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx', 'apps/*/test/**/*.test.ts', 'apps/*/test/**/*.test.tsx'],   // .tsx files declare `@vitest-environment jsdom`
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },          // one process: shared Linux server memory cap (AGENTS.md §4)
    coverage: { provider: 'v8', include: ['packages/*/src/**'], reporter: ['text-summary'],
      thresholds: { 'packages/composition-model/src/**': { lines: 90 }, 'packages/agents/src/**': { lines: 90 } } },   // TRD TR-090
  },
  esbuild: { jsx: 'automatic' },
  resolve: { conditions: ['source'] },
});
