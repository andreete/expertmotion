// S1 runtime: one set of services per ServiceContext, shared by the projects, composition and intents modules (each module
// may be started alone in tests; whichever starts first creates the runtime).
import type { ServiceContext } from '../context.js';
import { Backups } from './backup.js';
import { Checkpoints } from './checkpoints.js';
import { Projects } from './projects-svc.js';
import { SampleProjects } from './sample.js';
import { CompositionStore } from './store.js';
import { Workflow } from './workflow.js';

export interface S1 { store: CompositionStore; checkpoints: Checkpoints; workflow: Workflow; projects: Projects; backups: Backups; sample: SampleProjects; recovered: boolean }
const runtimes = new WeakMap<ServiceContext, S1>();

export function s1(ctx: ServiceContext): S1 {
  let r = runtimes.get(ctx);
  if (!r) {
    const store = new CompositionStore(ctx);
    const checkpoints = new Checkpoints(ctx, store);
    const workflow = new Workflow(ctx, store, checkpoints);
    const projects = new Projects(ctx, store, checkpoints, workflow);
    r = { store, checkpoints, workflow, projects, backups: new Backups(ctx, store), sample: new SampleProjects(ctx, store, projects), recovered: false };
    runtimes.set(ctx, r);
  }
  return r;
}
/** Crash recovery and housekeeping, once per runtime (FR-172, FR-175, DATABASE_SCHEMA §7). */
export function recoverOnce(ctx: ServiceContext): void {
  const r = s1(ctx);
  if (r.recovered) return;
  r.recovered = true;
  r.workflow.recoverOnStart();
  r.projects.purge();
  r.checkpoints.recoverOnStart();
}
