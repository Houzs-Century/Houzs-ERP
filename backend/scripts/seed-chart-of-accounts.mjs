#!/usr/bin/env node
/* Seed the accountant's chart of accounts — the owner's ask, verbatim
   (2026-09-03): chart of account你不能直接帮我放进去?

   WHAT THIS APPLIES. scripts/data/chart-of-accounts-houzs.json — the parsed
   AutoCount export (397 accounts: digit + letter code series, two-tier
   parent/child, section-derived types, SBK/SCH → acc_money), pre-classified
   shared vs company-specific by the same rule the Chart page uses: banks and
   cash (SBK/SCH) plus the related-party/director/HP/borrowing series
   (350/351/430/450/451/460/406) stay with company 1; everything else is the
   owner's 选择性公用 and lands in EVERY company, parents riding along.

   SAME SEMANTICS AS POST /accounting/chart/import, deliberately: upsert by
   (company_id, account_code) — name/type/parent/money follow the file,
   is_active goes TRUE — and rows NOT in the file are never touched (the 0297
   template rows the relay left behind wait for a person on the Chart page,
   not for a seed guessing). Idempotent: run it twice, the second run updates
   the same rows to the same values.

   MODE=plan (default) writes NOTHING — it prints, per company, how many rows
   would be created and how many updated. MODE=apply needs CONFIRM to be the
   exact sentence, like every repair workflow here.

   RE-RUN: a second apply upserts the same rows to the same values — pure
   idempotence; rows not in the file are never touched either run. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const MODE = APPLY ? "apply" : "plan";
const CONFIRM = process.env.CONFIRM ?? "";
if (MODE === "apply" && CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error("apply needs CONFIRM='I HAVE REVIEWED THE DRY-RUN' — run plan first and read it.");
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const { rows } = JSON.parse(readFileSync(join(HERE, "data/chart-of-accounts-houzs.json"), "utf8"));

const TYPES = new Set(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]);
const seen = new Set();
for (const r of rows) {
  if (!r.code || !r.name || !TYPES.has(r.accountType)) { console.error("bad row", r); process.exit(2); }
  if (seen.has(r.code)) { console.error("duplicate code in file", r.code); process.exit(2); }
  seen.add(r.code);
}
for (const r of rows) {
  if (r.parentCode && !seen.has(r.parentCode)) { console.error(`${r.code} names parent ${r.parentCode} not in the file`); process.exit(2); }
}

/* shared + the parents of shared rows — the tree stays whole. */
const sharedCodes = new Set(rows.filter((r) => r.shared).map((r) => r.code));
for (const r of rows) if (r.shared && r.parentCode) sharedCodes.add(r.parentCode);
const sharedRows = rows.filter((r) => sharedCodes.has(r.code));

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

const toDbRow = (companyId, r) => ({
  company_id: companyId,
  account_code: r.code,
  account_name: r.name,
  account_type: r.accountType,
  parent_code: r.parentCode,
  acc_money: r.accMoney === true,
  is_active: true,
});

try {
  const companies = await sql`SELECT id, code FROM public.companies ORDER BY id`;
  const targetIds = companies.map((c) => Number(c.id));
  if (!targetIds.includes(1)) { console.error("company 1 missing from public.companies — refusing"); process.exit(2); }

  console.log(`file: ${rows.length} accounts (${sharedRows.length} shared incl. parents, ${rows.length - rows.filter((r) => r.shared).length} company-specific)`);
  console.log(`companies: ${companies.map((c) => `${c.id}=${c.code}`).join(", ")}`);

  for (const co of targetIds) {
    const subset = co === 1 ? rows : sharedRows;
    const codes = subset.map((r) => r.code);
    const existing = await sql`
      SELECT account_code FROM scm.accounts
      WHERE company_id = ${co} AND account_code = ANY(${codes})`;
    const have = new Set(existing.map((e) => e.account_code));
    const creates = subset.filter((r) => !have.has(r.code)).length;
    console.log(`company ${co}: ${subset.length} row(s) → ${creates} create, ${subset.length - creates} update`);

    if (MODE === "apply") {
      /* Parents first so a fresh chart never has a child pointing at a code
         that lands later in the same batch (no FK today, but the tree reads
         cleanly at every instant). */
      const ordered = [...subset].sort((a, b) => (a.parentCode ? 1 : 0) - (b.parentCode ? 1 : 0));
      for (let i = 0; i < ordered.length; i += 100) {
        const chunk = ordered.slice(i, i + 100).map((r) => toDbRow(co, r));
        await sql`
          INSERT INTO scm.accounts ${sql(chunk, "company_id", "account_code", "account_name", "account_type", "parent_code", "acc_money", "is_active")}
          ON CONFLICT (company_id, account_code) DO UPDATE SET
            account_name = EXCLUDED.account_name,
            account_type = EXCLUDED.account_type,
            parent_code  = EXCLUDED.parent_code,
            acc_money    = EXCLUDED.acc_money,
            is_active    = TRUE`;
      }
      console.log(`company ${co}: applied.`);
    }
  }
  if (MODE === "plan") console.log("PLAN ONLY — nothing written. Re-run with MODE=apply and the CONFIRM sentence.");

  /* Fresh-connection verification: the session that wrote is the worst
     witness. A SECOND client re-reads and asserts SHAPE, not just counts —
     the Maybank leaf must carry its parent, its type and its money flag in
     every company that received the shared set. */
  if (MODE === "apply") {
    const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
    try {
      for (const co of targetIds) {
        const subset = co === 1 ? rows : sharedRows;
        const [{ n }] = await v`
          SELECT count(*)::int AS n FROM scm.accounts
          WHERE company_id = ${co} AND account_code = ANY(${subset.map((r) => r.code)}) AND is_active = TRUE`;
        if (n !== subset.length) throw new Error(`company ${co}: expected ${subset.length} active rows, found ${n}`);
        const probe = subset.find((r) => r.code === "310-0010") ?? subset.find((r) => r.parentCode);
        if (probe) {
          const [row] = await v`
            SELECT account_name, account_type, parent_code, acc_money FROM scm.accounts
            WHERE company_id = ${co} AND account_code = ${probe.code}`;
          if (!row || row.account_name !== probe.name || row.account_type !== probe.accountType
            || row.parent_code !== probe.parentCode || row.acc_money !== (probe.accMoney === true)) {
            throw new Error(`company ${co}: ${probe.code} shape mismatch: ${JSON.stringify(row)}`);
          }
        }
      }
      console.log("VERIFIED on a fresh connection: every row active, probe shape exact.");
    } finally {
      await v.end();
    }
  }
} finally {
  await sql.end();
}
