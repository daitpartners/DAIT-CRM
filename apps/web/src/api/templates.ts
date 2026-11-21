import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type TemplateLanguage = 'en' | 'es' | 'fr';

/** A team email template (release 2A), as `GET /api/email-templates` returns it. */
export type EmailTemplate = {
  id: number;
  name: string;
  language: TemplateLanguage;
  subject: string;
  body: string;
  sourceType: 'manual' | 'oft';
  fileName: string | null;
  fileSize: number | null;
  createdBy: { id: number; name: string } | null;
  createdAt: string;
  updatedAt: string;
};
export type TemplateInput = Pick<EmailTemplate, 'name' | 'language' | 'subject' | 'body'> &
  Partial<Pick<EmailTemplate, 'sourceType' | 'fileName' | 'fileSize'>>;

const KEY = ['email-templates'] as const;

/** Every template, the user's language first (the API orders them). */
export function useTemplates() {
  return useQuery({ queryKey: KEY, queryFn: async () => (await api<{ items: EmailTemplate[] }>('/api/email-templates')).items });
}

export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: number; body: TemplateInput & { updatedAt?: string } }) =>
      v.id
        ? api<EmailTemplate>(`/api/email-templates/${v.id}`, { method: 'PATCH', body: v.body })
        : api<EmailTemplate>('/api/email-templates', { method: 'POST', body: v.body }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/email-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
