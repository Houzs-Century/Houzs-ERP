// READ-ONLY. How many purchase invoices are POSTED while no supplier-debt (AP)
// journal exists for them, per company, and how did they get that way?
//
// WHY THIS EXISTS. PR #5469 proved a purchase invoice can be POSTED with no AP
// journal: postPiAccounting (src/scm/routes/accounting.ts) refuses on a zero
// total, an invoice with no lines, a line with no product group, a product
// group with no purchase account, or a failed write, and the post is kept
// anyway. It also found that POST /purchase-invoices/from-grn and
// /from-grn-items write their invoices straight to POSTED and never call
// postPiAccounting at all. How many such invoices production holds was
// UNKNOWN; this answers it without anyone opening a SQL console.
//
// THE LINKAGE, taken from the code rather than guessed:
//   postJournal (src/acc/engine.ts) keys a PI's entry on
//   scm.journal_entries (source_type = 'PI', source_doc_no = invoice_number,
//   company_id = the invoice's company); an entry is ACTIVE while
//   reversed is not true, and `posted` is flipped true as the last step, so an
//   active entry with posted = false is a write that stopped half-way.
//   classifyPiBackfill (src/scm/routes/accounting-pi-backfill.ts) uses the same
//   key and the same population (status not DRAFT / CANCELLED).
//
// CREATION PATH comes from the invoice's CREATE row in scm.entity_audit_log
// (recordPiCreate, src/scm/lib/pi-audit-trail.ts):
//   grn_convert_autopost  note 'Converted from Goods Receipt ...' with a POSTED
//                         snapshot — /from-grn or /from-grn-items, which post
//                         no journal by construction
//   grn_scan_draft        same note, DRAFT snapshot — the OCR scan queue, later
//                         confirmed through PATCH /:id/post
//   new_form              a CREATE row with no note — POST / (the New form,
//                         which the "Bill a Goods-Received Note" page also uses)
//   no_create_row         no CREATE row (predates the audit log, or its write
//                         failed); `notes` starting 'From ' with a grn_id is the
//                         /from-grn fingerprint and is reported beside it
//
// THE REASON column mirrors postPiAccounting's refusal order against TODAY's
// data. A group bound to an account after the invoice was posted reads as
// "unexplained" here, so read the reason as a hint, not as history.
//
// Strictly one SELECT. No DDL, no writes, no transaction. Exits 0 for every
// answer, including zero; only an unreachable database or a query error exits
// non-zero.
import "./lib/public-log-guard.mjs";
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : "-");
const LIST_LIMIT = 50;

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });

function reasonOf(r) {
  if (r.migrated) return "migrated_source (by design: AutoCount booked it)";
  if (Number(r.total_sen) <= 0) return "zero_total";
  if (r.n_lines === 0) return "no_lines";
  if (r.n_ungrouped > 0) return "line_ungrouped";
  if (r.n_unbound > 0) return "group_unbound";
  return "unexplained (journal never attempted, or write failed)";
}

