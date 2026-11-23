/* Translated display labels for fixed enums. Each phrase is a literal t() call so scripts/i18n-check.ts sees it. */
import type { CompanyStatus, LeadType, LookupGroup, Priority, Role, TaskKind, TaskOrigin } from '@dait-crm/shared';
import { CSV_MAX_ROWS, TASK_DURATION, taskEndTime } from '@dait-crm/shared';
import type { Lang } from '../api/queries';
import type { TFn } from './useT';

export function roleText(t: TFn, role: Role): string {
  switch (role) {
    case 'Administrator':
      return t('Administrator');
    case 'Manager':
      return t('Manager');
    case 'Sales Representative':
      return t('Sales Representative');
    case 'Data Research User':
      return t('Data Research User');
    default:
      return role;
  }
}

/** Language names are shown in their own language so a user can always find theirs. */
export const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', es: 'Español', fr: 'Français' };

export function groupText(t: TFn, group: LookupGroup): string {
  const labels: Record<LookupGroup, string> = {
    lead_source: t('Lead source'),
    lead_status: t('Lead status'),
    lead_type: t('Lead type'),
    priority: t('Priority'),
    country: t('Country'),
    industry: t('Industry'),
    business_category: t('Business category'),
    business_type: t('Business type'),
    employee_range: t('Employee range'),
    revenue_range: t('Revenue range'),
    ownership_type: t('Ownership type'),
    contact_type: t('Contact type'),
    location_type: t('Location type'),
    quote_status: t('Quote status'),
    currency: t('Currency'),
  };
  return labels[group] ?? group;
}

export function companyStatusText(t: TFn, status: CompanyStatus): string {
  switch (status) {
    // Company-specific keys: Spanish and French statuses agree with "empresa" / "entreprise" (feminine).
    case 'Active':
      return t('Active|company');
    case 'Inactive':
      return t('Inactive|company');
    case 'Closed':
      return t('Closed|company');
    default:
      return status;
  }
}

/** Badge class for a company status: Active green, Inactive grey, Closed amber. */
export function companyStatusBadge(status: CompanyStatus): string {
  return status === 'Active' ? 'badge b-ok' : status === 'Closed' ? 'badge b-warn' : 'badge b-grey';
}

/** A company's verification status (`|company`: Spanish and French agree with the feminine company). */
export function verificationText(t: TFn, status: string): string {
  switch (status) {
    case 'Verified':
      return t('Verified|company');
    case 'Partially Verified':
      return t('Partially verified');
    case 'Unverified':
      return t('Unverified|company');
    default:
      return status;
  }
}

/** Badge class for a verification status: Verified green, Partially Verified amber, Unverified grey. */
export function verificationBadge(status: string): string {
  return status === 'Verified' ? 'badge b-ok' : status === 'Partially Verified' ? 'badge b-warn' : 'badge b-grey';
}

/** A company's AI research status (RESEARCH_STATUSES): "Not started" = never researched, "Pending" = queued. */
export function researchStatusText(t: TFn, status: string): string {
  switch (status) {
    case 'Not started':
      return t('Not started|research');
    case 'Pending':
      return t('Pending|research');
    case 'Processing':
      return t('Processing|research');
    case 'Completed':
      return t('Completed|research');
    case 'Failed':
      return t('Failed|research');
    default:
      return status;
  }
}

/** A research run's sources (enrichment history "Sources"): provider keys as labels, comma separated. */
export function researchSourcesText(t: TFn, sources: readonly string[]): string {
  const label = (key: string) => {
    switch (key) {
      case 'website':
        return t('Website');
      case 'places':
        return t('Google Places');
      case 'claude':
        return t('Claude API');
      case 'websearch':
        return t('Web search');
      default:
        return key;
    }
  };
  return sources.map(label).join(', ');
}

/** Badge class for a research or run status (prototype badge): Pending / Processing amber, Completed green, Failed red. */
export function researchStatusBadge(status: string): string {
  switch (status) {
    case 'Pending':
    case 'Processing':
      return 'badge b-warn';
    case 'Completed':
      return 'badge b-ok';
    case 'Failed':
      return 'badge b-bad';
    default:
      return 'badge b-grey';
  }
}

/** The suggestions table's Field label (shared RESEARCH_FIELDS); an unknown field shows the server's label. */
export function researchFieldText(t: TFn, field: string, fallback: string): string {
  switch (field) {
    case 'description':
      return t('Company description');
    case 'legalName':
      return t('Legal company name');
    case 'businessEmail':
      return t('Business email');
    case 'street':
      return t('Street address');
    case 'city':
      return t('City');
    case 'state':
      return t('State / Province');
    case 'zip':
      return t('ZIP / Postal code');
    case 'yearEstablished':
      return t('Year established');
    case 'linkedinUrl':
      return t('LinkedIn company URL');
    case 'socialFacebook':
      return t('Facebook');
    case 'socialInstagram':
      return t('Instagram');
    case 'socialX':
      return t('X / Twitter');
    case 'socialYoutube':
      return t('YouTube');
    case 'websiteTechnology':
      return t('Website technology');
    case 'lat':
      return t('Latitude');
    case 'lng':
      return t('Longitude');
    case 'mapsUrl':
      return t('Google Maps link');
    case 'website':
      return t('Website');
    case 'websiteAssessment':
      return t('Website assessment');
    case 'specialisation':
      return t('Specialisation');
    case 'employeeRange':
      return t('Employee range');
    case 'aiPotentialServices':
      return t('Potential services');
    default:
      return fallback;
  }
}

