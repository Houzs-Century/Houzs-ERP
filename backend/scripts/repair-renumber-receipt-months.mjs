#!/usr/bin/env node
/* Put a general receipt's NUMBER in the month its own date falls in.

   Why (owner 2026-09-09, on 2990-OR-2609-001 whose journal is dated
   2026-02-07): 这个是因为之前receipt 没有办法选月份，后来才发现. The number was
   minted from TODAY rather than from the receipt's date. The code was fixed on
   2026-09-08 — routes/receipts.ts now mints from `docMonthTag(receiptDate)` —
   and the four papers created the day before are the leftovers. On prod:

     2990-OR-2609-001  dated 2026-02-07   ->  2990-OR-2602-001
     2990-OR-2609-002  dated 2026-03-12   ->  2990-OR-2603-001
     2990-OR-2609-003  dated 2026-04-30   ->  2990-OR-2604-001
     2990-OR-2609-004  dated 2026-05-07   ->  2990-OR-2605-001

   THIS BREAKS THE HOUSE RULE ON PURPOSE, once, on the owner's instruction
   (2026-09-09: 重编). "A number always points at the same document" is what an
   audit relies on, and renaming one is normally forbidden; these four were
   never issued to anybody and carry a month that is simply wrong. The four
   numbers they vacate are NOT re-used — the 2609 counter stays where it is, so
   the gap is permanent, which is the half of the rule that still holds.

   WHAT MOVES, and it is more than the receipt:
     • acc_receipts.receipt_number;
     • journal_entries.source_doc_no — EVERY entry of the receipt, not only the
       live one. Each of these four has three: the original (posted, since
       reversed), its RCT_REVERSAL contra, and the re-dated RCT that stands
       today. A rename that moved only the live one would leave the contra pair
       pointing at a number that no longer exists;
     • journal_entries.narration, where the number is spelled inside the
       sentence a person reads.
   The JOURNAL numbers themselves never move, so anything keyed on je_no —
   including a bank-statement movement matched to one — is untouched.

   UNLIKE repair-renumber-pv-series, this does NOT refuse a posted document
   with journals: all four are posted and all four have journals, and that is
   the whole population. What it refuses instead is a target number somebody
   else already holds.

   Two-phase rename through a -T## temporary so the UNIQUE (company_id,
   receipt_number) index is never crossed mid-way; everything in ONE
   transaction; verified on a FRESH connection afterwards. RE-RUN: convergent —
   a receipt whose number already agrees with its date is not touched, so a
   second run reports nothing to do.

   Env: DATABASE_URL, MODE=plan|apply, CONFIRM="RENUMBER RECEIPT MONTHS",
   optional COMPANY_ID to narrow it. */
import postgres from "postgres";

const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = "RENUMBER RECEIPT MONTHS";
const url = process.env.DATABASE_URL;
const COMPANY = process.env.COMPANY_ID ? Number(process.env.COMPANY_ID) : null;

if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
if (APPLY && process.env.CONFIRM !== CONFIRM) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM}"`); process.exit(2);
}
if (COMPANY !== null && !Number.isInteger(COMPANY)) {
  console.error(`COMPANY_ID must be an integer (got "${process.env.COMPANY_ID}")`); process.exit(2);
}

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
/** 2026-02-07 -> 2602, the tag routes/receipts.ts mints from. */
const monthTag = (d) => { const s = iso(d); return s.slice(2, 4) + s.slice(5, 7); };

/** "2990-OR-2609-001" -> { series: "2990-OR-2609", prefix: "2990-OR", tag: "2609", n: 1, width: 3 } */
function parseNo(no) {
  const m = /^(.*-OR)-(\d{4})-(\d+)$/.exec(String(no));
  if (!m) return null;
  return { prefix: m[1], tag: m[2], n: Number(m[3]), width: m[3].length };
}

/* ── What is wrong, and what each one should become ───────────────────────── */