async function main() {
  const rows = await sql`
    WITH pis AS (
      SELECT pi.id, pi.company_id, pi.invoice_number, pi.invoice_date, pi.status,
             pi.total_sen, pi.currency, pi.exchange_rate, pi.grn_id, pi.notes,
             COALESCE(pi.migrated_no_stock, false) AS migrated
        FROM scm.purchase_invoices pi
       WHERE UPPER(COALESCE(pi.status::text, '')) NOT IN ('DRAFT', 'CANCELLED')
    ),
    je AS (
      SELECT p.id AS pi_id,
             bool_or(COALESCE(j.reversed, false) = false) AS has_active,
             bool_or(COALESCE(j.reversed, false) = false AND j.posted IS TRUE) AS has_active_posted
        FROM pis p
        JOIN scm.journal_entries j
          ON j.source_type = 'PI'
         AND j.source_doc_no = p.invoice_number
         AND j.company_id IS NOT DISTINCT FROM p.company_id
       GROUP BY p.id
    ),
    gap AS (
      SELECT p.*, COALESCE(je.has_active, false) AS has_active
        FROM pis p LEFT JOIN je ON je.pi_id = p.id
       WHERE COALESCE(je.has_active_posted, false) = false
    ),
    created AS (
      SELECT DISTINCT ON (a.entity_id) a.entity_id, a.note, a.status_snapshot
        FROM scm.entity_audit_log a
        JOIN gap g ON a.entity_id::text = g.id::text
       WHERE a.entity_type = 'PURCHASE_INVOICE' AND a.action = 'CREATE'
       ORDER BY a.entity_id, a.created_at
    ),
    lines AS (
      SELECT i.purchase_invoice_id AS pi_id,
             COUNT(*)::int AS n_lines,
             COUNT(*) FILTER (WHERE btrim(COALESCE(i.item_group, '')) = '')::int AS n_ungrouped,
             COUNT(DISTINCT UPPER(btrim(i.item_group))) FILTER (
               WHERE btrim(COALESCE(i.item_group, '')) <> ''
                 AND NOT EXISTS (
                   SELECT 1 FROM scm.acc_item_group_accounts b
                    WHERE b.company_id = g.company_id
                      AND b.group_code = UPPER(btrim(i.item_group))
                      AND btrim(COALESCE(b.purchase_account, '')) <> '')
             )::int AS n_unbound
        FROM scm.purchase_invoice_items i
        JOIN gap g ON g.id = i.purchase_invoice_id
       GROUP BY i.purchase_invoice_id
    ),
    totals AS (
      SELECT p.company_id,
             COUNT(*) FILTER (WHERE NOT p.migrated)::int AS n_posted,
             COALESCE(SUM(ROUND(p.total_sen * COALESCE(NULLIF(p.exchange_rate, 0), 1))) FILTER (WHERE NOT p.migrated), 0)::bigint AS sen_posted,
             (SELECT COUNT(*)::int FROM scm.entity_audit_log a
                JOIN scm.purchase_invoices x ON a.entity_id = x.id::text
               WHERE a.entity_type = 'PURCHASE_INVOICE' AND a.action = 'CREATE'
                 AND x.company_id IS NOT DISTINCT FROM p.company_id
                 AND COALESCE(a.note, '') LIKE 'Converted from Goods Receipt%'
                 AND UPPER(COALESCE(a.status_snapshot, '')) = 'POSTED') AS n_autopost_ever
        FROM pis p
       GROUP BY p.company_id
    )
    SELECT 'total' AS kind, t.company_id, co.code AS company_code, NULL::text AS invoice_number,
           NULL::date AS invoice_date, NULL::text AS status, t.sen_posted AS total_sen, NULL::text AS currency,
           NULL::text AS exchange_rate, false AS migrated, false AS has_active, false AS from_grn_fingerprint,
           NULL::text AS path, t.n_posted AS n_lines, t.n_autopost_ever AS n_ungrouped, 0 AS n_unbound
      FROM totals t
      LEFT JOIN public.companies co ON co.id = t.company_id
    UNION ALL
    SELECT 'gap' AS kind, g.company_id, co.code AS company_code, g.invoice_number, g.invoice_date,
           g.status::text AS status, g.total_sen::bigint AS total_sen, g.currency::text AS currency,
           g.exchange_rate::text AS exchange_rate, g.migrated, g.has_active,
           (g.grn_id IS NOT NULL AND COALESCE(g.notes, '') LIKE 'From %') AS from_grn_fingerprint,
           CASE
             WHEN c.entity_id IS NULL THEN 'no_create_row'
             WHEN COALESCE(c.note, '') LIKE 'Converted from Goods Receipt%'
                  AND UPPER(COALESCE(c.status_snapshot, '')) = 'POSTED' THEN 'grn_convert_autopost'
             WHEN COALESCE(c.note, '') LIKE 'Converted from Goods Receipt%' THEN 'grn_scan_draft'
             ELSE 'new_form'
           END AS path,
           COALESCE(l.n_lines, 0) AS n_lines, COALESCE(l.n_ungrouped, 0) AS n_ungrouped,
           COALESCE(l.n_unbound, 0) AS n_unbound
      FROM gap g
      LEFT JOIN created c ON c.entity_id::text = g.id::text
      LEFT JOIN lines l ON l.pi_id = g.id
      LEFT JOIN public.companies co ON co.id = g.company_id
     ORDER BY kind DESC, company_id NULLS LAST, invoice_date, invoice_number`;

  const keyOf = (r) => `${r.company_id ?? "null"} ${r.company_code ?? ""}`.trim();
  const totals = new Map(rows.filter((r) => r.kind === "total").map((r) => [keyOf(r), r]));
  const gaps = rows.filter((r) => r.kind === "gap");
  notice("=== POSTED purchase invoices with NO posted AP journal (READ-ONLY) ===");
  notice(`rows found: ${gaps.length} (migrated AutoCount paperwork included and counted separately; it has no journal by design)`);

  const byCompany = new Map([...totals.keys()].map((k) => [k, []]));
  for (const r of gaps) {
    const k = keyOf(r);
    if (!byCompany.has(k)) byCompany.set(k, []);
    byCompany.get(k).push(r);
  }

  for (const [k, list] of byCompany) {
    const real = list.filter((r) => !r.migrated);
    const migrated = list.filter((r) => r.migrated);
    const myr = (rs) => rs.reduce((s, r) => s + Math.round(Number(r.total_sen) * (Number(r.exchange_rate) || 1)), 0);
    notice("");
    notice(`--- company ${k} ---`);
    const t = totals.get(k);
    if (t) {
      notice(`posted invoices in the population (not draft, not cancelled, not migrated): ${t.n_lines}, ${rm(t.total_sen)}`);
      notice(`invoices ever created already-POSTED by /from-grn or /from-grn-items (audit CREATE rows): ${t.n_ungrouped}`);
    }
    notice(`missing AP journal (excluding migrated): ${real.length} invoices, ${rm(myr(real))} (MYR at each invoice's own rate)`);
    notice(`migrated AutoCount paperwork (no journal by design): ${migrated.length} invoices, ${rm(myr(migrated))}`);
    if (real.length === 0) continue;
    const dates = real.map((r) => day(r.invoice_date)).sort();
    notice(`invoice dates: oldest ${dates[0]}, newest ${dates[dates.length - 1]}`);
    const half = real.filter((r) => r.has_active).length;
    if (half) notice(`of which a journal exists but was never flipped posted: ${half}`);

    const tally = (keyFn) => {
      const m = new Map();
      for (const r of real) {
        const key = keyFn(r);
        const t = m.get(key) ?? { n: 0, sen: 0 };
        t.n += 1; t.sen += Math.round(Number(r.total_sen) * (Number(r.exchange_rate) || 1));
        m.set(key, t);
      }
      return [...m].sort((a, b) => b[1].n - a[1].n);
    };
    notice("by creation path:");
    for (const [p, t] of tally((r) => r.path)) notice(`   ${p.padEnd(22)} ${String(t.n).padStart(5)}  ${rm(t.sen)}`);
    const fp = real.filter((r) => r.path === "no_create_row" && r.from_grn_fingerprint).length;
    if (fp) notice(`   (of no_create_row, ${fp} carry the /from-grn fingerprint: grn_id set and notes 'From ...')`);
    notice("by likely reason (today's data):");
    for (const [p, t] of tally(reasonOf)) notice(`   ${p.padEnd(56)} ${String(t.n).padStart(5)}  ${rm(t.sen)}`);
    notice("by status:");
    for (const [p, t] of tally((r) => r.status)) notice(`   ${p.padEnd(22)} ${String(t.n).padStart(5)}  ${rm(t.sen)}`);

    notice(`first ${Math.min(LIST_LIMIT, real.length)} of ${real.length} (oldest first):`);
    for (const r of real.slice(0, LIST_LIMIT)) {
      const cur = r.currency && r.currency !== "MYR" ? ` ${r.currency}@${r.exchange_rate}` : "";
      notice(`   ${String(r.invoice_number).padEnd(18)} ${day(r.invoice_date)}  ${rm(r.total_sen).padStart(16)}${cur}  ${String(r.status).padEnd(14)} ${r.path.padEnd(22)} ${reasonOf(r)}`);
    }
  }
  if (gaps.length === 0) notice("No POSTED purchase invoice is missing its AP journal.");
}

try {
  await main();
} catch (e) {
  console.error("check failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
