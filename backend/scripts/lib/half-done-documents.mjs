// Pure core of check-half-done-documents.mjs: "the document says done, but the
// stock / PO / bank behind it did not change". No database, no I/O. The script
// feeds rows in; every judgement about what counts as a mismatch lives here so
// the unit suite can hold it still.
//
// Nothing here reads or returns money. The duplicate check compares documents
// by fingerprints the SQL builds with md5(), so amounts and names never reach
// this module or the (public) Actions log.

import { isServiceLineMirror } from "./ledger-repair-core.mjs";

export const DEFAULT_DAYS = 180;
export const DEFAULT_LIMIT = 30;
export const DUPLICATE_WINDOW_SECONDS = 10;

/** Integer env value in [1, max], or the default when unset. */
export function intEnv(raw, dflt, max) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`expected an integer 1..${max}, got '${raw}'`);
  return n;
}

const num = (v) => (v == null ? 0 : Number(v));
const ts = (v) => (v == null ? null : new Date(v).getTime());

/** Hour of day in Malaysia time (UTC+8, no DST) for a timestamp. */
export function malaysiaHour(t) {
  const ms = ts(t);
  if (ms == null || Number.isNaN(ms)) return null;
  return (new Date(ms).getUTCHours() + 8) % 24;
}

/**
 * Compare what a document's goods lines say should have moved with what the
 * movements say did move, per (document, item code).
 *
 * lines:     [{ docId, docNo, createdAt, itemCode, itemGroup, qty }]
 * movements: [{ docId, itemCode, net }]  (net already signed for the document:
 *            IN for a GRN, OUT for a DO)
 * docs:      [{ docId, docNo, createdAt }] every document in scope, so a
 *            document whose lines are all service still has a home
 *
 * Service lines and lines with qty <= 0 expect nothing (the app writes nothing
 * for them). Returns one row per mismatched (doc, item):
 *   kind 'missing' — the line expects stock and no movement exists
 *   kind 'qty'     — a movement exists but its net differs from the lines
 *   kind 'extra'   — a movement for an item no goods line carries
 */
export function compareDocItems(docs, lines, movements) {
  const docById = new Map(docs.map((d) => [String(d.docId), d]));
  const expected = new Map();
  for (const l of lines) {
    if (isServiceLineMirror({ itemGroup: l.itemGroup ?? null, itemCode: l.itemCode })) continue;
    const q = num(l.qty);
    if (q <= 0) continue;
    const k = `${l.docId}|${String(l.itemCode).trim()}`;
    expected.set(k, (expected.get(k) ?? 0) + q);
  }
  const actual = new Map();
  for (const m of movements) {
    const k = `${m.docId}|${String(m.itemCode).trim()}`;
    actual.set(k, (actual.get(k) ?? 0) + num(m.net));
  }
  const out = [];
  for (const k of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(k) ?? 0;
    const have = actual.has(k) ? actual.get(k) : null;
    if (have !== null && have === want) continue;
    if (have === null && want === 0) continue;
    const [docId, itemCode] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    const d = docById.get(docId) ?? { docNo: docId, createdAt: null };
    const kind = have === null ? "missing" : want === 0 ? "extra" : "qty";
    out.push({ docId, docNo: d.docNo, createdAt: d.createdAt, itemCode, expected: want, actual: have ?? 0, kind });
  }
  return out.sort((a, b) => (ts(a.createdAt) ?? 0) - (ts(b.createdAt) ?? 0) || String(a.docNo).localeCompare(String(b.docNo)));
}

/**
 * A cancelled DO must net to zero: OUT minus its own IN corrections minus the
 * cancel's balancing ADJUSTMENT. movements: [{ docId, itemCode, net }] with net
 * already computed that way. Every non-zero (doc, item) is a residue.
 */
export function cancelledResidue(docs, movements) {
  return compareDocItems(docs, [], movements).map((r) => ({ ...r, kind: r.actual > 0 ? "not_reversed" : "over_reversed" }));
}

/** What one GRN line contributes to its PO line's received_qty (mirror of
 *  src/scm/lib/po-net-received.ts grnLineNetReceived). */
export function grnLineNetReceived(r) {
  const reopened = num(r.returned_qty) - num(r.returned_closed_qty);
  return Math.max(0, num(r.qty_accepted) - Math.max(0, reopened));
}

/** GRN statuses whose lines count toward received_qty (recomputePoReceived
 *  leaves out DRAFT and CANCELLED, nothing else). */
export const grnCountsAsReceived = (status) => status !== "DRAFT" && status !== "CANCELLED";

/**
 * poLines:  [{ poItemId, docNo, lineNo, itemCode, receivedQty, createdAt }]
 * grnLines: [{ poItemId, status, qty_accepted, returned_qty, returned_closed_qty }]
 */
