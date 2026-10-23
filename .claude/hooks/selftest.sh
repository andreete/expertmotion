#!/usr/bin/env bash
# Feeds sample inputs to the guards and reports allow/block. Does not run application code.
cd "$(dirname "$0")"
t() { local name="$1" script="$2" json="$3" expect="$4"; printf '%s' "$json" | bash "$script" >/dev/null 2>&1; local rc=$?; local got=allow; [ $rc -eq 2 ] && got=block; [ "$got" = "$expect" ] && echo "PASS $name" || echo "FAIL $name (expected $expect, got $got)"; }
t HG-002-port guard-bash.sh '{"tool_input":{"command":"PORT=4000 node x.js"}}' block
t HG-003-force guard-bash.sh '{"tool_input":{"command":"git push --force origin main"}}' block
t HG-003-ok guard-bash.sh '{"tool_input":{"command":"git push origin main"}}' allow
t HG-004-pred guard-bash.sh '{"tool_input":{"command":"rm -rf /home/andre/experthinker-studio/apps"}}' block
t HG-005-glossary guard-write.sh '{"tool_input":{"file_path":"/x/docs/GLOSSARY.md","content":"a"}}' block
t HG-007-env guard-write.sh '{"tool_input":{"file_path":"/x/.env","content":"a"}}' block
t HG-ok-doc guard-write.sh '{"tool_input":{"file_path":"/x/docs/PRD.md","content":"Expertmotion"}}' allow
