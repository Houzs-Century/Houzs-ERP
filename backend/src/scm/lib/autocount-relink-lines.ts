/* ----------------------------------------------------------------------------
   autocount-relink-lines — give a keyless ERP line back the AutoCount key it
   already has in the book.

   THE PROBLEM IT ENDS. A line the ERP ADDS to a document AutoCount already holds
   is appended by the account book, which assigns the DtlKey — and until
   2026-08-31 nothing carried that key back. The ERP row stays keyless, and every
   LATER edit of that document is refused whole by composeEdit's keyless guard.
   The operator reads "The ERP cannot tell which lines AutoCount already has",
   and Send again cannot clear it: a change has nothing to re-create.

   `docs/bugs/0583-*` closes that going forward, by having the service report the
   keys it assigned. It needs a deploy on the office host, and it does NOTHING
   for the documents already stuck. This is the other half: ASK THE BOOK what it
   holds and match, using the read route the host has served since 2026-08-15.

   THE OWNER ASKED FOR THE OTHER THING FIRST, and it is worth writing down why it
   was refused (2026-08-31): 「每一次进去都重新 reset 过它所有的 item line 会比较好
   呢?」 — clear every detail and rebuild. AutoCount's own documentation samples
   exactly that (`ClearDetails()` then `AddDetail()` in a loop), and it is the
   wrong answer HERE for two reasons that have nothing to do with taste:

     · it destroys every DtlKey, and the DtlKey is the identity every link in
       this system hangs on — PODTL.FromSODtlKey (which sales line a purchase
       line was raised for), the DO/GR transfer chain, the line photographs, and
       retirement itself;
     · AutoCount's own troubleshooting page for a document that has been
       TRANSFERRED says deleting its rows leaves the source pointing at nothing,
       the document goes grey and uneditable, and recovery needs raw SQL plus
       Management Studio's "Fix Deleted Document Transfer Problem".

   The instinct was right about the diagnosis — our side does not know the
   numbers — and wrong only about the remedy. Read them back; do not destroy
   them.

   IT MATCHES ON THE SAME RULES AS THE KEY STORE, and refuses on the same ones. A
   MISSING key is refused loudly by composeEdit; a WRONG key is not refused at
   all — it silently edits somebody else's line in a live account book on the
   next save. So this plans nothing it cannot prove:

     · a book line already claimed by one of our keyed rows is not a candidate;
     · a keyless row matches a candidate ONLY on the AutoCount item code;
     · where that code appears more than once among the candidates, Desc2 has to
       separate them, and a repeated code with no Desc2 on both sides is refused
       rather than guessed (a sofa document is the normal case, not the edge one:
       several lines share a model code and differ only in the build);
     · anything left ambiguous refuses THAT LINE, and the rest still land — this
       is a repair, and repairing four of five lines is better than none, as long
       as the fifth is named.
   -------------------------------------------------------------------------- */

import { splitSofaCode } from '../../services/autocount-sofa-collapse';

/** One line as the account book holds it (the fields `/doc-read` returns). */
export interface BookLine {
  DtlKey: number | string | null;
  ItemCode?: string | null;
  Desc2?: string | null;
}

/** One line as the ERP holds it. `acItemCode` is what the write-back SENDS for
 *  this row — the book's spelling, not ours — because that is what the book has
 *  stored. */
export interface ErpLineForRelink {
  id: string;
  acItemCode: string | null;
  desc2: string | null;
  dtlKey: number | null;
}

