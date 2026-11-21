import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LocationCreate, LocationUpdate } from '@dait-crm/shared';
import { api } from './client';
import { keys } from './queries';

/** A row in `GET /api/companies/:id/locations` (Headquarters first). */
export type LocationSummary = {
  id: number;
  companyId: number;
  name: string;
  locationType: string;
  country: string;
  state: string | null;
  city: string | null;
  street: string | null;
  zip: string | null;
  timezone: string | null;
  lat: number | null;
  lng: number | null;
  mapsUrl: string | null;
  phone: string | null;
  isVerified: boolean;
  source: string;
  updatedAt: string;
};

export function useLocations(companyId: number) {
  return useQuery({
    queryKey: keys.locations(companyId),
    queryFn: async () => (await api<{ items: LocationSummary[] }>(`/api/companies/${companyId}/locations`)).items,
    enabled: Number.isInteger(companyId),
  });
}

/** Create (no `id`) or update a location of `companyId`. */
export function useSaveLocation(companyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: number; body: LocationCreate | LocationUpdate }) =>
      v.id
        ? api<LocationSummary>(`/api/companies/${companyId}/locations/${v.id}`, { method: 'PATCH', body: v.body })
        : api<LocationSummary>(`/api/companies/${companyId}/locations`, { method: 'POST', body: v.body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.locations(companyId) }),
  });
}

export function useDeleteLocation(companyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/companies/${companyId}/locations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.locations(companyId) }),
  });
}
