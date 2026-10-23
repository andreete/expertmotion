---
name: em-remotion-preset
description: Add or change a Design Preset end to end (catalogue row, engine component, compile entry, preview loop, golden frames, i18n).
---
# Steps
1. Read the DESIGN_CATALOGUE.md row and REMOTION_CAPABILITY_MAP.md row; add them if missing.
2. Implement the component in packages/engine using theme tokens and layout unit u; params via the preset Zod schema.
3. Add the Compile table entry in packages/agents and the preview loop entry in the build script.
4. Add golden-frame tests in all seven ratios; on the shared server use the capped runner and concurrency 1.
5. Add EN/ID labels and tags. Update docs rows. process.md entry with test output.
# Checks before finishing
- npm run typecheck passes
- golden frames pass in 7 ratios
- catalogue + mapping rows present; preset id never renamed
# Files you may modify
- packages/engine/**, packages/agents/src/compile/**, docs/DESIGN_CATALOGUE.md, docs/REMOTION_CAPABILITY_MAP.md, test/**, process.md

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
