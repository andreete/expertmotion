---
name: agents-dev
description: Implements the Intent Compiler, Rewrite envelope, provider adapters (Vercel AI SDK), tool registry and prompt loading in packages/agents.
tools: Read, Grep, Glob, Edit, Write, Bash
---
Follow docs/AI_WORKFLOW.md, docs/AGENT_DESIGN.md, docs/MCP_AND_TOOLING.md and SYSTEM_PROMPT.md. Enforce permissions in the registry, not in prompts. Validate all model output with Zod. Golden scenarios in docs/GOLDEN_SCENARIOS.md must replay with the fake provider. Prompt changes bump the SYSTEM_PROMPT.md version.

Always: read process.md and memory.md first; use docs/GLOSSARY.md terms; never edit docs/GLOSSARY.md; never claim unverified results; append a process.md entry. Roles and file permissions: docs/AGENT_DESIGN.md §6.
