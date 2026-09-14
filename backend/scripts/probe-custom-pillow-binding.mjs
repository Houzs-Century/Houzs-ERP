// probe-custom-pillow-binding — READ-ONLY. "Is a custom pillow allocated by its
// own colour, or pooled by SKU?"
//
// Owner, 2026-09-14: 「你看一下我们的 Square Pillow 跟 Long Pillow。正常来说，他们如果有
// 选颜色，在 SpecialOrder 里的规格也是会出来的。因为它是 accessories，你也是 still 要根据
// 它的规格来分配的，不是吗？」
// Purchasing (Kathy), same day: "Square Pillow Custom & Long Pillow custom can't
// use FIFO, because have custom choose colour. Example HC-SO-013384 pillow PO is
// PO010084, no slot for HC-SO-013496 / 013236 ... system not allowed to order
// because already have PO", and "this PO has been double issued PO for Long
// pillow PO2609-091 & PO2609-101".
//
// WHAT THIS PRINTS
//   1. per named sales order: every SQUARE PILLOW / LONG PILLOW line — the colour
//      it carries (`variants.extraAddonNote`, the Special Order text) and every
//      purchase-order line pointing at it through `so_item_id`, dead or alive;
//   2. per named purchase order: every pillow line and the sales-order line +
//      colour it points at;
//   3. WHAT THE REAL ENGINE ANSWERS — the canonical `computeMrp` +
//      `mrpLineCoverage` over lib/pgrest-shim.mjs (the same PO number the SO
//      screen's coverage endpoint and the MRP page name), for EVERY live
//      company-1 custom pillow line: whether the PO it names is the line's OWN
//      (`so_item_id`) or somebody else's, and whether a line with its own PO
//      open is reported SHORT;
//   4. the class, company-wide: sales-order lines ordered on more than one live
//      purchase-order line (the double PO), and purchase-order lines whose
//      colour text disagrees with the sales-order line they point at.
//
// READ-ONLY. SELECTs only; the engine runs behind a guard that throws on any
// write method before the shim sees it, and the session is set READ ONLY.
// Exit 0 for every legitimate answer; non-zero only when the database cannot be
// reached.
//
// RE-RUN: read-only and idempotent — every run re-reads the live rows.
//
// Usage: npx tsx scripts/probe-custom-pillow-binding.mjs
//   SOS="HC-SO-013384,HC-SO-013496,HC-SO-013236,HC-SO-013503"
//   POS="HC-PO-010083,HC-PO-010084,HC-PO-009945,HC-PO-2609-091,HC-PO-2609-101"
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const COMPANY = Number(process.env.COMPANY || 1);
const ENGINE = (process.env.ENGINE ?? "1") !== "0";
const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const SOS = list(process.env.SOS || "HC-SO-013384,HC-SO-013496,HC-SO-013236,HC-SO-013503");
const POS = list(process.env.POS || "HC-PO-010083,HC-PO-010084,HC-PO-009945,HC-PO-2609-058,HC-PO-2609-065,HC-PO-2609-053,HC-PO-2609-091,HC-PO-2609-101");
/* The population is the Sofa Accessory CATEGORY in the product master (owner
   2026-09-14, 「这些sku全部都要处理」), not a typed code list: a SKU moved into it
   later is measured with nobody editing this file. Read in main(). */
let CODES = [];

const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
/* The colour a line names: the fabric code stock keys on (Sofa Accessory, 2026-09-14),
   else the Special Order text it used to live in. */
const colour = (v) => String((v && typeof v === "object" ? (v.fabricCode || v.extraAddonNote) : "") ?? "").trim();
const { SO_TERMINAL_STATES } = await import("./lib/so-terminal-states.mjs");
const PO_DEAD = ["CANCELLED", "DRAFT"];

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });

