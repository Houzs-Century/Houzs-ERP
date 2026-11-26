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
import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { timingSafeEqualStr } from "../services/auth";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";
import { intakeCompany } from "../lib/intake-company";
import {
  EM_WRITEBACK_COLS,
  EM_WRITEBACK_MAX,
  emTransporterUpdateSql,
  FEED_BALANCE_COLLECTION_SQL,
  FEED_EM_TRANSPORTER_SQL,
  FEED_EPOCH,
  FEED_MAX_LIMIT,
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
  FEED_ASSR_CONTACTS_SQL,
  FEED_ASSR_LEGS_SQL,
  toAssrContactRecord,
  toAssrLegRecords,
  type AssrFeedRow,
  type AssrLegKind,
  type AssrLegRecord,
} from "../lib/delivery-sheet-assr-feed";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { SUPPLIER_DATE_SLOT_COL, cascadePoSupplierDate } from "../scm/lib/po-supplier-date-cascade";
import { poHasDownstream } from "../scm/lib/downstream-lock";
import { enqueueEdit } from "../scm/lib/autocount-outbox";
import { sheetUsageCounter, type SheetUsageVars } from "../lib/sheet-sync-usage";

const app = new Hono<{ Bindings: Env; Variables: SheetUsageVars }>();

app.use("*", sheetUsageCounter);

const SHEET_KEY_COMPANY = "HOUZS";

async function badSheetKey(c: any): Promise<Response | null> {
  const provided = c.req.header("X-Intake-Key") || "";
  const expected = c.env.SHEET_SYNC_KEY || "";
  if (expected && timingSafeEqualStr(provided, expected)) {
    c.set("sheetAuthed", true);
    return null;
  }
  const limited = await checkRateLimit(c, "intake_badkey", clientIp(c), 10, 900);
  await new Promise((r) => setTimeout(r, 250));
  if (limited) return limited;
  return c.json({ error: "unauthorized" }, 401);
}

async function updatesKeyCompany(c: any): Promise<string | Response> {
  const provided = c.req.header("X-Intake-Key") || "";
  const key2990 = c.env.SHEET_SYNC_KEY_2990 || "";
  if (key2990 && timingSafeEqualStr(provided, key2990)) {
    c.set("sheetAuthed", true);
    return "2990";
  }
  return (await badSheetKey(c)) ?? SHEET_KEY_COMPANY;
}

