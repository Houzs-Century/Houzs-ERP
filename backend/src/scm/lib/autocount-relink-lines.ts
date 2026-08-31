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

  for (const row of keyless) {
    const want = norm(row.acItemCode);
    if (!want) {
      refused.push(`a line with no item code cannot be matched`);
      continue;
    }
    const sameCode = candidates.filter((c) => !taken.has(c.key) && c.code === want);
    if (sameCode.length === 0) {
      refused.push(`'${row.acItemCode}' — the account book has no unclaimed line with that item code`);
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

  return { assign, refused, alreadyKeyed };
}
