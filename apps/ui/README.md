# @expertmotion/ui — the Editor

React 19 + Vite 6 + Tailwind v4 + `@remotion/player`. Specification: `docs/BLUEPRINT.md` §3.7, `docs/UI_UX_SPECIFICATION.md`,
`docs/ELEMENT_IDS.md` (every interactive element carries `data-el`), `docs/API_SPECIFICATION.md` (client in `src/api/`).

On the shared Linux server run everything through the memory cap from the repo root:

```
bash scripts/run-capped.sh npx tsc -p apps/ui --noEmit
bash scripts/run-capped.sh npx vitest run --config apps/ui/vitest.config.ts   # all UI tests incl. jsdom .tsx
bash scripts/run-capped.sh npx vite build apps/ui
```

Runtime selection (`src/main.tsx`): `VITE_EM_MOCK=1` uses the in-memory fake Local Service (`src/mock/server.ts`);
otherwise the Desktop Shell bootstrap (`window.expertmotion.getBootstrap()`) or `VITE_EM_API` + `VITE_EM_TOKEN` in development.
Dev server port 4120 (never 3000/4000).
