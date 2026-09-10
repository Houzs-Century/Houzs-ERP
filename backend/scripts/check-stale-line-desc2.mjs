// Read-only census: which orders print a spec the line no longer has?
//
// An approved SPEC amendment rewrites the line's `variants`. Rebuilding the
// line's Description 2 — the sentence the Sales Order PDF prints under the item
// name — from those new variants only started happening when #3551 shipped:
// deploy run 34467359474, backend job completed 2026-09-10T10:50:39Z. Every SPEC
// amendment approved BEFORE that moment moved the spec and left the printed
// sentence saying the old thing.
//
// Found on HC-SO-012312, where a rep asked for the drawer off beds 2 and 3.
// Amendment A1 was approved 07:44:27Z and did remove "Right Drawer" from both
// HILTON lines; the fix went live at 10:50:39Z; at 12:20Z both lines still
// PRINTED "+ Right Drawer". Two lines of one order were seen by eye. This
// answers the question that follows and that nobody should answer by guessing:
// HOW MANY MORE, and WHICH.
//
// HOW IT DECIDES, without re-implementing anything:
//
// The approval's own audit row already carries the answer. `applySoAmendment`
// (scm/lib/so-revision.ts) writes `line_<code>_spec` as
// buildVariantSummary(itemGroup, variants) — the SAME call, on the SAME
// arguments, that produces Description 2 — recording the value BEFORE the
// amendment and the value AFTER it. So the expected printed sentence is a
// stored server-computed string, not something this script has to derive.
//
// Re-deriving it here would be the duplicated-decision bug class: a second
// implementation of the rule that drifts from the first, which is exactly what
// docs/bugs/0787 was about (a probe reading fewer variant keys than the
// renderer, and reporting a clean line that was not one).
//
// Per audit row, per `line_<code>_spec` change, against the order's CURRENT
// lines carrying that item code:
//
//   REBUILT   some line's description2 equals the recorded AFTER value
//   STALE     no line matches AFTER, and some line still equals BEFORE
//   UNCLEAR   neither — something changed it since, or the line is gone.
//             Reported as its own outcome and NEVER folded into either of the
//             other two. "I do not know" is an answer; dressing it as one of
//             the others is what this repo keeps paying for. It is also LISTED,
//             with what the line prints today beside what the approval asked
//             for: the first version printed the count alone, and a count of
//             rows nobody can look at is a count nobody can act on. It reads as
//             a tidy remainder when it is unfinished work.
//
// Two lines of one order can share an item code (HC-SO-012312 has two
// HILTON (A)-(Q)), so the audit key does not identify a LINE. That ambiguity is
// handled by asking "does ANY line with this code print the AFTER value" rather
// than by picking one.
//
// It also reports approvals AFTER the cutoff, separately. That half is the
// self-check: if those show STALE too, the fix is NOT working and this census
// has refuted the premise it was written on, which is worth far more than the
// count. A probe that can only confirm is not evidence.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — including "nothing is stale" — so a red job always means
// the check itself broke. Manual dispatch, own concurrency group, never on a
// schedule.
//
// RE-RUN: safe and free. It reads and prints; running it twice changes nothing.
//
// It says which orders print the wrong sentence. It does NOT repair them —
// repairing means raising and approving an amendment per order, which is a
// business act with a price authority attached, and no script here may forge it.
import { readFileSync } from "node:fs";
import postgres from "postgres";

/* Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars. */
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const note = (s) => console.log(`::notice::${s}`);

/* When the rebuild went live: the backend job of the deploy that carried #3551
   (run 34467359474) completed at this instant. Overridable so the same script
   can answer the same question about a different cutoff, and PRINTED on every
   run so no reader has to trust this constant. */
const DEFAULT_CUTOFF = "2026-09-10T10:50:39Z";

/* The audit key applySoAmendment writes per amended line. `<code>` is the
   line's item code at the time, which may contain anything a code may contain —
   so the prefix and suffix are matched and everything between them is the code,
   rather than a pattern that assumes what a code looks like. */
const SPEC_KEY = /^line_(.*)_spec$/;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const txt = (v) => (v == null ? "" : String(v));

