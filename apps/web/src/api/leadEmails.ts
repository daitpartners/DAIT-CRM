import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { keys } from './queries';

/**
 * An email on the lead page's Emails tab (release 2B-1; sent through the drafts path since web-mail release 3). Your
 * own; for Administrators and Managers (web-mail release 1) also the team's lead mail, view only, with `ownerName` =
 * whose mailbox it is (null for your own). Drafts stay with their owner.
 */
export type LeadEmail = {
  ownerName: string | null;
  id: number;
  leadId: number | null;
  folder: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'received' | 'draft';
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyText: string;
  occurredAt: string;
  lastError: string | null;
};
/** Under the lead's key so a lead refresh also refreshes its emails. */
const key = (leadId: number) => [...keys.lead(leadId), 'emails'] as const;

const pending = (m: LeadEmail) => m.status === 'queued' || m.status === 'sending';

export function useLeadEmails(leadId: number, enabled = true) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: key(leadId),
    queryFn: async () => {
      const before = new Set((qc.getQueryData<LeadEmail[]>(key(leadId)) ?? []).filter(pending).map((m) => m.id));
      const items = (await api<{ items: LeadEmail[] }>(`/api/leads/${leadId}/emails`)).items;
      // A send that left (or failed) since: its lead effects ("Email sent", Contacted, the follow-up) are on the lead now.
      const still = new Set(items.filter(pending).map((m) => m.id));
      if ([...before].some((id) => !still.has(id))) void qc.invalidateQueries({ queryKey: keys.lead(leadId), exact: true });
      return items;
    },
    enabled,
    // A queued email becomes Sent within seconds: check again while any is still sending.
    refetchInterval: (q) => (q.state.data?.some(pending) ? 5000 : false),
  });
}
