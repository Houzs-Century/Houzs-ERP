
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type HelperRow = {
  id: string;
  helper_code: string;
  name: string;
  contact: string | null;
  ic_number: string | null;
  in_house?: boolean;
  inHouse?: boolean;
  active: boolean;
  created_at: string;
  threepl_company_id?: string | null;
  warehouse_id?: string | null;
};

export type NewHelper = {
  threeplCompanyId?: string | null;
  helperCode?: string;
  name: string;
  contact?: string;
  icNumber?: string;
  inHouse?: boolean;
  active?: boolean;
  warehouseId?: string | null;
};

export function useHelpers(opts?: { includeInactive?: boolean }) {
  return useQuery({
    queryKey: ['helpers', opts?.includeInactive ?? false],
    queryFn: () => authedFetch<{ helpers: HelperRow[] }>(
      `/helpers${opts?.includeInactive ? '?active=false' : ''}`,
    ).then((r) => r.helpers),
    staleTime: 60_000,
  });
}

export function useCreateHelper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewHelper) =>
      authedFetch<{ helper: HelperRow }>(`/helpers`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['helpers'] }),
  });
}

export function useUpdateHelper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewHelper> & { id: string }) =>
      authedFetch<{ helper: HelperRow }>(`/helpers/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['helpers'] }),
  });
}
