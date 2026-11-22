/* Projects (release 3B): statuses, the list badge and the default primary stakeholders. */

export const PROJECT_STATUSES = ['Active', 'On hold', 'Completed', 'Cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Status badge class (prototype V.projects): Active green, Completed grey, On hold / Cancelled amber. */
export function projectBadge(status: string): 'b-ok' | 'b-grey' | 'b-warn' {
  if (status === 'Active') return 'b-ok';
  if (status === 'Completed') return 'b-grey';
  return 'b-warn';
}

/**
 * Stakeholders pre-ticked on a new project (prototype createProject): the lead's contact first, then the company's
 * contacts that are its primary contact or of type Decision Maker, in the given order, each once.
 */
export function primaryStakeholderIds(
  contacts: { id: number; isPrimary: boolean; contactType: string }[],
  leadContactId?: number | null,
): number[] {
  const ids: number[] = [];
  if (leadContactId != null) ids.push(leadContactId);
  for (const c of contacts) {
    if ((c.isPrimary || c.contactType === 'Decision Maker') && !ids.includes(c.id)) ids.push(c.id);
  }
  return ids;
}
