// FAIR PNL 2025/26 dedup — consolidates PMS-side duplicate projects to match the
// owner-authoritative Excel. DRY-RUN by default. Pass --commit to write.
// Actions (from dedup_actions_2526.json, owner-reviewed):
//   archive           : set archived_at (REVERSIBLE) on an empty/duplicate project
//   move_then_archive : move the project's finance lines to its keeper (preserve money),
//                       then archive the now-empty shell.
// SAFETY: never touches a project that has ANY file (checklist attachment / phase photo /
// legacy attachment / checklist evidence). Re-checks live before each action.
import postgres from "postgres";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

async function fileCount(id) {
  const [r] = await sql`
    SELECT (SELECT COUNT(*) FROM project_checklist_attachments ca JOIN project_checklist c ON c.id=ca.item_id WHERE c.project_id=${id} AND ca.archived_at IS NULL)
         + (SELECT COUNT(*) FROM project_phase_photos WHERE project_id=${id})
         + (SELECT COUNT(*) FROM project_attachments  WHERE project_id=${id})
         + (SELECT COUNT(*) FROM project_checklist c WHERE c.project_id=${id} AND c.evidence_r2_key IS NOT NULL AND c.evidence_r2_key<>'') AS n`;
  return Number(r.n);
}

async function main() {
  const acts = JSON.parse(fs.readFileSync(path.join(HERE, "dedup_actions_2526.json"), "utf8"));
  console.log(`\n=== FAIR PNL 2025/26 dedup — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`actions: ${acts.length} (archive ${acts.filter(a=>a.op==="archive").length}, move_then_archive ${acts.filter(a=>a.op==="move_then_archive").length})`);

  let archived = 0, moved = 0, skippedFiles = 0, skippedGone = 0, movedLines = 0;
  for (const a of acts) {
    const [p] = await sql`SELECT id, archived_at, venue, brand, start_date FROM projects WHERE id=${a.id}`;
    if (!p) { skippedGone++; console.log(`  SKIP p${a.id} — not found`); continue; }
    if (p.archived_at) { skippedGone++; continue; }
    const scope = p.start_date >= "2025-01-01" && p.start_date < "2026-07-01";
    if (!scope) { skippedGone++; console.log(`  SKIP p${a.id} — out of scope (${p.start_date})`); continue; }
    const nf = await fileCount(a.id);
    if (nf > 0) { skippedFiles++; console.log(`  SKIP p${a.id} — HAS ${nf} FILES (never touch) @ ${p.venue}`); continue; }

    if (a.op === "move_then_archive") {
      const [k] = await sql`SELECT id, archived_at FROM projects WHERE id=${a.keeper}`;
      if (!k || k.archived_at) { skippedGone++; console.log(`  SKIP p${a.id} — keeper p${a.keeper} missing/archived`); continue; }
      if (COMMIT) {
        const res = await sql`UPDATE project_finance_lines SET project_id=${a.keeper} WHERE project_id=${a.id} AND archived_at IS NULL`;
        movedLines += res.count;
        await sql`UPDATE projects SET archived_at = to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') WHERE id=${a.id}`;
      }
      moved++;
      console.log(`  ${COMMIT?"MOVED+ARCHIVED":"would move lines->keeper p"+a.keeper+" then archive"} p${a.id} (RM ${a.income}) @ ${p.venue}`);
    } else { // archive
      if (COMMIT) await sql`UPDATE projects SET archived_at = to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') WHERE id=${a.id}`;
      archived++;
      console.log(`  ${COMMIT?"ARCHIVED":"would archive"} p${a.id} (RM ${a.income}, ${a.reason}) @ ${p.venue}`);
    }
  }
  console.log(`\n${COMMIT?"DONE":"DRY-RUN"} — archive ${archived}, move_then_archive ${moved} (lines moved ${movedLines}), skipped-has-files ${skippedFiles}, skipped-gone/oos ${skippedGone}`);
  if (!COMMIT) console.log("--commit to apply. Deletes are archived_at (reversible).");
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });
