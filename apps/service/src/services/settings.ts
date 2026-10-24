// App settings (settings table, DATABASE_SCHEMA §3). Non-secret preferences only; secrets live in provider_connections.
import { z } from 'zod';
import type { DB } from '../db/open.js';

export const SettingsSchema = z.object({
  privateMode: z.boolean().default(false),
  uiLanguage: z.enum(['en', 'id']).default('en'),
  defaultLanguage: z.enum(['id', 'en']).default('id'),
  performanceProfile: z.enum(['standard', 'accelerated', 'turbo']).default('standard'),
  autoPlan: z.boolean().default(true),
  outputFolder: z.string().max(1024).optional(),
  autosaveDebounceMs: z.number().int().min(500).max(10_000).default(2000),
  autosaveMaxMs: z.number().int().min(1000).max(10_000).default(5000),
  telemetry: z.literal(false).default(false),
  updateChannel: z.enum(['stable', 'off']).default('stable'),
  onboardingDone: z.boolean().default(false),
}).strict();
export type Settings = z.infer<typeof SettingsSchema>;

export class SettingsStore {
  private cache: Settings | null = null;
  private readonly listeners = new Set<(s: Settings, changed: string[]) => void>();
  constructor(private readonly db: DB) {}
  get(): Settings {
    if (this.cache) return this.cache;
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as Array<{ key: string; value_json: string }>;
    const raw: Record<string, unknown> = {};
    for (const r of rows) if (r.key in SettingsSchema.shape) raw[r.key] = JSON.parse(r.value_json);
    this.cache = SettingsSchema.parse(raw);
    return this.cache;
  }
  update(patch: Partial<Settings>): Settings {
    const next = SettingsSchema.parse({ ...this.get(), ...patch });
    const changed = Object.keys(patch).filter((k) => JSON.stringify((this.get() as Record<string, unknown>)[k]) !== JSON.stringify((next as Record<string, unknown>)[k]));
    const up = this.db.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at');
    const now = new Date().toISOString();
    this.db.transaction(() => { for (const k of changed) up.run(k, JSON.stringify((next as Record<string, unknown>)[k]), now); })();
    this.cache = next;
    if (changed.length) for (const l of this.listeners) l(next, changed);
    return next;
  }
  onChange(fn: (s: Settings, changed: string[]) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
