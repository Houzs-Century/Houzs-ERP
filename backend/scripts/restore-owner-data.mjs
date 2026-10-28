// One-off restore of the owner's pre-cutover amendment data into Supabase.
//
// Background: the D1->Supabase cutover rebuilt prod from `main`, which did NOT
// carry the owner's May/June amendment data (branch feat/checklist-amendments).
// This re-applies ONLY that data, selectively + additively. Run by the
// restore-owner-data GitHub Actions workflow (which pg_dumps a backup first).
//
// SAFETY (hard rules baked in):
//   - Touches ONLY: projects, project_finance, lorries, users. NEVER the
//     Service / ASSR tables (another user edits Service live), NEVER roles or
//     role/page access, NEVER deletes a row, NEVER creates a project or user.
//   - Projects/finance: UPDATE existing rows matched by `code`. Unmatched codes
//     are REPORTED, never inserted (a project needs brand/pic/etc we don't have).
//   - Lorries: upsert by `plate` (his current fleet roster).
//   - Users: set company_phone (+ fill blank ic_number) on existing users
//     matched by email. Role assignment is intentionally NOT touched (owner
//     steering: user-management/roles stay on current main). Unmatched -> report.
//   - DRY RUN by default. Pass --apply to write. Apply runs in one transaction.
//
// Field rules (from RESTORE-DATA/README.md, Part C of RESTORE-FOR-DEV.md):
//   - total_sales = value; blank -> 0 (his value wins; quick-entry projects)
//   - rental      = set where source had a value (0 counts); blank -> leave
//   - booth_no / size_sqm = set where source had a value; blank -> leave
//
// Usage:
//   RESTORE_DIR=/tmp/restore node scripts/restore-owner-data.mjs            # dry run
//   RESTORE_DIR=/tmp/restore node scripts/restore-owner-data.mjs --apply    # write
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const DIR = process.env.RESTORE_DIR || ".batch4-data";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env or .dev.vars). Aborting.");
  process.exit(1);
}

