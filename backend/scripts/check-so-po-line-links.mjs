// check-so-po-line-links — READ-ONLY. "This sales order already has a purchase
// order — why does the line not show it?"
//
// Staff, 2026-09 (staff issue list #18 / #19):
//   #18 「SO-013389 this already have PO-010087, please update it」
//   #19 「SO-011114 already have PO:010045, please update, why only item 3 no show PO?」
//
// WHAT DECIDES THE PO A SALES-ORDER LINE SHOWS (read before trusting a verdict):
//   Desktop SO detail (`SalesOrderDetailV2`) paints the lines from GET
//   /mfg-sales-orders/:docNo, which hard-codes `coverage_po: null`, then overlays
//   GET /mfg-sales-orders/:docNo/coverage (`mfg-sales-orders-list-enrichment.ts`)
//   — `soCoverage` -> `computeMrp` -> `mrpLineCoverage` (`scm/routes/mrp.ts`).
//   `SoSourceChips` renders that PO only when `stock_state === 'po'`.
//   For a COMPANY-1 hard-bound line (sofa / bedframe / "(SP)" mattress) the ONLY
//   purchase order that can cover it is a live PO line that
//     (a) carries this line's id in `purchase_order_items.so_item_id`,
//     (b) is itself on a hard-bound `item_group`, and
//     (c) still has quantity outstanding or received
//   (`isDedicated` in mrp.ts). Every other line is POOLED: the PO it shows is
//   whichever one the FIFO walk hands it, and the link does not decide.
//
// SO THIS PRINTS, PER NAMED PAIR:
//   1. every SO line and every live PO line that links to it, with (a)(b)(c);
//   2. every line on the named PO, with where its link points or why it has none;
//   3. the verdict per SO line in one sentence;
//   4. what the REAL engine answers today — the canonical `computeMrp` +
//      `mrpLineCoverage` run over lib/pgrest-shim.mjs, i.e. the same PO number
//      the desktop coverage endpoint would return. Not a replica.
// AND, company-wide (company 1), THE CLASS SIZE:
//   A. live PO lines with no `so_item_id` whose SAME purchase order's other lines
//      are linked to a sales order that has a live line with the same item code
//      (the #19 shape);
//   B. open hard-bound SO lines with no live PO link whose SAME BUILD (same
//      AutoCount line key, `linked_ac_dtlkey`) has a sibling that IS linked — the
//      purchase order holds fewer compartments than the sales order (the #18 shape);
//   C. live PO lines linked to a hard-bound SO line while the PO line's own
//      `item_group` is not hard-bound.
//
// READ-ONLY. SELECTs only. The engine run goes through a guard that throws on any
// write method before the shim sees it, and the session is set READ ONLY.
// Exit 0 for every legitimate answer; non-zero only when the database cannot be
// reached. A failed engine run is REPORTED (section 4 says it did not run), never
// silently skipped.
//
// RE-RUN: read-only and idempotent — every run re-reads the live rows.
//
// ENUM TRAP: status columns are enums — `::text` before comparing.
//
// Usage: npx tsx scripts/check-so-po-line-links.mjs
//   PAIRS="HC-SO-013389:HC-PO-010087,HC-SO-011114:HC-PO-010045" COMPANY=1 ENGINE=1
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const COMPANY = Number(process.env.COMPANY || 1);
const ENGINE = (process.env.ENGINE ?? "1") !== "0";
const PAIRS = String(process.env.PAIRS || "HC-SO-013389:HC-PO-010087,HC-SO-011114:HC-PO-010045")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map((p) => { const [so, po] = p.split(":").map((x) => x.trim()); return { so, po }; });

const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const warn = (m) => console.log(GH ? `::warning::${m}` : m);
const say = (m = "") => console.log(m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

/* Mirrors of the three constants the verdict depends on. Each names its home;
   a disagreement with the engine run in section 4 means these drifted. */
// scm/lib/so-stock-allocation.ts HARD_BOUND_GROUPS + isHardBoundLine
const isHardBound = (group, code) => {
  const g = String(group ?? "").toLowerCase();
  if (g === "sofa" || g === "bedframe" || g === "fabric_accessory") return true;
  return g === "mattress" && /\(SP\)\s*$/i.test(String(code ?? ""));
};
// scm/routes/mrp.ts PO_DEAD
const PO_DEAD = new Set(["CANCELLED", "DRAFT"]);
// scm/shared/so-terminal-states.ts (via scripts/lib/so-terminal-states.mjs)
const { SO_TERMINAL_STATES } = await import("./lib/so-terminal-states.mjs");
const SO_DONE = new Set(SO_TERMINAL_STATES);
const HARD_BOUND_COMPANY_ID = 1;
const isService = (group, code) =>
  String(group ?? "").toUpperCase().includes("SERVICE") || /^SVC-/i.test(String(code ?? ""));

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });

async function main() {
  try {
    await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  } catch (e) {
    warn(`could not set the session READ ONLY (${e.message}) — continuing, every statement below is a SELECT`);
  }
  const [ro] = await sql`SELECT current_setting('transaction_read_only') AS ro, now()::text AS at`;
  notice(`=== SO -> PO line links — READ-ONLY (session transaction_read_only=${ro.ro}) · read at ${ro.at} · company ${COMPANY} ===`);
  if (COMPANY !== HARD_BOUND_COMPANY_ID) {
    notice(`company ${COMPANY} is POOLED (hard-bound rule is company ${HARD_BOUND_COMPANY_ID} only): a link never decides what a line shows there.`);
  }

  const detail = [];
  for (const pair of PAIRS) detail.push(await explainPair(pair));

  await engineSection(detail);
  await census();

  await sql.end();
}

/* ─────────────────────────── per pair ─────────────────────────── */
async function explainPair({ so, po }) {
  say("");
  notice(`──────── ${so}  <->  ${po} ────────`);
  const [h] = await sql`
    SELECT doc_no, company_id, status::text AS status, processing_date::text AS processing_date,
           customer_delivery_date::text AS delivery, debtor_name
      FROM scm.mfg_sales_orders WHERE doc_no = ${so}`;
  if (!h) { notice(`NO SUCH SALES ORDER ${so}`); return { so, po, lines: [] }; }
  const soDone = SO_DONE.has(String(h.status).toUpperCase());
  notice(`${h.doc_no} · status ${h.status}${soDone ? " (TERMINAL — creates no demand, the engine shows nothing for it)" : ""} · company ${h.company_id} · processing ${h.processing_date ?? "—"} · delivery ${h.delivery ?? "—"}`);

  const [ph] = await sql`
    SELECT id, po_number, status::text AS status, company_id, created_at::text AS created_at, linked_ac_docno, notes
      FROM scm.purchase_orders WHERE po_number = ${po}`;
  if (!ph) notice(`NO SUCH PURCHASE ORDER ${po}`);
  else notice(`${ph.po_number} · status ${ph.status}${PO_DEAD.has(ph.status) ? " (DEAD to the engine)" : ""} · company ${ph.company_id} · created ${ph.created_at.slice(0, 19)} · book ${ph.linked_ac_docno ?? "—"}`);

  const soLines = await sql`
    SELECT i.id::text AS id, i.line_no, i.item_code, i.item_group, i.qty, i.cancelled,
           i.stock_status, i.warehouse_id::text AS warehouse_id, i.linked_ac_dtlkey::text AS dtlkey,
           i.created_at::text AS created_at
      FROM scm.mfg_sales_order_items i WHERE i.doc_no = ${so}
     ORDER BY i.line_no NULLS LAST, i.created_at`;
  const soIds = soLines.map((l) => l.id);

  /* EVERY live-or-dead PO line pointing at these SO lines, on ANY purchase order. */
  const links = soIds.length ? await sql`
    SELECT it.id::text AS id, it.so_item_id::text AS so_item_id, p.po_number, p.status::text AS po_status,
           it.item_code, it.item_group, it.qty, it.received_qty
      FROM scm.purchase_order_items it JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
     WHERE it.so_item_id = ANY(${soIds}::uuid[])` : [];
  const linksBySo = new Map();
  for (const l of links) {
    if (!linksBySo.has(l.so_item_id)) linksBySo.set(l.so_item_id, []);
    linksBySo.get(l.so_item_id).push(l);
  }

  const poLines = ph ? await sql`
    SELECT it.id::text AS id, it.line_no, it.item_code, it.item_group, it.qty, it.received_qty,
           it.so_item_id::text AS so_item_id, it.linked_ac_dtlkey::text AS dtlkey, it.from_mrp,
           it.warehouse_id::text AS warehouse_id, it.created_at::text AS created_at,
           s.doc_no AS link_doc, s.line_no AS link_line, s.item_code AS link_code, s.cancelled AS link_cancelled
      FROM scm.purchase_order_items it
      LEFT JOIN scm.mfg_sales_order_items s ON s.id = it.so_item_id
     WHERE it.purchase_order_id = ${ph.id}
     ORDER BY it.line_no NULLS LAST, it.created_at` : [];

  /* Display order = what staff count as "item N" (GET /:docNo re-orders rows at
     read: mains -> accessories -> services, each build walked left to right). */
  let displayNo = new Map();
  try {
    const { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank } = await import("../src/scm/shared/so-line-display.ts");
    const live = soLines.filter((l) => !l.cancelled).map((l) => ({ ...l }));
    const ordered = orderSofaModuleRowsWithinBuilds(sortSoLinesByGroupRank(live, (r) => r.item_group));
    ordered.forEach((l, idx) => displayNo.set(l.id, idx + 1));
  } catch (e) {
    warn(`display order unavailable (${e.message}) — "item N" below falls back to line_no`);
    displayNo = new Map();
  }

  say("");
  say("SALES-ORDER LINES  (item = position on the screen; ln = stored line_no)");
  say(`${pad("item", 5)}${pad("ln", 4)}${pad("code", 24)}${pad("group", 11)}${pad("qty", 4)}${pad("stock", 9)}${pad("book key", 10)}${pad("bound", 6)}linked PO line(s): po · status · po group · qty/recv`);
  const verdicts = [];
  for (const l of soLines) {
    const hb = COMPANY === HARD_BOUND_COMPANY_ID && isHardBound(l.item_group, l.item_code);
    const ls = linksBySo.get(l.id) ?? [];
    const lsTxt = ls.length
      ? ls.map((x) => `${x.po_number} · ${x.po_status} · ${x.item_group ?? "∅"} · ${x.qty}/${x.received_qty ?? 0}`).join(" | ")
      : "none";
    say(`${pad(l.cancelled ? "x" : (displayNo.get(l.id) ?? "?"), 5)}${pad(l.line_no ?? "∅", 4)}${pad(l.item_code, 24)}${pad(l.item_group, 11)}${pad(l.qty, 4)}${pad(l.stock_status, 9)}${pad(l.dtlkey ?? "∅", 10)}${pad(hb ? "YES" : "no", 6)}${lsTxt}`);
    verdicts.push({ line: l, item: displayNo.get(l.id) ?? null, verdict: verdictFor(l, hb, ls, poLines, soLines, soDone) });
  }

  say("");
  say(`PURCHASE-ORDER LINES on ${po}`);
  say(`${pad("ln", 4)}${pad("code", 24)}${pad("group", 11)}${pad("qty/rcv", 8)}${pad("book key", 10)}${pad("created", 21)}links to`);
  for (const p of poLines) {
    let to;
    if (p.so_item_id) to = `${p.link_doc ?? "?"} ln ${p.link_line ?? "∅"} (${p.link_code ?? "?"})${p.link_cancelled ? " — CANCELLED SO line" : ""}${p.link_code && p.link_code !== p.item_code ? " — DIFFERENT item code" : ""}`;
    else {
      const sameCode = soLines.filter((s) => !s.cancelled && s.item_code === p.item_code);
      const uncovered = sameCode.filter((s) => !(linksBySo.get(s.id) ?? []).some((x) => !PO_DEAD.has(x.po_status)));
      to = `NOTHING (so_item_id is NULL) — ${so} has ${sameCode.length} live line(s) with ${p.item_code}, ${uncovered.length} of them not covered by any live PO line`;
    }
    say(`${pad(p.line_no ?? "∅", 4)}${pad(p.item_code, 24)}${pad(p.item_group, 11)}${pad(`${p.qty}/${p.received_qty ?? 0}`, 8)}${pad(p.dtlkey ?? "∅", 10)}${pad(p.created_at.slice(0, 19), 21)}${to}`);
  }

  say("");
  say("VERDICT PER SALES-ORDER LINE");
  for (const v of verdicts) {
    notice(`  ${so} item ${v.item ?? "x"} (ln ${v.line.line_no ?? "∅"}) ${v.line.item_code}: ${v.verdict}`);
  }
  return { so, po, lines: soLines, displayNo };
}

