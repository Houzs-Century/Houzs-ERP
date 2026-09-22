/**
 * /api/delivery-sheet — the HC Delivery sheet's ERP sync (replaces AutoCount).
 *
 * Two legs, both called by the sheet-bound Apps Script ("Delivery & Amend
 * Updated") on a time trigger, exactly where it used to call the AutoCount
 * middleware over ngrok:
 *
 *   GET  /so-since?since=<LastModified>&limit=<n>  — replaces /SalesOrder/getSince
 *   POST /updates  { updates: [{DocNo, Remark4?, ExpiryDate?}] }
 *                                                  — replaces PUT /SalesOrder/updateFromSheet
 *
 * PRE-AUTH, BY DESIGN: Google's servers call this, so there is no session and
 * no X-Company-Id. Auth is the shared secret in `X-Intake-Key`, and the ONLY
 * secret accepted is SHEET_SYNC_KEY — the HC Delivery sheet's own key, which
 * speaks for HOUZS (docs/modules/service-case.md, 2026-08-18 rule). The
 * company id is read from the master under that code and the request is
 * refused when the master cannot answer; an unscoped read here would be the
 * whole Houzs order book with phones and addresses.
 *
 * Column semantics the owner ruled on 2026-09-15 (docs/modules/delivery-sheet-sync.md):
 *   · Doc. No. = the AutoCount number the sheet already keys on
 *     (`linked_ac_docno`, else `doc_no`) so no migrated row duplicates;
 *   · Transfer To = the ERP's HC-DO numbers;
 *   · Sales Exemption Expiry Date (col O, the dispatch date) = `customer_delivery_date`,
 *     and the sheet's col Q edit writes it back there;
 *   · Remark 4 (col P) = `remark4`, written back from col A — col A itself is
 *     never written by the ERP (the writer starts at col B, as it always did).
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { timingSafeEqualStr } from "../services/auth";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";
import { intakeCompany } from "../lib/intake-company";
import {
  FEED_BALANCE_COLLECTION_SQL,
  FEED_OVERDUE_SQL,
  FEED_READY_OPEN_SQL,
  FEED_SINCE_SQL,
  UPDATES_MAX,
  updateFromSheetSql,
  feedLinesSql,
  feedByDocNosSql,
  feedFullByDocNosSql,
  isSheetReady,
  resolveSheetRemark2,
  normSheetDate,
  parseFromDate,
  parseLimit,
  parseSince,
  toSheetRecord,
  type DeliverySheetRecord,
  type FeedHeadRow,
  type FeedLineRow,
  type FeedReadinessHead,
} from "../lib/delivery-sheet-feed";
import { SO_DELIVERED_OR_BEYOND } from "../scm/shared/so-deliverable-states";
import {
  FEED_OUTSTANDING_PO_SQL,
  PO_OUTSTANDING_STATUSES,
  SHEET_PO_DATE_SLOTS,
  poHeadsForSheetSql,
  toOutstandingPoRecord,
  type PoFeedRow,
  type PoHeadForSheet,
} from "../lib/delivery-sheet-po-feed";
import {
  FEED_ASSR_LEGS_SQL,
  toAssrLegRecords,
  type AssrFeedRow,
} from "../lib/delivery-sheet-assr-feed";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { SUPPLIER_DATE_SLOT_COL, cascadePoSupplierDate } from "../scm/lib/po-supplier-date-cascade";
import { poHasDownstream } from "../scm/lib/downstream-lock";
import { enqueueEdit } from "../scm/lib/autocount-outbox";

const app = new Hono<{ Bindings: Env }>();

/** The company the sheet's secret speaks for. */
const SHEET_KEY_COMPANY = "HOUZS";

async function badSheetKey(c: any): Promise<Response | null> {
  const provided = c.req.header("X-Intake-Key") || "";
  const expected = c.env.SHEET_SYNC_KEY || "";
  if (expected && timingSafeEqualStr(provided, expected)) return null;
  const limited = await checkRateLimit(c, "intake_badkey", clientIp(c), 10, 900);
  await new Promise((r) => setTimeout(r, 250));
  if (limited) return limited;
  return c.json({ error: "unauthorized" }, 401);
}

/** The secret's company id, or the refusal to send. Never degrades to "no
 *  predicate": on a master-less install there is nothing this feed may serve. */