/** A research source type (shared SOURCE_TYPES and the manual dialog's "Other"); anything else shows as stored. */
export function sourceTypeText(t: TFn, type: string): string {
  switch (type) {
    case 'Company website':
      return t('Company website');
    case 'Google Places API':
      return t('Google Places API');
    case 'Public registry':
      return t('Public registry');
    case 'Business directory':
      return t('Business directory');
    case 'Social profile':
      return t('Social profile');
    case 'Contact form':
      return t('Contact form');
    case 'Manual research':
      return t('Manual research');
    case 'CSV import':
      return t('CSV import');
    case 'Other':
      return t('Other|source');
    default:
      return type;
  }
}

/**
 * A lead status. Statuses are a lookup group (administrators may add more): the seeded ones are
 * translated here (`|lead`: Spanish and French agree with the masculine "el lead" / "le lead");
 * any other value shows as stored.
 */
export function leadStatusText(t: TFn, status: string): string {
  switch (status) {
    case 'New':
      return t('New|lead');
    case 'Not Contacted':
      return t('Not Contacted|lead');
    case 'Contacted':
      return t('Contacted|lead');
    case 'Interested':
      return t('Interested|lead');
    case 'Qualified':
      return t('Qualified|lead');
    case 'Proposal Sent':
      return t('Proposal Sent|lead');
    case 'Negotiation':
      return t('Negotiation|lead');
    case 'Won':
      return t('Won|lead');
    case 'Lost':
      return t('Lost|lead');
    case 'Not Relevant':
      return t('Not Relevant|lead');
    default:
      return status;
  }
}

/** Badge class per lead status (prototype/js/ui.js STATUS); unknown statuses are grey. */
export function leadStatusBadge(status: string): string {
  const cls: Record<string, string> = {
    New: 'b-purple', 'Not Contacted': 'b-grey', Contacted: 'b-info', Interested: 'b-ok', Qualified: 'b-ok',
    'Proposal Sent': 'b-purple2', Negotiation: 'b-warn', Won: 'b-ok', Lost: 'b-bad', 'Not Relevant': 'b-grey',
  };
  return `badge ${cls[status] ?? 'b-grey'}`;
}

/** A quotation status (`|quote`: Spanish "el presupuesto" and French "le devis" are masculine). */
export function quoteStatusText(t: TFn, status: string): string {
  switch (status) {
    case 'Draft':
      return t('Draft|quote');
    case 'Sent':
      return t('Sent|quote');
    case 'Negotiating':
      return t('Negotiating|quote');
    case 'Accepted':
      return t('Accepted|quote');
    case 'Rejected':
      return t('Rejected|quote');
    case 'Expired':
      return t('Expired|quote');
    default:
      return status;
  }
}

/** A project status in the user's language (release 3B; masculine "proyecto" / "projet"). */
export function projectStatusText(t: TFn, status: string): string {
  switch (status) {
    case 'Active':
      return t('Active|project');
    case 'On hold':
      return t('On hold|project');
    case 'Completed':
      return t('Completed|project');
    case 'Cancelled':
      return t('Cancelled|project');
    default:
      return status;
  }
}

/** Badge class per quotation status (prototype/js/ui.js STATUS). */
export function quoteStatusBadge(status: string): string {
  const cls: Record<string, string> = { Draft: 'b-grey', Sent: 'b-purple', Negotiating: 'b-warn', Accepted: 'b-ok', Rejected: 'b-bad', Expired: 'b-grey' };
  return `badge ${cls[status] ?? 'b-grey'}`;
}

export function leadTypeText(t: TFn, type: LeadType): string {
  return type === 'Prospect' ? t('Prospect') : t('Lead');
}

/** `|priority`: Spanish "prioridad" and French "priorité" are feminine. */
export function priorityText(t: TFn, priority: Priority): string {
  switch (priority) {
    case 'High':
      return t('High|priority');
    case 'Medium':
      return t('Medium|priority');
    case 'Low':
      return t('Low|priority');
    default:
      return priority;
  }
}

/** How a task came about. */
export function taskOriginText(t: TFn, origin: TaskOrigin): string {
  switch (origin) {
    case 'follow_up':
      return t('Follow-up');
    case 'new_assignment':
      return t('New assignment');
    case 'transfer':
      return t('Transfer');
    case 'manual':
      return t('Manual|task');
    case 'quotation':
      return t('Quotation');
    default:
      return origin;
  }
}

/** A task's type: follow-up, call or meeting. */
export function taskKindText(t: TFn, kind: TaskKind): string {
  switch (kind) {
    case 'followup':
      return t('Follow-up');
    case 'call':
      return t('Call');
    case 'meeting':
      return t('Meeting');
    default:
      return kind;
  }
}