async function survey(sql) {
  const rows = COMPANY === null
    ? await sql`SELECT id, company_id, receipt_number, receipt_date, status, total_sen, payer_name
                  FROM scm.acc_receipts ORDER BY company_id, receipt_date, receipt_number`
    : await sql`SELECT id, company_id, receipt_number, receipt_date, status, total_sen, payer_name
                  FROM scm.acc_receipts WHERE company_id = ${COMPANY}
                 ORDER BY company_id, receipt_date, receipt_number`;

  const wrong = [];
  const unreadable = [];
  for (const r of rows) {
    const p = parseNo(r.receipt_number);
    /* A number this script cannot read is REPORTED, never guessed at. */
    if (!p) { unreadable.push(r); continue; }
    if (!r.receipt_date) { unreadable.push(r); continue; }
    if (p.tag === monthTag(r.receipt_date)) continue;      // already agrees
    wrong.push({ ...r, parsed: p });
  }

  /* The highest suffix each target series already holds, so a renumbered
     receipt lands AFTER whatever is genuinely in that month rather than on top
     of it. Computed from the live table, per company. */
  const taken = new Map();                                  // "co|series" -> max n
  for (const r of rows) {
    const p = parseNo(r.receipt_number);
    if (!p) continue;
    const key = `${r.company_id}|${p.prefix}-${p.tag}`;
    taken.set(key, Math.max(taken.get(key) ?? 0, p.n));
  }

  /* Assign in date order so the numbers a month ends up with read the way a
     person reads down a statement. */
  const plan = [];
  for (const r of wrong.sort((a, b) => iso(a.receipt_date).localeCompare(iso(b.receipt_date)))) {
    const tag = monthTag(r.receipt_date);
    const series = `${r.parsed.prefix}-${tag}`;
    const key = `${r.company_id}|${series}`;
    const next = (taken.get(key) ?? 0) + 1;
    taken.set(key, next);
    plan.push({
      id: r.id,
      companyId: r.company_id,
      from: r.receipt_number,
      to: `${series}-${String(next).padStart(r.parsed.width, "0")}`,
      date: iso(r.receipt_date),
      status: r.status,
      payer: r.payer_name,
      totalSen: r.total_sen,
    });
  }
  return { plan, unreadable, scanned: rows.length };
}

/** Every journal entry that names one of these numbers, by column. */
async function references(sql, numbers) {
  if (numbers.length === 0) return [];
  return sql`
    SELECT je_no, company_id, source_type, source_doc_no, entry_date, posted, reversed,
           (narration IS NOT NULL AND position(source_doc_no in narration) > 0) AS in_narration
      FROM scm.journal_entries
     WHERE source_doc_no = ANY(${numbers})
     ORDER BY source_doc_no, entry_date, je_no`;
}

async function main() {
  const sql = postgres(url, { max: 1, prepare: false });
  let exitCode = 0;
  try {
    const { plan, unreadable, scanned } = await survey(sql);
    note(`Scanned ${scanned} receipt(s)${COMPANY === null ? "" : ` in company ${COMPANY}`}.`);

    for (const r of unreadable) {
      warn(`SKIPPED ${r.receipt_number} (company ${r.company_id}) — its number or date cannot be read, so nothing is guessed.`);
    }

    if (plan.length === 0) {
      note("Every receipt number already agrees with its own date. Nothing to do.");
      return;
    }

    /* REFUSE a target somebody already holds. survey() already numbers above
       the live max, so this fires only if the table moved under us — and a
       clash here would be the UNIQUE index's problem a moment later. */
    for (const p of plan) {
      const [clash] = await sql`
        SELECT id FROM scm.acc_receipts
         WHERE company_id = ${p.companyId} AND receipt_number = ${p.to} AND id <> ${p.id} LIMIT 1`;
      if (clash) {
        console.error(`REFUSED: ${p.to} is already held by receipt ${clash.id} in company ${p.companyId}.`);
        process.exit(3);
      }
    }

    const numbers = plan.map((p) => p.from);
    const refs = await references(sql, numbers);

    note(`${plan.length} receipt(s) carry a number from the wrong month:`);
    for (const p of plan) {
      const mine = refs.filter((r) => r.source_doc_no === p.from);
      const live = mine.filter((r) => r.posted && !r.reversed && !r.source_type.endsWith("_REVERSAL"));
      note(
        `  ${p.from} -> ${p.to}   dated ${p.date} · ${p.status} · ${(p.totalSen / 100).toFixed(2)}`
        + ` · ${p.payer ?? "—"} · ${mine.length} journal(s)`
        + (live.length ? ` (live ${live.map((r) => r.je_no).join(", ")})` : " (no live journal)"),
      );
      for (const r of mine) {
        note(`      ${r.je_no}  ${r.source_type}  ${iso(r.entry_date)}`
          + `${r.reversed ? "  [reversed]" : ""}${r.in_narration ? "  [named in narration]" : ""}`);
      }
    }
    note(`${refs.length} journal reference(s) will move with them. Journal NUMBERS do not change.`);

    if (!APPLY) {
      note(`plan only — nothing was written. Re-run with MODE=apply and CONFIRM="${CONFIRM}".`);
      return;
    }

    /* ── THE WRITE ─────────────────────────────────────────────────────────
       Two phases through a temporary, so no moment exists where two rows want
       the same (company_id, receipt_number). One transaction: a half-renamed
       receipt whose journals point at neither number is the one state worth
       any amount of care to avoid. */
    await sql.begin(async (tx) => {
      for (const [i, p] of plan.entries()) {
        const temp = `${p.from}-T${String(i).padStart(2, "0")}`;
        await tx`UPDATE scm.acc_receipts SET receipt_number = ${temp}
                  WHERE id = ${p.id} AND company_id = ${p.companyId}`;
        await tx`UPDATE scm.journal_entries SET source_doc_no = ${temp}
                  WHERE source_doc_no = ${p.from} AND company_id = ${p.companyId}`;
        await tx`UPDATE scm.journal_entries
                    SET narration = replace(narration, ${p.from}, ${temp})
                  WHERE company_id = ${p.companyId} AND narration LIKE ${"%" + p.from + "%"}`;
      }
      for (const [i, p] of plan.entries()) {
        const temp = `${p.from}-T${String(i).padStart(2, "0")}`;
        await tx`UPDATE scm.acc_receipts SET receipt_number = ${p.to}
                  WHERE id = ${p.id} AND company_id = ${p.companyId}`;
        await tx`UPDATE scm.journal_entries SET source_doc_no = ${p.to}
                  WHERE source_doc_no = ${temp} AND company_id = ${p.companyId}`;
        await tx`UPDATE scm.journal_entries
                    SET narration = replace(narration, ${temp}, ${p.to})
                  WHERE company_id = ${p.companyId} AND narration LIKE ${"%" + temp + "%"}`;
      }
    });
    note(`Applied: ${plan.length} receipt(s) renumbered.`);

    /* The vacated numbers are NOT reclaimed. The 2609 counter stays where it
       is, so nothing will ever be issued 2990-OR-2609-001 again — the gap is
       permanent, which is the half of the number rule this repair keeps. */
    note("The numbers they vacated are left permanently unused; no counter is rewound.");
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (APPLY) {
    /* VERIFY ON A FRESH CONNECTION — a check inside the transaction that wrote
       the rows can only tell you what that transaction believes. */
    const check = postgres(url, { max: 1, prepare: false });
    try {
      const bad = COMPANY === null
        ? await check`SELECT receipt_number, receipt_date FROM scm.acc_receipts`
        : await check`SELECT receipt_number, receipt_date FROM scm.acc_receipts WHERE company_id = ${COMPANY}`;
      const still = bad.filter((r) => {
        const p = parseNo(r.receipt_number);
        return p && r.receipt_date && p.tag !== monthTag(r.receipt_date);
      });
      const orphan = await check`
        SELECT j.je_no, j.source_doc_no FROM scm.journal_entries j
         WHERE j.source_type IN ('RCT', 'RCT_REVERSAL')
           AND NOT EXISTS (SELECT 1 FROM scm.acc_receipts r
                            WHERE r.receipt_number = j.source_doc_no AND r.company_id = j.company_id)`;
      const temps = await check`
        SELECT receipt_number FROM scm.acc_receipts WHERE receipt_number LIKE '%-T__'`;

      note(`VERIFY: ${still.length} number(s) still disagree with their date`
        + `, ${orphan.length} receipt journal(s) point at no receipt`
        + `, ${temps.length} temporary number(s) left behind.`);
      for (const r of still) warn(`  still wrong: ${r.receipt_number} dated ${iso(r.receipt_date)}`);
      for (const r of orphan) warn(`  orphan journal: ${r.je_no} -> ${r.source_doc_no}`);
      for (const r of temps) warn(`  temporary left: ${r.receipt_number}`);
      if (still.length || orphan.length || temps.length) {
        console.error("VERIFY FAILED — the repair did not land clean.");
        exitCode = 4;
      } else {
        note("VERIFY OK — every receipt number sits in its own month and every journal follows it.");
      }
    } finally {
      await check.end({ timeout: 5 });
    }
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
