import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SignatureUpdate } from '@dait-crm/shared';
import { api } from './client';

/** The signed-in user's email signature (web-mail release 3): sanitised HTML (null: none) and Add automatically. */
export type Signature = { html: string | null; auto: boolean };

const KEY = ['me', 'signature'] as const;

export function useSignature() {
  return useQuery({ queryKey: KEY, queryFn: () => api<Signature>('/api/me/signature') });
}

/** Saves the signature; the answer (as the server sanitised it) becomes the cached one. */
export function useSaveSignature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SignatureUpdate) => api<Signature>('/api/me/signature', { method: 'PUT', body }),
    onSuccess: (saved) => qc.setQueryData(KEY, saved),
  });
}