/**
 * When a task happens, shown beside its title: "Call · 10:00–10:30" / "Meeting · 14:00–15:00" for calls and
 * meetings, the time alone for a timed follow-up, '' for an untimed one.
 */
export function taskWhenText(
  t: TFn,
  task: { kind: TaskKind; dueTime: string | null; durationMinutes: number | null },
): string {
  if (task.kind === 'followup') return task.dueTime ?? '';
  if (!task.dueTime) return taskKindText(t, task.kind);
  const minutes = task.durationMinutes ?? TASK_DURATION[task.kind];
  return `${taskKindText(t, task.kind)} · ${task.dueTime}–${taskEndTime(task.dueTime, minutes)}`;
}

/** Friendly text for API error codes; `vars` fills codes that carry values (csv_too_large: rows, max). */
export function errorText(t: TFn, code: string, vars: Record<string, string | number> = {}): string {
  switch (code) {
    case 'email_taken':
      return t('That email is already in use');
    case 'no_mailbox':
      return t('Connect your Microsoft 365 mailbox in Settings to send email from the CRM.');
    case 'cannot_deactivate_self':
      return t('You cannot deactivate your own account');
    case 'last_administrator':
      return t('There must always be at least one active administrator');
    case 'duplicate_value':
      return t('That value already exists in this list');
    case 'unknown_user':
      return t('One of the chosen users is not an active user');
    case 'invalid_credentials':
      return t('Email or password is incorrect');
    case 'forbidden':
      return t('You do not have access');
    case 'not_found':
      return t('Not found');
    case 'job_not_retryable':
      return t('That email is not waiting for a retry');
    case 'no_system_mailbox':
      return t('Connect a mailbox first');
    case 'invalid_send_as':
      return t('Enter a valid email address for Send as, or leave it empty');
    case 'validation':
      return t('Please check the highlighted fields');
    case 'stale':
      return t('Someone else changed this record. Reload and try again.');
    case 'not_accepted':
      return t('Only an accepted quotation can become a project.');
    case 'invalid_project':
      return t("That project can't be used for this email.");
    case 'quotation_linked':
      return t('That quotation is already linked to another project.');
    case 'domain_taken':
      return t('A company with this website domain already exists');
    case 'company_inactive':
      return t('This company is closed');
    case 'last_primary_contact':
      return t('A company must keep one primary contact');
    case 'contact_inactive':
      return t('This contact is inactive. Reactivate it first.');
    case 'lead_closed':
      return t('This lead is closed');
    case 'lead_archived':
      return t('This lead is archived. Restore it first.');
    case 'reason_required':
      return t('Enter a reason');
    case 'transfer_note_required':
      return t('Add a note for the person receiving the lead');
    case 'cannot_assign_hidden':
      return t('You cannot assign to that person');
    case 'invalid_status':
      return t('That status is not available');
    case 'already_assigned':
      return t('Someone has already taken this lead');
    case 'csv_invalid':
      return t('The file could not be read as CSV with a header row');
    case 'csv_too_large':
      return t('This file has {rows} rows; the limit is {max} per import. Split it and try again.', {
        rows: vars.rows ?? '?', max: vars.max ?? CSV_MAX_ROWS,
      });
    case 'company_already_linked':
      return t('This lead is already linked to a company');
    case 'already_logged':
      return t('This email is already on the lead.');
    case 'no_lead':
      return t('Link this email to a lead first.');
    case 'draft':
      return t('Drafts are edited in Outlook.');
    case 'not_connected':
      return t('Your mailbox needs reconnecting in Settings → Email & calendar connections.');
    case 'nothing_to_send':
      return t('None of the selected leads can be emailed.');
    case 'not_running':
      return t('This campaign is not running.');
    case 'not_paused':
      return t('This campaign is not paused.');
    case 'not_scheduled':
      return t('This campaign is not scheduled.');
    case 'task_done':
      return t('This task is already done');
    case 'time_required':
      return t('Enter a time for a call or meeting');
    case 'follow_up_kind':
      return t('The follow-up from the lead stays a follow-up');
    case 'locked':
      return t('This quotation is closed and can no longer be changed');
    case 'sending':
      return t('This quotation is being sent. Try again when it has gone.');
    case 'unsent_changes':
      return t('This quotation has unsent changes. Reload and try again.');
    case 'no_contact_email':
      return t('Choose a contact with an email address before sending');
    case 'pdf_too_large':
      return t('The PDF is too large to email. Shorten the quotation and try again.');
    case 'total_too_large':
      return t('The quotation total is too large. Lower the amounts and try again.');
    case 'invalid_transition':
      return t('That status change is not available');
    case 'research_running':
      return t('Research is already running for this company.');
    case 'daily_limit':
      return t('The daily research limit has been reached. Try again tomorrow.');
    case 'field_locked':
      return t('Field is verified · not overwritten');
    case 'already_decided':
      return t('This suggestion has already been decided.');
    default:
      return t('Something went wrong. Please try again.');
  }
}

export function initials(name: string): string {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
