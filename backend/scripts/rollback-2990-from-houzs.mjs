#!/usr/bin/env node
// Phase 2 ROLLBACK — remove every imported 2990 row from the destination DB.
// Owner rule 2026-07-13: the prod import is withdrawn; the full import must be
// proven on staging first, then replayed into prod once, complete.
//
// Deletes ONLY: scm rows WHERE company_id = <2990's id>, plus the imported
// legacy 2990 staff rows in the shared scm.staff table (matched by the SOURCE
// staff id list; rows with user_id set — Houzs-synced staff — are never touched,
// and the pinned system staff row is explicitly excluded).
// Houzs (company 1) data is untouched. The public.companies '2990' row stays.
// Dry-run unless APPLY=1.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
const SUPA_URL = process.env.SOURCE_SUPABASE_URL, SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY, DST = process.env.DATABASE_URL;
const APPLY = process.env.APPLY === "1";
const SYSTEM_STAFF = "00000000-0000-4000-8000-000000000001";
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const cidRow = await dst`SELECT id FROM companies WHERE code='2990'`;
  if (!cidRow.length) { console.log("NO 2990 company row — nothing to roll back"); return; }
  const cid = Number(cidRow[0].id);
  console.log(`2990 company_id=${cid} mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const tabs = await dst`SELECT t.table_name FROM information_schema.tables t WHERE t.table_schema='scm' AND t.table_type='BASE TABLE' AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='scm' AND c.table_name=t.table_name AND c.column_name='company_id') ORDER BY t.table_name`;
  let total = 0;
  const held = [];
  for (const { table_name: t } of tabs) {
    const [r] = await dst.unsafe(`SELECT count(*)::int AS n FROM scm."${t}" WHERE company_id=${cid}`);
    if (r.n > 0) { held.push(t); total += r.n; console.log(`${t}: ${r.n} rows to remove`); }
  }
  console.log(`TOTAL company-${cid} rows: ${total}`);

  if (APPLY) {
    // FK-order-agnostic delete: keep sweeping until empty or no progress.
    let remaining = new Set(held);
    for (let pass = 1; pass <= 10 && remaining.size; pass++) {
      let progress = false;
      for (const t of [...remaining]) {
        try {
          const r = await dst.unsafe(`DELETE FROM scm."${t}" WHERE company_id=${cid}`);
          if (r.count > 0) progress = true;
          const [left] = await dst.unsafe(`SELECT count(*)::int AS n FROM scm."${t}" WHERE company_id=${cid}`);
          if (left.n === 0) remaining.delete(t);
        } catch (e) { /* FK still referenced — later pass */ }
      }
      console.log(`pass ${pass}: ${remaining.size} tables still holding rows`);
      if (!progress && remaining.size) { console.log(`STUCK on: ${[...remaining].join(",")}`); break; }
    }
    if (remaining.size) { console.error("ROLLBACK_INCOMPLETE"); process.exit(1); }
  }

  // Imported legacy staff (shared table, no company_id): match by SOURCE ids.
  if (SUPA_URL && SUPA_KEY) {
    const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
    const { data, error } = await src.schema("public").from("staff").select("id");
    if (error) { console.log("staff src read failed: " + error.message); }
    else {
      const ids = (data ?? []).map(r => r.id).filter(id => id !== SYSTEM_STAFF);
      if (ids.length) {
        const [n] = await dst`SELECT count(*)::int AS n FROM scm.staff WHERE id = ANY(${ids}) AND user_id IS NULL`;
        console.log(`legacy 2990 staff rows to remove: ${n.n}`);
        if (APPLY) { const r = await dst`DELETE FROM scm.staff WHERE id = ANY(${ids}) AND user_id IS NULL`; console.log(`staff removed: ${r.count}`); }
      }
    }
  }

  if (APPLY) {
    let left = 0;
    for (const { table_name: t } of tabs) {
      const [r] = await dst.unsafe(`SELECT count(*)::int AS n FROM scm."${t}" WHERE company_id=${cid}`);
      if (r.n > 0) { left += r.n; console.log(`STILL_HELD ${t}: ${r.n}`); }
    }
    console.log(left === 0 ? "ROLLBACK_CLEAN" : `ROLLBACK_LEFTOVER=${left}`);
    if (left > 0) process.exit(1);
  }
}
main().then(() => dst.end()).catch(async e => { console.error("ROLLBACK_FAIL", e.message); await dst.end(); process.exit(1); });
