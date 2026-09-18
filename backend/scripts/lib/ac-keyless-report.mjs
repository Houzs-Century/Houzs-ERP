/* ---------------------------------------------------------------------------
   The sentences the keyless-line report says, where a test can hold them.

   THE OWNER CHOSE THIS SHAPE (2026-09-04, option C): do not mass-rebuild the
   migrated documents; find the ones that are ACTUALLY going to jam, with a tool,
   rather than waiting for somebody to trip over one.

       「我不要每次都来 fix 啊」

   WHAT A KEYLESS LINE COSTS, and why it is worth a report of its own. A line the
   ERP holds with no AutoCount line key cannot be matched on the next save, so
   `composeEdit` REFUSES the whole document (`KeylessLineError`) rather than
   append a duplicate to a licensed account book. That refusal is correct — but
   it arrives when a person is trying to save, which is the worst moment to find
   out. Every one of these is a jam that has not happened yet.

   IT IS NOT A DATA DEFECT. Nothing is wrong in the book; the ERP simply does not
   know which AutoCount line its own row corresponds to. `persistLineKeys`
   refuses to guess (a wrong key silently edits somebody else's line), so a
   document that could not be matched keeps NULL and says so. This report counts
   what that refusal left behind.

   THE SENTENCES LIVE HERE rather than inline in the script for the reason
   docs/bugs/0632 records: a line that asserts one shape for a set that holds
   several gets written once and read hundreds of times, and inline in a report
   script no test can reach it.
   -------------------------------------------------------------------------- */

/** A document carrying at least one line with no AutoCount key. */
/** @typedef {{ docNo: string, docType: 'SO'|'PO', keyless: number, lines: number,
 *              alreadyStuck: boolean, rebuildBlocked: string|null }} KeylessDoc */

/**
 * THE HEADING.
 *
 * Two populations are being counted and they need different words. A document
 * with a failed or skipped outbox row is ALREADY jammed — somebody is waiting on
 * it now. One without is a jam that fires the next time anybody saves it, which
 * may be tomorrow or never. Calling both "stuck" would send someone hunting for
 * an operator who is not actually blocked.
 */
export function keylessHeadingLine(docs) {
  if (!docs.length) {
    return 'KEYLESS LINES: none. Every linked document\'s lines carry an AutoCount'
      + ' key, so no save can be refused for this reason.';
  }
  const stuck = docs.filter((d) => d.alreadyStuck).length;
  const latent = docs.length - stuck;
  const parts = [];
  if (stuck) parts.push(`${stuck} ALREADY held back (someone is waiting on these now)`);
  if (latent) parts.push(`${latent} not yet jammed (the refusal fires on the NEXT save)`);
  return `KEYLESS LINES: ${docs.length} document(s) — ${parts.join(', ')}.`;
}

/**
 * WHAT TO DO WITH ONE, per document.
 *
 * The remedy is not uniform and naming the wrong one costs a live account book:
 * a rebuild reissues every line key, so a document a purchase order was raised
 * from must NOT be rebuilt (`docs/bugs/0609`) and neither may one built by
 * conversion. Those get the match-up route instead, which writes identity only.
 */
export function keylessRemedyOf(doc) {
  if (doc.rebuildBlocked) {
    return `match up lines (rebuild REFUSED: ${doc.rebuildBlocked})`;
  }
  return doc.keyless === doc.lines
    ? 'rebuild (no key on any line, so nothing downstream can hold one)'
    : 'match up lines, then rebuild if it still refuses';
}

/**
 * ONE ROW, and deliberately no item text.
 *
 * This repository is PUBLIC and its Actions logs are readable. A document number
 * is already printed by the outbox health check; item codes and customer names
 * are not, and a keyless-line refusal names real item codes — which is exactly
 * why `probe-doc-writeback` prints a classified reason instead of `last_error`.
 */
export function keylessRowLine(doc) {
  return `  ${doc.docType} ${doc.docNo}: ${doc.keyless} of ${doc.lines} line(s) have no key`
    + `${doc.alreadyStuck ? ', HELD BACK' : ''} — ${keylessRemedyOf(doc)}`;
}

/** Worst first: the jammed ones, then the widest gaps. */
export function keylessOrdered(docs) {
  return [...docs].sort((a, b) =>
    Number(b.alreadyStuck) - Number(a.alreadyStuck)
    || b.keyless - a.keyless
    || a.docNo.localeCompare(b.docNo));
}
