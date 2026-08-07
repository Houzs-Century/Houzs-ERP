// ----------------------------------------------------------------------------
// /api/sync/autocount-so-writeback — ERP-side half of the ERP -> AutoCount Sales
// Order write-back. The iNiState `syncSalesOrder` Logic job polls /pending, uses
// the AutoCount SDK to create each SO (and provision any missing master), then
// POSTs /ack so we never re-offer it.
//
// The ON/OFF switch lives on THIS (ERP) side: scm.sync_config key
// 'so_writeback_enabled'. Fail-CLOSED — a missing table/row or any value other
// than 'true' means OFF, and /pending returns nothing. Flip it from the ERP
// (PUT /enabled) — no server / UltraViewer access needed to turn it on or off.
//
// AUTH: the same static shared secret as the other sync receivers
// (x-sync-secret == env.SYNC_SECRET), fail-closed when unset. Mounted PRE-AUTH
// in src/index.ts, above the /api/* staff-session gate, because the caller is an
// automation agent with no Supabase JWT.
//
// See docs/erp-to-autocount-so-writeback.md for the field mapping + iNiState job.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../../types";
import { getSupabaseService } from "../../db/supabase";
import { mirrorAuthed } from "../lib/mirror-map";
import {
  composeAutoCountSalesOrder,
  makeItemCodeResolver,
  type ErpSoHeader,
  type ErpSoItem,
  type BindingRow,
} from "../../services/autocount-so-writeback";

export const autocountSoWriteback = new Hono<{ Bindings: Env }>();

const COMPANY_ID = 1; // Houzs Century — the one AutoCount account book. 2990 excluded.
const FLAG_KEY = "so_writeback_enabled";

type Sb = ReturnType<typeof getSupabaseService>;

/** Fail-closed read of the ERP-side ON/OFF switch. */
async function writebackEnabled(sb: Sb): Promise<boolean> {
  const { data, error } = await sb
    .from("sync_config")
    .select("v")
    .eq("k", FLAG_KEY)
    .maybeSingle();
  if (error) return false;
  return (data as { v?: string } | null)?.v === "true";
}

// GET /enabled — current switch state.
autocountSoWriteback.get("/enabled", async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json({ enabled: await writebackEnabled(getSupabaseService(c.env)) });
});

// PUT /enabled { enabled: boolean } — flip the switch from the ERP side.
autocountSoWriteback.put("/enabled", async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
  const v = body.enabled === true ? "true" : "false";
  const sb = getSupabaseService(c.env);
  const { error } = await sb
    .from("sync_config")
    .upsert({ k: FLAG_KEY, v, updated_at: new Date().toISOString() }, { onConflict: "k" });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true, enabled: v === "true" });
});

// GET /pending?limit=N — SOs to write, composed into the AutoCount payload +
// the masters to provision first. Returns nothing when the switch is OFF.
autocountSoWriteback.get("/pending", async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const sb = getSupabaseService(c.env);
  if (!(await writebackEnabled(sb))) return c.json({ enabled: false, pending: [] });

  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 100);

  const { data: syncedRows } = await sb.from("autocount_so_synced").select("doc_no");
  const synced = new Set(((syncedRows ?? []) as { doc_no: string }[]).map((r) => r.doc_no));

  const { data: soRows, error: soErr } = await sb
    .from("mfg_sales_orders")
    .select(
      "doc_no,so_date,debtor_name,agent,sales_location,branding,venue,address1,address2,address3,address4,phone,ref,po_doc_no,remark2,balance_centi",
    )
    .eq("company_id", COMPANY_ID)
    .order("so_date", { ascending: true })
    .limit(limit + synced.size);
  if (soErr) return c.json({ error: soErr.message }, 500);

  const pendingSos = ((soRows ?? []) as Record<string, unknown>[])
    .filter((r) => !synced.has(String(r.doc_no)))
    .slice(0, limit);

  // Bindings loaded once; the resolver stays DB-free (composer contract).
  const { data: bindRows } = await sb
    .from("supplier_material_bindings")
    .select("material_code,supplier_sku")
    .eq("company_id", COMPANY_ID)
    .eq("material_kind", "mfg_product");
  const bindings = new Map<string, BindingRow>();
  for (const b of (bindRows ?? []) as { material_code: string; supplier_sku: string | null }[]) {
    const sku = b.supplier_sku?.trim();
    if (sku) bindings.set(b.material_code, { supplierSku: sku, mainSupplierCode: null });
  }
  const resolver = makeItemCodeResolver(bindings);

  const pending: Array<Awaited<ReturnType<typeof composeAutoCountSalesOrder>>> = [];
  for (const so of pendingSos) {
    const { data: itemRows } = await sb
      .from("mfg_sales_order_items")
      .select("item_code,description,qty,unit_price_centi,variants")
      .eq("company_id", COMPANY_ID)
      .eq("doc_no", String(so.doc_no));

    const header: ErpSoHeader = {
      doc_no: String(so.doc_no),
      so_date: (so.so_date as string) ?? null,
      debtor_name: (so.debtor_name as string) ?? null,
      agent: (so.agent as string) ?? null,
      sales_location: (so.sales_location as string) ?? null,
      branding: (so.branding as string) ?? null,
      venue: (so.venue as string) ?? null,
      address1: (so.address1 as string) ?? null,
      address2: (so.address2 as string) ?? null,
      address3: (so.address3 as string) ?? null,
      address4: (so.address4 as string) ?? null,
      phone: (so.phone as string) ?? null,
      ref: (so.ref as string) ?? null,
      po_doc_no: (so.po_doc_no as string) ?? null,
      remark2: (so.remark2 as string) ?? null,
      line_delivery_date: null,
      balance_centi: (so.balance_centi as number) ?? null,
    };

    const items: ErpSoItem[] = ((itemRows ?? []) as Record<string, unknown>[]).map((it) => ({
      item_code: String(it.item_code ?? ""),
      item_group: null,
      description: (it.description as string) ?? null,
      description2: null,
      uom: null,
      qty: Number(it.qty) || 0,
      unit_price_centi: Number(it.unit_price_centi) || 0,
      variants: (it.variants as Record<string, unknown> | null) ?? null,
    }));

    pending.push(await composeAutoCountSalesOrder(header, items, resolver));
  }

  return c.json({ enabled: true, pending });
});

// POST /ack { synced: [{ doc_no, ac_docno? }] } — mark SOs written so they are
// not re-offered. Idempotent.
autocountSoWriteback.post("/ack", async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { synced?: unknown };
  const list = Array.isArray(body.synced) ? (body.synced as Record<string, unknown>[]) : [];
  const rows = list
    .filter((s) => s && s.doc_no)
    .map((s) => ({
      doc_no: String(s.doc_no),
      ac_docno: s.ac_docno != null ? String(s.ac_docno) : null,
      synced_at: new Date().toISOString(),
    }));
  if (!rows.length) return c.json({ ok: true, acked: 0 });
  const sb = getSupabaseService(c.env);
  const { error } = await sb.from("autocount_so_synced").upsert(rows, { onConflict: "doc_no" });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true, acked: rows.length });
});
