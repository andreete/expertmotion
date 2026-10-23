# Hooks and Guardrails (development-time)

| Field | Value |
|---|---|
| Status | baseline |
| Owner | Engineering lead |
| Last updated | 2026-10-24 |
| Depends on | AGENTS.md, CLAUDE.md, DEVELOPMENT_WORKFLOW.md, DEFINITION_OF_DONE.md |
| Used by | .claude/settings.json, .claude/hooks/* |

Hooks are deterministic checks around a coding agent's tool calls (brief §8.5, §20). They exist to enforce real controls, not to decorate. Claude Code hook events used: `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`. Other assistants should run the same scripts from their own hook mechanism or from `npm` scripts/CI.

## 1. Guardrails

| Id | Hook | Event / matcher | Check | Action on violation | Rationale |
|---|---|---|---|---|---|
| HG-001 | `guard-bash.sh` | PreToolUse, Bash | command contains `npm run dev` (not `dev:capped`) **and** the host is the shared server (`hostname` matches the configured name or `/proc/meminfo` total < 4 GB) | block with message "use npm run dev:capped" | memory cap on the 1.9 GB server |
| HG-002 | `guard-bash.sh` | PreToolUse, Bash | command binds or references ports 3000/4000 (`:3000`, `PORT=4000`, `--port 4000`) | block | ports belong to another tenant |
| HG-003 | `guard-bash.sh` | PreToolUse, Bash | `git push --force`, `git push -f`, `rm -rf /`, `rm -rf ~` | block | destructive |
| HG-004 | `guard-bash.sh` | PreToolUse, Bash | command touches `/home/andre/experthinker-studio` with a write (`>`, `sed -i`, `rm`, `mv`, `npm install` inside it) | block | predecessor is read-only reference |
| HG-005 | `guard-write.sh` | PreToolUse, Edit/Write/MultiEdit | target is `docs/GLOSSARY.md` and the environment variable `GLOSSARY_CHANGE=1` is not set | block with "glossary is frozen; set GLOSSARY_CHANGE=1 and add an ADR note" | frozen vocabulary |
| HG-006 | `guard-write.sh` | PreToolUse, Edit/Write | target under `docs/` contains "Remason" in the new content (checked post-write by HG-010 too) | warn | product name |
| HG-007 | `guard-write.sh` | PreToolUse, Edit/Write | target is `.env`, `*.pem`, `*.key`, `license-private*` | block | secrets never in repo |
| HG-008 | `post-edit.sh` | PostToolUse, Edit/Write | file under `packages/composition-model/**` or `packages/agents/**` changed and `package.json` exists | run `npm run typecheck -w <pkg>` and the package's unit tests; report failures to the agent | schema/op safety |
| HG-009 | `post-edit.sh` | PostToolUse, Edit/Write | file is an owner document (`DATABASE_SCHEMA.md`, `AI_WORKFLOW.md`, `DESIGN_CATALOGUE.md`, `ELEMENT_IDS.md`, `API_SPECIFICATION.md`, `ERROR_CATALOGUE.md`, `PERFORMANCE.md`) | print the list of documents that reference it (grep) as a reminder to sync | single-owner rule |
| HG-010 | `post-edit.sh` | PostToolUse, Edit/Write | any file under `docs/` or root `.md` | `grep -n Remason <file>` → warn if found | product name |
| HG-011 | `secret-scan.sh` | PostToolUse, Edit/Write | content matches key patterns (`sk-[A-Za-z0-9]{20,}`, `sk-or-`, `AIza[0-9A-Za-z_-]{30,}`, `-----BEGIN .* PRIVATE KEY-----`) | block the write (revert) and warn | credentials |
| HG-012 | `stop-process-log.sh` | Stop | git working tree has changes but `process.md` was not modified in this session | print reminder "append a process.md entry before finishing" (non-blocking) | continuity |
| HG-013 | `session-start.sh` | SessionStart | — | print the "Current state" block of `process.md` and the three provisional ADR ids | orientation |
| HG-014 | CI (not a Claude hook) | pre-merge | `npm audit --audit-level=high`, licence scan, `grep -ri remason`, INDEX matrices script, typecheck, tests | fail the merge | release quality |

## 2. Wiring (`.claude/settings.json`)

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bash .claude/hooks/session-start.sh" }] }],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash .claude/hooks/guard-bash.sh" }] },
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "bash .claude/hooks/guard-write.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "bash .claude/hooks/post-edit.sh" }, { "type": "command", "command": "bash .claude/hooks/secret-scan.sh" }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bash .claude/hooks/stop-process-log.sh" }] }]
  }
}
```

Hook scripts read the tool input as JSON on stdin (Claude Code convention), use `jq` when available and fall back to `grep`, exit `0` to allow, print a message and exit `2` to block. They must finish in < 2 s except HG-008 (typecheck), which may take longer and runs only when code exists.

## 3. Policy checks that are documents, not hooks

- Definition of Done (`DEFINITION_OF_DONE.md`) is checked by the reviewer, not automatable.
- Threat-model review cadence (`THREAT_MODEL.md`).
- Stage gates (`STAGE_MANAGEMENT.md`).

## 4. Testing the hooks

`bash .claude/hooks/selftest.sh` feeds sample tool inputs to each guard and asserts allow/block. Run it after editing any hook; paste the output into `process.md`. (The selftest itself is a shell script; it does not run application code.)
