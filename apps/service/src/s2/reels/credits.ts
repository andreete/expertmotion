// CREDITS file beside a finished render (FR-288, ADR-039): the CC0 music track (title, artist, licence proof), the self-made SFX,
// poster / picture Assets (with their stored attribution), pictures / clips / screenshots imported from the internet with their
// `credit` + `licence` (FR-303, ADR-041), every `source` string in the composition (`preset:shape.source-tag` texts) and the
// plan's `credits` lines (R-111 `credits?: string[]`). Pure text; never fails a render.
import fs from 'node:fs';
import path from 'node:path';
import type { CompositionModelT } from '@expertmotion/composition-model';
import { MUSIC_LIBRARY_LICENCE, analysis, musicTrack } from '@expertmotion/models';
import type { ServiceContext } from '../../context.js';
import { getAsset } from '../assets-repo.js';

/** Texts of every element rendered with `presetId` (walks the model JSON; the Reels shape presets live under tracks.shape / overlay). */
export function textsOfPreset(model: CompositionModelT, presetId: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const o = v as Record<string, unknown>;
    if (o['presetId'] === presetId || o['variant'] === presetId) {
      const p = (o['params'] ?? {}) as Record<string, unknown>;
      for (const k of ['text', 'source', 'label']) { const t = p[k] ?? o[k]; if (typeof t === 'string' && t.trim()) out.push(t.trim()); }
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(model);
  return [...new Set(out)];
}

export function buildCredits(ctx: ServiceContext, projectId: string, model: CompositionModelT, o: { outputFile: string; extra?: readonly string[]; projectName?: string }): string {
  const lines: string[] = [`CREDITS — ${path.basename(o.outputFile)}`, `Project: ${o.projectName ?? projectId}`, `Made with Expertmotion on ${new Date().toISOString().slice(0, 10)}`, ''];
  const music: string[] = []; const sfx = new Set<string>(); const voices: string[] = [];
  for (const a of model.tracks.audio) {
    const row = getAsset(ctx, a.assetId, projectId); if (!row) continue;
    const m = /^music-([a-z0-9-]+)\.(wav|mp3)$/i.exec(row.name);
    const track = m ? musicTrack(m[1]!) : undefined;
    if (a.role === 'bed' || track) music.push(track ? `"${track.title}" — ${track.artist} · ${MUSIC_LIBRARY_LICENCE.spdx} (${track.credit}) · proof: ${MUSIC_LIBRARY_LICENCE.proofUrl}` : row.name);
    else if (a.role === 'sfx' || row.source_key?.startsWith('sfx:')) sfx.add(row.source_key?.slice(4) || row.name.replace(/^SFX · /, '').replace(/\.wav$/, ''));
    else voices.push(row.name);
  }
  if (music.length) lines.push('Music:', ...[...new Set(music)].map((l) => `  - ${l}`), '');
  if (sfx.size) lines.push('Sound effects:', ...[...sfx].map((k) => `  - ${k}${k in analysis.SFX_LIBRARY ? ` (${analysis.SFX_LIBRARY[k as analysis.SfxKind].licence})` : ''}`), '');
  if (voices.length) lines.push('Voice:', ...[...new Set(voices)].map((l) => `  - ${l}`), '');
  // FR-288 pictures / poster overlays + FR-303 (ADR-041): every picture, clip or screenshot imported from the internet anywhere in
  // the composition (overlay, scene background, clip) with its stored credit + licence; the open catalogues' attribution as before.
  const pictures: string[] = []; const clips: string[] = []; const listed = new Set<string>();
  const assetIds: string[] = [];
  const collect = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(collect); return; }
    const o = v as Record<string, unknown>;
    if (typeof o['assetId'] === 'string') assetIds.push(o['assetId']);
    for (const k of Object.keys(o)) collect(o[k]);
  };
  collect(model.tracks);
  for (const id of assetIds) {
    if (listed.has(id)) continue; listed.add(id);
    const row = getAsset(ctx, id, projectId); if (!row || (row.kind !== 'image' && row.kind !== 'video')) continue;
    const isOverlay = (model.tracks.overlay as Array<{ assetId?: string }>).some((el) => el.assetId === id);
    let attribution: string | null = null;
    try { attribution = (ctx.db.prepare('SELECT attribution FROM asset_attributions WHERE asset_id = ?').get(row.id) as { attribution: string } | undefined)?.attribution ?? null; } catch { /* table missing in old DBs */ }
    const credit = row.credit ? `${row.credit}${row.licence ? ` · ${row.licence}` : ''}` : attribution;
    if (row.kind === 'image' && (isOverlay || credit)) pictures.push(credit ? `${row.name} — ${credit}` : row.name);
    else if (row.kind === 'video' && credit) clips.push(`${row.name} — ${credit}`);
  }
  if (pictures.length) lines.push('Pictures / poster:', ...[...new Set(pictures)].map((l) => `  - ${l}`), '');
  if (clips.length) lines.push('Clips:', ...[...new Set(clips)].map((l) => `  - ${l}`), '');
  const sources = [...textsOfPreset(model, 'preset:shape.source-tag'), ...(o.extra ?? []).map((s) => s.trim()).filter(Boolean)];
  if (sources.length) lines.push('Sources:', ...[...new Set(sources)].map((l) => `  - ${l}`), '');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** FR-288: the `credits` lines of the newest executed plan's applyOps step (the Editor's source list), else []. */
export function latestPlanCredits(ctx: ServiceContext, projectId: string): string[] {
  try {
    const rows = ctx.db.prepare("SELECT plan_json FROM edit_plans WHERE project_id = ? AND status = 'executed' ORDER BY updated_at DESC LIMIT 10").all(projectId) as Array<{ plan_json: string }>;
    for (const r of rows) {
      const plan = JSON.parse(r.plan_json) as { steps?: Array<{ args?: Record<string, unknown> }> };
      for (const st of plan.steps ?? []) { const c = st.args?.['credits']; if (Array.isArray(c) && c.length) return c.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 50); }
    }
  } catch { /* no plans table / unreadable plan */ }
  return [];
}

/** `<stem>-CREDITS.txt` next to the output; returns the path or null when it could not be written (logged, never thrown). */
export function writeCredits(ctx: ServiceContext, projectId: string, model: CompositionModelT, outputFile: string, extra?: readonly string[]): string | null {
  try {
    const projectName = (ctx.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined)?.name;
    const file = path.join(path.dirname(outputFile), `${path.basename(outputFile).replace(/\.[^.]+$/, '')}-CREDITS.txt`);
    fs.writeFileSync(file, buildCredits(ctx, projectId, model, { outputFile, ...(extra ? { extra } : {}), ...(projectName ? { projectName } : {}) }), 'utf8');
    return file;
  } catch (e) { ctx.log.warn({ projectId, err: String(e).slice(0, 300) }, 'credits file not written'); return null; }
}
