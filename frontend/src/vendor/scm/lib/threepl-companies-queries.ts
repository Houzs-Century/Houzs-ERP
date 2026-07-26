// 3PL carrier COMPANY master hooks (WS4a) — the owner-maintained list of 3PL
// vendors. A 3PL is a company that owns several lorries; a solo operator is a
// one-lorry company. Backed by scm.threepl_companies (mig 0210) via
// /api/scm/threepl-companies. Lorries attach to a company through
// scm.lorries.threepl_company_id (set from the lorry drawer).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type ThreePLCompanyRow = {
  id: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  isActive: boolean;
  notes: string | null;
  lorryCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type NewThreePLCompany = {
  name: string;
  contactName?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
  isActive?: boolean;
};

export type ThreePLCompanyPatch = Partial<NewThreePLCompany> & { id: string };

const KEY = ['threepl-companies'] as const;

export function useThreePLCompanies() {
  return useQuery({
    queryKey: KEY,
    queryFn: () =>
      authedFetch<{ companies: ThreePLCompanyRow[] }>('/threepl-companies').then((r) => r.companies),
    staleTime: 60_000,
  });
}

export function useCreateThreePLCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewThreePLCompany) =>
      authedFetch<{ company: ThreePLCompanyRow }>('/threepl-companies', {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateThreePLCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ThreePLCompanyPatch) =>
      authedFetch<{ company: ThreePLCompanyRow }>(`/threepl-companies/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteThreePLCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/threepl-companies/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
