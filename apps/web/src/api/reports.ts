import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export type Reports = {
  bySource: { source: string; count: number }[];
  enquiries: { received: number; spamBlocked: number; leadsCreated: number; awaitingReview: number; matchedExisting: number };
};

/** The Reports page (prototype app.js reports()). */
export function useReports() {
  return useQuery({ queryKey: ['reports'], queryFn: () => api<Reports>('/api/reports') });
}
