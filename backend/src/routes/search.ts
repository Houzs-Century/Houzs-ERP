import { Hono } from "hono";
import type { Env } from "../types";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { escapeForOr, phoneSearchOrParts } from "../scm/lib/postgrest-search";
import { normalizePhone } from "../scm/shared/phone";
import {
  activeCompanySql,
  allowedCompaniesSql,
  scopeToCompany,
  type CompanyScopeCtx,
} from "../scm/lib/companyScope";
// The ONE definition of ASSR's company scope — see the note above its use below.
import { assrCompanySql } from "./assr";
import { inArm, poIdsForSoDocNos, soDocNosByRef } from "../scm/lib/so-ref-search";
import { initialsLikes } from "../services/projects";
import { scmAreaReadable } from "../scm/middleware/area-guard";
import type { AuthUser } from "../services/auth";
import { NOTE_KIND_WORD } from "../acc/credit-notes";

/** Each word on its own, in any field, as the project list searches ("mle sccc"). */
function projectWordSearch(q: string): { sql: string; binds: string[] } {
  const binds: string[] = [];
  const arm = (like: string, cols: string[]) => cols.map((col) => { binds.push(like); return `${col} LIKE ?${binds.length}`; });
  const arms = q.trim().split(/\s+/).filter(Boolean).flatMap((word) => {
    const like = searchPattern(word);
    if (like === null) return [];
    return [`(${[...arm(like, ["code", "name", "venue", "organizer", "brand"]), ...initialsLikes(word).flatMap((p) => arm(p, ["venue"]))].join(" OR ")})`];
  });
  return { sql: arms.join(" AND "), binds };
}

/**
 * Global search across the workspace.
 *
 *   GET /api/search?q=<term>
 *
 * Returns up to N matches per source, grouped by type. Designed for
 * the frontend Cmd+K palette (desktop) AND the mobile search palette —
 * the result shape stays uniform so both UIs can render a flat list
 * with type chips and bold the matched keyword.
 *
 * Sources:
 *   - project          (public.projects)              — env.DB
 *   - assr_case        (public.assr_cases)            — env.DB
 *   - user             (public.users)                 — env.DB
 *   - sales_order      (scm.mfg_sales_orders)         — Supabase (scm schema)
 *   - product          (scm.mfg_products)             — Supabase (scm schema)
 *   - purchase_order   (scm.purchase_orders)          — Supabase (scm schema)
 *   - grn              (scm.grns)                      — Supabase (scm schema)
 *   - delivery_order   (scm.delivery_orders)          — Supabase (scm schema)
 *   - sales_invoice    (scm.sales_invoices)           — Supabase (scm schema)
 *   - purchase_invoice (scm.purchase_invoices)        — Supabase (scm schema)
 *   - supplier         (scm.suppliers)                — only if the caller can open Suppliers
 *   - customer         (scm.acc_debtors)              — Finance's customer master (Other Debtors)
 *   - credit_note      (scm.acc_credit_notes)         — credit / debit notes
 *   - receipt          (scm.acc_receipts + acc_debtor_receipts)
 *   - delivery_return  (scm.delivery_returns)
 *   - payment_voucher  (scm.payment_vouchers)
 *   The last five need Finance / Sales Returns area access — see MASTER_AREA.
 *
 * The public-schema sources use LIKE (rewritten to ILIKE + Postgres `$n`
 * by the d1-compat shim). The scm-schema sources talk to the SAME
 * Supabase over PostgREST via getSupabaseService (db.schema='scm').
 *
 * SCM sources are wrapped in a guarded helper: if the Supabase keys are
 * unset (tests / local) or PostgREST hiccups, we return the public-schema
 * hits we DO have rather than 500-ing the whole search. Existing search
 * behaviour is therefore never broken by the SCM additions.
 *
 * That degradation is REPORTED, never silent. Every source that fails is named
 * in `degraded`, and both palettes say so instead of rendering "No matches" —
 * a search that could not read a table must never look like a table with
 * nothing in it. (Hookka hit the same class from the other direction: a
 * timed-out global search rendered "No results" and an existing order looked
 * deleted. Their fix was the same principle — an honest error state distinct
 * from an empty one.)
 *
 * Auth: gated by the global /api/* auth middleware (mounted in
 * src/index.ts). COMPANY scoping IS enforced per source (see the scoping block
 * in the handler) — that is the multi-company isolation boundary. ROW-LEVEL
 * PERMISSION scoping (PIC / brand / salesperson visibility) is intentionally
 * loose: search shows match metadata only (no full record contents), and
 * follow-up navigation hits the relevant module, which enforces its own perms.
 */

