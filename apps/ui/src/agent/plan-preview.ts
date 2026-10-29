// Readable plan preview (QA 2026-10-28 #4, FR-222): before Execute the Creator sees WHAT the Editor Agent will do — the scenes with
// their timing, texts, shapes, transitions, voice-over and caption steps, and every removal — instead of "composition.applyOps ·
// 12 ops". Pure helpers over the plan's ops (plan.ready carries them since 2026-10-28); the Plan Card renders the rows.
import type { CompositionModelT } from '@expertmotion/composition-model';
import { getPreset } from '@expertmotion/catalogue';
import type { AssetDto, PlanDto } from '../api/types.js';

type T = (k: string, v?: Record<string, string | number>) => string;
type Op = { op: string; target?: { kind?: string; id?: string; index?: number }; args?: Record<string, unknown> };

/** Ops that remove content (Service DESTRUCTIVE set; R-073 asks for confirmDestructive). */
export const DESTRUCTIVE_OPS: readonly string[] = ['op:clip.remove', 'op:caption.clear', 'op:background.clear', 'op:text.remove', 'op:shape.remove', 'op:audio.remove', 'op:overlay.remove'];

export type PreviewKind = 'scene' | 'text' | 'shape' | 'transition' | 'background' | 'voice' | 'captions' | 'audio' | 'clip' | 'remove' | 'caption-fix' | 'timing' | 'other';
export interface PreviewRow { kind: PreviewKind; step: number; title: string; detail?: string; startMs?: number; durationMs?: number; count?: number }

