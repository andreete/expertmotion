import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },          // one process: shared Linux server memory cap (AGENTS.md §4)
    coverage: { provider: 'v8', include: ['packages/*/src/**'], reporter: ['text-summary'] },
  },
  resolve: { conditions: ['source'] },
});