function verdictFor(l, hardBound, ls, poLines, soLines, soDone) {
  if (l.cancelled) return "cancelled line — not shown";
  if (soDone) return "the order is terminal — the engine creates no demand for it, no PO is shown";
  if (isService(l.item_group, l.item_code)) return "service line — no purchase order is expected";
  const live = ls.filter((x) => !PO_DEAD.has(x.po_status));
  if (!hardBound) {
    return live.length
      ? `POOLED line, linked to ${live.map((x) => x.po_number).join(", ")} — the link does NOT decide the screen; the PO shown is whichever the FIFO walk assigns (section 4)`
      : "POOLED line, not linked — the link does NOT decide the screen; the PO shown is whichever the FIFO walk assigns (section 4)";
  }
  if (ls.length && !live.length) return `LINKED ONLY TO DEAD PO(s) ${ls.map((x) => `${x.po_number} ${x.po_status}`).join(", ")} — the engine ignores CANCELLED/DRAFT, so no PO can show`;
  if (live.length) {
    const good = live.filter((x) => isHardBound(x.item_group, x.item_code));
    if (!good.length) return `LINKED to ${live.map((x) => x.po_number).join(", ")} but the PO line's item_group (${live.map((x) => x.item_group ?? "∅").join(", ")}) is not hard-bound — condition (b) fails, the PO is invisible`;
    const withQty = good.filter((x) => Number(x.qty ?? 0) > 0);
    if (!withQty.length) return `LINKED to ${good.map((x) => x.po_number).join(", ")} with zero quantity — nothing to cover with`;
    return `LINKED OK to ${good.map((x) => `${x.po_number} (${x.qty}/${x.received_qty ?? 0})`).join(", ")} — (a)(b)(c) hold; section 4 says whether the engine shows it`;
  }
  /* Not linked by any PO line anywhere. Say precisely which of the three shapes. */
  const unlinkedSame = poLines.filter((p) => !p.so_item_id && p.item_code === l.item_code);
  if (unlinkedSame.length) {
    return `NOT LINKED — the named PO DOES carry ${l.item_code} on ${unlinkedSame.length} line(s) with so_item_id NULL (created ${unlinkedSame.map((p) => p.created_at.slice(0, 19)).join(", ")}). Condition (a) fails: the PO line exists but was never linked`;
  }
  const linkedElsewhere = poLines.filter((p) => p.so_item_id && p.item_code === l.item_code);
  if (linkedElsewhere.length) {
    return `NOT LINKED — the named PO's ${l.item_code} line is linked to ${linkedElsewhere.map((p) => `${p.link_doc} ln ${p.link_line}`).join(", ")} instead`;
  }
  const siblings = soLines.filter((s) => s.id !== l.id && !s.cancelled && l.dtlkey && s.dtlkey === l.dtlkey);
  const poSameBuild = poLines.filter((p) => siblings.some((s) => s.id === p.so_item_id));
  if (poSameBuild.length) {
    return `NOT ON THE PO AT ALL — this piece belongs to the same account-book line (key ${l.dtlkey}) as ${siblings.map((s) => s.item_code).join(" + ")}, and the named PO holds only ${poSameBuild.map((p) => p.item_code).join(" + ")} for that build. The sales order was split into more compartments than the purchase order was; there is no PO line to link`;
  }
  return `NOT ON THE PO AT ALL — no line on the named PO carries ${l.item_code}; this piece has no purchase order`;
}

/* ─────────────────────────── the engine ─────────────────────────── */
async function engineSection(detail) {
  say("");
  notice("──────── 4. WHAT THE ENGINE ANSWERS TODAY (canonical computeMrp + mrpLineCoverage) ────────");
  if (!ENGINE) { notice("ENGINE=0 — skipped on request"); return; }
  const t0 = Date.now();
  let cov;
  try {
    const { computeMrp, mrpLineCoverage } = await import("../src/scm/routes/mrp.ts");
    const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
    const shim = pgrestShim(sql, "scm");
    const sb = readOnlyGuard(shim);
    const mrp = await computeMrp(sb, {
      catFilter: null, whFilter: null, includeUndated: true, companyId: COMPANY,
      /* Lead buffers move DATES only, never which PO covers a line. */
      leadBuffers: { supplierBufferDays: {}, seasonBufferDays: {} },
    });
    if (shim.__gaps?.length) {
      notice(`ENGINE DID NOT RUN CLEANLY — shim gaps: ${shim.__gaps.join(" | ")}. Section 4 is NOT evidence.`);
      return;
    }
    cov = mrpLineCoverage(mrp);
    notice(`engine ran in ${Math.round((Date.now() - t0) / 1000)}s · ${mrp.skus.length} SKU rows · ${mrp.sofaSets.length} sofa sets`);
  } catch (e) {
    notice(`ENGINE DID NOT RUN — ${e.message}. Section 4 is NOT evidence; sections 1-3 and the census stand on their own.`);
    return;
  }
  for (const d of detail) {
    for (const l of d.lines) {
      if (l.cancelled) continue;
      const c = cov.get(l.id);
      /* The coverage endpoint's own rule, verbatim in outcome: sofa -> READY
         stock else 'po' when the engine names a PO; others -> the engine's source. */
      const isSofa = String(l.item_group ?? "").toUpperCase().includes("SOFA");
      const svc = isService(l.item_group, l.item_code);
      const state = svc ? "stock" : isSofa ? (l.stock_status === "READY" ? "stock" : (c?.source === "po" ? "po" : "shortage")) : (c?.source ?? null);
      const shows = state === "po" && c?.po ? c.po : null;
      notice(`  ${d.so} item ${d.displayNo?.get(l.id) ?? "?"} ${pad(l.item_code, 22)} engine source=${c?.source ?? "(no entry)"} po=${c?.po ?? "—"} eta=${c?.eta ? (c.eta instanceof Date ? c.eta.toISOString() : String(c.eta)).slice(0, 10) : "—"} -> stock_state=${state ?? "null"} -> Incoming PO chip: ${shows ?? "NONE"}`);
    }
  }
}

