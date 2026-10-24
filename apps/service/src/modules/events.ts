// Events module: R-190 GET /events (global SSE stream, API_SPECIFICATION §7). `projectId` narrows project-scoped events
// (events without a projectId always pass); `hardware=1` opts into `hardware.tick`, which no other client receives.
import { z } from 'zod';
import { EmError } from '@expertmotion/shared';
import type { EmEvent } from '../http/events.js';
import type { ServiceModule } from './types.js';
import { Id } from '../s3/dto.js';
import { setHardwareSubscribers } from '../s3/state.js';

const Query = z.object({ projectId: Id.optional(), hardware: z.enum(['0', '1']).optional() });

export function eventFilter(projectId: string | undefined, hardware: boolean): (e: EmEvent) => boolean {
  return (e) => {
    if (e.name === 'hardware.tick') return hardware;
    const p = e.data['projectId'];
    return projectId === undefined || typeof p !== 'string' || p === projectId;
  };
}

export const eventsModule: ServiceModule = {
  name: 'events',
  register(router, ctx) {
    router.get('/events', (req, res, next) => {
      const q = Query.safeParse(req.query);
      if (!q.success) { next(new EmError('EM-9002', 'Invalid request: bad event stream parameters.', { status: 400, path: `query.${String(q.error.issues[0]?.path[0] ?? '')}` })); return; }
      const hardware = q.data.hardware === '1';
      ctx.bus.attach(req, res, eventFilter(q.data.projectId, hardware));
      if (hardware) { setHardwareSubscribers(ctx, +1); let done = false; const off = () => { if (!done) { done = true; setHardwareSubscribers(ctx, -1); } }; req.on('close', off); res.on('close', off); }
    });
  },
};