async function main() {
  try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; } catch (e) { say(`could not set READ ONLY (${e.message}) — every statement is a SELECT`); }
  const [ro] = await sql`SELECT current_setting('transaction_read_only') AS ro, now()::text AS at`;
  CODES = (await sql`SELECT upper(btrim(code)) AS code FROM scm.mfg_products WHERE company_id = ${COMPANY} AND category::text = 'FABRIC_ACCESSORY' ORDER BY 1`).map((r) => r.code);
  if (CODES.length === 0) { notice(`company ${COMPANY} has NO Sofa Accessory (FABRIC_ACCESSORY) SKU — nothing to measure, and a zero below would mean nothing`); await sql.end(); return; }
  notice(`Sofa Accessory SKUs (${CODES.length}): ${CODES.join(", ")}`);
  notice(`=== Sofa Accessory binding — READ-ONLY (transaction_read_only=${ro.ro}) · read at ${ro.at} · company ${COMPANY} ===`);

  await soSection();
  await poSection();
  await engineSection();
  await census();
  await sql.end();
}

async function soSection() {
  say("");
  notice("──────── 1. SALES-ORDER PILLOW LINES and the PO lines that point at them ────────");
  const rows = await sql`
    SELECT h.doc_no, h.status::text AS so_status, h.processing_date::text AS proc,
           h.customer_delivery_date::text AS delivery,
           i.id::text AS id, i.line_no, i.item_code, i.qty, i.stock_status::text AS stock, i.variants
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.doc_no = ANY(${SOS}) AND upper(btrim(i.item_code)) = ANY(${CODES}) AND NOT i.cancelled
     ORDER BY h.doc_no, i.line_no`;
  const ids = rows.map((r) => r.id);
  const links = ids.length ? await sql`
    SELECT it.so_item_id::text AS so_item_id, p.po_number, p.status::text AS st, p.created_at::text AS created,
           it.qty, coalesce(it.received_qty, 0) AS rcv, it.from_mrp, it.variants, it.description2
      FROM scm.purchase_order_items it JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
     WHERE it.so_item_id = ANY(${ids}::uuid[]) ORDER BY p.created_at` : [];
  for (const r of rows) {
    const ls = links.filter((l) => l.so_item_id === r.id);
    say(`${pad(r.doc_no, 14)} ln ${pad(r.line_no, 3)} ${pad(r.item_code, 14)} qty ${pad(r.qty, 3)} ${pad(r.stock, 8)} colour "${colour(r.variants)}" · SO ${r.so_status} · proceeded ${r.proc ?? "NO"} · delivery ${r.delivery ?? "—"} · line ${r.id}`);
    if (!ls.length) say("      no purchase-order line points at this line");
    for (const l of ls) {
      say(`      <- ${pad(l.po_number, 15)} ${pad(l.st, 18)} qty ${l.qty} recv ${l.rcv} · from_mrp=${l.from_mrp} · created ${l.created.slice(0, 16)} · PO colour "${colour(l.variants) || String(l.description2 ?? "").trim()}"`);
    }
  }
}

async function poSection() {
  say("");
  notice("──────── 2. PURCHASE-ORDER PILLOW LINES and where each points ────────");
  const rows = await sql`
    SELECT p.po_number, p.status::text AS st, p.created_at::text AS created, left(coalesce(p.notes, ''), 80) AS notes,
           it.line_no, it.item_code, it.qty, coalesce(it.received_qty, 0) AS rcv, it.from_mrp, it.variants, it.description2,
           s.doc_no AS link_doc, s.line_no AS link_line, s.variants AS link_var
      FROM scm.purchase_orders p JOIN scm.purchase_order_items it ON it.purchase_order_id = p.id
      LEFT JOIN scm.mfg_sales_order_items s ON s.id = it.so_item_id
     WHERE p.po_number = ANY(${POS}) AND upper(btrim(it.item_code)) = ANY(${CODES})
     ORDER BY p.po_number, it.line_no`;
  for (const r of rows) {
    say(`${pad(r.po_number, 15)} ${pad(r.st, 18)} ln ${pad(r.line_no, 3)} ${pad(r.item_code, 14)} qty ${r.qty} recv ${r.rcv} · from_mrp=${r.from_mrp} · created ${r.created.slice(0, 16)} · PO colour "${colour(r.variants) || String(r.description2 ?? "").trim()}" -> ${r.link_doc ?? "NO LINK"} ln ${r.link_line ?? "—"} colour "${colour(r.link_var)}" · ${r.notes}`);
  }
}