/* A write can never reach the database from the engine run: every mutating
   builder method throws before the shim is asked. computeMrp reads only; if that
   ever changes, this is where it is caught. */
function readOnlyGuard(shim) {
  const WRITES = new Set(["update", "insert", "upsert", "delete", "rpc"]);
  return new Proxy(shim, {
    get(target, prop, recv) {
      if (prop === "rpc") return () => { throw new Error("read-only check: rpc refused"); };
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (table) => {
        const b = target.from(table);
        return new Proxy(b, {
          get(bt, p, r) {
            if (WRITES.has(String(p))) return () => { throw new Error(`read-only check: ${String(p)} on ${table} refused`); };
            return Reflect.get(bt, p, r);
          },
        });
      };
    },
  });
}

/* ─────────────────────────── census ─────────────────────────── */
async function census() {
  say("");
  notice(`──────── CLASS SIZE, company ${COMPANY} ────────`);
  const doneList = [...SO_DONE];

  /* A — the #19 shape. */
  const a = await sql`
    WITH po_live AS (
      SELECT it.*, p.po_number, p.status::text AS pst
        FROM scm.purchase_order_items it JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
       WHERE p.company_id = ${COMPANY} AND p.status::text <> ALL(${[...PO_DEAD]})
    ),
    sib AS (
      SELECT DISTINCT u.id AS uid, s.doc_no
        FROM po_live u
        JOIN po_live x ON x.purchase_order_id = u.purchase_order_id AND x.so_item_id IS NOT NULL
        JOIN scm.mfg_sales_order_items s ON s.id = x.so_item_id
       WHERE u.so_item_id IS NULL
    )
    SELECT u.po_number, u.pst, u.item_code, u.item_group, u.qty, u.received_qty, u.line_no,
           u.created_at::text AS created_at, u.linked_ac_dtlkey::text AS dtlkey,
           sib.doc_no AS so_doc, so.status::text AS so_status, i.line_no AS so_line,
           EXISTS (SELECT 1 FROM po_live y WHERE y.so_item_id = i.id) AS so_line_covered
      FROM po_live u
      JOIN sib ON sib.uid = u.id
      JOIN scm.mfg_sales_orders so ON so.doc_no = sib.doc_no
      JOIN scm.mfg_sales_order_items i ON i.doc_no = sib.doc_no AND i.item_code = u.item_code AND i.cancelled = false
     ORDER BY u.po_number, u.item_code`;
  const aOpen = a.filter((r) => !SO_DONE.has(r.so_status));
  const aHb = aOpen.filter((r) => isHardBound(r.item_group, r.item_code));
  notice(`A. PO line exists for the same SO, same item, NO link: ${a.length} pairing(s) · ${new Set(a.map((r) => r.po_number + r.item_code + r.created_at)).size} PO line(s) · on open SOs ${aOpen.length} · of those hard-bound (link decides the screen) ${aHb.length} · of those whose SO line has NO other PO cover ${aHb.filter((r) => !r.so_line_covered).length}`);
  for (const r of a.slice(0, 50)) {
    say(`   ${pad(r.po_number, 16)}${pad(r.pst, 20)}${pad(r.item_code, 24)}${pad(r.item_group, 10)}${pad(`${r.qty}/${r.received_qty ?? 0}`, 6)}ln ${pad(r.line_no ?? "∅", 4)}${pad(r.created_at.slice(0, 19), 21)}-> ${r.so_doc} ${pad(r.so_status, 15)} ln ${pad(r.so_line, 3)} ${r.so_line_covered ? "SO line ALREADY covered by another live PO line (this row is a DUPLICATE piece, not a missing link)" : "SO line has NO live PO cover"}`);
  }

  /* B — the #18 shape. */
  const b = await sql`
    WITH po_live AS (
      SELECT it.*, p.po_number FROM scm.purchase_order_items it JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
       WHERE p.company_id = ${COMPANY} AND p.status::text <> ALL(${[...PO_DEAD]})
    ),
    so_open AS (
      SELECT i.*, so.status::text AS so_status
        FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
       WHERE so.company_id = ${COMPANY} AND i.cancelled = false
         AND upper(so.status::text) <> ALL(${doneList})
         AND (lower(coalesce(i.item_group,'')) IN ('sofa','bedframe')
              OR (lower(coalesce(i.item_group,'')) = 'mattress' AND i.item_code ~* '\\(SP\\)\\s*$'))
    )
    SELECT u.doc_no, u.so_status, u.line_no, u.item_code, u.linked_ac_dtlkey::text AS dtlkey, u.created_at::text AS created_at,
           (SELECT string_agg(DISTINCT y.po_number || ' ' || y.item_code, ', ')
              FROM po_live y JOIN scm.mfg_sales_order_items s2 ON s2.id = y.so_item_id
             WHERE s2.doc_no = u.doc_no AND s2.id <> u.id AND s2.linked_ac_dtlkey = u.linked_ac_dtlkey) AS build_po
      FROM so_open u
     WHERE u.linked_ac_dtlkey IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM po_live y WHERE y.so_item_id = u.id)
       AND EXISTS (SELECT 1 FROM po_live y JOIN scm.mfg_sales_order_items s2 ON s2.id = y.so_item_id
                    WHERE s2.doc_no = u.doc_no AND s2.id <> u.id AND s2.linked_ac_dtlkey = u.linked_ac_dtlkey)
     ORDER BY u.doc_no, u.line_no`;
  notice(`B. open hard-bound SO piece with NO PO line while the rest of its build IS on a PO (PO holds fewer compartments): ${b.length} line(s) on ${new Set(b.map((r) => r.doc_no)).size} order(s)`);
  for (const r of b.slice(0, 50)) {
    say(`   ${pad(r.doc_no, 16)}${pad(r.so_status, 15)}ln ${pad(r.line_no, 3)} ${pad(r.item_code, 22)} key ${pad(r.dtlkey, 8)} created ${r.created_at.slice(0, 19)}  build on: ${r.build_po}`);
  }

  /* C — wrong category on a linked PO line. */
  const c = await sql`
    SELECT p.po_number, p.status::text AS pst, it.item_code, it.item_group AS po_group,
           i.doc_no, i.line_no, i.item_group AS so_group, it.qty, it.received_qty
      FROM scm.purchase_order_items it
      JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
      JOIN scm.mfg_sales_order_items i ON i.id = it.so_item_id
      JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
     WHERE p.company_id = ${COMPANY} AND p.status::text <> ALL(${[...PO_DEAD]})
       AND i.cancelled = false AND upper(so.status::text) <> ALL(${doneList})
       AND (lower(coalesce(i.item_group,'')) IN ('sofa','bedframe')
            OR (lower(coalesce(i.item_group,'')) = 'mattress' AND i.item_code ~* '\\(SP\\)\\s*$'))
       AND NOT (lower(coalesce(it.item_group,'')) IN ('sofa','bedframe')
            OR (lower(coalesce(it.item_group,'')) = 'mattress' AND it.item_code ~* '\\(SP\\)\\s*$'))
     ORDER BY p.po_number`;
  notice(`C. linked PO line whose own item_group is not hard-bound (hides the PO): ${c.length}`);
  for (const r of c.slice(0, 50)) {
    say(`   ${pad(r.po_number, 16)}${pad(r.pst, 20)}${pad(r.item_code, 22)} po group ${pad(r.po_group ?? "∅", 10)} -> ${r.doc_no} ln ${r.line_no} (${r.so_group}) qty ${r.qty}/${r.received_qty ?? 0}`);
  }
}

try {
  await main();
  process.exit(0);
} catch (e) {
  console.error(`::error::check could not complete: ${e.message}`);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
}
