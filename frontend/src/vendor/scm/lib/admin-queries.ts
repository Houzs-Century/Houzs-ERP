// Vendored SLICE of apps/backend/src/lib/admin-queries.ts — only `useStaff`,
// the single export the SO list (Salesperson column) + PaymentsTable
// (Collected By picker + default) read.
//
// HOUZS VENDOR NOTE: 2990's useStaff reads its Supabase `staff` table directly
// (supabase.from('staff')). Houzs has no client-side supabase, so this routes
// through GET /api/scm/staff (backend/src/scm/routes/staff.ts), which lists
// scm.staff rows camelCased to the StaffRow shape below. Seed sample salesperson
// rows with backend/scripts/scm-schema/seed-scm-staff-samples.mjs. Empty table →
// the endpoint returns [], so the SO list Salesperson column shows "—" and
// PaymentsTable's Collected-By select shows only "—" (the verbatim no-data
// fallbacks already in the pages).

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { getActiveCompanyId } from '../../../lib/activeCompany';

export type StaffRoleValue = 'sales' | 'showroom_lead' | 'coordinator' | 'finance' | 'admin';

export interface StaffRow {
  id: string;
  staffCode: string;
  name: string;
  role: StaffRoleValue;
  showroomId: string | null;
  venueId: string | null;
  initials: string;
  color: string;
  active: boolean;
  /* The Houzs user this staff row belongs to. Already sent by
     backend/src/scm/routes/staff.ts (STAFF_COLUMNS carries user_id, toApi maps it
     to `userId`) and simply never declared here. It is the ONLY reliable link
     between the two systems: measured on production 2026-08-12, 102 of 140
     scm.staff rows carry user_id while 18 carry an email. */
  userId: number | null;
  email: string | null;
  phone: string | null;
}

// FULL roster — every company, active AND inactive/departed. This is the id ->
// name DISPLAY source (useStaffLookup, the SO/DO/SI/consignment list Salesperson
// columns, persisted-payment "Collected By" names). It must NOT be company-scoped
// or those names blank out on historical / cross-company documents.
export const useStaff = () =>
  useQuery({
    queryKey: ['staff'],
    queryFn: async (): Promise<StaffRow[]> => {
      const res = await authedFetch<{ staff: StaffRow[] }>('/staff');
      return res.staff ?? [];
    },
    staleTime: 10 * 60_000,
  });

// COMPANY-SCOPED, active-only — the salesperson / "Collected By" SELECTION list.
// The backend (GET /staff/pickable) derives each person's company from their
// Team grants and returns only the ACTIVE company's people, closing the
// cross-company picker leak (a Houzs order could otherwise pick a 2990
// salesperson). Use this for dropdown OPTIONS; use useStaff for DISPLAY.
//
// The active company id is part of the query key so switching companies never
// serves the other company's cached list (the company-switch stale-cache trap).
// authed-fetch stamps the same id as the X-Company-Id header the backend scopes
// on; when unset (single-company Houzs) the backend degrades to the full active
// roster, so this is behaviourally unchanged there.
export const usePickableStaff = (opts?: { onlySales?: boolean }) => {
  const onlySales = opts?.onlySales === true;
  return useQuery({
    // Include the flag in the cache key so a page that asks for
    // sales-only doesn't share a cached list with one that asks for the
    // full roster (Payments' "Collected By" picker).
    queryKey: ['staff', 'pickable', getActiveCompanyId(), onlySales ? 'sales' : 'all'],
    queryFn: async (): Promise<StaffRow[]> => {
      const qs = onlySales ? '?onlySales=1' : '';
      const res = await authedFetch<{ staff: StaffRow[] }>(`/staff/pickable${qs}`);
      return res.staff ?? [];
    },
    staleTime: 10 * 60_000,
  });
};
