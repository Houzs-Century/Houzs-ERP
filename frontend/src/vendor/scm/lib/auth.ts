
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';

export type StaffRole =
  | 'sales' | 'showroom_lead' | 'coordinator' | 'finance' | 'admin'
  | 'sales_executive' | 'outlet_manager' | 'sales_director'
  | 'super_admin' | 'master_account';

export const isAdminLevel = (role: StaffRole | null | undefined): boolean =>
  role === 'admin' || role === 'super_admin';

export const isHatchSales = (role: StaffRole | null | undefined): boolean =>
  role === 'sales' || role === 'super_admin';

export interface StaffProfile {
  id: string | null;
  role: StaffRole;
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
