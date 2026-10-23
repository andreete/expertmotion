# MCP and Tooling: MCP evaluation, the Tool layer, provider adapters, development-time tooling

| Field | Value |
|---|---|
| Status | baseline |
| Owner | AI agent architect |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, DECISIONS.md (ADR-002, ADR-003, ADR-015, ADR-009), AI_WORKFLOW.md (§3, §8, §10, §11, §12), ARCHITECTURE.md (§3, §4, §9), ASSESSMENT.md (§4, §8), PERFORMANCE.md, ERROR_CATALOGUE.md, MASTER_PROJECT_PROMPT.md (§8.5, §9, §20) |
| Used by | AGENT_DESIGN.md, SYSTEM_PROMPT.md, API_SPECIFICATION.md, SECURITY.md, THREAT_MODEL.md, AGENT_SKILLS.md, HOOKS_AND_GUARDRAILS.md, TEST_PLAN.md, GOLDEN_SCENARIOS.md, TRD.md |
| Owner of | the MCP decision record (ADR-015 evaluation), the Tool registry structure and execution wrapper, tool permission tags, the JSON-mode fallback protocol, the provider adapter layer, the single egress module, the development-time vs runtime tooling distinction |
| ID range | none. Tool contracts are referenced by tool name (`composition.get`); requirements remain `AI-0xx` in AI_WORKFLOW.md; codes defined in ERROR_CATALOGUE.md are cited as-is; the tool-layer codes proposed here use the free band EM-45xx and are marked "proposed" until ERROR_CATALOGUE.md appends them |

This document records why Expertmotion does **not** use the Model Context Protocol (MCP) in the MVP (ADR-015), and specifies what it uses instead: a registry of typed, in-process Tools with a permission model, an execution wrapper, a provider adapter layer, and a single network egress module. It references AI_WORKFLOW.md for every schema and never redefines one. Terms follow GLOSSARY.md.

