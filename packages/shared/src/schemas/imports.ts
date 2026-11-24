import { z } from 'zod';
import { PagingQuery } from './paging.js';
import { BATCH_STATUSES, IMPORT_FIELDS } from '../imports.js';
import { LEAD_TYPES } from '../leads.js';
import { OUTREACH_LANGUAGES } from '../outreach.js';

/**
 * `POST /imports/batches`: Outreach language and Import as start with nothing chosen, so both are required (no
 * defaults): a batch without them is refused.
 */
export const ImportBatchCreate = z.object({
  language: z.enum(OUTREACH_LANGUAGES),
  leadType: z.enum(LEAD_TYPES),
});
export type ImportBatchCreate = z.infer<typeof ImportBatchCreate>;

/** `PATCH /imports/batches/:id`: either may change until Importing. */
export const ImportBatchUpdate = ImportBatchCreate.partial()
  .refine((b) => b.language !== undefined || b.leadType !== undefined, { message: 'nothing_to_change' });
export type ImportBatchUpdate = z.infer<typeof ImportBatchUpdate>;

/** `PATCH /imports/rows/:id`: one cell (field with its value; empty clears it), and / or the import tick. */
export const ImportRowUpdate = z.object({
  field: z.enum(IMPORT_FIELDS).optional(),
  value: z.string().trim().max(500).optional(),
  include: z.boolean().optional(),
})
  .refine((r) => (r.field === undefined) === (r.value === undefined), { path: ['value'], message: 'field_and_value' })
  .refine((r) => r.field !== undefined || r.include !== undefined, { message: 'nothing_to_change' });
export type ImportRowUpdate = z.infer<typeof ImportRowUpdate>;

/** The step-2 / step-3 row filters ("Include all" applies to the rows the filter shows). */
export const ROW_FILTERS = ['all', 'missing', 'already', 'notlead'] as const;
export type RowFilter = (typeof ROW_FILTERS)[number];

/** `POST /imports/batches/:id/include`. */
export const ImportIncludeAll = z.object({ filter: z.enum(ROW_FILTERS), include: z.boolean() });
export type ImportIncludeAll = z.infer<typeof ImportIncludeAll>;

/** `POST /imports/files/:id/columns`: an unsure column answered with the field it holds, or "skip" (stored as ignore). */
export const ImportColumnAnswer = z.object({
  sheet: z.string().max(100),
  col: z.number().int().min(0),
  field: z.enum([...IMPORT_FIELDS, 'skip']),
});
export type ImportColumnAnswer = z.infer<typeof ImportColumnAnswer>;

/**
 * `POST /imports/batches/:id/import` (the step-4 choices, kept as `ImportBatch.options`). Both boxes start unticked;
 * `noContactRows` (rows with no email or phone: import them or leave them out) has no default and must be sent, null
 * when nothing was chosen (refused when such rows exist).
 */
export const ImportCommit = z.object({
  acceptHigh: z.boolean(),
  noContactRows: z.enum(['import', 'leave']).nullable(),
  notify: z.boolean(),
});
export type ImportCommit = z.infer<typeof ImportCommit>;

/** `GET /imports/batches` (Data manager). */
export const ImportBatchListQuery = PagingQuery.extend({
  language: z.enum(OUTREACH_LANGUAGES).optional(),
  status: z.enum(BATCH_STATUSES).optional(),
});
export type ImportBatchListQuery = z.infer<typeof ImportBatchListQuery>;

/** `GET /imports/batches/:id/rows`: 100 rows a page; imported / skipped / errors are the batch detail's filters. */
export const ImportRowsQuery = PagingQuery.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
  filter: z.enum([...ROW_FILTERS, 'imported', 'skipped', 'errors']).default('all'),
});
export type ImportRowsQuery = z.infer<typeof ImportRowsQuery>;
