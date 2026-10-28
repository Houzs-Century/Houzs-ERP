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
   Safe against the anti-tamper gate: only a POS-tablet SESSION is drift-rejected
   server-side (isPosTabletCaller), and a web/mobile author's typed price is
   persisted by the backend (recomputeFromSnapshot trustOperatorSelling). */
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
 *  reads as a non-admin role.
 *
 *  `canWriteScmConfig` is the SAME "may write SCM master data" answer SO
 *  Maintenance gates on: the backend-resolved `user.scm_config_writer` (the flat
 *  `scm.config.write` perm OR the position policy's canWriteConfig flag), falling
 *  back to the flat key on an older backend that predates the field. The MRP
 *  page's "Lead Times" dialog gates on this, so a Procurement / Operation
 *  position can manage lead times without holding the '*' wildcard. */
export function useAuth(): { staff: StaffProfile | null; canWriteScmConfig: boolean } {
  const { can, user } = useHouzsAuth();
  const role: StaffRole = can('*') ? 'super_admin' : 'sales';
  const canWriteScmConfig = user?.scm_config_writer === undefined
    ? can('scm.config.write')
    : user.scm_config_writer;
  return { staff: { id: null, role, name: null, staffCode: null, venueId: null }, canWriteScmConfig };
}
