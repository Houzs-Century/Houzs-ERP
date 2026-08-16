// Vendored SLICE of apps/backend/src/lib/auth.tsx — only the two symbols the
// MRP page reads: isAdminLevel() (a pure role test) and useAuth() (read the
// signed-in staff so the page can gate the admin-only "Create PO" action).
//
// HOUZS VENDOR NOTE: 2990's full AuthProvider is a supabase-coupled context
// (session + staff fetch). Houzs has its own auth (auth/AuthContext) keyed on
// permission strings, not 2990 staff roles. Rather than re-mount 2990's
// provider, this shim BRIDGES to Houzs's useAuth().can('*'): an owner/admin who
// can do everything maps to the 2990 'super_admin' role, everyone else to
// 'sales' (non-admin). The MRP page only ever asks isAdminLevel(staff?.role),
// so this faithfully reproduces the gate without dragging in supabase.

import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';

// Mirror of the 2990 StaffRole union the MRP page touches. Only the two values
// the bridge can produce are meaningful here; the rest are kept so the type
// matches the source signature isAdminLevel(role: StaffRole | null | ...).
export type StaffRole =
  | 'sales' | 'showroom_lead' | 'coordinator' | 'finance' | 'admin'
  | 'sales_executive' | 'outlet_manager' | 'sales_director'
  | 'super_admin' | 'master_account';

/* Admin-level roles — anywhere the UI gated on role === 'admin', it should
   ALSO accept super_admin. (super_admin is a strict superset of admin.) */
export const isAdminLevel = (role: StaffRole | null | undefined): boolean =>
  role === 'admin' || role === 'super_admin';

/* HOUZS VENDOR — SoLineCard / MobileNewSO read isHatchSales(staff?.role) to
   decide whether a selling role may hand-type a line price. OWNER RULING
   (2026-07): a salesperson MAY set the selling price when opening an SO (it
   varies per order — roadshow / negotiated). The Houzs bridge only ever produces
   'super_admin' or 'sales', and both should price freely, so this is now true.
   Safe against the anti-tamper drift gate: only the POS cart CLIENT is
   drift-rejected server-side (isPosAppClient), and a typed price is never a
   stale cache. It is NOT a claim that the save will succeed: since 2026-08-16
   the backend persists a typed price only for a holder of `scm.so.price_authority`
   (maySetSellingPrice), and refuses a change that lowers the order total for a
   non-holder (`so_total_below_original` 422, mayReduceSoTotal) — on the ERP as
   well as on the tablet. This flag decides whether the INPUT is editable, and it
   is deliberately looser than the server. */
export const isHatchSales = (role: StaffRole | null | undefined): boolean =>
  role === 'sales' || role === 'super_admin';

export interface StaffProfile {
  /** HOUZS VENDOR — the SO PaymentsTable seeds "Collected By" from staff.id.
   *  The bridge has no 2990 staff row, so id is null and the picker shows no
   *  default collector (the verbatim empty-id fallback). */
  id: string | null;
  role: StaffRole;
  /** HOUZS VENDOR — the (Consignment)OrderNew create form reads the signed-in
   *  staff's name / code / venue to seed the locked Salesperson option + the
   *  resolved venue. The bridge has no 2990 staff row, so these are null/empty;
   *  the page's `?? null` + `|| ''` fallbacks render the verbatim empty state. */
  name?: string | null;
  staffCode?: string | null;
  venueId?: string | null;
}

/** Bridge to Houzs auth: a user who `can('*')` (owner / super-admin) maps to
 *  the 2990 'super_admin' role so isAdminLevel() returns true; everyone else
 *  reads as a non-admin role. */
export function useAuth(): { staff: StaffProfile | null } {
  const { can } = useHouzsAuth();
  const role: StaffRole = can('*') ? 'super_admin' : 'sales';
  return { staff: { id: null, role, name: null, staffCode: null, venueId: null } };
}
