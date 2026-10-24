// Editor Agent and Brainstorming Agent runs (AI_WORKFLOW §7, §9–§12; AGENT_DESIGN §2–§5; SYSTEM_PROMPT P-1/P-2).
import { conflictsWithLocked, deriveTiming, propertyKeysOf, type OperationT } from '@expertmotion/composition-model';
import { EmError, type Issue } from '@expertmotion/shared';
import { prompts } from './prompt-store.js';
import { parseModelReply, validatePlan, extractJson, type PlanContext } from './plan.js';
import { BrainstormTurn, type EditPlanT } from './schemas.js';
import type { RewriteEnvelope } from './envelope.js';
import type { ChatImage, ChatMessage, ChatProvider, ChatUsage } from './providers.js';
import { MAX_TOOL_ROUNDS, ReplyStreamer, asToolRequest, runTool, summarizeThread, toolResultMessage, toolsPromptBlock, BRAINSTORM_TOOL_NAMES, EDITOR_TOOL_NAMES, type BrainstormToolName, type ThreadSummary, type ToolCallRecord, type ToolHandlers } from './tools.js';

export interface RunOptions {
  maxCorrections?: number; maxTokens?: number; temperature?: number; signal?: AbortSignal; timeoutMs?: number; budgetCheck?: () => void;
  /** FR-075: receives streamed text deltas when the provider can stream (otherwise never called). */
  onDelta?: (delta: string) => void;
}
export interface EditorRunResult { ok: true; plan: EditPlanT; issues: Issue[]; attempts: number; usage: ChatUsage[]; droppedOps: number; toolCalls: ToolCallRecord[]; predicted?: ReturnType<typeof validatePlan>['predicted'] }
export interface EditorRunFailure { ok: false; error: EmError; attempts: number; usage: ChatUsage[]; toolCalls: ToolCallRecord[]; lastText?: string }
export interface EditorRunOptions extends RunOptions {
  /** FR-080: read-only tool handlers from the Local Service (AI_WORKFLOW §8); `composition.validateOps` is added here (dry run). */
  tools?: ToolHandlers;
  /** FR-072: images attached to the Creator's message; the caller passes them only for models with image input. */
  images?: ChatImage[];
}

/** `composition.validateOps` (AI_WORKFLOW §8): dry run of operations against the plan base; never mutates. */
export function dryRunOps(input: Record<string, unknown>, ctx: PlanContext & { planId: string; projectId: string }) {
  if (typeof input['baseVersion'] === 'string' && input['baseVersion'] !== ctx.baseVersion) return { ok: false, issues: [{ code: 'EM-2301', severity: 'block', path: 'baseVersion', message: `The base version is ${ctx.baseVersion}.` }], predictedDiff: [], predictedDurationMs: null };
  const ops = (input['ops'] ?? []) as OperationT[];
  const v = validatePlan({ id: ctx.planId, projectId: ctx.projectId, baseVersion: ctx.baseVersion, origin: 'editor-agent', goal: 'dry run', steps: [{ n: 1, tool: 'composition.applyOps', ops, args: {}, expectedDiff: 'dry run', dependsOn: [] }], touchesLockedKeys: [], risks: [], status: 'draft', validation: [] }, ctx);
  return { ok: v.plan.status === 'valid', issues: v.issues.slice(0, 20).map((i) => ({ code: i.code, severity: i.severity, path: i.path, message: i.message })),
    predictedDiff: (v.predicted?.diff ?? []).slice(0, 50), predictedDurationMs: v.predicted ? deriveTiming(v.predicted.model).durationMs : null };
}

const langName = (l: 'id' | 'en') => (l === 'id' ? 'Bahasa Indonesia' : 'English');
export const editorSystemPrompt = (env: RewriteEnvelope) => prompts().EDITOR_SYSTEM.replaceAll('{{language_name}}', langName(env.project.language)).replaceAll('{{base_version}}', env.baseVersion);

async function call(provider: ChatProvider, system: string, messages: ChatMessage[], o: RunOptions, usage: ChatUsage[]): Promise<string> {
  o.budgetCheck?.();
  for (let attempt = 0; ; attempt++) {
    try {
      const req = { system, messages, maxTokens: o.maxTokens ?? 4000, temperature: o.temperature ?? 0.2, ...(o.signal ? { signal: o.signal } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) };
      let streamed = false;
      const r = o.onDelta && provider.stream ? await provider.stream(req, (d) => { streamed = true; o.onDelta!(d); }).catch((e: unknown) => { throw Object.assign(e as object, { streamed }); })
        : await provider.complete(req);
      usage.push(r.usage);
      return r.text;
    } catch (e) {
      const em = e instanceof EmError ? e : new EmError('EM-4003', String(e));
      const partial = (e as { streamed?: boolean })?.streamed === true;                                       // text already shown: never replay it
      if (attempt === 0 && !partial && (em.code === 'EM-4101' || em.code === 'EM-4102') && !o.signal?.aborted) continue;   // retry once (AI_WORKFLOW §12)
      throw em;
    }
  }
}

