// ----------------------------------------------------------------------------
// so-dropdown-options — SO Maintenance picklists (scm.so_dropdown_options).
// Ported from 2990's apps/api/src/routes/so-dropdown-options.ts (Task #118).
//
// One generic table keyed by category backs the SO Maintenance page's
// mini-tables (customer_type / building_type / relationship / payment_method /
// payment_merchant / online_type / installment_plan / venue). See the seed in
// scripts/scm-schema/seed-scm-reference-data.sql (2990 migrations 0081/0083/0156).
//
// Endpoints (mirror 2990 so vendored pages call them with just an /api/scm prefix):
//   GET    /                        — all categories grouped, ACTIVE rows:
//                                       { customer_type: [...], building_type: [...], ... }
//                                     This is what the order forms read: one
//                                     request instead of one per dropdown.
//   GET    /?includeInactive=1      — as above plus deactivated rows (the
//                                     Maintenance page, which flips them back on).
//   GET    /?category=customer_type — active rows for one category, by sort_order
//   POST   /                        — create an option (payment_method locked)
//   PATCH  /:id                     — update value/label/sortOrder/active
//   DELETE /:id                     — hard delete (core payment_method rows locked)
//
// HOUZS VENDOR: isCorePaymentMethodRow is imported from the vendored
// scm/shared/payment-methods.ts (2990 imports it from @2990s/shared). The route
// degrades to empty groups when the relation is missing (parity with the other
// ported reference routes — localities/staff/fabric-colours).
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { isCorePaymentMethodRow } from "../shared/payment-methods";
import { supabaseAuth } from "../middleware/auth";
import { scopeToCompany, activeCompanyId,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from "../lib/companyScope";
import type { Env, Variables } from "../env";

export const soDropdownOptions = new Hono<{ Bindings: Env; Variables: Variables }>();

soDropdownOptions.use("*", supabaseAuth);

/* payment_method is a LOCKED set. The three SELECTABLE rows (Merchant / Online
   / Cash) drive branch logic end-to-end (POS handover cards, the deposit
   ledger, the payments cascade). Rename/reorder is fine; add, delete,
   deactivate, or VALUE edit is refused.

   'Installment' is no longer a selectable L1 method — mig 0037 deactivated it,
   and an EPP receipt is Merchant plus an installment_plan tenure. It IS still
   protected: this comment used to say it was "intentionally unprotected and may
   be deactivated", which stopped being true on 2026-08-13 when
   PAYMENT_METHOD_CORE_VALUES went back to four so the row historical payments
   point at cannot be deleted. So: three choosable, four protected.

   This gate is the backstop for direct API calls. */
/* Says what it ENFORCES. It said "a fixed set of three" while
   PAYMENT_METHOD_CORE_VALUES — the list this gate actually consults — has held
   FOUR since 2026-08-13, when Installment was re-locked (payment-methods.ts has
   that trace). Three is how many an operator can CHOOSE; four is how many rows
   are protected from deletion, because the deactivated Installment row still
   backs historical payments. A refusal message that miscounts the thing it is
   refusing is how the operator learns to distrust the message. */
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
  // Method is a 3-step cascade: Method -> (Merchant bank + installment plan |
  // Online sub-type | Cash). Each level is editable here.
  "payment_merchant",
  "online_type",
  "installment_plan",
  // SO Venue picklist.
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

// Dual-read camelCase ?? snake_case — the PostgREST driver may camelCase result
// columns; cover both so we never read undefined.
const toApi = (row: Record<string, unknown>) => ({
  id: row.id as string,
  category: row.category as string,
  value: row.value as string,
  label: row.label as string,
  sortOrder: (row.sortOrder ?? row.sort_order ?? 0) as number,
  active: (row.active ?? true) as boolean,
});

// GET — either single-category list or all-categories grouped.
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
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    const { data, error } = await q;
    if (error) {
      if (/relation .* does not exist/i.test(error.message)) return c.json({ options: [] });
      return c.json({ error: "fetch_failed", reason: error.message }, 500);
    }
    return c.json({ options: (data ?? []).map((r) => toApi(r as Record<string, unknown>)) });
  }

  // All categories grouped.
  //
  // `includeInactive` now means the SAME thing on BOTH branches: default
  // active-only, opt in for the rest. It previously defaulted to "every row" here
  // and "active only" above, so the two branches answered different questions and
  // the grouped form could not be used to serve an order form — an option the
  // maintenance page had deactivated would have come straight back into the SO
  // dropdowns. The maintenance page is the one caller that wants inactive rows
  // (to flip `active` back on) and it now asks for them: useAllSoDropdownOptions
  // sends includeInactive=1. (perf/so-waterfall, 2026-07-17 — this is what lets
  // ONE grouped request replace the 3-7 per-category requests every SO/DO/CN form
  // was firing.)
  let allQ = sb
    .from("so_dropdown_options")
    .select("id, category, value, label, sort_order, active")
    .order("category", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });
  if (!includeInactive) allQ = allQ.eq("active", true);
  allQ = scopeToCompany(allQ, c); // multi-company: isolate to the active company
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

// POST / — create a new option.
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
      company_id: activeCompanyId(c), // multi-company: stamp the active company
      category: parsed.data.category,
      value: parsed.data.value,
      label: parsed.data.label,
      sort_order: parsed.data.sortOrder ?? 0,
      active: parsed.data.active ?? true,
    })
    .select("id, category, value, label, sort_order, active")
    .single();
  if (error) {
    // 23505 = unique_violation (category, value)
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

// PATCH /:id — update fields.
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
  // Multi-company: scope the lookup AND the write to the active company so a
  // blind id from another company is not found (and can't be re-labelled).
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  /* Locked-set gate — look the row up first so we know its category+value.
     Core payment_method rows accept label / sortOrder / active=true only. */
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

// DELETE /:id — hard delete (core payment_method rows can never be deleted).
soDropdownOptions.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const sb = c.get("supabase");
  // Multi-company: scope the lookup AND the delete to the active company.
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
