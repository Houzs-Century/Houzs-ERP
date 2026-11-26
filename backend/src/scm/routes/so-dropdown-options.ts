
import { Hono } from "hono";
import { z } from "zod";
import { isCorePaymentMethodRow } from "../shared/payment-methods";
import { supabaseAuth } from "../middleware/auth";
import { scopeToCompany, activeCompanyId,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from "../lib/companyScope";
import type { Env, Variables } from "../env";

export const soDropdownOptions = new Hono<{ Bindings: Env; Variables: Variables }>();

soDropdownOptions.use("*", supabaseAuth);

const PAYMENT_METHOD_LOCK_REASON =
  "Payment methods are a locked set — they are wired to order logic (POS " +
  "handover cards, deposit ledger, payments cascade). Rename or reorder them " +
  "anytime; they cannot be added to, removed, or turned off. Four rows are " +
  "protected: Merchant, Online and Cash, plus the deactivated Installment row " +
  "that historical payments still point at.";

const CATEGORIES = [
  "customer_type",
  "building_type",
  "relationship",
  "payment_method",
  "payment_merchant",
  "online_type",
  "installment_plan",
  "venue",
] as const;
type Category = (typeof CATEGORIES)[number];
const categoryEnum = z.enum(CATEGORIES);

const createSchema = z.object({
  category: categoryEnum,
  value: z.string().trim().min(1),
  label: z.string().trim().min(1),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

const updateSchema = z.object({
  value: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

type DbRow = {
  id: string;
  category: string;
  value: string;
  label: string;
  sort_order: number;
  active: boolean;
};

const toApi = (row: Record<string, unknown>) => ({
  id: row.id as string,
  category: row.category as string,
  value: row.value as string,
  label: row.label as string,
  sortOrder: (row.sortOrder ?? row.sort_order ?? 0) as number,
  active: (row.active ?? true) as boolean,
});

soDropdownOptions.get("/", async (c) => {
  const categoryParam = c.req.query("category");
  const includeInactiveParam = c.req.query("includeInactive");
  const includeInactive = includeInactiveParam === "1" || includeInactiveParam === "true";

  const sb = c.get("supabase");

  if (categoryParam) {
    const parsed = categoryEnum.safeParse(categoryParam);
    if (!parsed.success) return c.json({ error: "invalid_category" }, 400);
    let q = sb
      .from("so_dropdown_options")
      .select("id, category, value, label, sort_order, active")
      .eq("category", parsed.data)
      .order("sort_order", { ascending: true })
      .order("label", { ascending: true });
    if (!includeInactive) q = q.eq("active", true);
    q = scopeToCompany(q, c);
    const { data, error } = await q;
    if (error) {
      if (/relation .* does not exist/i.test(error.message)) return c.json({ options: [] });
      return c.json({ error: "fetch_failed", reason: error.message }, 500);
    }
    return c.json({ options: (data ?? []).map((r) => toApi(r as Record<string, unknown>)) });
  }

  let allQ = sb
    .from("so_dropdown_options")
    .select("id, category, value, label, sort_order, active")
    .order("category", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });
  if (!includeInactive) allQ = allQ.eq("active", true);
  allQ = scopeToCompany(allQ, c);
  const { data, error } = await allQ;

  const grouped: Record<Category, ReturnType<typeof toApi>[]> = {
    customer_type: [],
    building_type: [],
    relationship: [],
    payment_method: [],
    payment_merchant: [],
    online_type: [],
    installment_plan: [],
    venue: [],
  };
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) return c.json({ options: grouped });
    return c.json({ error: "fetch_failed", reason: error.message }, 500);
  }
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const cat = r.category as string;
    if ((CATEGORIES as readonly string[]).includes(cat)) {
      grouped[cat as Category].push(toApi(r));
    }
  }
  return c.json({ options: grouped });
});

soDropdownOptions.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  if (parsed.data.category === "payment_method") {
    return c.json({ error: "payment_method_locked", reason: PAYMENT_METHOD_LOCK_REASON }, 409);
  }

  const sb = c.get("supabase");
  const { data, error } = await sb
    .from("so_dropdown_options")
    .insert({
      company_id: activeCompanyId(c),
      category: parsed.data.category,
      value: parsed.data.value,
      label: parsed.data.label,
      sort_order: parsed.data.sortOrder ?? 0,
      active: parsed.data.active ?? true,
    })
    .select("id, category, value, label, sort_order, active")
    .single();
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      return c.json(
        { error: "duplicate_value", reason: "A row with this (category, value) already exists." },
        409,
      );
    }
    return c.json({ error: "insert_failed", reason: error.message }, 500);
  }
  return c.json({ option: toApi(data as Record<string, unknown>) });
});

soDropdownOptions.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const patch: Record<string, unknown> = {};
  if (parsed.data.value !== undefined) patch.value = parsed.data.value;
  if (parsed.data.label !== undefined) patch.label = parsed.data.label;
  if (parsed.data.sortOrder !== undefined) patch.sort_order = parsed.data.sortOrder;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  if (Object.keys(patch).length === 0) return c.json({ ok: true, changed: 0 });

  const sb = c.get("supabase");
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: existing } = await scopeToCompanyId(sb
    .from("so_dropdown_options")
    .select("category, value")
    .eq("id", id), co.companyId)
    .maybeSingle();
  if (!existing) return c.json(NOT_THIS_COMPANY, 404);
  const existingRow = existing as Record<string, unknown>;
  if (isCorePaymentMethodRow(existingRow.category as string, existingRow.value as string)) {
    const valueChanged =
      parsed.data.value !== undefined && parsed.data.value !== (existingRow.value as string);
    if (valueChanged || parsed.data.active === false) {
      return c.json({ error: "payment_method_locked", reason: PAYMENT_METHOD_LOCK_REASON }, 409);
    }
  }

  const { data, error } = await scopeToCompanyId(sb
    .from("so_dropdown_options")
    .update(patch)
    .eq("id", id), co.companyId)
    .select("id, category, value, label, sort_order, active")
    .maybeSingle();
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      return c.json(
        { error: "duplicate_value", reason: "A row with this (category, value) already exists." },
        409,
      );
    }
    return c.json({ error: "update_failed", reason: error.message }, 500);
  }
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ option: toApi(data as Record<string, unknown>) });
});

soDropdownOptions.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const sb = c.get("supabase");
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: existing } = await scopeToCompanyId(sb
    .from("so_dropdown_options")
    .select("category, value")
    .eq("id", id), co.companyId)
    .maybeSingle();
  if (!existing) return c.json(NOT_THIS_COMPANY, 404);
  const existingRow = existing as Record<string, unknown>;
  if (isCorePaymentMethodRow(existingRow.category as string, existingRow.value as string)) {
    return c.json({ error: "payment_method_locked", reason: PAYMENT_METHOD_LOCK_REASON }, 409);
  }

  const { error } = await scopeToCompanyId(sb.from("so_dropdown_options").delete().eq("id", id), co.companyId);
  if (error) return c.json({ error: "delete_failed", reason: error.message }, 500);
  return c.json({ ok: true });
});

export default soDropdownOptions;
