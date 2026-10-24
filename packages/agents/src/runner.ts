// Editor Agent and Brainstorming Agent runs (AI_WORKFLOW §7, §9–§12; AGENT_DESIGN §2–§5; SYSTEM_PROMPT P-1/P-2).
import { conflictsWithLocked, propertyKeysOf } from '@expertmotion/composition-model';
import { EmError, type Issue } from '@expertmotion/shared';
import { prompts } from './prompt-store.js';
import { parseModelReply, validatePlan, extractJson, type PlanContext } from './plan.js';
import { BrainstormTurn, type EditPlanT } from './schemas.js';
import type { RewriteEnvelope } from './envelope.js';
import type { ChatMessage, ChatProvider, ChatUsage } from './providers.js';

export interface RunOptions { maxCorrections?: number; maxTokens?: number; temperature?: number; signal?: AbortSignal; timeoutMs?: number; budgetCheck?: () => void }
export interface EditorRunResult { ok: true; plan: EditPlanT; issues: Issue[]; attempts: number; usage: ChatUsage[]; droppedOps: number; predicted?: ReturnType<typeof validatePlan>['predicted'] }
export interface EditorRunFailure { ok: false; error: EmError; attempts: number; usage: ChatUsage[]; lastText?: string }

const langName = (l: 'id' | 'en') => (l === 'id' ? 'Bahasa Indonesia' : 'English');
export const editorSystemPrompt = (env: RewriteEnvelope) => prompts().EDITOR_SYSTEM.replaceAll('{{language_name}}', langName(env.project.language)).replaceAll('{{base_version}}', env.baseVersion);

async function call(provider: ChatProvider, system: string, messages: ChatMessage[], o: RunOptions, usage: ChatUsage[]): Promise<string> {
  o.budgetCheck?.();
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await provider.complete({ system, messages, maxTokens: o.maxTokens ?? 4000, temperature: o.temperature ?? 0.2, ...(o.signal ? { signal: o.signal } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
      usage.push(r.usage);
      return r.text;
    } catch (e) {
      const em = e instanceof EmError ? e : new EmError('EM-4003', String(e));
      if (attempt === 0 && (em.code === 'EM-4101' || em.code === 'EM-4102') && !o.signal?.aborted) continue;   // retry once (AI_WORKFLOW §12)
      throw em;
    }
  }
}

/** One Editor Agent run → a validated Edit Plan, or EM-4301 after 1 + maxCorrections invalid replies. */
export async function runEditorAgent(env: RewriteEnvelope, provider: ChatProvider, ctx: PlanContext & { planId: string; projectId: string }, o: RunOptions = {}): Promise<EditorRunResult | EditorRunFailure> {
  const usage: ChatUsage[] = []; const system = editorSystemPrompt(env);
  const messages: ChatMessage[] = [{ role: 'user', content: JSON.stringify(env) }];
  const maxCorrections = o.maxCorrections ?? 2;
  let lockedRetryUsed = false; let lastText: string | undefined;
  for (let attempt = 0; attempt <= maxCorrections + 1; attempt++) {
    let text: string;
    try { text = await call(provider, system, messages, o, usage); } catch (e) { return { ok: false, error: e as EmError, attempts: attempt + 1, usage }; }
    lastText = text;
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
      // Second violation: drop the offending operations with a notice (AI_WORKFLOW §6 conflict matrix)
      const locked = ctx.lockedKeys;
      plan = { ...plan, steps: plan.steps.map((s) => ({ ...s, ops: s.ops.filter((op) => { const bad = conflictsWithLocked(propertyKeysOf(op), locked).length > 0; if (bad) dropped++; return !bad; }) })).filter((s) => s.ops.length > 0),
        risks: [...plan.risks, { code: 'locked-key', message: `${dropped} change(s) to your own picks were left out.`, severity: 'info' }] };
      v = validatePlan(plan, ctx);
    }
    if (v.plan.status === 'valid') return { ok: true, plan: v.plan, issues: v.issues, attempts: attempt + 1, usage, droppedOps: dropped, ...(v.predicted ? { predicted: v.predicted } : {}) };
    if (v.plan.status === 'stale') return { ok: false, error: new EmError('EM-2301', 'The composition changed while the agent was planning; plan again.'), attempts: attempt + 1, usage, lastText: text };
    if (attempt >= maxCorrections) break;
    const blocking = v.issues.filter((i) => i.severity === 'block').slice(0, 8).map((i) => ({ code: i.code, path: i.path, message: i.message }));
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `The plan was rejected by validation: ${JSON.stringify(blocking)}. Fix it and reply with the EditPlan JSON only.` });
  }
  return { ok: false, error: new EmError('EM-4301', 'The model could not produce a valid plan.'), attempts: maxCorrections + 1, usage, ...(lastText ? { lastText } : {}) };
}

export interface BrainstormResult { ok: true; turn: ReturnType<typeof BrainstormTurn.parse>; usage: ChatUsage[] }
/** Brainstorming turn. Prose replies are accepted as plain text (no proposed intents) rather than failing the Creator's chat. */
export async function runBrainstorm(history: ChatMessage[], contextBlock: unknown, language: 'id' | 'en', provider: ChatProvider, o: RunOptions = {}): Promise<BrainstormResult | { ok: false; error: EmError; usage: ChatUsage[] }> {
  const usage: ChatUsage[] = [];
  const system = prompts().BRAINSTORM_SYSTEM.replaceAll('{{language_name}}', langName(language)).replaceAll('{{language_code}}', language).replaceAll('{{context_block}}', JSON.stringify(contextBlock));
  try {
    const text = await call(provider, system, windowMessages(history, 24_000), { temperature: 0.4, ...o }, usage);
    const json = extractJson(text);
    const parsed = json === undefined ? undefined : BrainstormTurn.safeParse(json);
    const turn = parsed?.success ? parsed.data : { reply: text.slice(0, 4000) };
    return { ok: true, turn, usage };
  } catch (e) { return { ok: false, error: e as EmError, usage }; }
}

/** Context windowing (AI_WORKFLOW §10): keep the newest messages within the character budget; older ones become one summary line. */
export function windowMessages(history: ChatMessage[], maxChars: number): ChatMessage[] {
  const out: ChatMessage[] = []; let used = 0;
  for (let i = history.length - 1; i >= 0; i--) { const m = history[i]!; if (used + m.content.length > maxChars && out.length) break; out.unshift(m); used += m.content.length; }
  const dropped = history.length - out.length;
  if (dropped > 0) out.unshift({ role: 'user', content: `(Earlier conversation: ${dropped} message(s) omitted. Decisions already applied are visible in the composition.)` });
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(continuing)' });
  return out;
}