export interface RelinkPlan {
  /** The rows to stamp, and the key each one gets. */
  assign: Array<{ id: string; dtlKey: number; itemCode: string }>;
  /** One sentence per row that could NOT be matched, for a person to read. */
  refused: string[];
  /** Rows that already carry a key — untouched, and counted so the report adds up. */
  alreadyKeyed: number;
  /**
   * ROWS THE ACCOUNT BOOK HAS NO LINE FOR AT ALL — the only refusal a caller may
   * turn into an `IsNewLine` declaration (docs/bugs/0817).
   *
   * AcSyncService names the two ways out of a keyless line itself: *"Store the
   * line's AutoCount DtlKey ... or mark the line IsNewLine, then retry."* The
   * second is only honest when the line really is new, and this is the one
   * refusal that proves it: the book carries NO line with that item code.
   *
   * NOT "no UNCLAIMED line", which is the sentence in `refused`. A book line
   * another ERP row has already claimed still EXISTS, and declaring that row new
   * would append a second copy of a line the book already holds — on a purchase
   * order or a receipt, permanently, because this SDK gives DeleteDetail to
   * SalesOrder alone. So the test here runs against every book line, claimed or
   * not, and a row only reaches this list when the code appears nowhere.
   *
   * Deliberately excludes the folded-sofa refusal: that one asks about
   * `<model>-1S`, and a build the book holds under its compartments' own codes
   * would be absent under the folded one while being entirely present.
   */
  absent: Array<{ id: string; itemCode: string }>;
}

const norm = (s: string | null | undefined): string => String(s ?? '').trim().toUpperCase();

