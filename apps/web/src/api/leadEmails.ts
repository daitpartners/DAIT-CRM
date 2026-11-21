import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';
import { keys } from './queries';

/** One of your own emails (release 2B-1). Nobody else's mail is ever returned. */
export type LeadEmail = {
  id: number;
  leadId: number | null;
  folder: string;
  status: 'queued' | 'sending' | 'sent' | 'failed';
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
  followUpDays: 2 | 3 | 7 | null;
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