External facts: MCP specification revision **2026-07-28** (schema at `schema/2026-07-28/schema.ts`), transports stdio and Streamable HTTP, security principles "User Consent and Control", "Data Privacy", "Tool Safety" (https://modelcontextprotocol.io/specification/latest, accessed 2026-10-24; transports per ASSESSMENT.md §8). Remotion's own MCP server is deprecated (ASSESSMENT.md §4, https://www.remotion.dev/docs/ai/mcp).

## 1. The question (brief §8.5)

> "Evaluate MCP against typed internal APIs. MCP is optional unless it provides a concrete benefit to the MVP."

Two candidate shapes for the layer between the Editor Agent / Brainstorming Agent and the Local Service:

| Shape | Description |
|---|---|
| **A. MCP** | The Local Service runs an MCP server (stdio or Streamable HTTP). The agent runtime is an MCP client/host; model tool calls are forwarded as MCP `tools/call` JSON-RPC requests; tool lists come from `tools/list`. |
| **B. Typed in-process Tools** | The agent runtime (`packages/agents`) holds a registry of TypeScript functions with Zod input/output schemas and permission tags. The model sees JSON Schema derived from Zod; calls are dispatched in-process inside the Local Service. |

Both shapes keep the invariant that the model proposes and deterministic code validates and executes (AI-001, brief §8.5). The difference is the hop between the model loop and the function.

## 2. Evaluation

### 2.1 Criteria and scores

Scale: `++` clearly better, `+` better, `=` equal, `-` worse, `--` clearly worse, for the **MVP** (one process, one Creator, agents embedded in the product).

| Criterion | A. MCP | B. Typed in-process Tools | Notes |
|---|---|---|---|
| Security boundary | `-` | `++` | Both agents already run inside the Local Service; an MCP server adds a second entry point (a socket or a child process) that must be authenticated, Host/Origin-guarded and audited like the REST API (ADR-005). In-process Tools add no listener. The brief's rule "narrow, documented application tools rather than filesystem or shell access" is satisfied by B directly; MCP's generality (resources, prompts, sampling, elicitation) is attack surface Expertmotion does not need. |
| Latency | `-` | `++` | In-process call: microseconds plus the handler. MCP over stdio: JSON-RPC serialisation, a child-process round trip, initialise/capability negotiation per session; over Streamable HTTP: an HTTP request per call. For plans with up to 40 steps and the two-correction loop (AI_WORKFLOW §8), hop cost accumulates on T0 laptops. |
| Schema validation | `=` | `+` | MCP tools carry JSON Schema `inputSchema` (and `outputSchema` since 2025-06); validation is still done by the server. B validates **both** input and output with the same Zod objects the Composition Model uses (`packages/composition-model`), so a tool cannot return a shape the Intent Compiler does not understand. |
| Permission model | `-` | `++` | MCP has no permission model for *which agent may call which tool*; the host is expected to ask the user per call ("Hosts must obtain explicit user consent before invoking any tool", spec Security section). Expertmotion's gate is **Execute**, once per plan, not once per tool call. B encodes `read|propose|mutate|spawn` tags and a per-agent caller list in the registry (§3.2) and enforces them in one wrapper. |
| Debuggability | `=` | `+` | MCP has well-known inspectors (`@modelcontextprotocol/inspector`). B has a plain function call stack, one structured log line per call (§3.3), and the fake-provider replay harness (GOLDEN_SCENARIOS.md §5) with no transport to mock. |
| Provider independence | `=` | `=` | Neither shape is tied to a provider. Tool calling itself is unified by the Vercel AI SDK (§5); MCP would sit *behind* that, not replace it. The JSON-mode fallback for models without tool calling (§3.5) is identical for both. |
| Packaging complexity | `--` | `++` | MCP stdio = one more child process to bundle, sign, supervise and restart (Desktop Shell already supervises the Local Service, Chrome Headless Shell, FFmpeg and Engine Binaries). Streamable HTTP = one more port and token. B ships as code inside the Local Service bundle. |
| Benefit to the Creator | `-` | `+` | The Creator never sees MCP. The only Creator benefit MCP could give is **external** assistants (Claude Desktop, IDE agents) controlling Expertmotion. That is PRD-056 (P2, "MCP façade for external assistants") and not part of the smallest complete workflow (brief §17). B gives the Creator faster plans and fewer failure modes now. |

### 2.2 Conclusion (= ADR-015)

**No MCP in the MVP.** Agents call typed in-process Tools (shape B). The registry in §3 is designed so that an MCP façade can be generated from it later without changing a single tool handler.

### 2.3 Conditions for adding an MCP façade post-MVP

All of the following must hold before the façade (sketched in §6.1) is scheduled:

| # | Condition | Why |
|---|---|---|
| C1 | A concrete Creator request exists: an **external assistant** (for example Claude Desktop or a coding agent) should read a Project and propose Edit Plans. | The brief allows MCP only for a concrete benefit. |
| C2 | Transport is **Streamable HTTP on loopback** (`127.0.0.1`), authenticated with the **Service Token** (bearer), Host/Origin guarded exactly like the REST API (ADR-005). No stdio launcher, so the Desktop Shell remains the only process supervisor. | Reuses the existing security boundary. |
| C3 | Exposed tools are **read-only or `propose`** (`composition.get`, `assets.list`, `catalogue.search`, `hardware.profile`, `project.settings.get`, `render.estimate`, `composition.validateOps`, plus `plan.propose`). **No `mutate` or `spawn` tool is exposed.** Execute still happens in the Editor's Plan Card. | Preserves AI-004 (Execute is the only mutation gate) and AI-020. |
| C4 | The façade is **off by default**, enabled per launch by the Creator in Settings, and **unavailable while Private Mode is on** (an external assistant may send project data to its own cloud). | Private Mode promise (PRD-020). |
| C5 | ADR-015 is superseded by a new ADR and `EditPlan.origin` gains the value `external` (schema change → DATABASE_SCHEMA.md migration note). | Append-only decisions; provenance of plans stays visible in the Plan Card. |

## 3. The Tool layer (shape B)

### 3.1 Registry structure

Location: `packages/agents/src/tools/registry.ts`; one file per tool under `packages/agents/src/tools/<name>.ts`. The registry is the **only** enumeration of tools; SYSTEM_PROMPT.md, AGENT_DESIGN.md and the JSON-mode fallback prompt are generated from it at build time (a drift test fails the build if a prompt mentions a tool not in the registry).

```ts
// packages/agents/src/tools/registry.ts (shape; exact code in Stage 5)
import { z } from 'zod';

export type Permission = 'read' | 'propose' | 'mutate' | 'spawn';
export type Caller = 'brainstorm' | 'editor' | 'runtime' | 'creator';
export type CostClass = 'free' | 'io' | 'cpu' | 'spawn';

export interface ToolContext {
  projectId: string;
  caller: Caller;                 // who is invoking (the agent runner sets it; the model cannot)
  agentRunId?: string;
  planId?: string;                // set only by the Execute runner
  hardwareTier: 'T0' | 'T1' | 'T2';
  privateMode: boolean;
  signal: AbortSignal;            // timeout + Creator cancel (agent.editor.cancel)
  log: (event: ToolLogEvent) => void;
}

export interface ToolDefinition<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: `${string}.${string}`;    // "<domain>.<verb>" e.g. "composition.get"
  description: string;            // style guide §3.4; ≤ 60 words; may contain an Indonesian example
  input: I;                       // Zod; every field has .describe()
  output: O;                      // Zod; validated before the result is returned
  permission: Permission;
  callers: readonly Caller[];     // who may call; 'runtime' = plan step executed after Execute
  timeoutMs: number;
  costClass: CostClass;
  resultBudgetBytes?: number;     // default 32 768; larger results are summarised/truncated with a marker
  examples?: ReadonlyArray<{ input: z.input<I>; note: string }>;
  handler: (input: z.output<I>, ctx: ToolContext) => Promise<z.output<O>>;
}
```

Permission tags:

| Tag | Meaning | Allowed from a model tool call? |
|---|---|---|
| `read` | Returns data; no side effects; idempotent. | yes |
| `propose` | Computes a proposal (dry run, estimate, validation); no state change. | yes |
| `mutate` | Changes the Composition Model, settings or the render queue. | **never**; only the Execute runner (`runtime`) or the Creator (`creator`) |
| `spawn` | Starts a child process or a job (generators, render). | **never** from a model call; `runtime` via a validated plan step, or `creator` |

The registry rows (contracts are in AI_WORKFLOW.md §8; this table adds the tooling attributes):

| Tool | Permission | Callers | Timeout | Cost class | Result budget |
|---|---|---|---|---|---|
| `composition.get` | read | brainstorm (summary only), editor, runtime | 2 000 ms | io | 16 KB summary / 256 KB full (editor only) |
| `composition.validateOps` | propose | editor, runtime | 5 000 ms | cpu | 32 KB |
| `composition.applyOps` | mutate | runtime (Execute runner only) | 30 000 ms | io | 32 KB |
| `catalogue.search` | read | brainstorm, editor | 1 000 ms | free | 16 KB (max 20 presets) |
| `assets.list` | read | brainstorm, editor, runtime | 2 000 ms | io | 16 KB |
| `assets.probe` | read | editor, runtime | 10 000 ms | cpu (ffprobe, cached) | 8 KB |
| `captions.generate` (P1) | spawn | runtime (plan step) | returns `jobId` ≤ 2 000 ms; job timeout in LOCAL_AI_MODELS.md | spawn | 1 KB |
| `tts.generate` (P1) | spawn | runtime (plan step) | as above | spawn | 1 KB |
| `music.generate` (P2) | spawn | runtime (plan step) | as above | spawn | 1 KB |
| `thumbnail.generate` (P2) | spawn | runtime (plan step) | as above | spawn | 1 KB |
| `render.estimate` | propose | brainstorm, editor, creator | 5 000 ms | cpu | 2 KB |
| `render.start` | mutate + spawn | **creator only** (Export dialog) | 2 000 ms (enqueue) | spawn | 1 KB |
| `hardware.profile` | read | brainstorm, editor, runtime | 500 ms (cached reading) | free | 1 KB |
| `project.settings.get` | read | brainstorm, editor, runtime | 1 000 ms | io | 2 KB |

Rules:
- A tool with `permission: 'mutate' | 'spawn'` is **not included** in the tool list sent to any model (§3.4); the model cannot even name it. The Editor Agent references generators and `composition.applyOps` only as **plan step `tool` names** inside the EditPlan JSON; the Execute runner invokes them after validation.
- `render.start` has no model-facing description at all; agents "may only suggest" (AI_WORKFLOW §8) by writing a risk/note in the plan.
- Adding a tool requires: registry entry, unit test, AGENT_DESIGN.md permission row, SYSTEM_PROMPT.md regeneration, and a GOLDEN_SCENARIOS.md case if it changes plan shapes.

### 3.2 Per-agent permission table (consistent with AI_WORKFLOW §8–§9)

| Tool | Brainstorming Agent | Editor Agent | Runtime (Execute runner / plan steps) | Creator (UI) |
|---|---|---|---|---|
| `composition.get` | summary only (`{summary: true}` forced by the wrapper) | summary or full | full | via Timeline View |
| `assets.list` | yes | yes | yes | Asset Panel |
| `catalogue.search` | yes | yes | — | Catalogue Search |
| `hardware.profile` | yes | yes | yes | Hardware Monitor |
| `project.settings.get` | yes | yes | yes | Project Settings |
| `composition.validateOps` | **no** | yes | yes (plan validation step 8) | — |
| `assets.probe` | **no** | yes | yes | Asset card tooltip |
| `render.estimate` | yes | yes | — | Export dialog |
| `composition.applyOps` | **no** | **no** (plan step name only) | yes, once per plan, inside one transaction | Execute button |
| `captions.generate`, `tts.generate`, `music.generate`, `thumbnail.generate` | **no** | **no** (plan step name only) | yes, as validated plan steps (P1/P2) | Generator Cards |
| `render.start` | **no** | **no** | **no** | **yes**, Export dialog only |

The Brainstorming Agent additionally has the output field `proposedIntents` (AI_WORKFLOW §9); that is an output schema, not a tool, and the handoff card is the Creator's gate.

### 3.3 Execution wrapper

Every call, from a model or from the runtime, goes through `executeTool(name, rawInput, ctx)`:

| Step | Action | On failure |
|---|---|---|
| 1 Lookup | find the tool in the registry | `EM-4501` unknown tool (proposed) |
| 2 Permission | `ctx.caller ∈ tool.callers`; a model caller may never reach `mutate`/`spawn` | `EM-4502` tool not permitted for this caller (proposed) |
| 3 Input validation | `tool.input.safeParse(rawInput)` | `EM-4503` invalid tool input, `issues[]` from Zod (proposed); the model may correct itself (max 2 corrections per run, AI_WORKFLOW §8) |
| 4 Preconditions | `spawn` tools: model installed and not Private-Mode-blocked for downloads; `composition.*`: project exists and `baseVersion` known | `EM-4506` precondition failed (proposed), message names the missing piece |
| 5 Run | `Promise.race(handler(input, ctx), timeout(tool.timeoutMs))`, honouring `ctx.signal` | `EM-4504` tool timed out (proposed) |
| 6 Output validation | `tool.output.safeParse(result)` | `EM-4505` tool returned an invalid result (proposed; an internal bug, logged at `error`, never shown as the model's fault) |
| 7 Result budget | serialise; if > `resultBudgetBytes`, apply the tool's summariser (or truncate arrays with `"…(+N more)"`) and set `truncated: true` | — |
| 8 Log | one JSON line (§3.3.2) | — |
| 9 Return | `{ok: true, result}` or `{error: {code, message, issues?}}` | — |

Error envelope (the shape the model receives as the tool result; AI_WORKFLOW §8):

```json
{ "error": { "code": "EM-4503", "message": "input.ops[2].args.durationMs: expected number 100..2000, received 5000", "issues": [{ "path": ["ops", 2, "args", "durationMs"], "message": "Number must be less than or equal to 2000" }] } }
```

Rules:
- The `message` is written for the model (English, terse, names the path). When an error must be shown to the Creator (after corrections are exhausted), the Editor shows the ERROR_CATALOGUE copy for the code, EN/ID, never the raw Zod text; the raw text sits behind "Details".
- A wrapper error never throws into the agent loop; it is returned as the tool result so the model can correct (AI-005). After the second correction on the same tool, the run ends with the last error code and the Plan Card shows "The model could not use a tool correctly · EM-45xx" / "Model tidak dapat memakai alat dengan benar · EM-45xx".
- `ctx.signal` is aborted by `agent.editor.cancel`; an aborted call returns `EM-4507` cancelled (proposed); the run is marked `cancelled` and the chat shows `EM-4303` "Request cancelled" (ERROR_CATALOGUE.md).

#### 3.3.1 Error codes: proposed additions (EM-45xx tool layer, EM-8203 egress) and reused definitions

ERROR_CATALOGUE.md (147 codes) already covers Private Mode, JSON mode and cancellation; only the tool-layer band and one egress code are new. Proposed rows follow the catalogue's column set (severity, EN/ID title and body, action, log fields) and its style guide (formal "Anda", no jargon).

| Code | Meaning | Creator copy EN / ID |
|---|---|---|
| EM-4501 (proposed, error) | Unknown tool name | "The model asked for a tool that does not exist. Try again or choose another model." / "Model meminta alat yang tidak ada. Coba lagi atau pilih model lain." |
| EM-4502 (proposed, error) | Tool not permitted for this caller | "The model tried an action it is not allowed to take. Nothing was changed." / "Model mencoba tindakan yang tidak diizinkan. Tidak ada yang berubah." |
| EM-4503 (proposed, error) | Invalid tool input after two corrections | "The model sent incomplete details twice. Try again or choose another model." / "Model dua kali mengirim detail yang tidak lengkap. Coba lagi atau pilih model lain." |
| EM-4504 (proposed, error) | Tool timed out | "A step took too long and was stopped. Try again." / "Satu langkah terlalu lama dan dihentikan. Coba lagi." |
| EM-4505 (proposed, error) | Tool returned an invalid result | "Something went wrong inside Expertmotion. Nothing was changed." / "Terjadi kesalahan di dalam Expertmotion. Tidak ada yang berubah." Action: Open Diagnostics |
| EM-4506 (proposed, error) | Tool precondition failed | "This step needs something that is missing (for example a model or an asset). Add it and try again." / "Langkah ini membutuhkan sesuatu yang belum ada (misalnya model atau aset). Tambahkan lalu coba lagi." |
| EM-4507 (proposed, info) | Tool call cancelled | "The step was cancelled. Nothing was changed." / "Langkah dibatalkan. Tidak ada yang berubah." |
| EM-8203 (proposed, error) | Egress blocked: host not on the allow-list | "Expertmotion only connects to the providers you configured. The request to \"{host}\" was blocked." / "Expertmotion hanya terhubung ke penyedia yang Anda atur. Permintaan ke \"{host}\" diblokir." |
| EM-8202 (defined) | Egress blocked: Private Mode is on | catalogue copy "Blocked by Private Mode" / "Diblokir Private Mode" (`{action}` = "Ask {model}"); the composer notice itself is EM-4401 "Agents are off in Private Mode" |

Defined codes reused unchanged (ERROR_CATALOGUE.md): EM-4101/4102 (provider timeout, rate limit), EM-4103 (provider 5xx), EM-4201/4202 (budget reached / 80 %), EM-4301 (invalid JSON after retries), EM-4303 (request cancelled), EM-4304 (request interrupted by restart), EM-4005 (JSON mode notice), EM-4401 (agents off in Private Mode), EM-8201 (offline), EM-8202 (blocked by Private Mode), EM-2201 (Target Resolution reject), EM-2302 (plan touched Locked Keys; steps removed), EM-31xx (preflight).

#### 3.3.2 Logging and redaction

One JSON line per call to `logs/service.log` (ARCHITECTURE §9):

```json
{ "t": "2026-10-24T08:12:31.412Z", "lvl": "info", "ev": "tool.call", "tool": "catalogue.search", "caller": "editor", "runId": "01J…", "projectId": "01J…", "ms": 3, "ok": true, "inBytes": 61, "outBytes": 2140, "truncated": false }
```

Redaction (applied by the logger, not by callers):

| Pattern | Replacement |
|---|---|
| `sk-[A-Za-z0-9_-]{8,}`, `sk-or-…`, `sk-ant-…`, `AIza[0-9A-Za-z_-]{30,}`, `Bearer …` | `[redacted:key]` |
| absolute file paths (`C:\…`, `/home/…`) | `[path:<assetId>]` when resolvable, else `[path]` |
| Creator chat text and `creatorNotes` | not logged at `info`; at `debug` the first 200 characters, flagged `creatorText: true` |
| provider responses | never logged in full; only `usage`, model id, finish reason, byte count; raw text of an `EM-4301` failure is stored on the `agent_runs` row (encrypted DB), not in the log |

### 3.4 Describing tools to the model

- **Schema**: JSON Schema is derived from the Zod `input` with `z.toJSONSchema()` (Zod 4) at registry load; `additionalProperties: false`; every property has a `description`. The same derivation feeds the JSON-mode prompt (§3.5) and the future MCP `inputSchema` (§6.1), so there is one source.
- **Model-facing list**: only tools where `callers` includes the current agent **and** `permission ∈ {read, propose}`.
- **Description style guide**:

| Rule | Example |
|---|---|
| First sentence: imperative verb + what it returns. | "Search the Design Catalogue and return matching presets with their parameter schemas." |
| Second sentence: when to use it. | "Use it before proposing any `presetId` you are not certain exists." |
| Optional third: when not to. | "Do not use it to list every preset; the capabilities block already contains the ids." |
| ≤ 60 words; no Markdown; no mention of Remotion, React, files or paths. | — |
| Indonesian examples are allowed in `examples[].note` and in the description when they help a mixed-language Creator. | `{ input: { query: "transisi halus" }, note: "Pencarian dalam Bahasa Indonesia cocok dengan tag ID preset (lembut, pudar)." }` |
| Parameter descriptions state units and ranges. | `durationMs: "Transition length in milliseconds, 100–2000; default 500."` |
| Never instruct the model about UI or approval in a tool description; that belongs to SYSTEM_PROMPT.md. | — |

### 3.5 JSON-mode fallback (models without tool calling)

The Capability Table (§5.2) marks `toolCalling: false` for some models. For them the runner switches to **JSON mode**:

| Aspect | Behaviour |
|---|---|
| Tool list | Embedded in the system prompt as a fenced JSON array `[{name, description, inputSchema}]` generated from the registry (same filter as §3.4). |
| Turn protocol | The model must answer with exactly one JSON object matching `JsonModeTurn` (below). No prose outside the object. If the provider supports `response_format: json_object` / `json_schema`, it is set; otherwise the instruction "respond with JSON only" plus a leading `{` assistant prefill where the provider allows it. |
| Tool rounds | Max 6 tool rounds per run (tool-calling models: max 12 tool calls). Each round's tool result is appended as a user message `{"toolResult": {...}}`. |
| Final answer | Editor Agent: `{"type":"final","plan": <EditPlan>}`; Brainstorming Agent: `{"type":"final","reply": "...", "proposedIntents": [...]}`. Parsed with the same Zod schemas as the tool-calling path. |
| Failures | Non-JSON or schema failure → re-prompt with the Zod error, max 2 (AI_WORKFLOW §12) → `EM-4301`. |
| Creator notice | Chat footer badge "Simple mode" / "Mode sederhana" with the EM-4005 copy (ERROR_CATALOGUE.md): "\"{model}\" does not support tool calling, so Expertmotion asks it for plain JSON plans instead. Results may be less reliable." / "\"{model}\" tidak mendukung pemanggilan alat, jadi Expertmotion memintanya membuat rencana JSON biasa. Hasil mungkin kurang andal." |

```ts
const JsonModeTurn = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool'),  name: z.string(), input: z.record(z.unknown()) }),
  z.object({ type: z.literal('final'), plan: EditPlan.optional(), reply: z.string().optional(), proposedIntents: z.array(EditIntent).optional() }),
]);
```

Validation and permissions in JSON mode are **identical** to the tool-calling path; the only difference is how the call is transported in the text.

## 4. Development-time tooling vs runtime agents (brief §20)

Expertmotion has two unrelated kinds of "agent tooling". They share no code, no prompts and no permissions.

| Aspect | Development-time (repo-side) | Runtime (inside Expertmotion) |
|---|---|---|
| What | Claude Code skills (`.claude/skills/*`), hooks (`.claude/settings.json`), subagents (`.claude/agents/*`), `AGENTS.md`/`CLAUDE.md` repository instructions | Brainstorming Agent, Editor Agent, Runtime Sub-agents, the Tool registry (§3) |
| Who runs it | The Operator and coding agents while building the product | The Creator's installed app |
| Where it runs | Developer machine / CI; may use shell, git, filesystem, test runners | Local Service process; Tools only (AI-006, AI-020); no shell, filesystem or network tools |
| Model and cost | Operator's own account and model (for example Claude) | Creator's Provider Connection; usage shown in chat footers (AI-015) |
| Purpose | Requirements analysis, architecture review, Remotion integration, UI implementation, DB migrations, provider integration, agent workflow implementation, security review, testing, packaging, documentation maintenance | Help the Creator make a video |
| Guardrails | Hooks: format, typecheck, tests, secret scan (`gitleaks`-style patterns), doc-consistency checks (glossary terms, element ids, op/preset ids exist), "no edits to frozen docs" policy | Zod validation, Locked Keys, Execute gate, budgets, Private Mode, egress allow-list |
| Specified in | AGENT_SKILLS.md, HOOKS_AND_GUARDRAILS.md, DEVELOPMENT_WORKFLOW.md | AI_WORKFLOW.md, AGENT_DESIGN.md, SYSTEM_PROMPT.md, this document |
| Shipped to the Creator? | **Never** (excluded from the installer; a packaging test asserts `.claude/` is absent) | yes |

Hooks that enforce real controls on the runtime code (brief §8.5 "Hooks should enforce real security and quality controls"):

| Hook (dev-time) | Check on runtime code |
|---|---|
| pre-commit / PreToolUse(Write) | registry drift test: every tool in SYSTEM_PROMPT.md and AGENT_DESIGN.md exists in `registry.ts`; every `mutate`/`spawn` tool has `callers` without `brainstorm`/`editor` |
| pre-commit | `grep` for `child_process`, `fs.`, `fetch(` outside the allow-listed modules (`ingest`, `render`, `models`, `egress`) fails the commit |
| pre-push | GOLDEN_SCENARIOS Compile-path tests and fake-provider replays pass |
| pre-commit | secret scan on all files including fixtures |

## 5. Provider adapter layer

### 5.1 Choice: Vercel AI SDK v6

Package `ai` (v6) with first-party providers `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google` and the community provider `@openrouter/ai-sdk-provider` (ASSESSMENT.md §8; versions pinned in TRD.md). Reasons: one tool-calling and streaming abstraction over the four providers the brief names (§9); Zod-typed tools and structured output; usage objects; custom `fetch` injection (needed for §5.6); provider-specific options passthrough for prompt caching (§5.5). Alternatives considered: hand-written clients per provider (four implementations of streaming, tool calling and error mapping to maintain), LangChain (heavier, no benefit for a closed op vocabulary).

Adapter interface (`packages/agents/src/providers/adapter.ts`):

```ts
export interface ProviderAdapter {
  id: 'openrouter' | 'openai' | 'anthropic' | 'google';
  listModels(conn: ProviderConnection): Promise<CapabilityRow[]>;      // §5.2
  validate(conn: ProviderConnection): Promise<{ ok: boolean; code?: string }>;
  run(req: AgentRequest): AsyncIterable<AgentEvent>;                    // text delta | tool call | tool result | usage | done | error
}
```

The fake adapter (`FakeProviderAdapter`) implements the same interface and replays recorded responses (GOLDEN_SCENARIOS.md §5).

### 5.2 Capability Table source

| Provider | Source of truth | Fields used | Refresh |
|---|---|---|---|
| OpenRouter | `GET https://openrouter.ai/api/v1/models` | `id`, `name`, `context_length`, `supported_parameters` (contains `tools` → `toolCalling: true`; `structured_outputs` or `response_format` → `structuredOutput: true`), `pricing.prompt` / `pricing.completion` (USD per token, strings → parsed), `architecture.input_modalities` (contains `image` → `imageInput: true`) | on connection validation and on "Refresh models" in `scr.providers`; cached in `provider_connections.models_json` with `models_fetched_at`; never automatically more than once per 24 h |
| OpenAI, Anthropic, Google | static table `packages/agents/src/capabilities/static.json` (`{modelId, contextLength, toolCalling, structuredOutput, streaming, imageInput, pricePerMTokIn?, pricePerMTokOut?, asOf}`) maintained by the Operator per release; the provider's model-list endpoint (where available) is used only to confirm the id exists | same keys | per release; the row shows `asOf` and the UI labels prices "approximate" |
| any | manual override per model in `scr.providers` ("Treat as: no tool calling") | `toolCalling` | Creator |

A model missing from both sources gets `{toolCalling: false, structuredOutput: false, contextLength: 32000, price: null}`, the label "unknown capabilities; simple mode" / "kemampuan tidak diketahui; mode sederhana", and the EM-4005 notice; a model without a price shows EM-4203 "Cost not reported" once.

### 5.3 Streaming

- All agent runs use streaming (`streamText`); the Editor renders text deltas in the chat and shows tool calls as collapsed "Checking catalogue…" / "Memeriksa katalog…" rows.
- The Editor Agent's final EditPlan is parsed only when the stream completes (partial JSON is never validated); the Plan Card appears at `plan.ready`.
- First-token timeout 30 s, total 120 s (AI_WORKFLOW §12) enforced with `AbortSignal.timeout` on the request; `agent.editor.cancel` aborts the same signal.

### 5.4 Usage extraction and cost

| Provider | Tokens | Cost | Label |
|---|---|---|---|
| OpenRouter | `usage.prompt_tokens`, `usage.completion_tokens` | `usage.cost` from the response (request sets `usage: {include: true}`; exposed via the provider metadata of the AI SDK result) | exact ("$0.0042") |
| OpenAI, Anthropic, Google | SDK `usage.inputTokens` / `outputTokens` (cache-read tokens counted separately where reported) | `tokens × pricePerMTok / 1e6` from the static table when present, `approximate: true` | "≈ $0.004" |
| any without price | tokens only | `null` | "n/a" |

Every run writes one `usage_records` row (DATABASE_SCHEMA.md); budgets per AI_WORKFLOW §11 (`EM-4201` at 100 %, warning at 80 %). Retries of a provider call that returned no usable response still record their tokens.

### 5.5 Timeouts, retries, rate limits, prompt caching

| Concern | Rule (AI_WORKFLOW §12 is authoritative) |
|---|---|
| Timeouts | 30 s first token, 120 s total; one retry with 2 s backoff; then `EM-4101` |
| 429 | wait `Retry-After` (≤ 20 s) once; then `EM-4102` |
| 5xx / network | one retry with 2 s backoff; then `EM-4101` |
| Invalid JSON / schema | re-prompt with the Zod error, max 2; then `EM-4301` |
| Idempotency | retries never re-execute Operations (plans are keyed by `planId`) |
| Prompt caching | Request layout is a **stable prefix** (versioned system prompt → tool list → compact project state ≤ 4k tokens) followed by the volatile part (thread summary, recent messages, intents). Anthropic: `providerOptions.anthropic.cacheControl = {type: 'ephemeral'}` on the last stable block; OpenAI: automatic prefix caching, nothing to set; Google: explicit context caching not used in MVP (minimum size and TTL billing make it unattractive for short runs); OpenRouter: passes the Anthropic/OpenAI behaviour through. Cache-read tokens are shown in the usage tooltip when reported. |

### 5.6 The single egress module and the Private Mode gate

All outbound HTTP in the Local Service goes through `packages/shared/src/egress.ts` (`egressFetch`). Provider adapters receive it as the `fetch` option; the Model Download and the update check use it too. Nothing else in the codebase may call `fetch`, `http.request` or `undici` directly (hook in §4).

```ts
export async function egressFetch(url: string, init: RequestInit, purpose: 'provider' | 'model-download' | 'update'): Promise<Response> {
  if (settings.privateMode) throw new EgressBlocked('EM-8202');
  const host = new URL(url).host;
  if (!ALLOWLIST[purpose].some(h => host === h || host.endsWith('.' + h))) throw new EgressBlocked('EM-8203');
  // https only, redirect: 'error', 120 s AbortSignal, structured log with redaction
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([init.signal!, AbortSignal.timeout(120_000)]) });
}
```

Allow-list (`provider`): `openrouter.ai`, `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, plus the `base_url` host of a `custom` connection (https only). Private Mode is checked **before** DNS resolution, so a network monitor shows zero connections (PRD-020, AI-017). Engine Binaries are spawned without proxy environment variables and after the same `privateMode` check for downloads (ARCHITECTURE §3).

## 6. Future options

### 6.1 MCP façade design sketch (post-MVP; conditions in §2.3)

```
External assistant (Claude Desktop / IDE agent)
   │  Streamable HTTP, JSON-RPC 2.0, Authorization: Bearer <Service Token>
   ▼
Local Service  POST/GET http://127.0.0.1:<port>/mcp      (same Express app, same Host/Origin guard)
   │  tools/list  → generated from the Tool registry (§3.1) filtered: permission ∈ {read, propose}, callers ∋ 'external'
   │  tools/call  → executeTool(name, input, {caller: 'external', …})   (same wrapper, same logs, same errors)
   │  plan.propose(EditPlan) → Zod + Locked Keys + dry-run validation → stored with origin 'external' → Plan Card (S2 "Proposed")
   ▼
Creator presses Execute in the Editor (unchanged)
```

| Element | Decision |
|---|---|
| Exposed tools | `composition.get`, `assets.list`, `catalogue.search`, `hardware.profile`, `project.settings.get`, `render.estimate`, `composition.validateOps`, `plan.propose` |
| Not exposed | `composition.applyOps`, all generators, `render.start`, anything that writes settings or credentials |
| Resources / prompts / sampling / elicitation | not implemented (tools only) |
| Session | one per external client; capability negotiation per spec; server advertises `tools` only |
| Security | Service Token bearer; loopback only; Host/Origin guard; off by default; disabled in Private Mode; every `tools/call` logged with `caller: 'external'`; the Plan Card shows "Proposed by <client name> · nothing applied yet" / "Usulan dari <client name> · belum diterapkan" |
| Schema | `inputSchema` from the same Zod→JSON Schema derivation (§3.4); `EditPlan.origin` extended with `external` (ADR + migration) |

### 6.2 Local small LLM (llama.cpp) for offline caption text and hashtags (ADR-009 follow-up)

ADR-009 routes social caption text and hashtag suggestions (PRD-037, P1) to the connected LLM and names a local llama.cpp model as a later option. Sketch:

| Aspect | Option |
|---|---|
| Engine | llama.cpp (MIT) as a signed Engine Binary, same supervision as whisper.cpp; CPU on T0, offload on T1/T2 |
| Model | a 1–3 B instruction model with permissive licence and Indonesian ability **[TO SELECT]** (candidates to evaluate: Qwen2.5-1.5B/3B-Instruct, Apache-2.0; SEA-LION or Sahabat-AI small variants, licence to check; Gemma 3 1B, Gemma terms to check); q4_K_M, ≤ 2.5 GB download via Model Manager |
| Output control | GBNF grammar / JSON schema constrained decoding so the output always parses (`{caption: string, hashtags: string[]}`) |
| Scope | caption text and hashtags only (PRD-037); **not** Edit Plans (plan quality needs a larger model; the tool protocol stays with the provider adapters) |
| Private Mode | works offline once downloaded; this is the only way `scr.generate.hashtags` can run with Private Mode on |
| Adapter | implements `ProviderAdapter` (§5.1) with `id: 'local'` so the Model Assignment UI needs no change; Capability Table row generated from the model manifest |
| Registry | LOCAL_AI_MODELS.md row with licence, size, tier |

## 7. Requirements traceability

| AI_WORKFLOW requirement | How this document satisfies it |
|---|---|
| AI-005 untrusted provider output | §3.3 wrapper, §3.5 Zod parse, §5.5 retries |
| AI-006 narrow Tools only | §3.1 registry is the only enumeration; §4 hook forbids `child_process`/`fs`/`fetch` outside allow-listed modules |
| AI-015 independent Model Assignment and usage | §5.2, §5.4 |
| AI-017 Private Mode at the egress module | §5.6 |
| AI-020 no shell/filesystem/network from model input | §3.1 permission tags, §3.2 table, §3.3 step 2 |
| ADR-015 | §2 |