// `wrangler d1 ... --json` wraps rows in [{ results: [...] }] (or sometimes the
// bare array). Normalise to the row array.
function rows(file) {
  // wrangler --json on Windows prepends a UTF-8 BOM; strip it before parse.
  let text = readFileSync(path.join(DIR, file), "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
  const raw = JSON.parse(text);
  if (Array.isArray(raw)) return raw[0]?.results ?? raw;
  return raw.results ?? [];
}

const projectRows = rows("projects-may-june-values.json");
const lorryRows = rows("lorries.json");
const staffRows = rows("fleet-staff.json");

const blank = (v) => v == null || String(v).trim() === "";

console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
console.log(`Source dir: ${DIR}`);
console.log(`Rows -> projects: ${projectRows.length}, lorries: ${lorryRows.length}, staff: ${staffRows.length}\n`);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const summary = {
  projects: { updated: 0, financeUpserted: 0, unmatched: [] },
  lorries: { inserted: 0, updated: 0 },
  staff: { phoneSet: 0, icFilled: 0, unmatched: [] },
};

async function run(sql) {
  // ── Projects + finance (UPDATE existing only, matched by code) ──────
  for (const r of projectRows) {
    if (blank(r.code)) continue;
    const found = await sql`SELECT id FROM projects WHERE code = ${r.code}`;
    if (!found.length) {
      summary.projects.unmatched.push(r.code);
      continue;
    }
    const id = found[0].id;
    const totalSales = blank(r.total_sales) ? 0 : Number(r.total_sales);
    const booth = blank(r.booth_no) ? null : String(r.booth_no).trim();
    const size = blank(r.size_sqm) ? null : Number(r.size_sqm);
    const rental = blank(r.rental) ? null : Number(r.rental);

    if (APPLY) {
      // booth_no / size_sqm: his value wins when present, else keep existing.
      await sql`UPDATE projects
                   SET booth_no = COALESCE(${booth}, booth_no),
                       size_sqm = COALESCE(${size}, size_sqm)
                 WHERE id = ${id}`;
      // project_finance: upsert. total_sales always set (his value; blank->0).
      // rental set only when source had a value.
      const pf = await sql`SELECT project_id FROM project_finance WHERE project_id = ${id}`;
      if (pf.length) {
        await sql`UPDATE project_finance
                     SET total_sales = ${totalSales},
                         rental = COALESCE(${rental}, rental),
                         updated_at = to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')
                   WHERE project_id = ${id}`;
      } else {
        await sql`INSERT INTO project_finance (project_id, total_sales, rental, updated_at)
                  VALUES (${id}, ${totalSales}, ${rental ?? 0},
                          to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'))`;
      }
    }
    summary.projects.updated += 1;
    summary.projects.financeUpserted += 1;
  }

  // ── Lorries (upsert by plate) ──────────────────────────────────────
  for (const r of lorryRows) {
    if (blank(r.plate)) continue;
    const existing = await sql`SELECT id FROM lorries WHERE plate = ${r.plate}`;
    const size = blank(r.size) ? null : String(r.size).trim();
    const model = blank(r.model) ? null : String(r.model).trim();
    const wh = blank(r.warehouse) ? null : String(r.warehouse).trim();
    const isInternal = r.is_internal === 0 || r.is_internal === false ? 0 : 1;
    const status = blank(r.status) ? "active" : String(r.status).trim();
    if (existing.length) {
      if (APPLY) {
        await sql`UPDATE lorries
                     SET size = COALESCE(${size}, size),
                         model = COALESCE(${model}, model),
                         warehouse = COALESCE(${wh}, warehouse),
                         is_internal = ${isInternal},
                         status = ${status},
                         is_active = 1
                   WHERE id = ${existing[0].id}`;
      }
      summary.lorries.updated += 1;
    } else {
      if (APPLY) {
        await sql`INSERT INTO lorries (plate, size, model, warehouse, is_internal, status, is_active)
                  VALUES (${r.plate}, ${size}, ${model}, ${wh}, ${isInternal}, ${status}, 1)`;
      }
      summary.lorries.inserted += 1;
    }
  }

  // ── Staff company_phone (+ fill blank ic_number), matched by email ──
  for (const r of staffRows) {
    if (blank(r.email)) continue;
    const found = await sql`SELECT id, company_phone, ic_number FROM users WHERE lower(email) = ${String(r.email).toLowerCase()}`;
    if (!found.length) {
      summary.staff.unmatched.push(r.email);
      continue;
    }
    const u = found[0];
    const cp = blank(r.company_phone) ? null : String(r.company_phone).trim();
    const ic = blank(r.ic_number) ? null : String(r.ic_number).trim();
    if (cp) {
      if (APPLY) await sql`UPDATE users SET company_phone = ${cp} WHERE id = ${u.id}`;
      summary.staff.phoneSet += 1;
    }
    // ic_number: only fill when currently blank (don't overwrite a real one).
    if (ic && blank(u.ic_number)) {
      if (APPLY) await sql`UPDATE users SET ic_number = ${ic} WHERE id = ${u.id}`;
      summary.staff.icFilled += 1;
    }
  }
}

try {
  if (APPLY) {
    await pg.begin(async (tx) => {
      await run(tx);
    });
  } else {
    await run(pg);
  }
} catch (e) {
  console.error("ERROR — transaction rolled back, nothing written.");
  console.error(String(e?.message || e));
  await pg.end();
  process.exit(1);
}

console.log("── Summary ─────────────────────────────────");
console.log(`Projects matched + updated:   ${summary.projects.updated}/${projectRows.length}`);
console.log(`Project_finance upserted:     ${summary.projects.financeUpserted}`);
console.log(`Projects UNMATCHED (skipped): ${summary.projects.unmatched.length}`);
if (summary.projects.unmatched.length)
  console.log("  " + summary.projects.unmatched.join("\n  "));
console.log(`Lorries inserted / updated:   ${summary.lorries.inserted} / ${summary.lorries.updated}`);
console.log(`Staff company_phone set:      ${summary.staff.phoneSet}`);
console.log(`Staff ic_number filled:       ${summary.staff.icFilled}`);
console.log(`Staff UNMATCHED (skipped):    ${summary.staff.unmatched.length}`);
if (summary.staff.unmatched.length)
  console.log("  " + summary.staff.unmatched.join("\n  "));
console.log("────────────────────────────────────────────");
console.log(APPLY ? "APPLIED." : "DRY RUN complete — no writes. Re-run with --apply to write.");

await pg.end();
