
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

/** The entry in this company's supplier master (Supplier maintenance) a carrier
 *  bills as — scm.threepl_companies.supplier_id. One supplier, one carrier. */
export type ThreePLSupplierLink = { id: string; code: string; name: string };

export type ThreePLCompanyRow = {
  id: string;
  code: string | null;
  name: string;
  registrationNo: string | null;
  contactName: string | null;
  contactPhone: string | null;
  officePhone: string | null;
  email: string | null;
  address: string | null;
  postcode: string | null;
  city: string | null;
  state: string | null;
  isActive: boolean;
  notes: string | null;
  supplier: ThreePLSupplierLink | null;
  lorryCount: number;
  driverCount: number;
  helperCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type NewThreePLCompany = {
  name: string;
  registrationNo?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  officePhone?: string | null;
  email?: string | null;
  address?: string | null;
  postcode?: string | null;
  city?: string | null;
  state?: string | null;
  notes?: string | null;
  isActive?: boolean;
  supplierId?: string | null;
};

/** A carrier's own crew and lorries — read-only (GET /threepl-companies/:id/fleet).
 *  The rows are created and edited through /drivers, /helpers and /lorries, which
 *  own the "linked to a 3PL means outsource" rule. */
export type ThreePLFleet = {
  drivers: Array<{ id: string; driver_code: string; name: string; phone: string | null; ic_number: string | null; active: boolean }>;
  helpers: Array<{ id: string; helper_code: string; name: string; contact: string | null; ic_number: string | null; active: boolean }>;
  lorries: Array<{ id: string; plate: string; type: string | null; capacity_m3: number | null; length_ft: number | null; width_ft: number | null; height_ft: number | null; active: boolean }>;
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

export function useThreePLFleet(companyId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'fleet', companyId],
    queryFn: () => authedFetch<ThreePLFleet>(`/threepl-companies/${companyId}/fleet`),
    enabled: !!companyId,
    staleTime: 30_000,
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
