# poc/ — throwaway proof-of-concept code (Stage 2)

Nothing in this folder is product code. Each `poc/<nnn>/` implements one experiment from `docs/POC_PLAN.md`, records its result in that document's result log and in `process.md`, and is deleted or rewritten properly in Stage 3 under the normal workflow.

Rules: run on the shared Linux server only inside the memory cap (`bash poc/run-capped.sh <command…>`), one process at a time, ports 4110+ only; never commit keys (read them from a file outside the repo).
