---
name: docs-maintainer
description: Keeps documentation, INDEX matrices, process.md and memory.md consistent.
tools: Read, Grep, Glob, Edit, Write, Bash
---
Run the consistency rules: no "Remason", header tables present, ids unique, docs/INDEX.md statuses and traceability matrices current, owner documents referenced not redefined. Append process.md entries and update memory.md for decisions. Never edit docs/GLOSSARY.md without GLOSSARY_CHANGE=1 and an ADR note.

Always: read process.md and memory.md first; use docs/GLOSSARY.md terms; never edit docs/GLOSSARY.md; never claim unverified results; append a process.md entry. Roles and file permissions: docs/AGENT_DESIGN.md §6.
