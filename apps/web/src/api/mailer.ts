import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { keys } from './queries';

/** A selected lead as the Mailer sees it (release 2C). */
export type RecipientCheck = {
  leadId: number;
  leadNumber: string | null;
  contactId: number | null;
  to: string;
  name: string;
  company: string;
  block: string | null;
  zones: string[];
  source: 'company' | 'address' | 'country' | 'sender';
};

export type CampaignStatus = 'Scheduled' | 'Sending' | 'Paused' | 'Completed' | 'Cancelled';
export type CampaignStats = { total: number; queued: number; sending: number; sent: number; failed: number; skipped: number; toSend: number; replied: number };

export type CampaignSummary = {
  id: number;
  number: string;
  name: string;
  templateName: string;
  sender: { id: number; name: string };
  status: CampaignStatus;
  pauseReason: string | null;
  waitReason: 'working_hours' | 'daily_limit' | null;
  startAt: string | null;
  nextSendAt: string | null;
  createdAt: string;
  completedAt: string | null;
  intervalMinutes: number;
  workingHoursOnly: boolean;
  stats: CampaignStats;
  next: string | null;
};

export type CampaignDetail = CampaignSummary & {
  templateUpdatedAt: string | null;
  subject: string;
  body: string;
  senderAddress: string;
  cc: string[];
  bcc: string[];
  unsubscribeLine: boolean;
  lawfulBasis: string;
  isSender: boolean;
  recipients: {
    id: number;
    leadId: number | null;
    leadNumber: string | null;
    name: string;
    company: string;
    to: string;
    status: 'Queued' | 'Sending' | 'Sent' | 'Failed' | 'Skipped' | 'Replied';
    sentAt: string | null;
    error: string | null;
    timezones: string[];
    timezoneSource: RecipientCheck['source'];
  }[];
};

export type CampaignCreate = {
  leadIds: number[];
  name: string;
  templateId: number;
  cc: string[];
  bcc: string[];
  startAt: string | null;
  intervalMinutes: number;
  workingHoursOnly: boolean;
  unsubscribeLine: boolean;
  lawfulBasis: string;
};

const ROOT = ['mailer'] as const;
const live = (s: CampaignStatus) => s === 'Sending' || s === 'Scheduled';

export function useMailerCheck() {
  return useMutation({
    mutationFn: (leadIds: number[]) => api<{ mailbox: { address: string } | null; rows: RecipientCheck[] }>('/api/mailer/check', { method: 'POST', body: { leadIds } }),
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CampaignCreate) => api<CampaignDetail>('/api/mailer', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ROOT });
      void qc.invalidateQueries({ queryKey: keys.navCounts });
    },
  });
}

export function useCampaigns() {
  return useQuery({
    queryKey: [...ROOT, 'list'],
    queryFn: async () => (await api<{ items: CampaignSummary[] }>('/api/mailer')).items,
    refetchInterval: (q) => (q.state.data?.some((c) => live(c.status)) ? 15_000 : false),
  });
}

export function useCampaign(id: number) {
  return useQuery({
    queryKey: [...ROOT, 'detail', id],
    queryFn: () => api<CampaignDetail>(`/api/mailer/${id}`),
    refetchInterval: (q) => (q.state.data && live(q.state.data.status) ? 15_000 : false),
  });
}

export function useCampaignAction(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'start' | 'cancel') => api<CampaignDetail>(`/api/mailer/${id}/${action}`, { method: 'POST' }),
    onSuccess: (data) => {
      qc.setQueryData([...ROOT, 'detail', id], data);
      void qc.invalidateQueries({ queryKey: [...ROOT, 'list'] });
      void qc.invalidateQueries({ queryKey: keys.navCounts });
    },
  });
}

/** Release 2C: Do not email on a lead (the Mailer skips it). */
export function useDoNotEmail(leadId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { doNotEmail: boolean; updatedAt: string }) => api<unknown>(`/api/leads/${leadId}/do-not-email`, { method: 'POST', body: v }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.lead(leadId) }),
  });
}
