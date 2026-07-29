// FAIR PNL cleanup — two safe passes. DRY-RUN by default; --commit to write.
//   --pass=empty : archive projects that are TRUE empty shells — 0 income, 0 finance
//                  lines, 0 files (checklist attachments/evidence/phase photos/legacy),
//                  0 checklist items. (Real future bookings keep dates/checklist, so kept.)
//   --pass=dups  : exact duplicates — same brand+venue+start_date+end_date, >1 non-archived
//                  project; keep the one with most data (income, then files), archive the rest.
// Deletes are archived_at (REVERSIBLE). NO scope cap (covers 2027 future too, per owner),
// but --pass=dups never archives a project that holds files.
import postgres from "postgres";
const COMMIT = process.argv.includes("--commit");
const PASS = (process.argv.find((a) => a.startsWith("--pass=")) || "").split("=")[1] || "";
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
if (!["empty", "dups"].includes(PASS)) { console.error("need --pass=empty|dups"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });
const arch = async (id) => sql`UPDATE projects SET archived_at = to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') WHERE id=${id}`;

async function filesOf(id) {
  const [r] = await sql`
    SELECT (SELECT COUNT(*) FROM project_checklist_attachments ca JOIN project_checklist c ON c.id=ca.item_id WHERE c.project_id=${id} AND ca.archived_at IS NULL)
         + (SELECT COUNT(*) FROM project_phase_photos WHERE project_id=${id})
         + (SELECT COUNT(*) FROM project_attachments  WHERE project_id=${id})
         + (SELECT COUNT(*) FROM project_checklist c WHERE c.project_id=${id} AND c.evidence_r2_key IS NOT NULL AND c.evidence_r2_key<>'') AS n`;
  return Number(r.n);
}

async function main() {
  console.log(`\n=== FAIR PNL cleanup pass=${PASS} — ${COMMIT ? "COMMIT" : "DRY-RUN"} ===`);
  if (PASS === "empty") {
    const rows = await sql`
      SELECT p.id, p.name, p.start_date,
        (SELECT COUNT(*) FROM project_finance_lines l WHERE l.project_id=p.id AND l.archived_at IS NULL) nlines,
        (SELECT COUNT(*) FROM project_checklist c WHERE c.project_id=p.id) nchk
      FROM projects p WHERE p.archived_at IS NULL
      ORDER BY p.start_date`;
    let n = 0;
    for (const p of rows) {
      if (Number(p.nlines) > 0 || Number(p.nchk) > 0) continue;
      const f = await filesOf(p.id);
      if (f > 0) continue;
      n++;
      if (COMMIT) await arch(p.id);
      if (n <= 60) console.log(`  ${COMMIT ? "ARCHIVED" : "would archive"} p${p.id} ${p.start_date} — TRUE EMPTY — ${p.name}`);
    }
    console.log(`\n${COMMIT ? "DONE" : "DRY-RUN"} — true-empty shells: ${n}`);
  } else {
    const rows = await sql`
      SELECT p.id, p.name, p.brand, p.venue, p.start_date, p.end_date,
        COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id=p.id AND l.kind='income' AND l.archived_at IS NULL),0) income
      FROM projects p WHERE p.archived_at IS NULL`;
    const groups = new Map();
    for (const p of rows) { const k = `${p.brand}|${p.venue}|${p.start_date}|${p.end_date}`; (groups.get(k) || groups.set(k, []).get(k)).push(p); }
    let n = 0;
    for (const [k, g] of groups) {
      if (g.length < 2) continue;
      const withFiles = [];
      for (const p of g) withFiles.push({ p, f: await filesOf(p.id) });
      withFiles.sort((a, b) => (b.f - a.f) || (Number(b.p.income) - Number(a.p.income)));
      const keep = withFiles[0];
      for (const { p, f } of withFiles.slice(1)) {
        if (f > 0) { console.log(`  SKIP p${p.id} — has ${f} files (dup of p${keep.p.id})`); continue; }
        n++;
        if (COMMIT) await arch(p.id);
        console.log(`  ${COMMIT ? "ARCHIVED" : "would archive"} dup p${p.id} (${p.start_date}) keep p${keep.p.id} — ${p.name}`);
      }
    }
    console.log(`\n${COMMIT ? "DONE" : "DRY-RUN"} — exact-duplicate projects archived: ${n}`);
  }
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });
