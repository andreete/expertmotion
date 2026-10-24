// Media grants (API_SPECIFICATION §2.2, SEC-010): random 256-bit tokens in the URL path, scoped to one project (preview,
// sliding TTL) or one render job (until its final event). In memory only; never logged.
import crypto from 'node:crypto';

export interface Grant { token: string; projectId: string; kind: 'preview' | 'render'; jobId?: string; assetIds?: Set<string>; expiresAt: number }
export class GrantStore {
  private readonly grants = new Map<string, Grant>();
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}
  issuePreview(projectId: string): Grant {
    for (const g of this.grants.values()) if (g.kind === 'preview' && g.projectId === projectId && g.expiresAt > this.now()) { g.expiresAt = this.now() + this.ttlMs; return g; }
    return this.add({ token: crypto.randomBytes(32).toString('base64url'), projectId, kind: 'preview', expiresAt: this.now() + this.ttlMs });
  }
  issueRender(projectId: string, jobId: string, assetIds: Iterable<string>): Grant {
    return this.add({ token: crypto.randomBytes(32).toString('base64url'), projectId, kind: 'render', jobId, assetIds: new Set(assetIds), expiresAt: Number.MAX_SAFE_INTEGER });
  }
  /** Returns the grant when it may read this asset of this project; slides preview expiry. */
  check(token: string, projectId: string, assetId: string): Grant | undefined {
    const g = this.grants.get(token);
    if (!g || g.expiresAt <= this.now() || g.projectId !== projectId) return undefined;
    if (g.kind === 'render' && g.assetIds && !g.assetIds.has(assetId)) return undefined;
    if (g.kind === 'preview') g.expiresAt = this.now() + this.ttlMs;
    return g;
  }
  lookup(token: string): Grant | undefined { const g = this.grants.get(token); return g && g.expiresAt > this.now() ? g : undefined; }
  revoke(token: string): boolean { return this.grants.delete(token); }
  revokeJob(jobId: string): void { for (const [k, g] of this.grants) if (g.jobId === jobId) this.grants.delete(k); }
  revokeProject(projectId: string): void { for (const [k, g] of this.grants) if (g.projectId === projectId) this.grants.delete(k); }
  private add(g: Grant): Grant { this.grants.set(g.token, g); return g; }
}
export const GRANT_RE = /^[A-Za-z0-9_-]{43}$/;
