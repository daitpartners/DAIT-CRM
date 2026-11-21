import { z } from 'zod';
import { LEAD_TYPES, PRIORITIES } from '../leads.js';
import { isoDate, optionalEmail, optionalText, optionalUrl } from './common.js';
import { PagingQuery } from './paging.js';

const status = z.string().trim().min(1).max(40);
const updatedAt = z.string().datetime();

/** Editable lead details (shared by create and update; no defaults here). */
const leadDetails = z.object({
  leadType: z.enum(LEAD_TYPES),
  companyName: z.string().trim().min(1).max(200),
  website: optionalUrl(),
  businessEmail: optionalEmail(),
  phone: optionalText(40),
  country: z.string().trim().min(1).max(80),
  city: optionalText(100),
  leadSource: z.string().trim().min(1).max(60),
  sourceUrl: optionalUrl(500),
  priority: z.enum(PRIORITIES),
  nextFollowUp: isoDate.nullish(),
  notes: optionalText(5000),
});

export const LeadCreate = leadDetails.extend({
  leadType: leadDetails.shape.leadType.default('Lead'),
  priority: leadDetails.shape.priority.default('Medium'),
  status: status.default('New'),
  companyId: z.number().int().positive().optional(),
  contactId: z.number().int().positive().optional(),
  assignedToId: z.number().int().positive().nullish(),
  /** Use this company instead of running duplicate matching. */
  linkCompanyId: z.number().int().positive().optional(),
  /** Create a company when no match is found. */
  createCompany: z.boolean().default(true),
});
export type LeadCreate = z.infer<typeof LeadCreate>;

/** PATCH /leads/:id — details only; status, assignee and contact have their own endpoints. */
export const LeadUpdate = leadDetails.partial().extend({ updatedAt });
export type LeadUpdate = z.infer<typeof LeadUpdate>;

export const LeadStatusChange = z.object({
  status,
  /** Required (1–500) by the route for Lost / Not Relevant. */
  reason: optionalText(500),
  updatedAt,
});
export type LeadStatusChange = z.infer<typeof LeadStatusChange>;

/**
 * `POST /leads/:id/transfer`. The note is required by the route (`transfer_note_required`) unless
 * the actor is taking the lead themselves. Unassigning is `POST /leads/:id/unassign`.
 */
export const LeadTransfer = z.object({
  toUserId: z.number().int().positive(),
  note: z.string().trim().min(1).max(1000).optional(),
  updatedAt,
});
export type LeadTransfer = z.infer<typeof LeadTransfer>;

/** `POST /leads/:id/unassign` (Administrator / Manager): the lead goes back to the unassigned pool. */
export const LeadUnassign = z.object({
  note: z.string().trim().min(1).max(1000),
  updatedAt,
});
export type LeadUnassign = z.infer<typeof LeadUnassign>;

export const CALL_OUTCOMES = ['Connected', 'No answer', 'Voicemail', 'Wrong number', 'Callback requested'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const LogCall = z.object({
  outcome: z.enum(CALL_OUTCOMES),
  minutes: z.number().int().min(0).max(600).optional(),
  body: optionalText(2000),
  statusAfter: status.optional(),
  nextFollowUp: isoDate.nullish(),
  updatedAt,
});
export type LogCall = z.infer<typeof LogCall>;

export const LEAD_TABS = ['all', 'leads', 'prospects', 'mine', 'overdue', 'unassigned'] as const;
export const LEAD_SORTS = [
  'number', 'companyName', 'contact', 'country', 'leadType', 'leadSource', 'status', 'priority', 'assignedTo',
  'nextFollowUp', 'createdAt',
] as const;

/** `GET /leads` query. Query values arrive as strings. */
export const LeadListQuery = PagingQuery.extend({
  tab: z.enum(LEAD_TABS).optional(),
  sort: z.enum(LEAD_SORTS).optional(),
  status: z.string().trim().min(1).max(40).optional(),
  source: z.string().trim().min(1).max(60).optional(),
  country: z.string().trim().min(1).max(80).optional(),
  assignedTo: z.union([z.literal('none'), z.coerce.number().int().positive()]).optional(),
  leadType: z.enum(LEAD_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** `1` includes archived leads (view_all_leads only). */
  archived: z.enum(['0', '1']).optional(),
});
export type LeadListQuery = z.infer<typeof LeadListQuery>;

export const LeadBulk = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
  action: z.enum(['assign', 'archive', 'unarchive']),
  toUserId: z.number().int().positive().nullish(),
  note: z.string().trim().max(1000).optional(),
});
export type LeadBulk = z.infer<typeof LeadBulk>;

/** Body of archive / unarchive: only the optimistic-lock stamp. */
export const UpdatedAtOnly = z.object({ updatedAt });
export type UpdatedAtOnly = z.infer<typeof UpdatedAtOnly>;

export const SwitchContact = z.object({
  contactId: z.number().int().positive().nullable(),
  updatedAt,
});
export type SwitchContact = z.infer<typeof SwitchContact>;