const app = new Hono<{ Bindings: Env }>();

const PER_SOURCE_LIMIT = 6;

type HitType =
  | "project"
  | "assr_case"
  | "user"
  | "sales_order"
  | "product"
  | "purchase_order"
  | "grn"
  | "delivery_order"
  | "sales_invoice"
  | "purchase_invoice"
  | "supplier"
  | "customer"
  | "credit_note"
  | "receipt"
  | "delivery_return"
  | "payment_voucher";

/* The six sources added 2026-11-10 are offered only to a caller who could OPEN
   the result: each is the area its own router is guarded by in scm/index.ts.
   The older ten predate this and stay as they were (metadata only; the module
   they open enforces its own gate). */
const AREA_OF = {
  supplier: "scm.procurement.suppliers",
  customer: "scm.finance.accounting",
  credit_note: "scm.finance.accounting",
  receipt: "scm.finance.accounting",
  delivery_return: "scm.sales.returns",
  payment_voucher: "scm.finance.accounting",
} as const satisfies Partial<Record<HitType, string>>;

/**
 * What the search could not read. Empty on a healthy search; a source lands
 * here when PostgREST rejected or the promise rejected outright. The client
 * uses it to distinguish "nothing matched" from "we could not look".
 */
export interface GlobalSearchResult {
  hits: Hit[];
  degraded: HitType[];
}

interface Hit {
  type: HitType;
  id: string | number;       // primary key for deep-link
  title: string;             // headline
  subtitle?: string | null;  // contextual line
  date?: string | null;      // optional anchor date (DD/MM/YYYY on the client)
  status?: string | null;    // where the record stands, as stored (DRAFT, POSTED, ...)
  link: string;              // SPA destination (with focus= when relevant)
}

export function searchPattern(raw: string, postgrest = false): string | null {
  // `%` and `_` are SQL LIKE wildcards; PostgREST also accepts `*` as an
  // alias for `%`. Neutralise all three before either query grammar sees them.
  const grammarSafe = postgrest ? escapeForOr(raw) : raw;
  const term = grammarSafe.replace(/[%_*]/g, "").trim();
  if (!term) return null;
  // A one-character contains scan cannot use pg_trgm at ERP scale. Make the
  // first key a real whole-database prefix search; from the second key onward
  // the existing trigram-backed contains search takes over.
  return [...term].length === 1 ? `${term}%` : `%${term}%`;
}

/** The SO phone arms of the top search bar. Phones are stored E.164
 *  ("+60123456789"), so "012-345 6789" as staff type it never substring-matched;
 *  the SO / DO / SI lists' own normaliser adds the bare-digit E.164 arm. A
 *  one-key prefix search (no leading %) stays a single raw arm. */
export function soPhoneArms(raw: string, wildcard: string): string[] {
  if (!wildcard.startsWith("%")) return [`phone.ilike.${wildcard}`];
  return phoneSearchOrParts(wildcard.slice(1, -1), raw, normalizePhone);
}

/* ASSR company scope — now IMPORTED from routes/assr.ts rather than copied.
   This was a local copy carrying the comment "MUST stay in sync with
   routes/assr.ts assrCompanySql()", and it had NOT stayed in sync. It still
   pinned rank-and-file Sales to HOUZS via houzsCompanySql, which emits
   `AND company_id = <houzsId>` REGARDLESS of the caller's grants. The owner
   removed that pin on 2026-07-20 — assr.ts records the decision trail:
   "Service Cases now follow the caller's GRANTED companies like the rest of the
   SCM portal — no ASSR-specific role pin."

   So the same person got two different answers: /api/assr showed a 2990 rep
   their own cases, while global SEARCH showed them HOUZS cases they hold no
   grant for and hid their own. A cross-company disclosure and a blind spot from
   one stale copy.

   Sharing the function is the fix; a comment asking two files to agree is not a
   mechanism. Verified 2026-08-13 against assr.ts:131. */

