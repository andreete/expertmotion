// Usage module: R-086 per-project usage summary (Usage Records, AI_WORKFLOW §11). Recording and budget enforcement are the
// providers module's hooks; this module only reads.
import { z } from 'zod';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { MonthQuery, monthOf, ProjectParams, requireProject } from '../s3/dto.js';
import { budgetState, projectByModel, projectMonthSpend } from '../s3/usage-store.js';

export const usageModule: ServiceModule = {
  name: 'usage',
  register(router, ctx) {
    route(router, 'get', '/projects/:id/usage', { params: ProjectParams, query: z.object({ month: MonthQuery.optional() }) }, ({ params, query }) => {
      requireProject(ctx, params.id);
      const month = query.month ?? monthOf(ctx.now());
      const { breach: _b, ...budget } = budgetState(ctx, params.id, month);
      void _b;
      return { month, project: projectMonthSpend(ctx, params.id, month),
        byAgent: { brainstorm: projectMonthSpend(ctx, params.id, month, 'brainstorm'), editor: projectMonthSpend(ctx, params.id, month, 'editor') },
        byModel: projectByModel(ctx, params.id, month), budget };
    });
  },
};
