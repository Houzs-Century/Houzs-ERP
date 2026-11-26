
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export interface FabricLibrary {
  id: string;
  label: string;
  tier: string;
  defaultSurcharge: number;
  active: boolean;
  sortOrder: number;
}

const LIBRARY_OPTS = { staleTime: Infinity, gcTime: Infinity };

export const useFabricLibrary = () =>
  useQuery({
    queryKey: ['library', 'fabrics'],
    queryFn: async (): Promise<FabricLibrary[]> => {
      const res = await authedFetch<{ fabrics: FabricLibrary[] }>('/fabric-library');
      return res.fabrics ?? [];
    },
    ...LIBRARY_OPTS,
  });
