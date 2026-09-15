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
  FEED_SINCE_SQL,
  UPDATE_FROM_SHEET_SQL,
  UPDATES_MAX,
  feedLinesSql,
  normSheetDate,
  parseLimit,
  parseSince,
  toSheetRecord,
  type FeedHeadRow,
  type FeedLineRow,
} from "../lib/delivery-sheet-feed";

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

app.get("/so-since", async (c) => {
  const denied = await badSheetKey(c);
  if (denied) return denied;
  const since = parseSince(c.req.query("since"));
  if (!since) return c.json({ error: "bad_since", message: "since must be a timestamp (yyyy-mm-dd hh:mm:ss[.ffffff][+hh])" }, 400);
  const limit = parseLimit(c.req.query("limit"));
  const co = await sheetCompanyId(c);
  if ("refusal" in co) return co.refusal;

  let heads: FeedHeadRow[];
  try {
    // company-scope: ?1 is the secret's company id, resolved from the master above.
    const res = await c.env.DB.prepare(FEED_SINCE_SQL).bind(co.id, since, limit).all<FeedHeadRow>();
    heads = res.results ?? [];
  } catch (e) {
    return c.json({ error: "feed_read_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }

  // The lines exist only to derive Remarks 2 for orders whose header carries
  // none. A failed read refuses the page rather than writing blank remarks.
  const linesByDoc = new Map<string, FeedLineRow[]>();
  const docNos = heads.map((h) => h.doc_no);
  for (let i = 0; i < docNos.length; i += 100) {
    const chunk = docNos.slice(i, i + 100);
    try {
      const res = await c.env.DB.prepare(feedLinesSql(chunk.length)).bind(...chunk).all<FeedLineRow>();
      for (const l of res.results ?? []) {
        const arr = linesByDoc.get(l.doc_no) ?? [];
        arr.push(l);
        linesByDoc.set(l.doc_no, arr);
      }
    } catch (e) {
      return c.json({ error: "lines_read_failed", message: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  const records = heads.map((h) => toSheetRecord(h, linesByDoc.get(h.doc_no) ?? []));
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

  const results: Array<Record<string, unknown>> = [];
  for (const u of updates) {
    const docNo = String(u.DocNo ?? "").trim();
    if (!docNo) {
      results.push({ DocNo: null, skipped: "no_doc_no" });
      continue;
    }
    // A Remark4 that is PRESENT is written as-is, blank included — clearing
    // col A is a real edit. An ABSENT Remark4 keeps the ERP's value.
    const remark4 = u.Remark4 == null ? null : String(u.Remark4).trim();
    // A blank date keeps the ERP's date: the old daily PO sync nulled dates
    // stored as text, and this leg must not repeat that.
    const expiry = normSheetDate(u.ExpiryDate);
    if (u.ExpiryDate != null && String(u.ExpiryDate).trim() && !expiry) {
      results.push({ DocNo: docNo, skipped: "bad_date" });
      continue;
    }
    if (remark4 == null && !expiry) {
      results.push({ DocNo: docNo, skipped: "nothing_to_write" });
      continue;
    }
    try {
      // company-scope: ?3 is the secret's company id; the row is found by the sheet's AutoCount number OR the ERP number within it.
      const res = await c.env.DB.prepare(UPDATE_FROM_SHEET_SQL)
        .bind(remark4, expiry, co.id, docNo)
        .all<{ doc_no: string }>();
      const hit = res.results?.[0];
      if (!hit) results.push({ DocNo: docNo, skipped: "no_order" });
      else results.push({ DocNo: docNo, ErpDocNo: hit.doc_no, ok: true, remark4, delivery_date: expiry });
    } catch (e) {
      results.push({ DocNo: docNo, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const written = results.filter((r) => r.ok === true).length;
  return c.json({ count: results.length, written, results });
});

export default app;
