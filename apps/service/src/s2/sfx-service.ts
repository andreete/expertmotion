// Procedural SFX Assets (FR-288, Reels pipeline, ADR-039): the six self-made CC0 sounds of `synthSfx` (whoosh, pop, click, tick,
// ding, rise) written once per project as 48 kHz WAVs and registered through the ingest pipeline (name "SFX · <kind>.wav",
// `source_key` sfx:<kind> so a second call finds the same Asset). Used by Execute when a plan step places SFX (`ctx.hooks.sfxAssets`).
import fs from 'node:fs';
import path from 'node:path';
import type { ServiceContext } from '../context.js';
import { em } from './common.js';
import { getAsset } from './assets-repo.js';
import { ingestOf, inspectSource } from './ingest.js';
import { analysis } from '@expertmotion/models';

type SfxKind = analysis.SfxKind;

export const SFX_KINDS: readonly SfxKind[] = analysis.SFX_KINDS;
export const SFX_SAMPLE_RATE = 48000;
export const sfxSourceKey = (kind: SfxKind): string => `sfx:${kind}`;
export const sfxAssetName = (kind: SfxKind): string => `SFX · ${kind}.wav`;

/** The project's SFX Assets by kind (made on first use; one ingest per missing kind, in order). */
export async function ensureSfxAssets(ctx: ServiceContext, projectId: string): Promise<Record<SfxKind, string>> {
  const ingest = ingestOf(ctx); const out = {} as Record<SfxKind, string>;
  const dir = path.join(ctx.paths.tmp, `sfx-${ctx.newId()}`);
  try {
    for (const kind of SFX_KINDS) {
      const have = ingest.findBySource(projectId, sfxSourceKey(kind));
      if (have) {
        const row = have.status === 'ingesting' ? (await ingest.whenSettled(have.id)).row ?? getAsset(ctx, have.id) : have;
        if (row && row.status === 'ready') { out[kind] = row.id; continue; }
      }
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${kind}.wav`);
      fs.writeFileSync(file, analysis.writeWav16(analysis.synthSfx(kind, SFX_SAMPLE_RATE), SFX_SAMPLE_RATE));
      const name = sfxAssetName(kind);
      const s = await inspectSource(file, name);
      await ingest.checkCapacity(projectId, s.bytes);
      const row = ingest.importFile({ projectId, source: file, name, kind: s.kind, bytes: s.bytes, ext: s.ext, move: true, sourceKey: sfxSourceKey(kind) });
      const o = await ingest.whenSettled(row.id);
      const id = o.status === 'duplicate' || o.status === 'ready' ? o.row?.id : undefined;
      if (!id) throw em('EM-7101', `The "${kind}" sound could not be imported.`, { details: { reason: o.status, kind } });
      out[kind] = id;
    }
    return out;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
