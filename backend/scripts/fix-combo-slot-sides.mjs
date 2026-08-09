// Combo slots must accept BOTH sides (owner 2026-08-09: "如果是 1A,左右都是
// 要对的 — 它没有分左右,左右都要可以在里面").
//
// The 2026-08 combo loads fixed some slots to a single side (e.g. R819
// 2R+3R as [1A(R)(LHF)],[1A(R)(RHF)],…; THL 2pp slots). This rewrites every
// single-code slot that carries a (LHF)/(RHF) side into the OR-pair
// [base(LHF), base(RHF)] — same convention as the Hookka quotation combos.
// Scope: rows created by our two loaders (notes match), both supplier and
// master rows. In-place modules UPDATE (rows are hours old, unreferenced).
//
// DRY-RUN default; APPLY=1 writes.
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const SIDE = /^(.+)\((LHF|RHF)\)$/;

function fixModules(mods) {
  let changed = false;
  const next = mods.map((slot) => {
    if (Array.isArray(slot) && slot.length === 1) {
      const m = SIDE.exec(slot[0]);
      if (m) { changed = true; return [`${m[1]}(LHF)`, `${m[1]}(RHF)`]; }
    }
    return slot;
  });
  return { changed, next };
}

try {
  const rows = await sql`SELECT id, base_model, modules, label, notes FROM scm.sofa_combo_pricing
    WHERE deleted_at IS NULL
      AND (notes LIKE 'supplier-price-list-2026-08%' OR notes = 'hookka-quotation-2026-08-09')`;
  let fix = 0, ok = 0;
  const samples = [];
  await sql.begin(async (tx) => {
    for (const r of rows) {
      const { changed, next } = fixModules(r.modules);
      if (!changed) { ok++; continue; }
      fix++;
      if (samples.length < 6) samples.push(`${r.base_model} ${r.label}: ${JSON.stringify(r.modules)} -> ${JSON.stringify(next)}`);
      if (APPLY) await tx`UPDATE scm.sofa_combo_pricing SET modules = ${tx.json(next)}, updated_at = now() WHERE id = ${r.id}`;
    }
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: fixed ${fix}, already-or-set ${ok} of ${rows.length}`);
    for (const s of samples) console.log("  " + s);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });
