#!/usr/bin/env node
/* Read-only: which posted documents have NO general-ledger entry, and can the
 * 2026-08-18 regression account for them?
 *
 * WHY THIS EXISTS. `docs/bugs/0522` found that jePrefixForCompany read a table
 * that does not exist, so every journal post threw, uncaught, from 2026-08-18.
 * The fix is live and verified. It does NOT write the entries that were missed.
 *
 * The owner's instruction, 2026-08-23, when given the repair options:
 * **先只查清楚，不动帐** — find out first, touch nothing. So this measures and
 * moves nothing. There is no write in this file.
 *
 * ── THE QUESTION, AND WHY IT IS NOT "HOW MANY ARE MISSING" ────────────────
 * The count alone is a trap. The AP control check reports 33 documents on one
 * company, and 21 of them carry JULY document numbers — BEFORE the regression
 * existed. Repairing all 33 as "the bug's damage" would book entries for
 * documents whose cause nobody has established.
 *
 * So the split is the deliverable:
 *
 *   AFTER  2026-08-18   the regression explains it
 *   BEFORE 2026-08-18   something else did, and this probe's job is to say
 *                       what evidence there is, not to guess
 *
 * The date used is the DOCUMENT's own `invoice_date`, not its number. A doc
 * number's YYMM is the month it was MINTED, which is not always the month it is
 * dated — reading the split off the number would be reading a label instead of
 * the fact.
 *
 * ── ONE DISTINCTION THAT CAN EXPLAIN THE WHOLE EARLIER BATCH ──────────────
 * "No ACTIVE journal" and "no journal at all" are different states, and the
 * control check cannot tell them apart — it filters `posted = true AND
 * reversed = false`, so a document whose entry was posted and later REVERSED
 * looks identical to one that never posted. A reversed entry is normal: it is
 * what a cancel does. This probe separates them, because if the earlier batch
 * is mostly reversals then there is nothing wrong with it at all.
 *
 * ── WHAT IT DELIBERATELY DOES NOT PRINT ──────────────────────────────────
 * No document numbers, no amounts, no supplier or customer names. This
 * repository and its Actions logs are PUBLIC, and these are payables and
 * receivables. The exact figures are already in the app's own Self-check
 * screen, which is private and is where the owner should read them. What a
 * public log can carry is the SHAPE: how many, in which bucket, and why.
 *
 * ── IF IT CANNOT READ SOMETHING IT SAYS SO ───────────────────────────────
 * Every section that fails prints the reason and the run exits non-zero. A
 * report that measured nothing must never look like a clean answer — that lesson
 * cost two green runs already (docs/bugs/0511, 0512).
 */
import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — the database cannot be asked. Nothing was measured.");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);
const why = (e) => {
  const m = String(e?.message ?? "").trim();
  return (m || e?.name || "unknown error") + (e?.code ? ` [${e.code}]` : "");
};

/* The day PR #2427 deployed the read that threw. Documents dated on or after
   this are inside the regression's window; earlier ones are not. */
const REGRESSION_DAY = "2026-08-18";

let measured = 0;
const TOTAL_SECTIONS = 3;

/* AR comes from sales invoices, AP from purchase invoices — the same two
   populations the control check compares, so the two answers can be laid side
   by side. `source_type` is what the journal calls each. */
const DOCS = [
  { label: "销售发票 Sales invoice",   table: "sales_invoices",    source: "SI" },
  { label: "采购发票 Purchase invoice", table: "purchase_invoices", source: "PI" },
];