async function sheetCompanyId(c: any, code = SHEET_KEY_COMPANY): Promise<{ id: number } | { refusal: Response }> {
  const keyCo = await intakeCompany(c.env.DB, code);
  if (keyCo.id == null) {
    return {
      refusal: c.json(
        {
          error: "company_unresolved",
          message: `No company is configured for code ${code}, so this sync cannot be scoped and is refused.`,
        },
        503,
      ),
    };
  }
  return { id: keyCo.id };
}

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
  c.set("usageRows", records.length);
  return c.json({
    count: records.length,
    limit,
    since,
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
  c.set("usageRows", loaded.records.length);
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
  c.set("usageRows", loaded.records.length);
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
  c.set("usageRows", records.length);
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

  const deliveredSet = new Set<string>([...SO_DELIVERED_OR_BEYOND]);
  const stateByKey = new Map<string, { ErpDocNo: string; Remark2: string | null; Ready: boolean; Status: string; Deletable: boolean }>();
  for (const h of heads) {
    const remark2 = resolveSheetRemark2(h.remark2, linesByDoc.get(h.doc_no) ?? []);
    const ready = isSheetReady(remark2);
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
  c.set("usageRows", results.length);
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
  c.set("usageRows", loaded.records.length);
  return c.json({ count: loaded.records.length, requested: docNos.length, records: loaded.records });
});

/* East-Malaysia transporter feed (owner 2026-11-19): the ESB ("EM Delivery")
   and BS ("SABAH EM Delivery") transporter sheets are fed DIRECTLY from the ERP
   now, not from the HC Delivery master sheet's EM Order tab (the master -> ESB /
   BS push is retired). Full state, no cursor — the transporter Apps Script
   updates the rows it already has and APPENDS the eligible ones each run. One
   list, two kinds:
     - SO rows: East (SBH / SRW) live orders, each carrying `Ready` — the owner's
       append gate ("只收 ready 的", 2026-11-19). Region is re-checked here so a
       Singapore-addressed SRW order (Region SG) is dropped.
     - ASSR legs: the East own-team service / pickup / delivery-back legs that
       already show on these sheets (keyed SO-xxxx-SERVICE etc.), via the same
       own-team-gated feed /assr-legs uses, read full-state here.
   `Appendable` is what the Apps Script appends on: `Ready` for an SO row, always
   for a leg (its own-team gate is already applied in SQL). Updates to rows the
   sheet already holds are never gated. The transporter-owned freight columns
   (consignment, vessel, ETD/ETA, BS delivery date) are the sheets' own and are
   neither sent nor read back — the ERP has never stored them. */
app.get("/em-transporter", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;

  const loaded = await loadRecords(c, FEED_EM_TRANSPORTER_SQL, [co.id]);
  if ("refusal" in loaded) return loaded.refusal;
  const soRecords = loaded.records
    .filter((r) => r.Region === "EAST")
    .map((r) => ({ ...r, Kind: null as AssrLegKind | null, Appendable: r.Ready }));

  let legRecords: Array<AssrLegRecord & { Appendable: boolean }> = [];
  try {
    const res = (await c.env.DB.prepare(FEED_ASSR_LEGS_SQL).bind(FEED_EPOCH, FEED_MAX_LIMIT).all()) as { results?: AssrFeedRow[] };
    legRecords = (res.results ?? [])
      .flatMap(toAssrLegRecords)
      .filter((r) => r.Region === "EAST")
      .map((r) => ({ ...r, Appendable: true }));
  } catch (e) {
    return c.json({ error: "assr_read_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }

  const records = [...soRecords, ...legRecords];
  c.set("usageRows", records.length);
  return c.json({ count: records.length, so: soRecords.length, legs: legRecords.length, records });
});

/* East-MY transporter WRITE-BACK (owner 2026-11-20): the ESB / BS sheets' own
   edits flow back into the ERP's Delivery Planning. These HC fields live on the
   DELIVERY ORDER, so each sheet row (keyed on the AutoCount DocNo) resolves to
   its order's latest live DO and that DO is updated — the board's "EM Order"
   layout then shows them. Company-scoped by the secret; a blank never clears
   (emTransporterUpdateSql). ESB writes the shipping fields, BS the delivery
   ones; both post here. */
app.post("/em-transporter-updates", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;

  let body: any;
  try { body = await c.req.json(); } catch { body = null; }
  const raw = Array.isArray(body?.updates) ? (body.updates as unknown[]) : null;
  if (!raw) return c.json({ error: "bad_body", message: "expected { updates: [{ DocNo, ... }] }" }, 400);

  const byDoc = new Map<string, Record<string, unknown>>();
  for (const u of raw) {
    const rec = (u ?? {}) as Record<string, unknown>;
    const doc = String(rec.DocNo ?? "").trim();
    if (doc) byDoc.set(doc, rec);
  }
  const rows = [...byDoc.entries()];
  if (!rows.length) return c.json({ error: "no_updates" }, 400);
  if (rows.length > EM_WRITEBACK_MAX) return c.json({ error: "too_many", max: EM_WRITEBACK_MAX }, 413);

  const binds: unknown[] = [];
  for (const [doc, rec] of rows) {
    binds.push(doc);
    for (const { key, cast } of EM_WRITEBACK_COLS) {
      const v = rec[key];
      if (v === undefined || v === null || String(v).trim() === "") { binds.push(null); continue; }
      binds.push(cast === "date" ? normSheetDate(v) : String(v));
    }
  }
  binds.push(co.id);

  let updated: Array<{ sheet_doc_no: string }>;
  try {
    const res = (await c.env.DB.prepare(emTransporterUpdateSql(rows.length)).bind(...binds).all()) as { results?: Array<{ sheet_doc_no: string }> };
    updated = res.results ?? [];
  } catch (e) {
    return c.json({ error: "write_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }
  const updatedDocs = new Set(updated.map((r) => r.sheet_doc_no));
  const results = rows.map(([doc]) => ({ DocNo: doc, updated: updatedDocs.has(doc) }));
  c.set("usageRows", updated.length);
  return c.json({
    count: results.length,
    updated: updated.length,
    not_updated: results.filter((r) => !r.updated).map((r) => r.DocNo),
    results,
  });
});

/* Service-Case (ASSR) legs (owner 2026-09-17): each open case's inspection /
   pickup / delivery-back leg that OUR OWN team drives is emitted here so the
   sheet appends it beside the Sales-Order rows for the same region. Own-team
   gated by design (see delivery-sheet-assr-feed.ts); the Delivery Planning
   board stays un-gated, so board and sheet intentionally differ. Incremental,
   same `since`/`limit` cursor as /so-since — but the LIMIT counts CASES, each
   expanding to up to three leg rows. */
async function assrCasePage<R>(c: Context<{ Bindings: Env; Variables: SheetUsageVars }>, sql: string, toRecords: (row: AssrFeedRow) => R[]) {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const since = parseSince(c.req.query("since"));
  if (!since) return c.json({ error: "bad_since", message: "since must be a timestamp (yyyy-mm-dd hh:mm:ss[.ffffff][+hh])" }, 400);
  const limit = parseLimit(c.req.query("limit"));

  let cases: AssrFeedRow[];
  try {
    // company-scope: none by owner ruling — Service Cases are not split by company (see FEED_ASSR_LEGS_SQL).
    const res = (await c.env.DB.prepare(sql).bind(since, limit).all()) as { results?: AssrFeedRow[] };
    cases = res.results ?? [];
  } catch (e) {
    return c.json({ error: "feed_read_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }
  const records = cases.flatMap(toRecords);
  c.set("usageRows", records.length);
  return c.json({
    count: records.length,
    cases: cases.length,
    limit,
    since,
    next_since: cases.length ? cases[cases.length - 1]!.last_modified_text : null,
    has_more: cases.length >= limit,
    records,
  });
}

app.get("/assr-legs", (c) => assrCasePage(c, FEED_ASSR_LEGS_SQL, toAssrLegRecords));

app.get("/assr-contacts", (c) => assrCasePage(c, FEED_ASSR_CONTACTS_SQL, (row) => [toAssrContactRecord(row)]));

type SheetUpdate = { DocNo?: unknown; Remark4?: unknown; ExpiryDate?: unknown };

app.post("/updates", async (c) => {
  const keyCode = await updatesKeyCompany(c);
  if (typeof keyCode !== "string") return keyCode;
  let body: { updates?: unknown };
  try {
    body = (await c.req.json()) as { updates?: unknown };
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  const updates = Array.isArray(body.updates) ? (body.updates as SheetUpdate[]) : null;
  if (!updates) return c.json({ error: "bad_request", message: "updates[] required" }, 400);
  if (updates.length > UPDATES_MAX) return c.json({ error: "too_many", max: UPDATES_MAX }, 413);
  const co = await sheetCompanyId(c, keyCode);
  if ("refusal" in co) return co.refusal;

  const results: Array<Record<string, unknown>> = updates.map(() => ({}));
  const rows: Array<{ i: number; docNo: string; remark4: string | null; expiry: string | null }> = [];
  updates.forEach((u, i) => {
    const docNo = String(u.DocNo ?? "").trim();
    if (!docNo) {
      results[i] = { DocNo: null, skipped: "no_doc_no" };
      return;
    }
    const remark4 = u.Remark4 == null ? null : String(u.Remark4).trim();
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
  c.set("usageRows", results.length);
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
  c.set("usageRows", records.length);
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
  const dryRun = body.dry_run === true;
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;

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
        requireEmpty: false,
      });
      if (!r.ok) {
        failure = r.reason;
        break;
      }
      written[SUPPLIER_DATE_SLOT_COL[slot]] = date;
    }
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
  c.set("usageRows", results.length);
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