export function comparePoReceived(poLines, grnLines) {
  const sum = new Map();
  for (const g of grnLines) {
    if (!grnCountsAsReceived(g.status)) continue;
    const k = String(g.poItemId);
    sum.set(k, (sum.get(k) ?? 0) + grnLineNetReceived(g));
  }
  const out = [];
  for (const p of poLines) {
    const want = sum.get(String(p.poItemId)) ?? 0;
    const have = num(p.receivedQty);
    if (want !== have) out.push({ ...p, expected: want, actual: have, kind: have > want ? "over" : "under" });
  }
  return out.sort((a, b) => (ts(a.createdAt) ?? 0) - (ts(b.createdAt) ?? 0));
}

/**
 * Rebank contras whose payment has no live entry afterwards.
 * rows: [{ jeNo, sourceType, paymentId, createdAt, paymentExists, liveEntries }]
 * A payment deleted since then needs no entry; only an existing payment with
 * zero live (posted, unreversed) entries is half-done.
 */
export function strandedRebanks(rows) {
  return rows
    .filter((r) => r.paymentExists && num(r.liveEntries) === 0)
    .map((r) => ({ ...r, docNo: `${r.jeNo} (${String(r.paymentId).slice(0, 8)})` }));
}

/**
 * Stock buckets whose open FIFO lots disagree with the movement ledger.
 * rows: [{ itemCode, warehouse, variantKey, movementNet, lotOpen, lastAt }]
 */
export function lotBucketDiffs(rows) {
  return rows
    .filter((r) => num(r.movementNet) !== num(r.lotOpen))
    .map((r) => ({
      ...r,
      createdAt: r.lastAt,
      docNo: `${r.itemCode} @ ${r.warehouse} vk=${r.variantKey ?? ""}`,
      diff: num(r.lotOpen) - num(r.movementNet),
      kind: num(r.lotOpen) > num(r.movementNet) ? "lots_above_movements" : "lots_below_movements",
    }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || String(a.docNo).localeCompare(String(b.docNo)));
}

/**
 * Double-submit clusters: documents with the same fingerprint (header + lines,
 * built by the SQL) whose created_at fall within `windowSeconds` of the
 * previous one in the chain.
 * docs: [{ docNo, fingerprint, createdAt, status }]
 * Returns [{ fingerprint, docs: [...], createdAt (first), spanSeconds }]
 */
export function duplicateClusters(docs, windowSeconds = DUPLICATE_WINDOW_SECONDS) {
  const byFp = new Map();
  for (const d of docs) {
    if (!d.fingerprint) continue;
    const list = byFp.get(d.fingerprint) ?? [];
    list.push(d);
    byFp.set(d.fingerprint, list);
  }
  const out = [];
  for (const [fingerprint, list] of byFp) {
    if (list.length < 2) continue;
    list.sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
    let cur = [list[0]];
    const flush = () => {
      if (cur.length > 1) {
        out.push({
          fingerprint, docs: cur, createdAt: cur[0].createdAt,
          docNo: cur.map((d) => d.docNo).join(" + "),
          spanSeconds: Math.round((ts(cur[cur.length - 1].createdAt) - ts(cur[0].createdAt)) / 100) / 10,
        });
      }
    };
    for (let i = 1; i < list.length; i++) {
      if (ts(list[i].createdAt) - ts(list[i - 1].createdAt) <= windowSeconds * 1000) cur.push(list[i]);
      else { flush(); cur = [list[i]]; }
    }
    flush();
  }
  return out.sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
}

/**
 * Count, oldest and newest date, distinct documents, and the first `limit`
 * examples. rows carry docNo and createdAt.
 */
export function summarise(rows, limit) {
  const dates = rows.map((r) => ts(r.createdAt)).filter((x) => x != null && !Number.isNaN(x));
  const iso = (ms) => (ms == null ? "-" : new Date(ms).toISOString().slice(0, 10));
  return {
    count: rows.length,
    documents: new Set(rows.map((r) => r.docId ?? r.docNo)).size,
    oldest: iso(dates.length ? Math.min(...dates) : null),
    newest: iso(dates.length ? Math.max(...dates) : null),
    examples: rows.slice(0, limit),
  };
}

/**
 * Failures by Malaysia hour beside all documents by hour, so a cluster at a
 * busy hour can be told apart from "that is simply when work happens".
 * Each document counts once. Returns 24 rows.
 */
export function hourProfile(failedDocs, allDocs) {
  const tally = (docs) => {
    const seen = new Set();
    const h = Array(24).fill(0);
    for (const d of docs) {
      const key = String(d.docId ?? d.docNo);
      if (seen.has(key)) continue;
      seen.add(key);
      const hr = malaysiaHour(d.createdAt);
      if (hr != null) h[hr] += 1;
    }
    return h;
  };
  const f = tally(failedDocs);
  const a = tally(allDocs);
  return f.map((n, hour) => ({ hour, failed: n, all: a[hour], pct: a[hour] ? Math.round((1000 * n) / a[hour]) / 10 : 0 }));
}