async function main() {
  note("=== 已过帐但没有总帐分录的单据 — 只读普查 ===");
  note("老板 2026-08-23：先只查清楚，不动帐。这支不写任何东西。");
  note("公开纪录：只印数量和分类，不印单号、金额、客户或供应商 —— 那些在系统自己的");
  note("Self-check 画面里，那是私有的。");
  note("");

  /* ── 0. RAW CENSUS ───────────────────────────────────────────────────────
     Printed FIRST and with no predicate, so "0 affected" can never be confused
     with "that table could not be read". */
  note("── 每张表总共几张单（不带任何条件）──");
  for (const d of DOCS) {
    try {
      const [r] = await sql`SELECT COUNT(*) AS n FROM scm.${sql(d.table)}`;
      note(`   ${pad(d.label, 26)}${rpad(r.n, 7)} 张`);
    } catch (e) {
      note(`   ${pad(d.label, 26)}读不到 — ${why(e).slice(0, 90)}`);
    }
  }
  try {
    const [r] = await sql`SELECT COUNT(*) AS n FROM scm.journal_entries`;
    note(`   ${pad("总帐分录 journal_entries", 26)}${rpad(r.n, 7)} 笔`);
  } catch (e) {
    note(`   ${pad("总帐分录 journal_entries", 26)}读不到 — ${why(e).slice(0, 90)}`);
  }
  note("");

  /* ── 1. THE SPLIT ────────────────────────────────────────────────────────
     A document counts as UNEXPLAINED only when it has no journal row AT ALL.
     One that has a reversed row was posted and then reversed — that is what a
     cancel does, and it is not a failure. */
  note("── 第一类：没有分录的单据，按单据自己的日期分 ──");
  note(`   分界线 ${REGRESSION_DAY} —— PR #2427 上线那天（docs/bugs/0522）`);
  note("");
  let splitOk = false;
  for (const d of DOCS) {
    try {
      const rows = await sql`
        SELECT i.company_id                                        AS company_id,
               (i.invoice_date >= ${REGRESSION_DAY}::date)         AS in_window,
               (je.n IS NULL OR je.n = 0)                          AS never_posted,
               COUNT(*)                                            AS n
          FROM scm.${sql(d.table)} i
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS n
              FROM scm.journal_entries j
             WHERE j.source_type = ${d.source}
               AND j.source_doc_no = i.invoice_number
               AND j.company_id IS NOT DISTINCT FROM i.company_id
          ) je ON TRUE
         WHERE UPPER(COALESCE(i.status::text, '')) NOT IN ('DRAFT', 'CANCELLED', 'VOID')
           AND COALESCE(i.migrated_no_stock, false) = false
           AND COALESCE(i.total_sen, 0) > 0
           AND NOT EXISTS (
             SELECT 1 FROM scm.journal_entries a
              WHERE a.source_type = ${d.source}
                AND a.source_doc_no = i.invoice_number
                AND a.company_id IS NOT DISTINCT FROM i.company_id
                AND a.posted = true AND a.reversed = false
           )
         GROUP BY 1, 2, 3
         ORDER BY 1, 2, 3
      `;
      if (rows.length === 0) {
        note(`   ${d.label}：没有任何一张缺分录的单据。`);
      } else {
        note(`   ${d.label}`);
        for (const r of rows) {
          const when = r.in_window ? `${REGRESSION_DAY} 起` : `${REGRESSION_DAY} 之前`;
          const kind = r.never_posted ? "从来没有过分录" : "有分录但被冲销了";
          note(`      company ${rpad(r.company_id ?? "—", 3)}  ${pad(when, 16)}${pad(kind, 20)}${rpad(r.n, 5)} 张`);
        }
      }
      splitOk = true;
    } catch (e) {
      note(`   ${d.label}：读不到 — ${why(e).slice(0, 120)}`);
    }
  }
  if (splitOk) measured++;
  note("");
  note("   「有分录但被冲销了」不是问题 —— 取消单据本来就会冲销它的分录。");
  note("   要看的是「从来没有过分录」那一栏。");
  note("");

  /* ── 2. IS THE EARLIER BATCH EVEN THE SAME SHAPE? ────────────────────────
     If the pre-regression documents were never posted for a DIFFERENT reason,
     the difference should show somewhere in the document itself. These are the
     three inputs postPiAccounting/postSiAccounting refuse on, checked so the
     answer is evidence rather than a hunch. */
  note("── 第二类：分界线之前那批，长得跟之后那批一样吗？──");
  note("   查的是过帐函式真正会拒绝的三个输入，不是猜。");
  note("");
  let shapeOk = false;
  for (const d of DOCS) {
    try {
      const [r] = await sql`
        SELECT COUNT(*)                                                          AS total,
               COUNT(*) FILTER (WHERE i.company_id IS NULL)                      AS no_company,
               COUNT(*) FILTER (WHERE i.invoice_date IS NULL)                    AS no_date,
               COUNT(*) FILTER (WHERE COALESCE(i.total_sen, 0) <= 0)             AS zero_total
          FROM scm.${sql(d.table)} i
         WHERE UPPER(COALESCE(i.status::text, '')) NOT IN ('DRAFT', 'CANCELLED', 'VOID')
           AND COALESCE(i.migrated_no_stock, false) = false
           AND i.invoice_date < ${REGRESSION_DAY}::date
           AND NOT EXISTS (
             SELECT 1 FROM scm.journal_entries a
              WHERE a.source_type = ${d.source}
                AND a.source_doc_no = i.invoice_number
                AND a.company_id IS NOT DISTINCT FROM i.company_id
           )
      `;
      note(`   ${pad(d.label, 26)}分界线前、从来没有分录的：${rpad(r.total, 4)} 张`);
      note(`   ${pad("", 26)}其中 company_id 是空的：${rpad(r.no_company, 4)}`);
      note(`   ${pad("", 26)}      日期是空的：      ${rpad(r.no_date, 4)}`);
      note(`   ${pad("", 26)}      金额 <= 0：       ${rpad(r.zero_total, 4)}`);
      shapeOk = true;
    } catch (e) {
      note(`   ${d.label}：读不到 — ${why(e).slice(0, 120)}`);
    }
  }
  if (shapeOk) measured++;
  note("");
  note("   三个都是 0，就代表这批单据本身没有毛病 —— 它们只是从来没被要求过帐，");
  note("   或者被一个这支查不到的原因挡下来。那是下一步要查的，不是这支能答的。");
  note("");

  /* ── 3. WHEN DID THE LEDGER ACTUALLY STOP AND RESTART ────────────────────
     The regression's fingerprint, read off the ledger itself rather than off
     the deploy log: the last entry before the gap, and the first one after. */
  note("── 第三类：帐本实际上什么时候停、什么时候又开始 ──");
  let gapOk = false;
  try {
    const rows = await sql`
      SELECT company_id,
             MAX(entry_date) FILTER (WHERE entry_date <  ${REGRESSION_DAY}::date) AS last_before,
             MIN(entry_date) FILTER (WHERE entry_date >= ${REGRESSION_DAY}::date) AS first_after,
             COUNT(*)        FILTER (WHERE entry_date >= ${REGRESSION_DAY}::date) AS n_after
        FROM scm.journal_entries
       WHERE posted = true
       GROUP BY company_id
       ORDER BY company_id
    `;
    if (rows.length === 0) note("   帐本里一笔 posted 的分录都没有。");
    for (const r of rows) {
      note(`   company ${rpad(r.company_id ?? "—", 3)}  分界线前最后一笔 ${pad(String(r.last_before ?? "—").slice(0, 10), 12)}`
         + `分界线后第一笔 ${pad(String(r.first_after ?? "（没有）").slice(0, 12), 14)}之后共 ${rpad(r.n_after, 4)} 笔`);
    }
    gapOk = true;
  } catch (e) {
    note(`   读不到 — ${why(e).slice(0, 120)}`);
  }
  if (gapOk) measured++;
  note("");

  note("=== 完 — 只读，什么都没有改 ===");
  note("要补哪一批、怎么补，是老板的决定。这支只负责把「这个 bug 造成的」和");
  note("「另有原因的」分开，免得把成因不明的单据当成 bug 的损害一起补进去。");

  await sql.end({ timeout: 5 });

  if (measured < TOTAL_SECTIONS) {
    console.error(`Only ${measured} of ${TOTAL_SECTIONS} sections could be read. This is NOT a clean result.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("probe failed:", why(e));
  process.exit(1);
});
