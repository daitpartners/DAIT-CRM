import { z } from 'zod';
import { isoDate, optionalText } from './common.js';
import { PROJECT_STATUSES } from '../projects.js';
import { QUOTE_CURRENCIES, round2 } from '../quotations.js';
import { QUOTE_MAX_AMOUNT } from './quotation.js';

const id = z.number().int().positive();
const DESCRIPTION_MAX = 10_000;
const STAKEHOLDERS_MAX = 200;

/** The Create / Edit project dialog's fields (prototype V.projectModal); the company is fixed once created. */
const projectFields = {
  /** One of the client's leads, or null for "— none —" (the API checks company and visibility). */
  leadId: id.nullish(),
  /** One of the client's Accepted quotations with no project, or null for "— none —". */
  quotationId: id.nullish(),
  name: z.string().trim().min(1).max(200),
  status: z.enum(PROJECT_STATUSES),
  startDate: isoDate,
  /** Rounded to 2 decimals as the Decimal(14,2) column stores it; null when not given. */
  value: z.number().min(0).max(QUOTE_MAX_AMOUNT).transform(round2).nullish(),
  currency: z.enum(QUOTE_CURRENCIES),
  managerId: id,
  /** Primary stakeholders: contacts of the client (the API checks); duplicates removed. */
  stakeholderIds: z.array(id).max(STAKEHOLDERS_MAX).transform((ids) => [...new Set(ids)]),
  description: optionalText(DESCRIPTION_MAX),
};

/** `POST /projects`. */
export const projectCreateSchema = z.object({ companyId: id, ...projectFields });
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

/** `PATCH /projects/:id`: every field but the client; `updatedAt` is the version the dialog loaded (409 when stale). */
export const projectUpdateSchema = z.object({ ...projectFields, updatedAt: z.string().datetime() });
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

/** `GET /projects?company=&status=`: the list filters (kept in the URL). Tiles ignore them. */
export const projectListQuerySchema = z.object({
  company: z.coerce.number().int().positive().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

/** `GET /projects/form-options?company=`: the Create / Edit dialog's choices for one client. */
export const projectFormOptionsQuerySchema = z.object({ company: z.coerce.number().int().positive() });
