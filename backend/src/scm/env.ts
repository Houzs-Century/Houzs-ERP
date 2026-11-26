import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Env as HouzsEnv } from "../types";

export type Env = HouzsEnv;

export interface Variables {
  user: User;
  supabase: SupabaseClient<any, any, any>;
  houzsUser: {
    id: number;
    email?: string;
    name?: string | null;
    position_name?: string | null;
    position_policy?: import("../services/positionPolicyRows").PositionPolicyRow | null;
    department_name?: string | null;
    role_name?: string | null;
    permissions?: string[];
    permissions_set?: Set<string>;
    position_capabilities?: string[];
  } | undefined;
  scmWriteBypassed?: boolean;
  cancelExecutionAdmitted?: boolean;
  sessionOrigin?: string;
  companyId?: number;
  companyCode?: string;
  allowedCompanyIds?: number[];
  companies?: Array<{ id: number; code: string; name: string }>;
}