/**
 * The search itself, callable WITHOUT the HTTP layer. The route below is a thin
 * wrapper; the ERP Assistant's `search_erp` tool calls this SAME function, so it
 * gets IDENTICAL company scoping. companyScope.ts blesses exactly this: its
 * helpers take a bare `{ get }` precisely so a headless caller (a background job,
 * an agent) scopes through ONE implementation instead of re-deriving the
 * predicate — the cross-company leak a local copy would invite. Returns match
 * METADATA only (no record contents, no money); every source is company-scoped;
 * never throws on the SCM side — a failed SCM source is named in `degraded`
 * instead, so the caller can tell an empty result from an unread one.
 */
export async function runGlobalSearch(
  c: CompanyScopeCtx,
  env: Env,
  raw: string,
): Promise<GlobalSearchResult> {
  const pat = searchPattern(raw);
  if (!pat) return { hits: [], degraded: [] };

  const hits: Hit[] = [];
  const degraded: HitType[] = [];

  // Multi-company scoping. Each fragment is "" ONLY when the company context is
  // unresolved (pre-migration / D1 test mirror / cold-start), so legacy
  // single-company SQL runs unchanged; a RESOLVED-but-restricted caller gets a
  // match-nothing predicate instead — never fail open, because the DB client is
  // service-role (RLS bypassed) so these predicates ARE the isolation boundary:
  //   · projects follow the ACTIVE company (per-company module, like the
  //     Projects page itself) via activeCompanySql;
  //   · ASSR is HOUZS-only: rank-and-file Sales are PINNED to HOUZS, office /
  //     backend / directors widen to their allowed set — the exact rule the
  //     /api/assr list uses (assrCompanySql, mirrored above);
  //   · users stay global — matches /api/users, an unscoped shared directory.
  const projectCoSql = activeCompanySql(c);
  const assrCoSql = assrCompanySql(c);

  // ── Public-schema sources (env.DB) ─────────────────────────
  // Fire all source queries in parallel — they share a Postgres client
  // anyway, so this just avoids serial round-trip latency.
  const projectWords = projectWordSearch(raw);
  const [projectRows, assrRows, userRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, code, name, stage, start_date
         FROM projects
        WHERE archived_at IS NULL
          AND ${projectWords.sql}${projectCoSql}
        ORDER BY start_date DESC NULLS LAST, id DESC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(...projectWords.binds)
      .all<{
        id: number;
        code: string;
        name: string;
        stage: string | null;
        start_date: string | null;
      }>(),

    env.DB.prepare(
      `SELECT id, assr_no, customer_name, complaint_issue, status, complained_date
         FROM assr_cases
        WHERE archived_at IS NULL
          AND (assr_no LIKE ?1 OR customer_name LIKE ?1 OR phone LIKE ?1
               OR complaint_issue LIKE ?1 OR doc_no LIKE ?1 OR po_no LIKE ?1 OR ref_no LIKE ?1)${assrCoSql}
        ORDER BY complained_date DESC NULLS LAST, id DESC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
      .all<{
        id: number;
        assr_no: string;
        customer_name: string | null;
        complaint_issue: string | null;
        status: string;
        complained_date: string | null;
      }>(),

    // role_id joins to roles table for the human-readable name; left
    // join is fine because the user list is short.
    env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.user_type, r.name AS role_name
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE COALESCE(u.status, 'active') != 'disabled'
          AND (u.name LIKE ?1 OR u.email LIKE ?1 OR r.name LIKE ?1)
        ORDER BY u.name ASC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
      .all<{
        id: number;
        name: string;
        email: string;
        user_type: string | null;
        role_name: string | null;
      }>(),
  ]);

  // Projects — start_date anchors the hit's date and drives the calendar jump.
  for (const r of projectRows.results ?? []) {
    const code = pick(r, "code");
    const name = pick(r, "name");
    hits.push({
      type: "project",
      id: r.id,
      title: [code, name].filter(Boolean).join(" · ") || name || String(r.id),
      subtitle: pick(r, "stage"),
      date: pick(r, "start_date"),
      link: `/projects?focus=${r.id}`,
    });
  }

  for (const r of assrRows.results ?? []) {
    hits.push({
      type: "assr_case",
      id: r.id,
      title: pick(r, "assr_no") ?? String(r.id),
      subtitle:
        [pick(r, "customer_name"), pick(r, "complaint_issue")].filter(Boolean).join(" · ") ||
        pick(r, "status"),
      date: pick(r, "complained_date"),
      status: pick(r, "status"),
      link: `/assr?focus=${r.id}`,
    });
  }

  for (const r of userRows.results ?? []) {
    hits.push({
      type: "user",
      id: r.id,
      title: pick(r, "name") ?? str(r.email) ?? String(r.id),
      subtitle: [pick(r, "role_name"), pick(r, "email")].filter(Boolean).join(" · "),
      link: `/team?focus=${r.id}`,
    });
  }

  // ── SCM sources (Supabase, scm schema) ─────────────────────
  // Guarded: any failure here degrades to the public hits above, and names the
  // source it could not read in `degraded`.
  await appendScmHits(c, env, raw, hits, degraded);

  return { hits, degraded };
}

app.get("/", async (c) => {
  const raw = (c.req.query("q") || "").trim();
  const { hits, degraded } = await runGlobalSearch(c, c.env, raw);
  return c.json({ q: raw, hits, degraded });
});

/**
 * Append the scm-schema hits: Sales Order, Product, and the five
 * procurement/fulfilment DOCUMENTS a real ERP expects Cmd+K to reach directly —
 * Purchase Order, GRN, Delivery Order, Sales Invoice, Purchase Invoice.
 *
 * Never throws — a missing Supabase config or a PostgREST error just yields zero
 * SCM hits so the public-schema search still returns. A source that FAILED is
 * pushed onto `degraded` so the caller can say so; a source that merely matched
 * nothing is not. An unconfigured Supabase (tests / local) is not degradation —
 * that deployment has no SCM half to read. Each `.or(...)` free-text is passed
 * through escapeForOr() (via searchPattern) so a term with PostgREST grammar
 * chars (`,(){}`) can't corrupt the filter.
 *
 * Every doc source matches ONLY its base-table text columns — supplier name and
 * the PO/GRN source refs are embedded FK resources (not base columns) and so are
 * ilike-safe to SELECT for display but not to filter, exactly as each list route
 * documents. All five are per-company documents, scoped through the SAME
 * scopeToCompany helper as Sales Orders / Products, and deep-link to their detail
 * route by primary-key id (the routes are /scm/<doc>/:id).
 */
async function appendScmHits(
  c: CompanyScopeCtx,
  env: Env,
  raw: string,
  hits: Hit[],
  degraded: HitType[],
): Promise<void> {
  if (!isSupabaseConfigured(env)) return;
  const wildcard = searchPattern(raw, true);
  if (!wildcard) return;

  let sb: ReturnType<typeof getSupabaseService>;
  try {
    sb = getSupabaseService(env);
  } catch (e) {
    // Configured but unbuildable: every SCM source is unreadable, not empty.
    console.warn("[search] SCM client unavailable:", (e as Error)?.message ?? e);
    const can = openableNewerTypes((c.get("user") as AuthUser | undefined) ?? null);
    degraded.push(...SCM_SOURCE_TYPES.filter((t) => !(t in AREA_OF) || can.has(t as keyof typeof AREA_OF)));
    return;
  }

  // Documents are found by their SO's reference too: the DO / SI copy of it is
  // often empty and a PO has none (lib/so-ref-search.ts). A failed lookup only
  // drops that extra arm; the direct matches still run. One-character terms
  // are prefix searches and skip it.
  let soRefDocNos: string[] = [];
  let soRefPoIds: string[] = [];
  if (wildcard.startsWith("%")) {
    try {
      soRefDocNos = await soDocNosByRef(sb, c, raw);
      soRefPoIds = await poIdsForSoDocNos(sb, soRefDocNos);
    } catch (e) {
      console.warn("[search] SO reference lookup failed:", e instanceof Error ? e.message : e);
    }
  }

  // Multi-company: SOs + products are PER-COMPANY modules, so their search hits
  // follow the ACTIVE company via scopeToCompany — the same helper the SO /
  // product list routes use. Unresolved → no predicate (legacy single-company);
  // resolved-but-restricted → an empty `in` that matches nothing (never fail
  // open).
  const soQuery = sb
    .from("mfg_sales_orders")
    .select("doc_no, debtor_name, phone, ref, so_date, branding, status")
    .or(
      [
        `doc_no.ilike.${wildcard}`, `debtor_name.ilike.${wildcard}`,
        `ref.ilike.${wildcard}`, `customer_so_no.ilike.${wildcard}`,
        ...soPhoneArms(raw, wildcard),
      ].join(",")
    );
  const prodQuery = sb
    .from("mfg_products")
    .select("id, code, name, description, sell_price_sen")
    .eq("status", "ACTIVE")
    .or(`code.ilike.${wildcard},name.ilike.${wildcard},description.ilike.${wildcard}`);

  // ── Procurement / fulfilment documents ──────────────────────
  // Each matches the SAME base-table text columns its own list route searches
  // (supplier name / PO / GRN refs are embedded FK resources — SELECTed for
  // display, not filtered). supplier(name) rides the SELECT for the subtitle.
  const poQuery = sb
    .from("purchase_orders")
    .select("id, po_number, po_date, notes, status, supplier:suppliers(name)")
    .or([`po_number.ilike.${wildcard}`, `notes.ilike.${wildcard}`, ...inArm("id", soRefPoIds)].join(","));
  const grnQuery = sb
    .from("grns")
    .select(
      "id, grn_number, received_at, delivery_note_ref, status, " +
        "supplier:suppliers(name), purchase_order:purchase_orders(po_number)"
    )
    .or(
      `grn_number.ilike.${wildcard},delivery_note_ref.ilike.${wildcard},` +
        `notes.ilike.${wildcard}`
    );
  const doQuery = sb
    .from("delivery_orders")
    .select("id, do_number, do_date, debtor_name, so_doc_no, ref, status")
    .or(
      [`do_number.ilike.${wildcard}`, `so_doc_no.ilike.${wildcard}`,
        `debtor_name.ilike.${wildcard}`, `ref.ilike.${wildcard}`, ...inArm("so_doc_no", soRefDocNos)].join(",")
    );
  const siQuery = sb
    .from("sales_invoices")
    .select("id, invoice_number, invoice_date, debtor_name, so_doc_no, ref, status")
    .or(
      [`invoice_number.ilike.${wildcard}`, `so_doc_no.ilike.${wildcard}`,
        `debtor_name.ilike.${wildcard}`, `ref.ilike.${wildcard}`, ...inArm("so_doc_no", soRefDocNos)].join(",")
    );
  const piQuery = sb
    .from("purchase_invoices")
    .select("id, invoice_number, invoice_date, supplier_invoice_ref, status, supplier:suppliers(name)")
    .or(
      `invoice_number.ilike.${wildcard},supplier_invoice_ref.ilike.${wildcard},` +
        `notes.ilike.${wildcard}`
    );

  // The six newer sources run alongside, not after, the seven below.
  const newer = appendNewerScmHits(c, sb, wildcard, hits, degraded);
  const [soRes, prodRes, poRes, grnRes, doRes, siRes, piRes] = await Promise.allSettled([
    scopeToCompany(soQuery, c)
      .order("so_date", { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    scopeToCompany(prodQuery, c)
      .order("code", { ascending: true })
      .limit(PER_SOURCE_LIMIT),
    scopeToCompany(poQuery, c)
      .order("po_date", { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    scopeToCompany(grnQuery, c)
      .order("received_at", { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    scopeToCompany(doQuery, c)
      .order("do_date", { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    scopeToCompany(siQuery, c)
      .order("invoice_date", { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    scopeToCompany(piQuery, c)
      .order("invoice_date", { ascending: false })
      .limit(PER_SOURCE_LIMIT),
  ]);

  for (const r of sourceRows(soRes, "sales_order", degraded)) {
    const docNo = String(r.doc_no ?? "");
    if (!docNo) continue;
    hits.push({
      type: "sales_order",
      id: docNo,
      title: docNo,
      subtitle:
        [str(r.debtor_name), str(r.branding), str(r.ref)].filter(Boolean).join(" · ") ||
        str(r.phone),
      date: str(r.so_date),
      status: str(r.status),
      // Deep-link the SPA straight to the SO detail route
      // (/scm/sales-orders/:docNo); the mobile palette maps the same doc_no
      // onto its own so-detail screen.
      link: `/scm/sales-orders/${encodeURIComponent(docNo)}`,
    });
  }

  for (const r of sourceRows(prodRes, "product", degraded)) {
    const code = str(r.code);
    if (!code) continue;
    hits.push({
      type: "product",
      id: code,
      title: [code, str(r.name)].filter(Boolean).join(" · ") || code,
      subtitle: str(r.description),
      date: null,
      link: `/scm/products?focus=${encodeURIComponent(code)}`,
    });
  }

  // Purchase Orders — supplier(name) embed drives the subtitle.
  for (const r of sourceRows(poRes, "purchase_order", degraded)) {
    const id = str(r.id);
    const docNo = str(r.po_number);
    if (!id || !docNo) continue;
    hits.push({
      type: "purchase_order",
      id,
      title: docNo,
      subtitle: [embedField(r.supplier, "name"), str(r.notes)].filter(Boolean).join(" · "),
      date: str(r.po_date),
      status: str(r.status),
      link: `/scm/purchase-orders/${encodeURIComponent(id)}`,
    });
  }

  // GRNs — supplier + source PO number make the subtitle.
  for (const r of sourceRows(grnRes, "grn", degraded)) {
    const id = str(r.id);
    const docNo = str(r.grn_number);
    if (!id || !docNo) continue;
    const poNo = embedField(r.purchase_order, "po_number");
    hits.push({
      type: "grn",
      id,
      title: docNo,
      subtitle:
        [embedField(r.supplier, "name"), poNo ? `PO ${poNo}` : null, str(r.delivery_note_ref)]
          .filter(Boolean)
          .join(" · "),
      date: str(r.received_at),
      status: str(r.status),
      link: `/scm/grns/${encodeURIComponent(id)}`,
    });
  }

  // Delivery Orders — customer + source SO ref.
  for (const r of sourceRows(doRes, "delivery_order", degraded)) {
    const id = str(r.id);
    const docNo = str(r.do_number);
    if (!id || !docNo) continue;
    const soNo = str(r.so_doc_no);
    hits.push({
      type: "delivery_order",
      id,
      title: docNo,
      subtitle:
        [str(r.debtor_name), soNo ? `SO ${soNo}` : null, str(r.ref)].filter(Boolean).join(" · "),
      date: str(r.do_date),
      status: str(r.status),
      link: `/scm/delivery-orders/${encodeURIComponent(id)}`,
    });
  }

  // Sales Invoices — customer + source SO ref.
  for (const r of sourceRows(siRes, "sales_invoice", degraded)) {
    const id = str(r.id);
    const docNo = str(r.invoice_number);
    if (!id || !docNo) continue;
    const soNo = str(r.so_doc_no);
    hits.push({
      type: "sales_invoice",
      id,
      title: docNo,
      subtitle:
        [str(r.debtor_name), soNo ? `SO ${soNo}` : null, str(r.ref)].filter(Boolean).join(" · "),
      date: str(r.invoice_date),
      status: str(r.status),
      link: `/scm/sales-invoices/${encodeURIComponent(id)}`,
    });
  }

  // Purchase Invoices — supplier + the supplier's own invoice ref.
  for (const r of sourceRows(piRes, "purchase_invoice", degraded)) {
    const id = str(r.id);
    const docNo = str(r.invoice_number);
    if (!id || !docNo) continue;
    hits.push({
      type: "purchase_invoice",
      id,
      title: docNo,
      subtitle:
        [embedField(r.supplier, "name"), str(r.supplier_invoice_ref)]
          .filter(Boolean)
          .join(" · "),
      date: str(r.invoice_date),
      status: str(r.status),
      link: `/scm/purchase-invoices/${encodeURIComponent(id)}`,
    });
  }
  await newer;
}

/** Which of the six newer sources this caller could open. A caller with no user
 *  on the context (a headless job) gets none: the stricter answer. */
export function openableNewerTypes(user: AuthUser | null): Set<keyof typeof AREA_OF> {
  const out = new Set<keyof typeof AREA_OF>();
  for (const [type, area] of Object.entries(AREA_OF) as Array<[keyof typeof AREA_OF, string]>) {
    if (scmAreaReadable(user, area)) out.add(type);
  }
  return out;
}


/**
 * Suppliers, customers (Finance's Other Debtors master), credit / debit notes,
 * receipts, delivery returns and payment vouchers. Each is company-scoped by the
 * same scopeToCompany as the rest, capped at PER_SOURCE_LIMIT, searched only on
 * columns migration 20261110T2000 gives a trigram index (suppliers' came in
 * 0240), and skipped outright for a caller who cannot open that area — a hit
 * the person cannot follow is noise, and a skipped source is not "degraded".
 */
async function appendNewerScmHits(
  c: CompanyScopeCtx,
  sb: ReturnType<typeof getSupabaseService>,
  w: string,
  hits: Hit[],
  degraded: HitType[],
): Promise<void> {
  const user = (c.get("user") as AuthUser | undefined) ?? null;
  const can = openableNewerTypes(user);
  if (can.size === 0) return;
  const skip = Promise.resolve({ data: [], error: null });
  const run = (type: keyof typeof AREA_OF, q: () => PromiseLike<{ data: unknown; error: unknown }>) =>
    can.has(type) ? q() : skip;

  const [supRes, custRes, noteRes, rcptRes, drcptRes, drRes, pvRes] = await Promise.allSettled([
    run("supplier", () => scopeToCompany(
      sb.from("suppliers").select("id, code, name, contact_person, status")
        .or(`code.ilike.${w},name.ilike.${w},contact_person.ilike.${w}`), c,
    ).order("name", { ascending: true }).limit(PER_SOURCE_LIMIT)),
    run("customer", () => scopeToCompany(
      sb.from("acc_debtors").select("id, code, name, phone, is_active")
        .or(`code.ilike.${w},name.ilike.${w},phone.ilike.${w}`), c,
    ).order("name", { ascending: true }).limit(PER_SOURCE_LIMIT)),
    run("credit_note", () => scopeToCompany(
      sb.from("acc_credit_notes").select("id, note_number, kind, party_name, so_doc_no, note_date, status")
        .or(`note_number.ilike.${w},party_name.ilike.${w},so_doc_no.ilike.${w}`), c,
    ).order("note_date", { ascending: false }).limit(PER_SOURCE_LIMIT)),
    run("receipt", () => scopeToCompany(
      sb.from("acc_receipts").select("id, receipt_number, payer_name, receipt_date, status")
        .or(`receipt_number.ilike.${w},payer_name.ilike.${w}`), c,
    ).order("receipt_date", { ascending: false }).limit(PER_SOURCE_LIMIT)),
    run("receipt", () => scopeToCompany(
      sb.from("acc_debtor_receipts").select("id, receipt_number, receipt_date, status, debtor:acc_debtors(name)")
        .ilike("receipt_number", w), c,
    ).order("receipt_date", { ascending: false }).limit(PER_SOURCE_LIMIT)),
    run("delivery_return", () => scopeToCompany(
      sb.from("delivery_returns").select("id, return_number, do_doc_no, debtor_name, return_date, status")
        .or(`return_number.ilike.${w},do_doc_no.ilike.${w},debtor_name.ilike.${w}`), c,
    ).order("return_date", { ascending: false }).limit(PER_SOURCE_LIMIT)),
    run("payment_voucher", () => scopeToCompany(
      sb.from("payment_vouchers").select("id, pv_number, payee_name, bill_ref, voucher_date, status")
        .or(`pv_number.ilike.${w},payee_name.ilike.${w},bill_ref.ilike.${w}`), c,
    ).order("voucher_date", { ascending: false }).limit(PER_SOURCE_LIMIT)),
  ]);

  for (const r of sourceRows(supRes, "supplier", degraded)) {
    const id = str(r.id);
    if (!id) continue;
    hits.push({
      type: "supplier",
      id,
      title: [str(r.code), str(r.name)].filter(Boolean).join(" · ") || id,
      subtitle: str(r.contact_person),
      status: str(r.status),
      link: `/scm/suppliers/${encodeURIComponent(id)}`,
    });
  }

  for (const r of sourceRows(custRes, "customer", degraded)) {
    const id = str(r.id);
    if (!id) continue;
    hits.push({
      type: "customer",
      id,
      title: [str(r.code), str(r.name)].filter(Boolean).join(" · ") || id,
      subtitle: str(r.phone),
      status: r.is_active === false ? "INACTIVE" : "ACTIVE",
      link: `/scm/other-debtors/${encodeURIComponent(id)}`,
    });
  }

  for (const r of sourceRows(noteRes, "credit_note", degraded)) {
    const id = str(r.id);
    const no = str(r.note_number);
    if (!id || !no) continue;
    const so = str(r.so_doc_no);
    hits.push({
      type: "credit_note",
      id,
      title: no,
      subtitle: [(NOTE_KIND_WORD as Record<string, string>)[str(r.kind) ?? ""] ?? str(r.kind), str(r.party_name), so ? `SO ${so}` : null]
        .filter(Boolean).join(" · "),
      date: str(r.note_date),
      status: str(r.status),
      link: `/scm/credit-notes/${encodeURIComponent(id)}`,
    });
  }

  // Two receipt tables, one hit type: the newest PER_SOURCE_LIMIT of the pair.
  const receipts = [
    ...sourceRows(rcptRes, "receipt", degraded).map((r) => ({
      r, payer: str(r.payer_name), link: `/scm/receipts/sundry/${encodeURIComponent(String(r.id))}`,
    })),
    ...sourceRows(drcptRes, "receipt", degraded).map((r) => ({
      r, payer: embedField(r.debtor, "name"), link: `/scm/receipts/debtor/${encodeURIComponent(String(r.id))}`,
    })),
  ]
    .filter(({ r }) => str(r.id) && str(r.receipt_number))
    .sort((a, b) => String(b.r.receipt_date ?? "").localeCompare(String(a.r.receipt_date ?? "")))
    .slice(0, PER_SOURCE_LIMIT);
  for (const { r, payer, link } of receipts) {
    hits.push({
      type: "receipt",
      id: String(r.id),
      title: String(r.receipt_number),
      subtitle: payer,
      date: str(r.receipt_date),
      status: str(r.status),
      link,
    });
  }

  for (const r of sourceRows(drRes, "delivery_return", degraded)) {
    const id = str(r.id);
    const no = str(r.return_number);
    if (!id || !no) continue;
    const doNo = str(r.do_doc_no);
    hits.push({
      type: "delivery_return",
      id,
      title: no,
      subtitle: [str(r.debtor_name), doNo ? `DO ${doNo}` : null].filter(Boolean).join(" · "),
      date: str(r.return_date),
      status: str(r.status),
      link: `/scm/delivery-returns/${encodeURIComponent(id)}`,
    });
  }

  for (const r of sourceRows(pvRes, "payment_voucher", degraded)) {
    const id = str(r.id);
    const no = str(r.pv_number);
    if (!id || !no) continue;
    hits.push({
      type: "payment_voucher",
      id,
      title: no,
      subtitle: [str(r.payee_name), str(r.bill_ref)].filter(Boolean).join(" · "),
      date: str(r.voucher_date),
      status: str(r.status),
      link: `/scm/payment-vouchers/${encodeURIComponent(id)}`,
    });
  }
}

// Every SCM source, in the order appendScmHits queries them. Used to mark the
// whole SCM half degraded when the client itself cannot be built.
const SCM_SOURCE_TYPES = [
  "sales_order",
  "product",
  "purchase_order",
  "grn",
  "delivery_order",
  "sales_invoice",
  "purchase_invoice",
  "supplier",
  "customer",
  "credit_note",
  "receipt",
  "delivery_return",
  "payment_voucher",
] as const satisfies readonly HitType[];

/**
 * Rows from one settled source, or [] with the source recorded as degraded.
 *
 * This exists because the previous shape — `if (res.status === "fulfilled" &&
 * !res.value.error)` repeated per source — made "this source errored" and "this
 * source matched nothing" the same observable outcome. Routing both through one
 * function makes the failure branch impossible to forget when a source is added.
 */
function sourceRows(
  res: PromiseSettledResult<{ data: unknown; error: unknown }>,
  type: HitType,
  degraded: HitType[],
): Array<Record<string, unknown>> {
  if (res.status === "rejected") {
    console.warn(`[search] source ${type} rejected:`, res.reason);
    if (!degraded.includes(type)) degraded.push(type);
    return [];
  }
  if (res.value.error) {
    console.warn(`[search] source ${type} errored:`, res.value.error);
    if (!degraded.includes(type)) degraded.push(type);
    return [];
  }
  return (res.value.data ?? []) as Array<Record<string, unknown>>;
}

// A to-one FK embed arrives as an object OR (Supabase typegen) a single-element
// array; pull one string field out of whichever shape, null-safe throughout.
function embedField(v: unknown, field: string): string | null {
  if (v == null) return null;
  const row = Array.isArray(v) ? v[0] : v;
  if (row == null || typeof row !== "object") return null;
  return str((row as Record<string, unknown>)[field]);
}

// Dual-read camelCase ?? snake_case. NOTE: this repo's postgres.js client sets
// NO column transform (db/pg.ts says so explicitly, and deliberately — Houzs
// reads snake_case everywhere, unlike Hookka whose adapter camelCases every
// column and who pay for it with a recurring bug class). So the camelCase arm
// never fires today; it is harmless belt-and-braces, not a requirement. Do not
// copy this pattern outward believing snake_case reads are unsafe here.
function pick<T extends Record<string, unknown>>(row: T, snake: string): string | null {
  const camel = snake.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
  const v = (row as Record<string, unknown>)[camel] ?? (row as Record<string, unknown>)[snake];
  return v == null ? null : String(v);
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

export default app;
