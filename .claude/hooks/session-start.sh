#!/usr/bin/env bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
echo "Expertmotion — current state (from process.md):"
awk '/^## Current state/{f=1;next} /^---/{if(f)exit} f' process.md 2>/dev/null
echo "Provisional ADRs awaiting Operator confirmation: ADR-008, ADR-009, ADR-016 (docs/DECISIONS.md)."
echo "Rules: AGENTS.md. Glossary frozen. Product name: Expertmotion."
exit 0