async function sheetCompanyId(c: any): Promise<{ id: number } | { refusal: Response }> {
  const keyCo = await intakeCompany(c.env.DB, SHEET_KEY_COMPANY);
  if (keyCo.id == null) {
    return {
      refusal: c.json(
        {
          error: "company_unresolved",
          message: `No company is configured for code ${SHEET_KEY_COMPANY}, so this sync cannot be scoped and is refused.`,
        },
        503,
      ),
    };
  }
  return { id: keyCo.id };
}

/**
 * Run one feed statement and map its heads to sheet records. The lines exist
 * only to derive Remarks 2 for orders whose header carries none; a failed read
 * refuses the whole page rather than writing blank remarks into the sheet.
 */
async function loadRecords(
  c: any,
  sql: string,
  binds: unknown[],
): Promise<{ records: DeliverySheetRecord[] } | { refusal: Response }> {
  let heads: FeedHeadRow[];
  try {
    const res = (await c.env.DB.prepare(sql).bind(...binds).all()) as { results?: FeedHeadRow[] };
    heads = res.results ?? [];
  } catch (e) {
    return { refusal: c.json({ error: "feed_read_failed", message: e instanceof Error ? e.message : String(e) }, 502) };
  }
  const linesByDoc = new Map<string, FeedLineRow[]>();
  const docNos = heads.map((h) => h.doc_no);
  for (let i = 0; i < docNos.length; i += 100) {
    const chunk = docNos.slice(i, i + 100);
    try {
      const res = (await c.env.DB.prepare(feedLinesSql(chunk.length)).bind(...chunk).all()) as { results?: FeedLineRow[] };
      for (const l of res.results ?? []) {
        const arr = linesByDoc.get(l.doc_no) ?? [];
        arr.push(l);
        linesByDoc.set(l.doc_no, arr);
      }
    } catch (e) {
      return { refusal: c.json({ error: "lines_read_failed", message: e instanceof Error ? e.message : String(e) }, 502) };
    }
  }
  return { records: heads.map((h) => toSheetRecord(h, linesByDoc.get(h.doc_no) ?? [])) };
}

app.get("/so-since", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const since = parseSince(c.req.query("since"));
  if (!since) return c.json({ error: "bad_since", message: "since must be a timestamp (yyyy-mm-dd hh:mm:ss[.ffffff][+hh])" }, 400);
  const limit = parseLimit(c.req.query("limit"));
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;

  // company-scope: ?1 is the secret's company id, resolved from the master above.
  const loaded = await loadRecords(c, FEED_SINCE_SQL, [co.id, since, limit]);
  if ("refusal" in loaded) return loaded.refusal;
  const { records } = loaded;
  return c.json({
    count: records.length,
    limit,
    since,
    // The checkpoint the sheet should store once every row of this page is
    // written; null when the page is empty (keep the old one).
    next_since: records.length ? records[records.length - 1]!.LastModified : null,
    has_more: records.length >= limit,
    records,
  });
});

/* Phase 2 (owner 2026-09-16): the two daily lists that used to come from
   AutoCount's /SalesOrder/getOverdue and /getBalanceCollection. Full state,
   no cursor — the sheet appends (Overdue History) or rewrites (Balance
   Collection) the whole answer each day. */

app.get("/overdue", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;
  // company-scope: ?1 is the secret's company id.
  const loaded = await loadRecords(c, FEED_OVERDUE_SQL, [co.id]);
  if ("refusal" in loaded) return loaded.refusal;
  return c.json({ count: loaded.records.length, records: loaded.records });
});

app.get("/balance-collection", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;
  // company-scope: ?1 is the secret's company id.
  const loaded = await loadRecords(c, FEED_BALANCE_COLLECTION_SQL, [co.id]);
  if ("refusal" in loaded) return loaded.refusal;
  return c.json({ count: loaded.records.length, records: loaded.records });
});

/* Owner 2026-09-17: only an order whose Remarks 2 is READY / READY (PARTIAL)
   may ENTER the sheet. The since-feed marks each record `Ready` and the Apps
   Script appends only those; this is the sweep for the ones that became ready
   without their header moving (the allocator flips lines, not the order). */
app.get("/ready-open", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const from = parseFromDate(c.req.query("from"));
  if (!from) return c.json({ error: "bad_from", message: "from must be yyyy-mm-dd" }, 400);
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;
  // company-scope: ?1 is the secret's company id. ?2 (order date) and ?3
  // (became-ready day) are both the from-date — see FEED_READY_OPEN_SQL.
  const loaded = await loadRecords(c, FEED_READY_OPEN_SQL, [co.id, from, from]);
  if ("refusal" in loaded) return loaded.refusal;
  const records = loaded.records.filter((r) => r.Ready);
  return c.json({ count: records.length, scanned: loaded.records.length, from, records });
});

