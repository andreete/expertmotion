// ServiceContext: everything a module needs, created once at startup. Cross-module calls go through `hooks`, which the owning
// module installs in its `start()`; defaults keep every module usable (and testable) on its own.
import { EmError, newId as ulid, type EmCode, type Logger } from '@expertmotion/shared';
import type { AssetFacts, CompositionModelT, OperationT, Tier } from '@expertmotion/composition-model';
import type { EditIntentT, EditPlanT } from '@expertmotion/agents';
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
  loopsDir: string;
  licenseDir: string;                   // resources/license (embedded revoked.json + .sig)                     // resources/catalogue (<category>/<name>.webm, DESIGN_CATALOGUE §2)
}

export interface Hooks {
  /** assets module: facts for composition validation and Compile. */
  assetFacts(projectId: string): AssetFacts[];
  /** hardware module: current Hardware Tier. */
  tier(): Tier;
  /** providers module: a provider for the agent's Model Assignment (throws EM-4001/4007/4401). */
  providerFor(agent: 'brainstorm' | 'editor', projectId: string): ChatProvider;
  /** providers module: record usage (never throws; budgetCheck blocks the next run). */
  recordUsage(projectId: string, agent: 'brainstorm' | 'editor', runId: string, usage: ChatUsage[]): void;
  budgetCheck(projectId: string): void;
  /** license module: whether exports must be watermarked (Trial Mode). */
  isTrial(): boolean;
  /** projects module: notify that the project head changed (autosave, SSE). */
  headChanged(projectId: string, versionId: string): void;
  /** composition module (S1): current head of a project (EM-9003 when unknown). */
  composition(projectId: string): { model: CompositionModelT; versionId: string };
  /** composition module (S1): apply ops as one new version (validated, transactional); returns the new version id. */
  applyOps(projectId: string, ops: OperationT[], source: { kind: 'generator' | 'asset' | 'system'; ref?: string; summary: string }): string;
  /** intents module (S1): create an Edit Plan from the Intent Queue and/or a typed instruction (Compile or Editor Agent). */
  createPlan(projectId: string, input: { instruction?: string; mode?: 'auto' | 'compile' | 'agent'; signal?: AbortSignal;
    /** agent run created by the caller (S3 editor chat): reuse it instead of creating a second run row and second run events. */
    runId?: string; intentIds?: string[] }): Promise<EditPlanT & { planId: string; runId?: string }>;
  /** intents module (S1): enqueue intents (Brainstorm handoff, AI_WORKFLOW §6), persist, emit intent.updated; returns the queue. */
  enqueueIntents?(projectId: string, intents: EditIntentT[]): { queue: EditIntentT[] };
}

export interface ServiceContext {
  cfg: ServiceConfig; paths: Paths; db: DB; bus: EventBus; grants: GrantStore; egress: Egress; settings: SettingsStore; log: Logger;
  resources: Resources; hooks: Hooks; newId: () => string; now: () => string;
  /** Origins of Remotion render pages allowed to fetch /media/ during a render job (renders module adds/removes them). */
  mediaOrigins: Set<string>;
}

export function defaultHooks(): Hooks {
  const no = (code: EmCode) => (): never => { throw new EmError(code, 'Not available.'); };
  return {
    assetFacts: () => [], tier: () => 'T1', providerFor: no('EM-4001'), recordUsage: () => {}, budgetCheck: () => {}, isTrial: () => true, headChanged: () => {},
    composition: no('EM-9003'), applyOps: no('EM-9003'), createPlan: async () => no('EM-9003')(),
  };
}
export const newId = (): string => ulid();
export const nowIso = (): string => new Date().toISOString();
