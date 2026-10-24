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

## Editor features added in the gap pass (2026-10-24)

| Feature | Where | Spec |
|---|---|---|
| In-app tour on the real Editor with the R-025 sample project (`createSampleProject`, `ProjectDto.isSample`); steps advance on their real trigger (Design click, a pick, a supersede, a timeline selection, a message, Execute, a ratio pick, opening Export) or Next; Esc asks before ending; Help ▸ Tour re-runs it (choice between this project and the sample when the project has clips); TOUR-7 shows the prepared sample plan without a provider; `service.notice {kind:'sample', ready:false}` shows a toast and the tour continues | `src/screens/Tour.tsx`, `state/store.tsx` (`openSampleProject`), `state/reducer.ts` (`sampleReady`), mock R-025 in `src/mock/server.ts` | ONBOARDING_TOUR.md §3, ONB-6 |
| Sample marker "Sample · " / "Contoh · " in the Project Title (`hdr.title.sample`) | `src/header/Header.tsx` | ONBOARDING_TOUR.md §2 |
| Panel dividers `lib.divider`, `agent.divider`, `stage.divider` (`role="separator"`, ←/→ or ↑/↓ by 16 px, Home/End, double-click or Enter resets, drag); ranges Library 240–420 (drag below 200 collapses), Agent 320–520, Stage ≥ 560, Timeline 220 to 50 % of the Stage; sizes in prefs (`expertmotion.prefs.v1` → `panelSizes` per window-width bucket) | `src/components/Splitter.tsx`, `src/layout.ts`, `src/App.tsx` | EDITOR_INTERACTION_MODEL.md §9, FR-099, FR-155 |
| Catalogue Card ⓘ Details popover (`lib.catalogue.card.details`, `lib.catalogue.params*`): fields from `presetParamsJsonSchema`, defaults from `preset.defaults`, client-side `validateParams`, "Apply with these settings" sends R-060 `params`; Space on a card opens it; focus trapped, Esc returns focus to ⓘ | `src/library/PresetParams.tsx`, `src/library/Catalogue.tsx` | UI_UX_SPECIFICATION.md §11.1 |
| Intent Queue grouping "Applied in v5 (3)" (`agent.editor.intentqueue.group`), collapsed by default, expandable | `src/agent/IntentQueue.tsx` (`groupQueue`) | UI_UX_SPECIFICATION.md §11.3 |
| Generator Insert without the Editor Agent: generated Asset → R-035; captions → R-130 again with `insert: true` | `src/screens/Generate.tsx` | API_SPECIFICATION.md R-130, R-035 |

Tests: `test/tour.test.tsx`, `test/layout.test.tsx`, `test/params.test.tsx`, `test/generate.test.tsx`, grouping in `test/intentqueue.test.tsx`.
