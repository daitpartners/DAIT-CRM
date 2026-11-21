import { z } from 'zod';

export const PagingQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).default('asc'),
  q: z.string().trim().max(200).optional(),
});
export type PagingQuery = z.infer<typeof PagingQuery>;

/** Prisma skip/take for a parsed PagingQuery. */
export function pageArgs(p: Pick<PagingQuery, 'page' | 'pageSize'>): { skip: number; take: number } {
  return { skip: (p.page - 1) * p.pageSize, take: p.pageSize };
}