export function planLineRelink(input: {
  bookLines: BookLine[];
  erpLines: ErpLineForRelink[];
}): RelinkPlan {
  const { bookLines, erpLines } = input;
  const claimed = new Set(
    erpLines.map((l) => l.dtlKey).filter((k): k is number => Number.isFinite(Number(k)) && Number(k) > 0)
      .map((k) => Number(k)),
  );
  /* Candidates in book order (DtlKey ascending), so a repeated code that DOES
     get separated is separated deterministically. */
  const candidates = bookLines
    .map((b) => ({ key: Number(b.DtlKey), code: norm(b.ItemCode), desc2: norm(b.Desc2) }))
    .filter((b) => Number.isFinite(b.key) && b.key > 0 && !claimed.has(b.key))
    .sort((a, b) => a.key - b.key);

  const keyless = erpLines.filter((l) => !(Number.isFinite(Number(l.dtlKey)) && Number(l.dtlKey) > 0));
  const alreadyKeyed = erpLines.length - keyless.length;

  const assign: RelinkPlan['assign'] = [];
  const refused: string[] = [];
  const taken = new Set<number>();
  const unmatched: ErpLineForRelink[] = [];
  const absent: RelinkPlan['absent'] = [];
  /* EVERY book line, claimed or not — see `absent` on RelinkPlan for why this
     is not the same question `candidates` answers. */
  const bookCodes = new Set(bookLines.map((b) => norm(b.ItemCode)).filter(Boolean));

  for (const row of keyless) {
    const want = norm(row.acItemCode);
    if (!want) {
      refused.push(`a line with no item code cannot be matched`);
      continue;
    }
    const sameCode = candidates.filter((c) => !taken.has(c.key) && c.code === want);
    if (sameCode.length === 0) {
      /* HELD, not refused yet. The book may hold this row as part of a FOLDED
         sofa line instead of under its own compartment code — pass 2 below. */
      unmatched.push(row);
      continue;
    }
    if (sameCode.length === 1) {
      assign.push({ id: row.id, dtlKey: sameCode[0].key, itemCode: row.acItemCode ?? '' });
      taken.add(sameCode[0].key);
      continue;
    }
    /* The code repeats among the candidates. Desc2 is what tells two lines of
       one model apart, and it must be present on BOTH sides to be evidence.
       PREFIX-TOLERANT: SODTL.Desc2 is nvarchar(100) and the book truncates its
       own long sofa builds, so an equality test would refuse a legitimate match
       (the same carve-out persistLineKeys documents). */
    const mine = norm(row.desc2);
    const byDesc = mine
      ? sameCode.filter((c) => c.desc2 && (c.desc2.startsWith(mine) || mine.startsWith(c.desc2)))
      : [];
    if (byDesc.length === 1) {
      assign.push({ id: row.id, dtlKey: byDesc[0].key, itemCode: row.acItemCode ?? '' });
      taken.add(byDesc[0].key);
      continue;
    }
    refused.push(
      `'${row.acItemCode}' — ${sameCode.length} unclaimed lines in the account book carry that item `
      + `code and ${mine ? 'none of their descriptions matches this one' : 'this line has no description to tell them apart'}`,
    );
  }

  /* ── PASS 2: A SOFA THE BOOK KEEPS AS ONE LINE ──────────────────────────────
     composeEdit folds a build's compartments into a single AutoCount detail
     (`collapseSofaLines`) and sends it under `<model>-1S`. Pass 1 compares one
     ERP row to one book row, so where the book took the fold, a build the ERP
     holds as eight compartments met a book holding ONE line: `8060-CNR` never
     matched `8060-1S`, and every compartment was refused. That is the whole of
     HC-GRN-2609-008, and the unexplained `stamped 0` the relink sweep reported
     on 2026-09-11.

     IT IS A FALLBACK, AND THAT ORDERING IS THE POINT. The book does NOT always
     fold: `autocountRelinkSweep.test.ts` carries a live delivery order whose
     9028 compartments are three separate book lines under their own codes, and
     pass 1 matches all three exactly. Folding first would have refused them and
     lost three provable stamps. So only a row pass 1 could find NO line for is
     offered here.

     `<model>-1S` IS THE FOLDED CODE, NOT A COMPARTMENT TO FOLD. A row already
     carrying it is already at the book's grain — a sales order holds one row per
     build, and two builds of one model are two rows Desc2 tells apart. `1S` is
     in the compartment table (a one-seater is a real compartment), so this has
     to be said out loud: everything BUT `1S` folds.

     It refuses on the same rule as pass 1. The Desc2 that separates two builds
     of one model is composed from variant and colour columns this planner does
     not read, so a repeated `<model>-1S` refuses the group rather than guessing.
     A wrong DtlKey rewrites somebody else's line in a live account book. */
  const foldModel = (code: string | null): string | null => {
    const split = splitSofaCode(String(code ?? ''));
    if (!split || split.compartment.trim().toUpperCase() === '1S') return null;
    return split.model;
  };
  const missing = (row: ErpLineForRelink) => {
    refused.push(`'${row.acItemCode}' — the account book has no unclaimed line with that item code`);
    /* The stronger fact, recorded only when it holds: the code is on NO book
       line at all, so there is nothing this row could be a second copy of. */
    if (!bookCodes.has(norm(row.acItemCode))) {
      absent.push({ id: row.id, itemCode: row.acItemCode ?? '' });
    }
  };

  const groups = new Map<string, ErpLineForRelink[]>();
  for (const row of unmatched) {
    const model = foldModel(row.acItemCode);
    if (model == null) { missing(row); continue; }
    const g = groups.get(model);
    if (g) g.push(row); else groups.set(model, [row]);
  }

  for (const [model, rows] of groups) {
    /* THE BUILD'S OWN KEPT ROWS ANSWER FIRST. One AutoCount line has one DtlKey,
       so a single distinct value across this build's other compartments IS the
       key these are missing. A kept `<model>-1S` row is a different build at
       book grain and does not get a say. */
    const sibling = new Set(
      erpLines
        .filter((l) => foldModel(l.acItemCode) === model
          && Number.isFinite(Number(l.dtlKey)) && Number(l.dtlKey) > 0)
        .map((l) => Number(l.dtlKey)),
    );
    if (sibling.size === 1) {
      const key = [...sibling][0];
      for (const r of rows) assign.push({ id: r.id, dtlKey: key, itemCode: r.acItemCode ?? '' });
      continue;
    }
    if (sibling.size > 1) {
      refused.push(
        `sofa ${model} — ${rows.length} compartment(s) carry no key and this build's other lines already `
        + `point at ${sibling.size} different book lines, so which one these belong to is not stated`,
      );
      continue;
    }

    const folded = candidates.filter((c) => !taken.has(c.key) && c.code === norm(`${model}-1S`));
    if (folded.length === 1) {
      for (const r of rows) assign.push({ id: r.id, dtlKey: folded[0].key, itemCode: r.acItemCode ?? '' });
      taken.add(folded[0].key);
      continue;
    }
    if (folded.length === 0) { for (const r of rows) missing(r); continue; }
    refused.push(
      `sofa ${model} — ${rows.length} compartment(s) fold to one book line '${model}-1S', and the account `
      + `book has ${folded.length} unclaimed lines with that item code; telling two builds of one model `
      + `apart needs the composed build text, which this planner does not hold`,
    );
  }

  return { assign, refused, alreadyKeyed, absent };
}