async function engineSection() {
  say("");
  notice("──────── 3. WHAT THE ENGINE ANSWERS (canonical computeMrp + mrpLineCoverage) ────────");
  if (!ENGINE) { notice("ENGINE=0 — skipped"); return; }
  let cov;
  const t0 = Date.now();
  try {
    const { computeMrp, mrpLineCoverage } = await import("../src/scm/routes/mrp.ts");
    const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
    const shim = pgrestShim(sql, "scm");
    const mrp = await computeMrp(readOnlyGuard(shim), {
      catFilter: null, whFilter: null, includeUndated: true, companyId: COMPANY,
      leadBuffers: { supplierBufferDays: {}, seasonBufferDays: {} },
    });
    if (shim.__gaps?.length) { notice(`ENGINE DID NOT RUN CLEANLY — shim gaps: ${shim.__gaps.join(" | ")}. Section 3 is NOT evidence.`); return; }
    cov = mrpLineCoverage(mrp);
    notice(`engine ran in ${Math.round((Date.now() - t0) / 1000)}s · ${mrp.skus.length} SKU rows`);
  } catch (e) {
    notice(`ENGINE DID NOT RUN — ${e.message}. Section 3 is NOT evidence.`);
    return;
  }
  const lines = await sql`
    SELECT i.id::text AS id, i.doc_no, i.line_no, i.item_code, i.qty, i.variants, h.customer_delivery_date::text AS delivery,
           (SELECT coalesce(json_agg(json_build_object('po', p.po_number, 'qty', it.qty, 'rcv', coalesce(it.received_qty, 0))), '[]'::json)
              FROM scm.purchase_order_items it JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
             WHERE it.so_item_id = i.id AND p.status::text <> ALL(${PO_DEAD})) AS own
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${COMPANY} AND upper(btrim(i.item_code)) = ANY(${CODES}) AND NOT i.cancelled
       AND h.status::text <> ALL(${SO_TERMINAL_STATES})
     ORDER BY i.item_code, h.customer_delivery_date NULLS LAST, i.doc_no`;
  let foreign = 0, shortWithOwn = 0, ownOk = 0, noEntry = 0;
  const flagged = [];
  for (const l of lines) {
    const c = cov.get(l.id);
    const own = (l.own ?? []).map((o) => o.po);
    const ownOpen = (l.own ?? []).reduce((s, o) => s + Math.max(0, Number(o.qty) - Number(o.rcv)), 0);
    let verdict;
    if (!c) { noEntry += 1; verdict = "no engine entry (delivered / out of view)"; }
    else if (c.po && !own.includes(c.po)) { foreign += 1; verdict = `MIS-ASSIGNED: engine names ${c.po}, which is NOT this line's purchase order${own.length ? ` (own: ${own.join(", ")})` : " (it has none)"}`; }
    else if (c.source === "shortage" && ownOpen >= Number(l.qty)) { shortWithOwn += 1; verdict = `SHORT while its own PO ${own.join(", ")} has ${ownOpen} open`; }
    else if (c.source === "shortage" && ownOpen > 0) { ownOk += 1; verdict = `ok (short: its own PO ${own.join(", ")} holds only ${ownOpen} of ${l.qty})`; }
    else { ownOk += 1; verdict = `ok (${c.source}${c.po ? ` ${c.po}` : ""})`; }
    const named = SOS.includes(l.doc_no);
    if (named || verdict.startsWith("MIS") || verdict.startsWith("SHORT")) flagged.push({ l, verdict, named });
  }
  for (const { l, verdict, named } of flagged) {
    say(`${named ? "*" : " "} ${pad(l.doc_no, 14)} ln ${pad(l.line_no, 3)} ${pad(l.item_code, 14)} qty ${pad(l.qty, 3)} delivery ${pad(l.delivery ?? "—", 10)} colour "${colour(l.variants)}" -> ${verdict}`);
  }
  notice(`engine verdict over ${lines.length} live company-${COMPANY} Sofa Accessory lines: ${foreign} covered by SOMEBODY ELSE's PO · ${shortWithOwn} short while their own PO is open · ${ownOk} ok · ${noEntry} no entry`);
}

