import type { PositionPolicyRow } from "../../services/positionPolicyRows";
import { createMiddleware } from "hono/factory";
import type { User } from "@supabase/supabase-js";
import type { Env, Variables } from "../env";
import { getSupabaseService } from "../../db/supabase";

// global /api/* middleware (Houzs session auth, mounted in index.ts), so this
export const SCM_SYSTEM_STAFF_ID = "00000000-0000-4000-8000-000000000001";

export const supabaseAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    if ((c.get("user") as { id?: unknown } | undefined)?.id === SCM_SYSTEM_STAFF_ID) {
      return next();
    }
    const hu = c.get("user") as unknown as {
      id?: number | string;
      email?: string;
      name?: string | null;
      role_name?: string | null;
      position_name?: string | null;
      department_name?: string | null;
      permissions?: string[];
      permissions_set?: Set<string>;
      position_capabilities?: string[];
      position_policy?: PositionPolicyRow | null;
    } | undefined;
    c.set(
      "houzsUser",
      hu && hu.id != null
        ? {
            id: Number(hu.id),
            email: hu.email,
            name: hu.name ?? null,
            position_name: hu.position_name ?? null,
            department_name: hu.department_name ?? null,
            role_name: hu.role_name ?? null,
            permissions: hu.permissions,
            permissions_set: hu.permissions_set,
            position_capabilities: hu.position_capabilities,
            position_policy: hu.position_policy ?? null,
          }
        : undefined,
    );
    c.set("user", {
      id: SCM_SYSTEM_STAFF_ID,
      email: hu?.email ?? "",
      app_metadata: {},
      user_metadata: { name: hu?.name ?? hu?.email ?? undefined },
      aud: "authenticated",
      created_at: "",
    } as unknown as User);
    c.set("supabase", getSupabaseService(c.env));
    await next();
  },
);
