import { z } from 'zod';
import { LEAD_TYPES, PRIORITIES } from '../leads.js';
import { OUTREACH_LANGUAGES } from '../outreach.js';
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
  /** Left out on create = from the country (defaultOutreachLanguage); a later country edit does not change it. */
  outreachLanguage: z.enum(OUTREACH_LANGUAGES).optional(),
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

/** `POST /leads/:id/research`: a `research` activity on the timeline (title, optional link and notes). */
export const ResearchNote = z.object({
  title: z.string().trim().min(1).max(200),
  url: optionalUrl(500),
  body: optionalText(5000),
  updatedAt,
});
export type ResearchNote = z.infer<typeof ResearchNote>;

/** A meeting note may be dated ahead (a planned meeting), but no more than a year from now. */
function withinAYear(iso: string): boolean {
  const max = new Date();
  max.setFullYear(max.getFullYear() + 1);
  return Date.parse(iso) <= max.getTime();
}

/** `POST /leads/:id/meeting`: a `meeting` activity dated when the meeting took place (at most a year ahead). */
export const MeetingNote = z.object({
  title: z.string().trim().min(1).max(200),
  occurredAt: z
    .string()
    .datetime({ offset: true })
    .refine(withinAYear, { message: 'At most one year from now' }),
  body: optionalText(5000),
  updatedAt,
});
export type MeetingNote = z.infer<typeof MeetingNote>;

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
  /** Outreach language: English / Spanish leads. */
  language: z.enum(OUTREACH_LANGUAGES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Leads of this company. */
  companyId: z.coerce.number().int().positive().optional(),
  /** `1` includes archived leads (view_all_leads only). */
  archived: z.enum(['0', '1']).optional(),
  /** `1` keeps open leads only (not Won, Lost or Not Relevant), e.g. the calendar's lead picker. */
  open: z.literal('1').optional(),
});
export type LeadListQuery = z.infer<typeof LeadListQuery>;

/** `GET /companies/:id/activities`: 20 per page by default, newest first. */
export const CompanyActivityQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type CompanyActivityQuery = z.infer<typeof CompanyActivityQuery>;

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

/* ------------------------------------------------------------------ CSV import */

/** Lead fields a CSV column can map to. */
export const CSV_FIELDS = [
  'companyName', 'website', 'businessEmail', 'phone', 'country', 'city', 'contactFirstName', 'contactLastName',
  'contactEmail', 'leadSource', 'priority', 'notes', 'sourceUrl', 'outreachLanguage',
] as const;
export type CsvField = (typeof CSV_FIELDS)[number];

/** Largest CSV text accepted by the import endpoints (characters). */
export const CSV_MAX_LENGTH = 5_000_000;

/** Most data rows accepted by one CSV preview / import (the CLI prospect import is not capped). */
export const CSV_MAX_ROWS = 1000;

const csvHeader = z.string().trim().min(1).max(200);
const optionalHeader = csvHeader.nullish().transform((v) => v ?? null);

/** CSV header name per lead field (null = not imported). `companyName` and `country` are required. */
export const CsvMapping = z.object({
  columns: z.object({
    companyName: csvHeader,
    website: optionalHeader,
    businessEmail: optionalHeader,
    phone: optionalHeader,
    country: csvHeader,
    city: optionalHeader,
    contactFirstName: optionalHeader,
    contactLastName: optionalHeader,
    contactEmail: optionalHeader,
    leadSource: optionalHeader,
    priority: optionalHeader,
    notes: optionalHeader,
    sourceUrl: optionalHeader,
    outreachLanguage: optionalHeader,
  }),
});
export type CsvMapping = z.infer<typeof CsvMapping>;
/** A suggested mapping: any field, required ones included, may be unmatched (null). */
export type CsvSuggestedMapping = { columns: Record<CsvField, string | null> };

const csvText = z.string().min(1).max(CSV_MAX_LENGTH);

/** `POST /imports/leads/preview`. */
export const CsvPreview = z.object({ csv: csvText });
export type CsvPreview = z.infer<typeof CsvPreview>;

/** `POST /imports/leads`. */
export const CsvImport = z.object({
  csv: csvText,
  mapping: CsvMapping,
  /** Used for rows without a mapped (or with an empty) lead source column. */
  leadSource: z.string().trim().min(1).max(60).default('CSV Import'),
  assignedToId: z.number().int().positive().nullish(),
});
export type CsvImport = z.infer<typeof CsvImport>;

/** `POST /leads/:id/resolve-company`: link an existing company, or create one from the lead. */
export const ResolveCompany = z.object({
  companyId: z.union([z.number().int().positive(), z.literal('create')]),
  updatedAt,
});
export type ResolveCompany = z.infer<typeof ResolveCompany>;

/** `POST /leads/:id/do-not-email` (release 2C): opted out or unsubscribed; the Mailer skips the lead. */
export const LeadDoNotEmail = z.object({ doNotEmail: z.boolean(), updatedAt });
export type LeadDoNotEmail = z.infer<typeof LeadDoNotEmail>;
