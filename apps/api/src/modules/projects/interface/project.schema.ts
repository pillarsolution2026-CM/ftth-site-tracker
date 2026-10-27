import { z } from 'zod';

// TODO(orchestrator): promote to packages/shared once web/mobile need it (contract is not in shared yet).
export const ProjectResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  client: z.string(),
  crsEpsg: z.number().int(),
  currency: z.string().length(3),
  locale: z.enum(['ar', 'en', 'fr']),
});
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;
