import { Hono } from "hono";
import type { Env } from "../types";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { escapeForOr } from "../scm/lib/postgrest-search";
import {
  activeCompanySql,
  allowedCompaniesSql,
  houzsCompanySql,
  scopeToCompany,
  type CompanyScopeCtx,
} from "../scm/lib/companyScope";
import { isDirectorUser, isSalesUser } from "../services/pmsAccess";

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
  | "purchase_invoice";

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

// ASSR company pin — MUST stay in sync with routes/assr.ts assrCompanySql().
// Service Cases are a HOUZS-only module: rank-and-file Sales are PINNED to
// HOUZS (never see 2990 cases), while office / backend / directors run one
// cross-company portal and widen to their allowed set. Returns the same
// three-state fragment as its primitives — "" when the company context is
// unresolved (legacy single-company), a match-nothing predicate when the
// caller is resolved but restricted, never fail open.
function assrCompanySql(c: CompanyScopeCtx): string {
  const user = c.get("user") as Parameters<typeof isSalesUser>[0];
  const pinsToHouzs = isSalesUser(user) && !isDirectorUser(user);
  return pinsToHouzs ? houzsCompanySql(c) : allowedCompaniesSql(c);
}

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
  const [projectRows, assrRows, userRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, code, name, stage, start_date
         FROM projects
        WHERE archived_at IS NULL
          AND (code LIKE ?1 OR name LIKE ?1 OR venue LIKE ?1 OR organizer LIKE ?1
               OR brand LIKE ?1)${projectCoSql}
        ORDER BY start_date DESC NULLS LAST, id DESC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
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
               OR complaint_issue LIKE ?1 OR doc_no LIKE ?1 OR po_no LIKE ?1)${assrCoSql}
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
    degraded.push(...SCM_SOURCE_TYPES);
    return;
  }

  // Multi-company: SOs + products are PER-COMPANY modules, so their search hits
  // follow the ACTIVE company via scopeToCompany — the same helper the SO /
  // product list routes use. Unresolved → no predicate (legacy single-company);
  // resolved-but-restricted → an empty `in` that matches nothing (never fail
  // open).
  const soQuery = sb
    .from("mfg_sales_orders")
    .select("doc_no, debtor_name, phone, ref, so_date, branding")
    .or(
      `doc_no.ilike.${wildcard},debtor_name.ilike.${wildcard},` +
        `ref.ilike.${wildcard},phone.ilike.${wildcard},po_doc_no.ilike.${wildcard}`
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
    .select("id, po_number, po_date, notes, supplier:suppliers(name)")
    .or(`po_number.ilike.${wildcard},notes.ilike.${wildcard}`);
  const grnQuery = sb
    .from("grns")
    .select(
      "id, grn_number, received_at, delivery_note_ref, " +
        "supplier:suppliers(name), purchase_order:purchase_orders(po_number)"
    )
    .or(
      `grn_number.ilike.${wildcard},delivery_note_ref.ilike.${wildcard},` +
        `notes.ilike.${wildcard}`
    );
  const doQuery = sb
    .from("delivery_orders")
    .select("id, do_number, do_date, debtor_name, so_doc_no, ref")
    .or(
      `do_number.ilike.${wildcard},so_doc_no.ilike.${wildcard},` +
        `debtor_name.ilike.${wildcard},ref.ilike.${wildcard}`
    );
  const siQuery = sb
    .from("sales_invoices")
    .select("id, invoice_number, invoice_date, debtor_name, so_doc_no, ref")
    .or(
      `invoice_number.ilike.${wildcard},so_doc_no.ilike.${wildcard},` +
        `debtor_name.ilike.${wildcard},ref.ilike.${wildcard}`
    );
  const piQuery = sb
    .from("purchase_invoices")
    .select("id, invoice_number, invoice_date, supplier_invoice_ref, supplier:suppliers(name)")
    .or(
      `invoice_number.ilike.${wildcard},supplier_invoice_ref.ilike.${wildcard},` +
        `notes.ilike.${wildcard}`
    );

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
      link: `/scm/purchase-invoices/${encodeURIComponent(id)}`,
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
    degraded.push(type);
    return [];
  }
  if (res.value.error) {
    console.warn(`[search] source ${type} errored:`, res.value.error);
    degraded.push(type);
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