/* Reconcile support (owner 2026-09-20): the delivery tabs keep only orders whose
   LIVE Remarks 2 is READY / READY (PARTIAL). Given the DocNos currently on a
   tab, this returns each one's live readiness so the Apps Script can refresh the
   cell (stale product-word -> READY) and DELETE the rows that are genuinely not
   ready. A DocNo not found in this company's live order book is `found:false`
   and the Apps Script LEAVES it — never delete a row the ERP does not own
   (service/pickup legs, pre-go-live delivered rows, any non-ERP row). */
const PRUNE_CHECK_MAX = 2000;
app.post("/prune-check", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const raw = Array.isArray(body?.doc_nos) ? (body.doc_nos as unknown[]) : null;
  if (!raw) return c.json({ error: "bad_body", message: "expected { doc_nos: string[] }" }, 400);
  const docNos = [...new Set(raw.map((d) => String(d ?? "").trim()).filter(Boolean))];
  if (!docNos.length) return c.json({ error: "no_doc_nos" }, 400);
  if (docNos.length > PRUNE_CHECK_MAX) return c.json({ error: "too_many", max: PRUNE_CHECK_MAX }, 413);

  // company-scope: first bind is the secret's company id; the doc numbers are
  // matched on linked_ac_docno OR doc_no (the sheet key is linked_ac_docno).
  let heads: FeedReadinessHead[];
  try {
    const res = (await c.env.DB.prepare(feedByDocNosSql(docNos.length))
      .bind(co.id, ...docNos, ...docNos)
      .all()) as { results?: FeedReadinessHead[] };
    heads = res.results ?? [];
  } catch (e) {
    return c.json({ error: "read_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }

  const linesByDoc = new Map<string, FeedLineRow[]>();
  const foundDocNos = heads.map((h) => h.doc_no);
  for (let i = 0; i < foundDocNos.length; i += 100) {
    const chunk = foundDocNos.slice(i, i + 100);
    if (!chunk.length) break;
    try {
      const res = (await c.env.DB.prepare(feedLinesSql(chunk.length)).bind(...chunk).all()) as { results?: FeedLineRow[] };
      for (const l of res.results ?? []) {
        const arr = linesByDoc.get(l.doc_no) ?? [];
        arr.push(l);
        linesByDoc.set(l.doc_no, arr);
      }
    } catch (e) {
      return c.json({ error: "lines_read_failed", message: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  // Key each found order by BOTH its ERP number and its sheet key, so an input
  // that used either one resolves.
  const deliveredSet = new Set<string>([...SO_DELIVERED_OR_BEYOND]);
  const stateByKey = new Map<string, { ErpDocNo: string; Remark2: string | null; Ready: boolean; Status: string; Deletable: boolean }>();
  for (const h of heads) {
    const remark2 = resolveSheetRemark2(h.remark2, linesByDoc.get(h.doc_no) ?? []);
    const ready = isSheetReady(remark2);
    // Delete only an UNDELIVERED order whose stock is not in. A delivered /
    // invoiced / closed order is a record — never pruned, even if its (possibly
    // frozen) line flags read not-ready.
    const deletable = !ready && !deliveredSet.has(h.status);
    const st = { ErpDocNo: h.doc_no, Remark2: remark2, Ready: ready, Status: h.status, Deletable: deletable };
    stateByKey.set(h.doc_no, st);
    if (h.linked_ac_docno) stateByKey.set(h.linked_ac_docno, st);
  }

  const results = docNos.map((d) => {
    const st = stateByKey.get(d);
    return st
      ? { DocNo: d, found: true, ErpDocNo: st.ErpDocNo, Ready: st.Ready, Remark2: st.Remark2, Status: st.Status, Deletable: st.Deletable }
      : { DocNo: d, found: false, ErpDocNo: null as string | null, Ready: false, Remark2: null as string | null, Status: null as string | null, Deletable: false };
  });
  return c.json({
    count: results.length,
    found: results.filter((r) => r.found).length,
    would_remove: results.filter((r) => r.Deletable).length,
    results,
  });
});

/* Manual restore (owner 2026-09-21): full sheet records for an explicit DocNo
   list, NO readiness gate — the "put these specific orders back on the tab"
   tool for rows removed by mistake or wanted despite not being ready. The
   normal since / ready-open feeds only append READY orders and only from
   ERP_APPEND_FROM onward, so an older or not-yet-ready order cannot re-enter on
   its own; this returns exactly the requested orders (this company, live only)
   as sheet records so the Apps Script can append the ones missing from the tab. */
const FEED_BY_DOCNOS_MAX = 500;
app.post("/feed-by-docnos", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const raw = Array.isArray(body?.doc_nos) ? (body.doc_nos as unknown[]) : null;
  if (!raw) return c.json({ error: "bad_body", message: "expected { doc_nos: string[] }" }, 400);
  const docNos = [...new Set(raw.map((d) => String(d ?? "").trim()).filter(Boolean))];
  if (!docNos.length) return c.json({ error: "no_doc_nos" }, 400);
  if (docNos.length > FEED_BY_DOCNOS_MAX) return c.json({ error: "too_many", max: FEED_BY_DOCNOS_MAX }, 413);

  // company-scope: ?1 is the secret's company id; the doc numbers match doc_no
  // OR linked_ac_docno (the sheet key is linked_ac_docno), bound once at ?2..
  const loaded = await loadRecords(c, feedFullByDocNosSql(docNos.length), [co.id, ...docNos]);
  if ("refusal" in loaded) return loaded.refusal;
  return c.json({ count: loaded.records.length, requested: docNos.length, records: loaded.records });
});

/* Service-Case (ASSR) legs (owner 2026-09-17): each open case's inspection /
   pickup / delivery-back leg that OUR OWN team drives is emitted here so the
   sheet appends it beside the Sales-Order rows for the same region. Own-team
   gated by design (see delivery-sheet-assr-feed.ts); the Delivery Planning
   board stays un-gated, so board and sheet intentionally differ. Incremental,
   same `since`/`limit` cursor as /so-since — but the LIMIT counts CASES, each
   expanding to up to three leg rows. */
app.get("/assr-legs", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const since = parseSince(c.req.query("since"));
  if (!since) return c.json({ error: "bad_since", message: "since must be a timestamp (yyyy-mm-dd hh:mm:ss[.ffffff][+hh])" }, 400);
  const limit = parseLimit(c.req.query("limit"));
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;

  let cases: AssrFeedRow[];
  try {
    // company-scope: ?1 is the secret's company id, resolved from the master.
    const res = (await c.env.DB.prepare(FEED_ASSR_LEGS_SQL).bind(co.id, since, limit).all()) as { results?: AssrFeedRow[] };
    cases = res.results ?? [];
  } catch (e) {
    return c.json({ error: "feed_read_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }
  const records = cases.flatMap(toAssrLegRecords);
  return c.json({
    count: records.length,
    // The page is a CASE page; the checkpoint and has_more are measured in
    // cases so paging is correct even though each case emits up to three legs.
    cases: cases.length,
    limit,
    since,
    next_since: cases.length ? cases[cases.length - 1]!.last_modified_text : null,
    has_more: cases.length >= limit,
    records,
  });
});

type SheetUpdate = { DocNo?: unknown; Remark4?: unknown; ExpiryDate?: unknown };

app.post("/updates", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  let body: { updates?: unknown };
  try {
    body = (await c.req.json()) as { updates?: unknown };
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  const updates = Array.isArray(body.updates) ? (body.updates as SheetUpdate[]) : null;
  if (!updates) return c.json({ error: "bad_request", message: "updates[] required" }, 400);
  if (updates.length > UPDATES_MAX) return c.json({ error: "too_many", max: UPDATES_MAX }, 413);
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;

  // Validate every row first; the writable ones go to the database as ONE
  // statement (see updateFromSheetSql for why one round trip matters here).
  const results: Array<Record<string, unknown>> = updates.map(() => ({}));
  const rows: Array<{ i: number; docNo: string; remark4: string | null; expiry: string | null }> = [];
  updates.forEach((u, i) => {
    const docNo = String(u.DocNo ?? "").trim();
    if (!docNo) {
      results[i] = { DocNo: null, skipped: "no_doc_no" };
      return;
    }
    // A Remark4 that is PRESENT is written as-is, blank included — clearing
    // col A is a real edit. An ABSENT Remark4 keeps the ERP's value.
    const remark4 = u.Remark4 == null ? null : String(u.Remark4).trim();
    // A blank date keeps the ERP's date: the old daily PO sync nulled dates
    // stored as text, and this leg must not repeat that.
    const expiry = normSheetDate(u.ExpiryDate);
    if (u.ExpiryDate != null && String(u.ExpiryDate).trim() && !expiry) {
      results[i] = { DocNo: docNo, skipped: "bad_date" };
      return;
    }
    if (remark4 == null && !expiry) {
      results[i] = { DocNo: docNo, skipped: "nothing_to_write" };
      return;
    }
    results[i] = { DocNo: docNo, skipped: "no_order" };
    rows.push({ i, docNo, remark4, expiry });
  });

  if (rows.length) {
    // The same Doc. No. twice in one batch would update one row twice in a
    // single statement; the LAST occurrence wins, as it would row by row.
    const byDoc = new Map<string, (typeof rows)[number]>();
    for (const r of rows) byDoc.set(r.docNo, r);
    const batch = [...byDoc.values()];
    const binds: unknown[] = [];
    for (const r of batch) binds.push(r.docNo, r.remark4, r.expiry);
    binds.push(co.id);
    try {
      // company-scope: the last bind is the secret's company id; each row is found by the sheet's AutoCount number OR the ERP number within it.
      const res = await c.env.DB.prepare(updateFromSheetSql(batch.length))
        .bind(...binds)
        .all<{ doc_no: string; sheet_doc_no: string }>();
      const hitBySheetDoc = new Map<string, string>();
      for (const h of res.results ?? []) hitBySheetDoc.set(h.sheet_doc_no, h.doc_no);
      for (const r of rows) {
        const erpDocNo = hitBySheetDoc.get(r.docNo);
        if (erpDocNo) results[r.i] = { DocNo: r.docNo, ErpDocNo: erpDocNo, ok: true, remark4: r.remark4, delivery_date: r.expiry };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const r of rows) results[r.i] = { DocNo: r.docNo, error: message };
    }
  }
  const written = results.filter((r) => r.ok === true).length;
  return c.json({ count: results.length, written, results });
});

/* Phase 3 (owner 2026-09-16): the Outstanding PO tab. Replaces AutoCount's
   /PurchaseOrder/getOutstanding (read) and /PurchaseOrder/update-udf-dates
   (the three supplier delivery dates, written back to the ERP's header slots
   2/3/4 and cascaded to the lines — the same writer the PO editor's bulk
   supplier-date action and the line import use — and then queued to the
   account book through the ordinary PO write-back). */

app.get("/outstanding-po", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;
  let rows: PoFeedRow[];
  try {
    // company-scope: ?1 is the secret's company id.
    const res = (await c.env.DB.prepare(FEED_OUTSTANDING_PO_SQL).bind(co.id).all()) as { results?: PoFeedRow[] };
    rows = res.results ?? [];
  } catch (e) {
    return c.json({ error: "feed_read_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }
  const records = rows.map(toOutstandingPoRecord);
  return c.json({ count: records.length, records });
});

type SheetPoDates = { DocNo?: unknown; SupplierDeliveryDate1?: unknown; SupplierDeliveryDate2?: unknown; SupplierDeliveryDate3?: unknown };

app.post("/po-dates", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  let body: { updates?: unknown; dry_run?: unknown };
  try {
    body = (await c.req.json()) as { updates?: unknown; dry_run?: unknown };
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  const updates = Array.isArray(body.updates) ? (body.updates as SheetPoDates[]) : null;
  if (!updates) return c.json({ error: "bad_request", message: "updates[] required" }, 400);
  if (updates.length > UPDATES_MAX) return c.json({ error: "too_many", max: UPDATES_MAX }, 413);
  if (!isSupabaseConfigured(c.env)) return c.json({ error: "supabase not configured" }, 503);
  // A preview: everything up to the write is done and reported, nothing is
  // written or queued. The cutover's first push is run this way so the owner
  // sees what the tab would change before it changes it.
  const dryRun = body.dry_run === true;
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;

  // Validate every row first. A blank date KEEPS the ERP's date (clearing a
  // supplier date is done in the ERP, as the phase-1 rule for col O); a row
  // with nothing to write is skipped before any read.
  const results: Array<Record<string, unknown>> = updates.map(() => ({}));
  const wanted = new Map<string, { i: number[]; dates: Partial<Record<2 | 3 | 4, string>> }>();
  updates.forEach((u, i) => {
    const docNo = String(u.DocNo ?? "").trim();
    if (!docNo) {
      results[i] = { DocNo: null, skipped: "no_doc_no" };
      return;
    }
    const dates: Partial<Record<2 | 3 | 4, string>> = {};
    for (const [field, slot] of SHEET_PO_DATE_SLOTS) {
      const raw = u[field];
      if (raw == null || !String(raw).trim()) continue;
      const d = normSheetDate(raw);
      if (!d) {
        results[i] = { DocNo: docNo, skipped: "bad_date", field };
        return;
      }
      dates[slot] = d;
    }
    if (!Object.keys(dates).length) {
      results[i] = { DocNo: docNo, skipped: "nothing_to_write" };
      return;
    }
    results[i] = { DocNo: docNo, skipped: "no_order" };
    // The same Doc. No. on several lines: later rows fill slots earlier ones
    // left blank and override the ones they name (last wins per slot).
    const w = wanted.get(docNo) ?? { i: [], dates: {} };
    w.i.push(i);
    Object.assign(w.dates, dates);
    wanted.set(docNo, w);
  });

  let heads: PoHeadForSheet[] = [];
  if (wanted.size) {
    try {
      // company-scope: the last bind is the secret's company id.
      const res = (await c.env.DB.prepare(poHeadsForSheetSql(wanted.size))
        .bind(...wanted.keys(), co.id)
        .all()) as { results?: PoHeadForSheet[] };
      heads = res.results ?? [];
    } catch (e) {
      return c.json({ error: "po_read_failed", message: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  const sb = getSupabaseService(c.env);
  for (const h of heads) {
    const w = wanted.get(h.sheet_doc_no);
    if (!w) continue;
    const report = (r: Record<string, unknown>) => {
      for (const i of w.i) results[i] = { DocNo: h.sheet_doc_no, ErpDocNo: h.po_number, ...r };
    };
    if (!PO_OUTSTANDING_STATUSES.includes(h.status)) {
      report({ skipped: "po_not_outstanding", status: h.status });
      continue;
    }
    // Only a date that actually moved is written, so a daily push of the whole
    // tab queues nothing for a PO whose dates the ERP already holds.
    const moved = (Object.entries(w.dates) as Array<[string, string]>)
      .map(([slot, date]) => [Number(slot) as 2 | 3 | 4, date] as const)
      .filter(([slot, date]) => h[SUPPLIER_DATE_SLOT_COL[slot]] !== date);
    if (!moved.length) {
      report({ ok: true, unchanged: true });
      continue;
    }
    let lock: { message: string } | null;
    try {
      lock = await poHasDownstream(sb, h.id);
    } catch (e) {
      report({ error: `downstream check failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    if (lock) {
      report({ skipped: "po_locked", message: lock.message });
      continue;
    }
    if (dryRun) {
      const wouldWrite: Record<string, string> = {};
      for (const [slot, date] of moved) wouldWrite[SUPPLIER_DATE_SLOT_COL[slot]] = date;
      report({ ok: true, dry_run: true, would_write: wouldWrite, current: before_dates(h) });
      continue;
    }
    const before: Record<string, unknown> = {
      po_number: h.po_number,
      status: h.status,
      company_id: h.company_id,
      supplier_delivery_date_2: h.supplier_delivery_date_2,
      supplier_delivery_date_3: h.supplier_delivery_date_3,
      supplier_delivery_date_4: h.supplier_delivery_date_4,
    };
    const written: Record<string, string> = {};
    let failure: string | null = null;
    for (const [slot, date] of moved) {
      const r = await cascadePoSupplierDate(sb, {
        companyId: co.id,
        poId: h.id,
        before,
        slot,
        date,
        applyToLines: true,
        actor: null,
        note: "HC Delivery sheet (Outstanding PO)",
      });
      if (!r.ok) {
        failure = r.reason;
        break;
      }
      written[SUPPLIER_DATE_SLOT_COL[slot]] = date;
    }
    // ERP -> AutoCount, once per PO that moved (even a half-applied one: the
    // book should hold whatever the ERP now holds).
    let queued = false;
    if (Object.keys(written).length) {
      try {
        queued = await enqueueEdit(sb, { companyId: co.id, docType: "PO", docId: h.id, createdBy: null });
      } catch (e) {
        console.error(`delivery-sheet po-dates: AutoCount enqueue failed for ${h.po_number}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failure) report({ error: failure, written, queued });
    else report({ ok: true, written, queued });
  }

  const count = results.filter((r) => r.ok === true && r.unchanged !== true && r.dry_run !== true).length;
  return c.json({ count: results.length, written: count, dry_run: dryRun, results });
});

function before_dates(h: PoHeadForSheet): Record<string, string | null> {
  return {
    supplier_delivery_date_2: h.supplier_delivery_date_2,
    supplier_delivery_date_3: h.supplier_delivery_date_3,
    supplier_delivery_date_4: h.supplier_delivery_date_4,
  };
}

export default app;
