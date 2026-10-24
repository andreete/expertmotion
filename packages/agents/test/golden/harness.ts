// Golden scenario harness (a), GOLDEN_SCENARIOS §4.1: pure Compile path, no DB, no HTTP, provider spy must stay at zero.
import { applyOperations, createEmptyModel, deriveTiming, hashModel, validate, type AssetFacts, type CompositionModelT, type OperationT, type Tier } from '@expertmotion/composition-model';
import { buildCompilePlan, compileIntents, createIntents, enqueue, lockedKeysFromQueue, pickFromIntent, restore, validatePlan, type DesignPick, type EditIntentT } from '../../src/index.js';

export const SRT_FX_S1 = [
  { text: 'Halo semua, hari ini kita review HP dua juta.', startMs: 0, endMs: 1400 },
  { text: 'Layarnya besar, baterainya awet.', startMs: 1500, endMs: 3000 },
  { text: 'Kameranya cukup untuk konten harian.', startMs: 3100, endMs: 4600 },
  { text: 'Harganya masih masuk akal.', startMs: 4700, endMs: 5900 },
  { text: 'Masih layak di 2026? Kita lihat.', startMs: 6000, endMs: 7000 },
];
/** Fixture facts (GOLDEN_SCENARIOS §1.1): only the properties the contract fixes. */
export const FIXTURES: AssetFacts[] = [
  { id: 'FX-V1', kind: 'video', status: 'ready', durationMs: 8000, name: 'kota-pagi.mp4', hasAudio: true, width: 1920, height: 1080 },
  { id: 'FX-V2', kind: 'video', status: 'ready', durationMs: 6000, name: 'unboxing-hp.mp4', hasAudio: true, width: 1920, height: 1080 },
  { id: 'FX-V3', kind: 'video', status: 'ready', durationMs: 5000, name: 'kopi-latte.mov', hasAudio: false, width: 1080, height: 1920 },
  { id: 'FX-M1', kind: 'audio', status: 'ready', durationMs: 30_000, name: 'bed-lofi.mp3' },
];

export class Scenario {
  model: CompositionModelT; queue: EditIntentT[] = []; versions: string[] = []; providerCalls = 0; tier: Tier;
  private n = 0;
  readonly newId = () => `id${String(++this.n).padStart(3, '0')}`;
  readonly opsHistory: OperationT[] = [];
  constructor(opts: { ratio?: '16:9' | '9:16'; tier?: Tier; assets?: AssetFacts[] } = {}) {
    this.tier = opts.tier ?? 'T1';
    this.model = createEmptyModel('gs', { autoRatio: false, ...(opts.ratio ? { ratio: opts.ratio } : {}) });
    this.assets = opts.assets ?? FIXTURES;
    this.versions.push(hashModel(this.model));
  }
  assets: AssetFacts[];
  get head(): string { return this.versions[this.versions.length - 1]!; }
  get durationMs(): number { return deriveTiming(this.model).durationMs; }
  get lockedKeys(): string[] { return lockedKeysFromQueue(this.queue); }

  /** One Creator pick through steps 2–10 of the pipeline. Returns the new intents (or the rejecting issue codes). */
  pick(p: Omit<DesignPick, 'projectId' | 'source'>): { intents: EditIntentT[]; ops: OperationT[] } | { rejected: string[] } {
    const r = createIntents({ projectId: 'gs', source: 'ui', ...p }, { model: this.model, baseVersion: this.head, newId: this.newId, now: () => '2026-10-24T00:00:00.000Z' });
    if (!r.ok) return { rejected: r.issues.map((i) => i.code) };
    return this.compileAndExecute(r.value, enqueue(this.queue, r.value));
  }
  restoreIntent(id: string) {
    const r = restore(this.queue, id, () => '2026-10-24T00:00:01.000Z');
    if (!r.ok) return { rejected: r.issues.map((i) => i.code) };
    const restored = r.value.filter((i) => i.id === id || i.parentIntentId === id);
    return this.compileAndExecute(restored, r.value);
  }
  private compileAndExecute(fresh: EditIntentT[], nextQueue: EditIntentT[]) {
    const active = fresh.filter((i) => nextQueue.find((q) => q.id === i.id)?.status !== 'superseded');
    const c = compileIntents(active, (i) => pickFromIntent(i), this.model);
    if (!c.ok) return { rejected: c.issues.map((i) => i.code) };
    const plan = buildCompilePlan(c.value, { id: this.newId(), projectId: 'gs', baseVersion: this.head, goal: 'golden', expectedDiff: '' });
    // Compile may replace the Creator's own Locked Keys (GS-03): only agent plans are checked against locks.
    const v = validatePlan(plan, { model: this.model, baseVersion: this.head, assets: this.assets, tier: this.tier, lockedKeys: [], newId: this.newId });
    const blocking = v.issues.filter((i) => i.severity === 'block');
    if (blocking.length) return { rejected: blocking.map((i) => i.code) };
    const a = applyOperations(this.model, c.value, { assets: this.assets, tier: this.tier, newId: this.newId });
    if (!a.ok) return { rejected: a.issues.map((i) => i.code) };
    this.model = a.value.model; this.versions.push(hashModel(this.model)); this.opsHistory.push(...c.value);
    this.queue = nextQueue.map((q) => (fresh.some((f) => f.id === q.id) && q.status === 'queued' ? { ...q, status: 'compiled' as const } : q));
    return { intents: fresh, ops: c.value };
  }
  issues() { return validate(this.model, { assets: this.assets, tier: this.tier }); }
}
export function expectOk<T extends object>(r: T | { rejected: string[] }): T {
  if ('rejected' in r) throw new Error(`rejected: ${r.rejected.join(', ')}`);
  return r;
}
