// FR-301 (ADR-041): the Creator's own Pexels API key — stored like the voice keys (AES-256-GCM sealed with a key derived from the
// database key, label 'research-secrets', AAD `research_keys:pexels`), checked once against the Pexels API before it is stored,
// returned only as a hint, decrypted only for a call, never logged. Routes R-089a … R-089c (modules/agents.ts).
import { EmError } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { createSecretBox, secretHint, type SecretBox } from './crypto.js';
import { normalizeKey } from './keys.js';
import { PEXELS_API } from './research.js';

export type ResearchKeyProvider = 'pexels';
const boxes = new WeakMap<ServiceContext, SecretBox>();
const box = (ctx: ServiceContext): SecretBox => { let b = boxes.get(ctx); if (!b) { b = createSecretBox(ctx.cfg.dbKeyHex, 'research-secrets'); boxes.set(ctx, b); } return b; };

export class ResearchKeys {
  constructor(private readonly ctx: ServiceContext) {}
  /** The decrypted key for one call, or null (none stored / unreadable). */
  key(provider: ResearchKeyProvider): string | null {
    let r: { secret_enc: Buffer } | undefined;
    try { r = this.ctx.db.prepare('SELECT secret_enc FROM research_keys WHERE provider = ?').get(provider) as typeof r; } catch { return null; }
    if (!r) return null;
    try { return box(this.ctx).open(r.secret_enc, `research_keys:${provider}`); } catch { return null; }
  }
  hint(provider: ResearchKeyProvider): string | null {
    try { return (this.ctx.db.prepare('SELECT secret_hint FROM research_keys WHERE provider = ?').get(provider) as { secret_hint: string } | undefined)?.secret_hint ?? null; } catch { return null; }
  }
  /** R-089a: hints only. */
  status(): { pexels: { hint: string | null } } { return { pexels: { hint: this.hint('pexels') } }; }
  /** R-089b: checks the key with one tiny search (`GET /v1/search?query=nature&per_page=1`), then stores / replaces it. */
  async setPexelsKey(raw: string): Promise<{ provider: 'pexels'; secretHint: string; status: 'valid' }> {
    if (this.ctx.settings.get().privateMode) throw new EmError('EM-8202', 'Private Mode is on, so the Pexels key was not checked.', { details: { action: 'Pexels key' } });
    const key = normalizeKey(raw);
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(key)) throw new EmError('EM-9002', 'Invalid request: this does not look like a Pexels API key.', { status: 400, path: 'body.key' });
    const res = await this.ctx.egress.for('research-api')(`${PEXELS_API}/v1/search?query=nature&per_page=1`, { headers: { Authorization: key, Accept: 'application/json' } });
    void res.body?.cancel().catch(() => undefined);
    if (res.status === 401 || res.status === 403) throw new EmError('EM-4410', 'Pexels did not accept this API key. Check that it was copied completely (pexels.com/api).', { status: 422, details: { status: res.status } });
    if (res.status !== 200) throw new EmError('EM-4407', `Pexels answered HTTP ${res.status} while checking the key. Try again later.`, { details: { status: res.status } });
    const now = this.ctx.now();
    this.ctx.db.prepare(`INSERT INTO research_keys (provider, secret_enc, secret_hint, created_at, updated_at) VALUES ('pexels', ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET secret_enc = excluded.secret_enc, secret_hint = excluded.secret_hint, updated_at = excluded.updated_at`).run(box(this.ctx).seal(key, 'research_keys:pexels'), secretHint(key), now, now);
    this.ctx.log.info({ provider: 'pexels' }, 'research key stored');
    return { provider: 'pexels', secretHint: secretHint(key), status: 'valid' };
  }
  remove(provider: ResearchKeyProvider): void { this.ctx.db.prepare('DELETE FROM research_keys WHERE provider = ?').run(provider); }
}
const instances = new WeakMap<ServiceContext, ResearchKeys>();
export function researchKeysOf(ctx: ServiceContext): ResearchKeys { let r = instances.get(ctx); if (!r) { r = new ResearchKeys(ctx); instances.set(ctx, r); } return r; }