/** One Editor Agent run → a validated Edit Plan, or EM-4301 after 1 + maxCorrections invalid replies. */
export async function runEditorAgent(env: RewriteEnvelope, provider: ChatProvider, ctx: PlanContext & { planId: string; projectId: string }, o: EditorRunOptions = {}): Promise<EditorRunResult | EditorRunFailure> {
  const usage: ChatUsage[] = []; const toolCalls: ToolCallRecord[] = [];
  // FR-080: JSON-mode read-only tool loop (same protocol as the Brainstorm loop); tool rounds do not count as corrections.
  const handlers: ToolHandlers = o.tools ? { ...o.tools, 'composition.validateOps': (i) => dryRunOps(i, ctx) } : {};
  const names = o.tools ? EDITOR_TOOL_NAMES.filter((n) => !!handlers[n]) : [];
  const system = editorSystemPrompt(env) + toolsPromptBlock(names, 'reply with the EditPlan JSON only');
  const messages: ChatMessage[] = [{ role: 'user', content: JSON.stringify(env), ...(o.images?.length ? { images: o.images } : {}) }];
  const maxCorrections = o.maxCorrections ?? 2;
  let lockedRetryUsed = false; let lastText: string | undefined; let toolRounds = 0;
  for (let attempt = 0; attempt <= maxCorrections + 1; attempt++) {
    let text: string;
    // FR-084: the plan's goal streams while the model writes it (first attempt only, so a correction never repeats it).
    const streamer = o.onDelta && attempt === 0 ? new ReplyStreamer('goal') : null;
    const co: RunOptions = { ...o }; delete co.onDelta;
    if (streamer) co.onDelta = (d: string) => { const v = streamer.push(d); if (v) o.onDelta!(v); };
    try { text = await call(provider, system, [...messages], co, usage); } catch (e) { return { ok: false, error: e as EmError, attempts: attempt + 1, usage, toolCalls }; }
    lastText = text;
    const req = names.length ? asToolRequest(extractJson(text)) : null;
    if (req) {
      messages.push({ role: 'assistant', content: text });
      if (toolRounds < MAX_TOOL_ROUNDS) {
        toolRounds++;
        const rec = await runTool(req.name, req.input, handlers, EDITOR_TOOL_NAMES);
        toolCalls.push(rec); messages.push(toolResultMessage(rec)); attempt--; continue;
      }
      messages.push({ role: 'user', content: 'No more tool calls. Reply with the EditPlan JSON only.' }); continue;
    }
    const parsed = parseModelReply(text, { id: ctx.planId, projectId: ctx.projectId });
    if (!parsed.plan) {
      if (attempt >= maxCorrections) break;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: parsed.problem! }); continue;
    }
    let plan = parsed.plan; let dropped = 0;
    let v = validatePlan(plan, ctx);
    if (v.plan.touchesLockedKeys.length) {
      if (!lockedRetryUsed && attempt < maxCorrections + 1) {
        lockedRetryUsed = true;
        messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Rejected: these keys are locked because the Creator chose them: ${v.plan.touchesLockedKeys.join(', ')}. Remove every operation that changes them, add a risk {code:"locked-key", severity:"info"}, and reply with the EditPlan JSON only.` });
        continue;
      }
      // Second violation: drop the offending operations with a notice (AI_WORKFLOW §6 conflict matrix). FR-081: every step that
      // lost operations is listed as an EM-2302 validation entry (path `droppedSteps[n]`) so the Plan Card shows it struck through.
      const locked = ctx.lockedKeys;
      const lost: Array<{ n: number; expectedDiff: string; keys: string[] }> = [];
      plan = { ...plan, steps: plan.steps.map((s) => {
        const keys = new Set<string>();
        const keep = s.ops.filter((op) => { const hit = conflictsWithLocked(propertyKeysOf(op), locked); hit.forEach((k) => keys.add(k)); return hit.length === 0; });
        if (keep.length < s.ops.length) { dropped += s.ops.length - keep.length; lost.push({ n: s.n, expectedDiff: s.expectedDiff, keys: [...keys] }); }
        return { ...s, ops: keep };
      }).filter((s) => s.ops.length > 0),
        risks: [...plan.risks, { code: 'locked-key', message: `${dropped} change(s) to your own picks were left out.`, severity: 'info' }] };
      v = validatePlan(plan, ctx);
      v = { ...v, plan: { ...v.plan, validation: [...v.plan.validation, ...lost.map((d) => ({ path: `droppedSteps[${d.n}]`, code: 'EM-2302', message: `${d.n}. ${d.expectedDiff} (${d.keys.join(', ')})` }))] } };
    }
    if (v.plan.status === 'valid') return { ok: true, plan: v.plan, issues: v.issues, attempts: attempt + 1, usage, droppedOps: dropped, toolCalls, ...(v.predicted ? { predicted: v.predicted } : {}) };
    if (v.plan.status === 'stale') return { ok: false, error: new EmError('EM-2301', 'The composition changed while the agent was planning; plan again.'), attempts: attempt + 1, usage, toolCalls, lastText: text };
    if (attempt >= maxCorrections) break;
    const blocking = v.issues.filter((i) => i.severity === 'block').slice(0, 8).map((i) => ({ code: i.code, path: i.path, message: i.message }));
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `The plan was rejected by validation: ${JSON.stringify(blocking)}. Fix it and reply with the EditPlan JSON only.` });
  }
  return { ok: false, error: new EmError('EM-4301', 'The model could not produce a valid plan.'), attempts: maxCorrections + 1, usage, toolCalls, ...(lastText ? { lastText } : {}) };
}

export interface BrainstormResult { ok: true; turn: ReturnType<typeof BrainstormTurn.parse>; usage: ChatUsage[]; toolCalls: ToolCallRecord[]; summary: ThreadSummary | null }
export interface BrainstormOptions extends RunOptions {
  /** Model context length in tokens (Capability Table); the thread window is 60 % of it (AI_WORKFLOW §10). Unknown → 32k. */
  contextLength?: number | null;
  /** Read-only tool handlers supplied by the Local Service (AI_WORKFLOW §9); omitted tools are not offered to the model. */
  tools?: ToolHandlers;
  /** FR-072: images attached to the newest user message (sent as image parts; the caller checks image input capability). */
  images?: ChatImage[];
}
/** Characters of thread history that fit: 60 % of the context minus the system prompt and the reply budget (≈ 4 chars per token). */
export function threadBudgetChars(contextLength: number | null | undefined, systemChars: number, maxReplyTokens = 4000): number {
  const ctx = contextLength && contextLength > 0 ? contextLength : 32_000;
  return Math.max(2000, Math.floor(0.6 * ctx * 4) - systemChars - maxReplyTokens * 4);
}
/**
 * Brainstorming turn (read-only; never mutates, ADR-003). JSON-mode tool loop: up to MAX_TOOL_ROUNDS read-only tool calls,
 * then the BrainstormTurn reply. Prose replies are accepted as plain text (no proposed intents) rather than failing the chat.
 */
export async function runBrainstorm(history: ChatMessage[], contextBlock: unknown, language: 'id' | 'en', provider: ChatProvider, o: BrainstormOptions = {}): Promise<BrainstormResult | { ok: false; error: EmError; usage: ChatUsage[]; toolCalls: ToolCallRecord[] }> {
  const usage: ChatUsage[] = []; const toolCalls: ToolCallRecord[] = [];
  const names = BRAINSTORM_TOOL_NAMES.filter((n): n is BrainstormToolName => !!o.tools?.[n]);
  const system = prompts().BRAINSTORM_SYSTEM.replaceAll('{{language_name}}', langName(language)).replaceAll('{{language_code}}', language).replaceAll('{{context_block}}', JSON.stringify(contextBlock)) + toolsPromptBlock(names);
  const w = windowThread(history, threadBudgetChars(o.contextLength, system.length, o.maxTokens ?? 4000));
  const messages = [...w.messages];
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  if (o.images?.length && lastUser >= 0) messages[lastUser] = { ...messages[lastUser]!, images: o.images };
  try {
    for (let round = 0; ; round++) {
      const streamer = o.onDelta ? new ReplyStreamer() : null;
      const text = await call(provider, system, [...messages], { temperature: 0.4, ...o, ...(streamer ? { onDelta: (d: string) => { const v = streamer.push(d); if (v) o.onDelta!(v); } } : {}) }, usage);
      const json = extractJson(text);
      const req = asToolRequest(json);
      if (req && round < MAX_TOOL_ROUNDS && names.length) {
        const rec = await runTool(req.name, req.input, o.tools ?? {});
        toolCalls.push(rec);
        messages.push({ role: 'assistant', content: text }, toolResultMessage(rec));
        continue;
      }
      const parsed = json === undefined || req ? undefined : BrainstormTurn.safeParse(json);
      const turn = parsed?.success ? parsed.data : { reply: req ? '…' : text.slice(0, 4000) };
      return { ok: true, turn, usage, toolCalls, summary: w.summary };
    }
  } catch (e) { return { ok: false, error: e as EmError, usage, toolCalls }; }
}

/** windowMessages plus the deterministic summary of what fell out of the window (AI_WORKFLOW §10 `threadSummary`). */
export function windowThread(history: ChatMessage[], maxChars: number): { messages: ChatMessage[]; summary: ThreadSummary | null } {
  const kept: ChatMessage[] = []; let used = 0;
  for (let i = history.length - 1; i >= 0; i--) { const m = history[i]!; if (used + m.content.length > maxChars && kept.length) break; kept.unshift(m); used += m.content.length; }
  const dropped = history.slice(0, history.length - kept.length);
  const summary = dropped.length ? summarizeThread(dropped) : null;
  if (summary) kept.unshift({ role: 'user', content: `(threadSummary) ${summary.text}` });
  if (kept[0]?.role === 'assistant') kept.unshift({ role: 'user', content: '(continuing)' });
  return { messages: kept, summary };
}

/** Context windowing (AI_WORKFLOW §10): keep the newest messages within the character budget; older ones become a summary block. */
export function windowMessages(history: ChatMessage[], maxChars: number): ChatMessage[] {
  return windowThread(history, maxChars).messages;
}
