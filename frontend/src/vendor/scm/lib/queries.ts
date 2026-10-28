// Vendored SLICE of apps/backend/src/lib/queries.ts — only useFabricLibrary,
// the sole export the ProductModelDetail page reads (for the SOFA fabric-picker
// checklist that drives allowed_options.fabrics).
//
// HOUZS VENDOR — the source hook read the `fabric_library` table DIRECTLY via the
// supabase client (a POS-side colour-library read). Houzs has no client-side
// supabase, so this routes through GET /api/scm/fabric-library
// (backend/src/scm/routes/fabric-library.ts), which lists all rows (incl.
// inactive so admin can re-enable) camelCased to the FabricLibrary shape. Empty
// table → endpoint returns [], so the SOFA "fabrics offered" checklist renders
// with no options. Seed sample rows with seed-fabric-library.mjs.

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

// All fabrics (incl. inactive) so admin can re-enable.
export const useFabricLibrary = () =>
  useQuery({
    queryKey: ['library', 'fabrics'],
    queryFn: async (): Promise<FabricLibrary[]> => {
      const res = await authedFetch<{ fabrics: FabricLibrary[] }>('/fabric-library');
      return res.fabrics ?? [];
    },
    ...LIBRARY_OPTS,
  });
