import { z } from 'zod';

export const MAX_PAGE_SIZE = 500;

/** Query string `?page=1&pageSize=100` (1-based). */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/** `{ items, page, pageSize, total }` for the given item schema. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
  });
}

/** `?flag=true|false` → boolean. Absent → undefined. */
export const BooleanQuerySchema = z.enum(['true', 'false']).transform((value) => value === 'true');
