import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';
import { keys } from './queries';

/**
 * An email on the lead page (release 2B-1). Your own; for Administrators and Managers (web-mail release 1) also the
 * team's lead mail, view only, with `ownerName` = whose mailbox it is (null for your own). Drafts stay with their owner.
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
export type LeadEmailSend = {
  to: string;
  cc: string[];
  subject: string;
  body: string;
  /** A formatted message's HTML (the server sanitises it again); null / absent when plain. */
  bodyHtml?: string | null;
  followUpDays: 2 | 3 | 7 | null;
  /** Release 3B: tag it with one of the company's projects. */
  projectId?: number | null;
  /** A template's files: its inline pictures go with the HTML that shows them, plus the attachments kept. */
  templateId?: number | null;
  attachmentIds?: number[];
  updatedAt: string;
};

/** Under the lead's key so a lead refresh also refreshes its emails. */
const key = (leadId: number) => [...keys.lead(leadId), 'emails'] as const;

export function useLeadEmails(leadId: number, enabled = true) {
  return useQuery({
    queryKey: key(leadId),
    queryFn: async () => (await api<{ items: LeadEmail[] }>(`/api/leads/${leadId}/emails`)).items,
    enabled,
    // A queued email becomes Sent within seconds: check again while any is still sending.
    refetchInterval: (q) => (q.state.data?.some((m) => m.status === 'queued' || m.status === 'sending') ? 5000 : false),
  });
}

export function useSendLeadEmail(leadId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LeadEmailSend) => api<LeadEmail>(`/api/leads/${leadId}/emails`, { method: 'POST', body }),
    // The lead changed too (timeline entry, follow-up, updatedAt).
    onSettled: () => qc.invalidateQueries({ queryKey: keys.lead(leadId) }),
    // The mailbox was disconnected or put in error since the page loaded: refresh it so the form shows the connect note.
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'no_mailbox') void qc.invalidateQueries({ queryKey: ['mailboxes'] });
    },
  });
}