async function main() {
  const cutoff = (process.env.CUTOFF_UTC ?? "").trim() || DEFAULT_CUTOFF;
  const url = resolveUrl();
  if (!url) {
    console.error("No DATABASE_URL (env or backend/.dev.vars). Cannot answer.");
    process.exit(1);
  }
  const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

  try {
    note(`Cutoff (the rebuild went live): ${cutoff}`);
    note("An approval BEFORE it ran code that did not touch Description 2.");

    const rows = await sql`
      SELECT so_doc_no, created_at, field_changes
        FROM scm.mfg_so_audit_log
       WHERE action = 'AMENDMENT_SO_APPROVED'
         AND field_changes IS NOT NULL
       ORDER BY created_at ASC`;
    note(`Approved amendments in the audit log: ${rows.length}`);

    /* doc_no -> the spec changes its approvals recorded, split by side of the
       cutoff. Collected first so the line read below is ONE query per document
       rather than one per change. */
    const byDoc = new Map();
    let specChanges = 0;
    for (const r of rows) {
      const changes = Array.isArray(r.field_changes) ? r.field_changes : null;
      if (changes == null) continue;
      for (const c of changes) {
        const m = SPEC_KEY.exec(String(c?.field ?? ""));
        if (!m) continue;
        const from = txt(c?.from);
        const to = txt(c?.to);
        if (from === to) continue; // the differ drops no-ops; belt and braces
        specChanges += 1;
        const entry = byDoc.get(r.so_doc_no) ?? { before: [], after: [] };
        const side = new Date(r.created_at) < new Date(cutoff) ? entry.before : entry.after;
        side.push({ code: m[1], from, to, at: r.created_at });
        byDoc.set(r.so_doc_no, entry);
      }
    }
    note(`Line spec changes carried by those approvals: ${specChanges}, across ${byDoc.size} order(s)`);

    const verdictOf = (change, lines) => {
      const same = lines.filter((l) => l.item_code === change.code);
      if (same.some((l) => txt(l.description2) === change.to)) return "REBUILT";
      if (same.some((l) => txt(l.description2) === change.from)) return "STALE";
      return "UNCLEAR";
    };

    const staleDocs = [];
    const unclearDocs = [];
    const nBefore = { REBUILT: 0, STALE: 0, UNCLEAR: 0 };
    const nAfter = { REBUILT: 0, STALE: 0, UNCLEAR: 0 };

    for (const [docNo, entry] of byDoc) {
      /* `doc_no`, NOT `so_doc_no`. The two tables spell the same reference
         differently — the audit log above is `so_doc_no`, the line table is
         `doc_no` — and reading the neighbouring query is what makes that look
         obvious rather than arbitrary. This script died on its first dispatch
         with `column "so_doc_no" does not exist`, after every gate passed,
         because they all read code and none of them opens the database
         (docs/bugs/0790-*). */
      const lines = await sql`
        SELECT item_code, description2, cancelled
          FROM scm.mfg_sales_order_items
         WHERE doc_no = ${docNo}`;
      const live = lines.filter((l) => !l.cancelled);
      const stale = [];
      const unclear = [];
      for (const ch of entry.before) {
        const v = verdictOf(ch, live);
        nBefore[v] += 1;
        if (v === "STALE") stale.push(ch);
        /* An UNCLEAR row is carried with what its lines PRINT TODAY, because
           that third string is the whole reason the verdict is unclear and a
           reader cannot judge the row without it. Cancelled lines are listed
           too, flagged: "the line was cancelled" is usually the answer, and
           hiding them would leave the row looking unexplained. */
        if (v === "UNCLEAR") {
          unclear.push({
            ...ch,
            now: lines
              .filter((l) => l.item_code === ch.code)
              .map((l) => `${l.cancelled ? "[cancelled] " : ""}${txt(l.description2) || "(empty)"}`),
          });
        }
      }
      for (const ch of entry.after) nAfter[verdictOf(ch, live)] += 1;
      if (stale.length > 0) staleDocs.push({ docNo, stale });
      if (unclear.length > 0) unclearDocs.push({ docNo, unclear });
    }

    note("---- approvals BEFORE the cutoff (the affected population) ----");
    note(`  REBUILT ${nBefore.REBUILT}   STALE ${nBefore.STALE}   UNCLEAR ${nBefore.UNCLEAR}`);
    note("---- approvals AFTER the cutoff (the self-check) ----");
    note(`  REBUILT ${nAfter.REBUILT}   STALE ${nAfter.STALE}   UNCLEAR ${nAfter.UNCLEAR}`);
    if (nAfter.STALE > 0) {
      note("  STALE after the cutoff means the rebuild is NOT working. That refutes");
      note("  the premise this census was written on, and matters more than the count.");
    }

    note(`---- orders that PRINT a spec their line no longer has: ${staleDocs.length} ----`);
    if (staleDocs.length === 0) {
      note("  NONE. Nothing to chase.");
    }
    for (const d of staleDocs) {
      note(`  ${d.docNo} — ${d.stale.length} line(s)`);
      for (const ch of d.stale) {
        note(`      ${ch.code}`);
        note(`        PRINTS NOW: ${clip(ch.from, 300)}`);
        note(`        SHOULD BE : ${clip(ch.to, 300)}`);
      }
    }

    /* LISTED, not merely counted. The first version printed a number here and
       nothing else, and the owner's immediate and correct question was to see
       them — a count of rows nobody can look at is a count of rows nobody can
       act on, and it reads as a tidy remainder rather than as unfinished work. */
    note(`---- rows this cannot judge: ${unclearDocs.length} order(s) ----`);
    if (unclearDocs.length === 0) {
      note("  NONE. Every recorded spec change matched one side or the other.");
    } else {
      note("  Neither the BEFORE nor the AFTER value is what the line prints today.");
      note("  Something changed it after the approval, or the line is gone. Read them.");
    }
    for (const d of unclearDocs) {
      note(`  ${d.docNo} — ${d.unclear.length} row(s)`);
      for (const ch of d.unclear) {
        note(`      ${ch.code}   (approved ${ch.at})`);
        note(`        WAS       : ${clip(ch.from, 300)}`);
        note(`        ASKED FOR : ${clip(ch.to, 300)}`);
        if (ch.now.length === 0) {
          note("        PRINTS NOW: no line on this order carries that item code any more");
        }
        for (const n of ch.now) note(`        PRINTS NOW: ${clip(n, 300)}`);
      }
    }

    note("---- what to do with this ----");
    note("  Each order above needs ONE more spec amendment raised and approved;");
    note("  the approval now rebuilds the printed sentence. That is a business act");
    note("  with a price authority attached, so no script here does it for you.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(`check-stale-line-desc2 failed: ${e?.message ?? e}`);
  process.exit(1);
});
