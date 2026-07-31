// READ-ONLY. Sizes the blast radius of unifying Processing Date and Proceed.
//
// Owner 2026-07-31: "Processing Date 和 Proceed 是一样的... houzs 是 30%, 2990 是
// 50%... 全系统直接统一一个叫 Processing Date". Today the code disagrees with that
// in two ways, and this measures the cost of fixing each ONE SEPARATELY, because
// they have opposite risk profiles:
//
//   (A) THRESHOLD, per company. scm/shared/order-rules.ts documents
//       PROCEED_PAID_THRESHOLD = 0.5 as "a 2990 rule" that "must NOT gate the
//       Houzs processing date", and PROCESSING_DATE_PAID_THRESHOLD = 0.30 as the
//       Houzs one — but `grep -c company` on that file returns 0. Both constants
//       apply to every company. Scoping them RELAXES Houzs (nothing new is
//       refused) and TIGHTENS 2990 from 30% to 50%.
//
//   (B) COMPLETENESS. meetsProceedGate also demands name + email + address +
//       postcode + delivery date; the processing-date gate is money-only, and
//       that is DELIBERATE today (order-rules.ts: "an order with incomplete
//       customer info may still carry a Processing Date (Loo: resolve customer
//       details in Proceed)"). Unifying adopts those conditions, so orders that
//       save today start being refused. This is the expensive half.
//
// So the output is per-company and per-CONDITION: the owner can take (A) now and
// stage (B), or take both, on real numbers rather than a guess.
//
// COUNTS ORDERS THAT ALREADY CARRY A PROCESSING DATE and are not cancelled —
// those are exactly the rows a future edit would re-run the gate against. An
// order with no Processing Date is unaffected by either change.
//
// NOTE. status/company columns are ENUM/int here, not text. COALESCE(col,'') on
// an enum fails with "invalid input value for enum" — always ::text FIRST. That
// trap had check-foreign-rate-one.mjs silently dead until 2026-07-30.
import postgres from "postgres";
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : "-");