const sec = (ms: number) => `${(ms / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} dtk`;
const q = (v: unknown, n = 60): string => { const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const presetName = (id: unknown, lang: 'en' | 'id'): string => {
  if (typeof id !== 'string') return '';
  try { const p = getPreset(id as never); return p?.label?.[lang] ?? id.replace(/^preset:[a-z]+\./, ''); } catch { return id.replace(/^preset:[a-z]+\./, ''); }
};
const opsOf = (plan: PlanDto): Array<{ step: number; op: Op }> => plan.steps.flatMap((s) => (s.ops as Op[]).map((op) => ({ step: s.n, op })));

/** A removal in the Creator's words ("Klip 2", "Teks “Tantangannya”", "Musik voice-1.wav"). */
export function removalLabel(op: string, target: Op['target'], ctx: { head?: { model?: CompositionModelT | null } | null; assets: readonly AssetDto[] }): string {
  const model = ctx.head?.model ?? null; const id = target?.id;
  const name = (assetId: string | undefined) => (assetId ? ctx.assets.find((a) => a.id === assetId)?.name : undefined);
  if (op === 'op:caption.clear') return 'Semua caption';
  if (op === 'op:background.clear') return 'Latar video';
  if (model && id) {
    if (op === 'op:clip.remove') { const i = model.tracks.video.findIndex((c) => c.id === id); if (i >= 0) return `${model.tracks.video[i]!.assetId ? 'Klip' : 'Adegan'} ${i + 1}${name(model.tracks.video[i]!.assetId) ? ` (${name(model.tracks.video[i]!.assetId)})` : ''}`; }
    if (op === 'op:text.remove') { const x = model.tracks.text.find((y) => y.id === id); if (x) return `Teks “${q(x.text, 40)}”`; }
    if (op === 'op:audio.remove') { const a = model.tracks.audio.find((y) => y.id === id); if (a) return `${a.role === 'voice' ? 'Suara' : 'Audio'} ${name(a.assetId) ?? ''}`.trim(); }
    if (op === 'op:shape.remove' || op === 'op:overlay.remove') { const o = model.tracks.overlay.find((y) => y.id === id); if (o) return o.kind === 'image' ? `Gambar ${name(o.assetId) ?? ''}`.trim() : 'Bentuk'; }
  }
  return op.replace(/^op:/, '').replace('.remove', '') + (id ? ` ${id.slice(-4)}` : '');
}
export function destructiveItems(plan: PlanDto, ctx: { head?: { model?: CompositionModelT | null } | null; assets: readonly AssetDto[] } = { assets: [] }): Array<{ op: string; label: string }> {
  return opsOf(plan).filter(({ op }) => DESTRUCTIVE_OPS.includes(op.op)).map(({ op }) => ({ op: op.op, label: removalLabel(op.op, op.target, ctx) }));
}

/**
 * The preview rows of a plan: scenes in order with their start time (from the current duration for appended scenes), texts with
 * their words and time, shapes, transitions, background, voice-over / caption generator steps, caption fixes, removals.
 */
export function previewRows(plan: PlanDto, model: CompositionModelT | null | undefined, lang: 'en' | 'id', ctx: { assets: readonly AssetDto[] } = { assets: [] }): PreviewRow[] {
  const rows: PreviewRow[] = [];
  // Review U8: scene start times follow the Sequence the plan leaves behind: every clip in order, minus each transition's overlap
  // (a cut's transition makes the next clip start that much earlier), exactly as deriveTiming does after Execute.
  const seq: Array<{ d: number; row?: PreviewRow }> = (model?.tracks.video ?? []).map((c) => ({ d: c.durationMs ?? 0 }));
  const trans = new Map((model?.transitions ?? []).map((x) => [x.cutIndex, x.durationMs] as const));
  let sceneN = model ? model.tracks.video.length : 0;
  for (const s of plan.steps) {
    if (s.tool === 'tts.generate') { rows.push({ kind: 'voice', step: s.n, title: 'Suara narasi', detail: q(s.args?.['text'], 90), ...(typeof s.args?.['atMs'] === 'number' ? { startMs: s.args['atMs'] as number } : {}) }); continue; }
    if (s.tool === 'music.generate') { rows.push({ kind: 'audio', step: s.n, title: 'Musik latar (CC0)', detail: [q(s.args?.['prompt'], 40), 'diredam saat ada suara'].filter(Boolean).join(' · ') }); continue; }   // FR-266
    if (s.tool === 'captions.generate') { rows.push({ kind: 'captions', step: s.n, title: 'Caption dari naskah', detail: s.args?.['source'] === 'voice' ? 'disinkronkan dengan suara' : s.args?.['source'] === 'sequence' ? 'dari audio video' : 'dari naskah' }); continue; }
    for (const op of s.ops as Op[]) {
      const a = op.args ?? {};
      switch (op.op) {
        case 'op:scene.add': {
          const d = typeof a['durationMs'] === 'number' ? a['durationMs'] : 3000; sceneN += 1;
          const bits = [q(a['title'], 50) && `“${q(a['title'], 50)}”`, q(a['text'], 60), a['background'] ? `latar ${presetName(a['background'], lang)}` : '', a['transition'] ? `transisi ${presetName(a['transition'], lang)}` : '', a['motionId'] ? `gerak ${presetName(a['motionId'], lang)}` : ''].filter(Boolean);
          const row: PreviewRow = { kind: 'scene', step: s.n, title: `Adegan ${sceneN}`, detail: bits.join(' · '), startMs: 0, durationMs: d };
          rows.push(row); seq.push({ d, row });
          if (a['transition'] && seq.length > 1) trans.set(seq.length - 2, typeof a['transitionMs'] === 'number' ? a['transitionMs'] : 500);
          break;
        }
        case 'op:text.add': rows.push({ kind: 'text', step: s.n, title: `Teks “${q(a['text'], 50)}”`, ...(a['variant'] ? { detail: presetName(a['variant'], lang) } : {}), ...(typeof a['atMs'] === 'number' ? { startMs: a['atMs'] } : {}), ...(typeof a['durationMs'] === 'number' ? { durationMs: a['durationMs'] } : {}) }); break;
        case 'op:shape.add': rows.push({ kind: 'shape', step: s.n, title: `Bentuk ${presetName(a['presetId'], lang)}`, ...(typeof a['atMs'] === 'number' ? { startMs: a['atMs'] } : {}), ...(typeof a['durationMs'] === 'number' ? { durationMs: a['durationMs'] } : {}) }); break;
        case 'op:transition.set': if (op.target?.kind === 'cut' && typeof op.target.index === 'number' && typeof a['durationMs'] === 'number') trans.set(op.target.index, a['durationMs']);
          rows.push({ kind: 'transition', step: s.n, title: `Transisi ${presetName(a['presetId'], lang)}`, detail: op.target?.kind === 'cut' && typeof op.target.index === 'number' ? `potongan ${op.target.index + 1}` : 'semua potongan' }); break;
        case 'op:background.set': case 'op:scene.setBackground': rows.push({ kind: 'background', step: s.n, title: `Latar ${presetName(a['presetId'], lang)}` }); break;
        case 'op:audio.addBed': rows.push({ kind: 'audio', step: s.n, title: `Musik latar ${ctx.assets.find((x) => x.id === a['assetId'])?.name ?? ''}`.trim(), detail: [typeof a['volume'] === 'number' ? `volume ${Math.round((a['volume'] as number) * 100)}%` : '', a['fadeOutMs'] ? `fade out ${sec(a['fadeOutMs'] as number)}` : '', a['loop'] ? 'diulang' : ''].filter(Boolean).join(' · ') }); break;
        case 'op:clip.insert': if (a['atIndex'] === undefined && typeof a['durationMs'] === 'number') seq.push({ d: a['durationMs'] });
          // FR-261: a footage clip shows which part of the file plays and how loud its own sound is
          rows.push({ kind: 'clip', step: s.n, title: `Klip ${ctx.assets.find((x) => x.id === a['assetId'])?.name ?? ''}`.trim(), ...(typeof a['durationMs'] === 'number' ? { durationMs: a['durationMs'] } : {}),
            ...(typeof a['trimBeforeMs'] === 'number' || typeof a['volume'] === 'number' ? { detail: [typeof a['trimBeforeMs'] === 'number' && typeof a['durationMs'] === 'number' ? `potongan ${sec(a['trimBeforeMs'] as number)}–${sec((a['trimBeforeMs'] as number) + (a['durationMs'] as number))}` : '',
              typeof a['volume'] === 'number' && a['volume'] < 1 ? `suara ${Math.round((a['volume'] as number) * 100)}%` : '', a['transform'] ? 'jendela / setengah layar' : ''].filter(Boolean).join(' · ') } : {}) }); break;
        case 'op:caption.replaceText': rows.push({ kind: 'caption-fix', step: s.n, title: `Caption: “${q(a['find'], 40)}” → “${q(a['replace'], 40)}”`, ...(typeof a['atMs'] === 'number' ? { startMs: a['atMs'] } : {}) }); break;
        case 'op:caption.editPage': rows.push({ kind: 'caption-fix', step: s.n, title: `Caption diganti: “${q(a['text'], 60)}”`, ...(typeof a['atMs'] === 'number' ? { startMs: a['atMs'] } : {}) }); break;
        case 'op:caption.setPages': rows.push({ kind: 'captions', step: s.n, title: `Caption (${Array.isArray(a['pages']) ? (a['pages'] as unknown[]).length : 0} halaman)` }); break;
        case 'op:element.setTiming': rows.push({ kind: 'timing', step: s.n, title: `Waktu ${op.target?.kind ?? ''}`.trim(), ...(typeof a['atMs'] === 'number' ? { startMs: a['atMs'] } : {}), ...(typeof a['durationMs'] === 'number' ? { durationMs: a['durationMs'] } : {}) }); break;
        default:
          if (DESTRUCTIVE_OPS.includes(op.op)) rows.push({ kind: 'remove', step: s.n, title: `Hapus ${removalLabel(op.op, op.target, { head: model ? { model } : null, assets: ctx.assets })}` });
          else { const last = rows[rows.length - 1]; if (last?.kind === 'other' && last.step === s.n && last.title === op.op.replace(/^op:/, '')) last.count = (last.count ?? 1) + 1; else rows.push({ kind: 'other', step: s.n, title: op.op.replace(/^op:/, '') }); }
      }
    }
  }
  let at = 0;
  seq.forEach((c, i) => { if (c.row) c.row.startMs = at; at += c.d; if (i < seq.length - 1) at -= trans.get(i) ?? 0; });
  return rows;
}
/** Total duration after the plan (appended scenes), when the plan builds scenes; null otherwise. */
export function previewDurationMs(rows: readonly PreviewRow[]): number | null {
  const scenes = rows.filter((r) => r.kind === 'scene');
  if (!scenes.length) return null;
  const last = scenes[scenes.length - 1]!;
  return (last.startMs ?? 0) + (last.durationMs ?? 0);
}
export const fmtTime = (ms: number): string => { const s = Math.max(0, Math.round(ms / 100) / 10); const m = Math.floor(s / 60); const r = s - m * 60; return `${m}:${r.toFixed(1).padStart(4, '0')}`; };
