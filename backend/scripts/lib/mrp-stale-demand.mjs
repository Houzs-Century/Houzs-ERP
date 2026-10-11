/* Shared by check-mrp-stale-demand.mjs (read-only report) and
   close-stale-sales-orders.mjs (plan/apply close tool): run the CANONICAL MRP
   engine without letting it write, read the AutoCount book snapshot, and say
   what state the book holds each sales-order line in.

   Both tools must agree on "which lines MRP still plans for" and "what the book
   says about them" — two copies of this code would be two answers.

   NO SHEBANG — imported by tests (CLAUDE.md R101). The engine import is dynamic
   so a test that only needs the pure helpers never loads mrp.ts. */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A pgrest shim that throws on every write verb, so a read-only tool cannot
 *  write through the engine even if the engine grows a write. */
export function readOnlyGuard(shim) {
  const WRITES = new Set(["update", "insert", "upsert", "delete", "rpc"]);
  return new Proxy(shim, {
    get(target, prop, recv) {
      if (prop === "rpc") return () => { throw new Error("read-only engine run: rpc refused"); };
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (table) => {
        const b = target.from(table);
        return new Proxy(b, {
          get(bt, p, r) {
            if (WRITES.has(String(p))) return () => { throw new Error(`read-only engine run: ${String(p)} on ${table} refused`); };
            return Reflect.get(bt, p, r);
          },
        });
      };
    },
  });
}

/** The committed AutoCount snapshot (SO headers + SO lines, and the DO lines
 *  that were transferred from an SO line). */
export function loadBook(file = path.join(HERE, "..", "data", "ac-convert-edges.json.gz")) {
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
  const H = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
  const headers = new Map(snap.types.SO.headers.map((h) => [h[H.docNo], { date: h[H.docDate], cancelled: h[H.cancelled] === "T" }]));
  const lines = new Map();
  for (const r of snap.types.SO.lines) {
    lines.set(String(r[L.dtlKey]), { docNo: r[L.docNo], item: r[L.itemKey], qty: Number(r[L.qty] || 0), toDo: Number(r[L.transferedQty] || 0), transferable: r[L.transferable] });
  }
  /* Which book DO / invoice was transferred from an SO — evidence for "the book
     says delivered". The snapshot's fromDocDtlKey is blank on DO lines, so the
     link is by document number (SO docNo -> DO/IV docNos), not by line. */
  const transfersBySo = new Map();
  for (const t of ["DO", "IV"]) {
    for (const r of snap.types[t]?.lines ?? []) {
      if (r[L.fromDocType] !== "SO" || !r[L.fromDocNo]) continue;
      const list = transfersBySo.get(r[L.fromDocNo]) ?? [];
      if (!list.includes(r[L.docNo])) list.push(r[L.docNo]);
      transfersBySo.set(r[L.fromDocNo], list);
    }
  }
  return { exportedAt: snap.exported_at, headers, lines, transfersBySo };
}

/** What the book says about one ERP sales-order line. */
export function bookState(book, { ac_key, ac_doc, doc_no }) {
  const bookDoc = String(ac_doc ?? String(doc_no).replace(/^HC-/, "")).trim().toUpperCase();
  if (!ac_key && !book.headers.has(bookDoc)) return "NOT_IN_BOOK";
  if (book.headers.get(bookDoc)?.cancelled) return "BOOK_CANCELLED";
  const b = ac_key ? book.lines.get(String(ac_key)) : null;
  if (!b) return "BOOK_LINE_NOT_FOUND";
  if (b.qty > 0 && b.toDo >= b.qty) return "BOOK_DELIVERED";
  if (b.toDo > 0) return "BOOK_PARTIAL";
  return "BOOK_OPEN";
}

export const dateState = (d, today) => (!d ? "UNDATED" : d < today ? "EXPIRED" : "FUTURE");

/** Run computeMrp read-only and return every sales-order line it still plans
 *  for, keyed by so item id. Throws when the engine cannot run cleanly. */
export async function plannedSoLines(sql, companyId) {
  const { computeMrp } = await import("../../src/scm/routes/mrp.ts");
  const { pgrestShim } = await import("./pgrest-shim.mjs");
  const shim = pgrestShim(sql, "scm");
  const mrp = await computeMrp(readOnlyGuard(shim), {
    catFilter: null, whFilter: null, includeUndated: true, companyId,
    leadBuffers: { supplierBufferDays: {}, seasonBufferDays: {} },
  });
  if (shim.__gaps?.length) throw new Error(`engine did not run cleanly — shim gaps: ${shim.__gaps.join(" | ")}`);
  const planned = new Map();
  for (const sku of mrp.skus) for (const l of sku.lines) planned.set(l.soItemId, { qty: l.qty, stock: l.stockQty ?? 0, short: l.shortageQty ?? 0, po: l.poNumber, delivery: l.deliveryDate, cat: sku.category ?? sku.itemGroup ?? null });
  for (const s of mrp.sofaSets) planned.set(s.soItemId, { qty: s.qty, stock: s.stockQty ?? 0, short: s.shortageQty ?? 0, po: s.poNumber, delivery: s.deliveryDate, cat: "sofa" });
  return planned;
}

export const todayMyt = async (sql) => (await sql`SELECT to_char((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD') AS today`)[0].today;