async function main() {
  notice("=== PROCESSING-DATE / PROCEED UNIFICATION — BLAST RADIUS (READ-ONLY) ===");

  // company code per row. The companies master holds the code; the SO holds the id.
  const rows = await sql`
    SELECT so.doc_no,
           UPPER(COALESCE(c.code::text, '?')) AS company,
           UPPER(COALESCE(so.status::text, '')) AS status,
           so.internal_expected_dd,
           NULLIF(BTRIM(so.debtor_name), '')            AS nm,
           NULLIF(BTRIM(COALESCE(so.email, '')), '')     AS email,
           NULLIF(BTRIM(COALESCE(so.address1, '')), '')  AS addr,
           NULLIF(BTRIM(COALESCE(so.postcode, '')), '')  AS postcode,
           so.customer_delivery_date                     AS deliv,
           COALESCE(so.local_total_centi, 0)             AS total_centi,
           /* Mirrors soProceedGateRefusal exactly (mfg-sales-orders.ts:513):
              payments join on so_doc_no, sum amount_centi, NO status filter.
              A different paid figure here would make this detector measure a
              gate the app does not run. */
           COALESCE((SELECT SUM(p.amount_centi)
                       FROM scm.mfg_sales_order_payments p
                      WHERE p.so_doc_no = so.doc_no), 0) AS paid_centi
      FROM scm.mfg_sales_orders so
      LEFT JOIN public.companies c ON c.id = so.company_id
     WHERE so.internal_expected_dd IS NOT NULL
       AND UPPER(COALESCE(so.status::text, '')) <> 'CANCELLED'`;

  notice(`  live SOs carrying a Processing Date : ${rows.length}`);
  if (!rows.length) { notice("  nothing to measure."); notice("=== END ==="); return; }

  const THRESH = { HOUZS: 0.30, "2990": 0.50 };
  const byCo = new Map();
  for (const r of rows) {
    const co = THRESH[r.company] !== undefined ? r.company : "OTHER";
    if (!byCo.has(co)) byCo.set(co, []);
    byCo.get(co).push(r);
  }

  const ratio = (r) => (Number(r.total_centi) > 0 ? Number(r.paid_centi) / Number(r.total_centi) : 1);

  notice("================ (A) THRESHOLD ONLY — scope the % per company ================");
  notice("  Today EVERY company is gated at 30% for the Processing Date. Scoping means");
  notice("  HOUZS stays 30% (nothing new refused) and 2990 moves 30% -> 50%.");
  for (const [co, list] of byCo) {
    const t = THRESH[co];
    if (t === undefined) { notice(`  ${pad(co, 6)} ${list.length} orders — no threshold defined, left alone`); continue; }
    const failsNow = list.filter((r) => ratio(r) < 0.30).length;
    const failsNew = list.filter((r) => ratio(r) < t).length;
    const newlyRefused = failsNew - failsNow;
    notice(`  ${pad(co, 6)} orders=${pad(list.length, 5)} fail@30%(today)=${pad(failsNow, 5)} fail@${Math.round(t * 100)}%(new)=${pad(failsNew, 5)}  NEWLY REFUSED: ${newlyRefused}`);
  }

  notice("================ (B) COMPLETENESS — adopt the Proceed conditions ================");
  notice("  Money aside: which of these orders lack a field meetsProceedGate demands?");
  const missCount = { nm: 0, email: 0, addr: 0, postcode: 0, deliv: 0 };
  const anyMiss = [];
  for (const r of rows) {
    const miss = [];
    if (!r.nm) { missCount.nm++; miss.push("name"); }
    if (!r.email) { missCount.email++; miss.push("email"); }
    if (!r.addr) { missCount.addr++; miss.push("address"); }
    if (!r.postcode) { missCount.postcode++; miss.push("postcode"); }
    if (!r.deliv) { missCount.deliv++; miss.push("delivery-date"); }
    if (miss.length) anyMiss.push({ ...r, miss });
  }
  notice(`  orders missing at least one         : ${anyMiss.length} of ${rows.length}  (${pct(anyMiss.length, rows.length)})`);
  for (const [k, v] of Object.entries(missCount)) {
    notice(`   - missing ${pad(k, 10)} : ${pad(v, 5)} (${pct(v, rows.length)})`);
  }
  notice("  ^ EVERY ONE of these can carry a Processing Date today and could not after (B).");

  notice("================ (A)+(B) TOGETHER — the full unified gate ================");
  for (const [co, list] of byCo) {
    const t = THRESH[co];
    if (t === undefined) continue;
    const refused = list.filter((r) => {
      const complete = r.nm && r.email && r.addr && r.postcode && r.deliv;
      return !complete || ratio(r) < t;
    });
    notice(`  ${pad(co, 6)} orders=${pad(list.length, 5)} refused by the unified gate=${pad(refused.length, 5)} (${pct(refused.length, list.length)})`);
  }

  notice("================ SAMPLE — 25 that (A)+(B) would refuse ================");
  notice(`    ${pad("doc_no", 20)} ${pad("co", 6)} ${pad("paid%", 7)} why`);
  let shown = 0;
  for (const r of rows) {
    const t = THRESH[r.company];
    if (t === undefined) continue;
    const why = [];
    if (!r.nm) why.push("name");
    if (!r.email) why.push("email");
    if (!r.addr) why.push("address");
    if (!r.postcode) why.push("postcode");
    if (!r.deliv) why.push("delivery-date");
    if (ratio(r) < t) why.push(`paid ${Math.round(ratio(r) * 100)}% < ${Math.round(t * 100)}%`);
    if (!why.length) continue;
    notice(`    ${pad(r.doc_no, 20)} ${pad(r.company, 6)} ${pad(`${Math.round(ratio(r) * 100)}%`, 7)} ${why.join(", ")}`);
    if (++shown >= 25) break;
  }
  if (!shown) notice("    none — the unified gate would refuse nothing that exists today.");

  /* (C) The path that had NO gate at all. Approving an SO amendment can set
     internal_expected_dd through header_changes, and until 2026-07-31 the only
     check there was proc <= delivery. This counts the OPEN amendments a new gate
     on that path would refuse, so the fix ships on a number rather than a hope. */
  notice("================ (C) PENDING AMENDMENTS that set a Processing Date ================");
  const amds = await sql`
    SELECT a.id, a.so_doc_no, UPPER(COALESCE(a.status::text,'')) AS status, a.header_changes
      FROM scm.so_amendments a
     WHERE a.header_changes IS NOT NULL
       AND UPPER(COALESCE(a.status::text,'')) NOT IN ('APPLIED','REJECTED','CANCELLED')`;
  const setsProc = amds.filter((a) => {
    const h = a.header_changes ?? {};
    const v = h.internalExpectedDd;
    return v !== undefined && v !== null && String(v).trim() !== '';
  });
  notice(`  open amendments with header changes       : ${amds.length}`);
  notice(`   - of those, SETTING a Processing Date    : ${setsProc.length}`);
  if (!setsProc.length) {
    notice("  none — the new gate on the amendment path refuses nothing that is queued today.");
  } else {
    const byDoc = new Map(rows.map((r) => [r.doc_no, r]));
    let refused = 0;
    for (const a of setsProc) {
      const r = byDoc.get(a.so_doc_no);
      if (!r) { notice(`    ${pad(a.so_doc_no, 20)} (SO carries no Processing Date yet — not in the measured set)`); continue; }
      const t = THRESH[r.company] ?? 0.30;
      const why = [];
      if (!r.nm) why.push("name");
      if (!r.addr) why.push("address");
      if (!r.postcode) why.push("postcode");
      if (ratio(r) < t) why.push(`paid ${Math.round(ratio(r) * 100)}% < ${Math.round(t * 100)}%`);
      if (why.length) { refused++; notice(`    ${pad(a.so_doc_no, 20)} ${pad(r.company, 6)} WOULD BE REFUSED: ${why.join(", ")}`); }
    }
    notice(`  amendments the new gate would refuse      : ${refused} of ${setsProc.length}`);
  }

  notice("=== END — read-only, no rows changed. ===");
}
main().then(() => sql.end()).catch((e) => { console.error("GATE_IMPACT_FAIL", e?.message ?? e); process.exit(1); });
