// ServiceContext: everything a module needs, created once at startup. Cross-module calls go through `hooks`, which the owning
// module installs in its `start()`; defaults keep every module usable (and testable) on its own.
import { EmError, newId as ulid, type EmCode, type Logger } from '@expertmotion/shared';
import type { AssetFacts, Tier } from '@expertmotion/composition-model';
import type { ChatProvider, ChatUsage } from '@expertmotion/agents';
import type { ServiceConfig, Paths } from './config.js';
import type { DB } from './db/open.js';
import type { EventBus } from './http/events.js';
import type { GrantStore } from './services/grants.js';
import type { Egress } from './services/egress.js';
import type { SettingsStore } from './services/settings.js';

export interface Resources {
  engineBundle: string;                 // serveUrl folder (resources/engine/bundle)
  browserExecutable?: string;           // Chrome Headless Shell (packaged: resources/engine/chrome)
  binariesDirectory?: string;           // Remotion compositor (packaged: resources/engine/compositor)
  ffmpeg: string; ffprobe: string;      // ingestion binaries (ADR-019)
  loopsDir: string;                     // resources/catalogue/loops
}

export interface Hooks {
  /** assets module: facts for composition validation and Compile. */
  assetFacts(projectId: string): AssetFacts[];
  /** hardware module: current Hardware Tier. */
  tier(): Tier;
  /** providers module: a provider for the agent's Model Assignment (throws EM-4001/4007/4401). */
  providerFor(agent: 'brainstorm' | 'editor', projectId: string): ChatProvider;
  /** providers module: record usage; throws EM-4201 when a budget would be exceeded. */
  recordUsage(projectId: string, agent: 'brainstorm' | 'editor', runId: string, usage: ChatUsage[]): void;
  budgetCheck(projectId: string): void;
  /** license module: whether exports must be watermarked (Trial Mode). */
  isTrial(): boolean;
  /** projects module: notify that the project head changed (autosave, SSE). */
  headChanged(projectId: string, versionId: string): void;
}

export interface ServiceContext {
  cfg: ServiceConfig; paths: Paths; db: DB; bus: EventBus; grants: GrantStore; egress: Egress; settings: SettingsStore; log: Logger;
  resources: Resources; hooks: Hooks; newId: () => string; now: () => string;
}

export function defaultHooks(): Hooks {
  const no = (code: EmCode) => (): never => { throw new EmError(code, 'Not available.'); };
  return {
    assetFacts: () => [], tier: () => 'T1', providerFor: no('EM-4001'), recordUsage: () => {}, budgetCheck: () => {}, isTrial: () => true, headChanged: () => {},
  };
}
export const newId = (): string => ulid();
export const nowIso = (): string => new Date().toISOString();