async function census() {
  say("");
  notice(`──────── 4. CLASS SIZE, company ${COMPANY} ────────`);
  const dbl = await sql`
    SELECT s.doc_no, s.line_no, s.item_code, s.qty, s.variants,
           json_agg(json_build_object('po', p.po_number, 'st', p.status::text, 'qty', it.qty, 'rcv', coalesce(it.received_qty, 0), 'mrp', it.from_mrp, 'at', p.created_at::text) ORDER BY p.created_at) AS pos,
           sum(it.qty) AS ordered
      FROM scm.purchase_order_items it
      JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
      JOIN scm.mfg_sales_order_items s ON s.id = it.so_item_id
      JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
     WHERE h.company_id = ${COMPANY} AND upper(btrim(s.item_code)) = ANY(${CODES})
       AND p.status::text <> ALL(${PO_DEAD}) AND NOT s.cancelled
     GROUP BY s.id, s.doc_no, s.line_no, s.item_code, s.qty, s.variants
    HAVING sum(it.qty) > s.qty
     ORDER BY s.doc_no`;
  notice(`A. ${dbl.length} Sofa Accessory sales-order line(s) ordered MORE than their quantity on live purchase orders`);
  for (const d of dbl) {
    say(`   ${pad(d.doc_no, 14)} ln ${pad(d.line_no, 3)} ${pad(d.item_code, 14)} qty ${d.qty} ordered ${d.ordered} colour "${colour(d.variants)}": ${d.pos.map((p) => `${p.po} ${p.st} ${p.qty}/${p.rcv} mrp=${p.mrp} ${String(p.at).slice(0, 10)}`).join(" | ")}`);
  }
  const mism = await sql`
    SELECT p.po_number, p.status::text AS st, it.line_no, it.item_code, it.variants, it.description2,
           s.doc_no, s.line_no AS sl, s.item_code AS s_code, s.variants AS s_var
      FROM scm.purchase_order_items it
      JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
      JOIN scm.mfg_sales_order_items s ON s.id = it.so_item_id
     WHERE p.company_id = ${COMPANY} AND upper(btrim(it.item_code)) = ANY(${CODES})
       AND p.status::text <> ALL(${PO_DEAD})`;
  const norm = (t) => String(t ?? "").toUpperCase().replace(/^SPECIAL:\s*/, "").replace(/[^A-Z0-9]/g, "");
  const bad = mism.filter((m) => {
    const poText = norm(colour(m.variants) || m.description2);
    const soText = norm(colour(m.s_var));
    return upper(m.item_code) !== upper(m.s_code) || (soText && poText && !poText.includes(soText) && !soText.includes(poText)) || (soText && !poText);
  });
  notice(`B. ${bad.length} of ${mism.length} live linked Sofa Accessory PO line(s) disagree with the sales-order line they point at (item code, or colour text; a PO line with NO colour for a coloured SO line counts)`);
  for (const m of bad) {
    say(`   ${pad(m.po_number, 15)} ${pad(m.st, 18)} ln ${pad(m.line_no, 3)} ${pad(m.item_code, 14)} PO colour "${colour(m.variants) || String(m.description2 ?? "").trim()}" -> ${m.doc_no} ln ${m.sl} ${m.s_code} colour "${colour(m.s_var)}"`);
  }
  const [unl] = await sql`
    SELECT count(*)::int AS n FROM scm.purchase_order_items it JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
     WHERE p.company_id = ${COMPANY} AND upper(btrim(it.item_code)) = ANY(${CODES}) AND it.so_item_id IS NULL
       AND p.status::text <> ALL(${PO_DEAD})`;
  notice(`C. ${unl.n} live Sofa Accessory PO line(s) carry NO sales-order link at all`);
}

function upper(s) { return String(s ?? "").trim().toUpperCase(); }

function readOnlyGuard(shim) {
  const WRITES = new Set(["update", "insert", "upsert", "delete", "rpc"]);
  return new Proxy(shim, {
    get(target, prop, recv) {
      if (prop === "rpc") return () => { throw new Error("read-only probe: rpc refused"); };
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (table) => {
        const b = target.from(table);
        return new Proxy(b, {
          get(bt, p, r) {
            if (WRITES.has(String(p))) return () => { throw new Error(`read-only probe: ${String(p)} on ${table} refused`); };
            return Reflect.get(bt, p, r);
          },
        });
      };
    },
  });
}

main().catch(async (e) => {
  console.error(`probe failed: ${e.message}`);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
});
