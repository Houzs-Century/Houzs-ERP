/**
 * Store the AutoCount DtlKeys a create/convert returned onto the ERP line rows.
 *
 * SPLIT OUT OF autocount-outbox.ts on 2026-08-17, for the same reason
 * `mastersOf` and the `autocount-read` helpers were: that file sits at the
 * 2,000-line cap and the cap is not raisable (docs/repo-hygiene.md). Nothing
 * about the behaviour moved with it — this is the same function, and the
 * `dispatchOne` call site is unchanged.
 *
 * It is a good seam rather than an arbitrary one: line IDENTITY is the whole
 * subject here and it has its own failure mode (a wrong key silently edits a
 * different line in a live account book), so it earns being readable on its own.
 */
import type { AcCreatedLine } from '../../services/autocount-writeback';
/* TYPE-ONLY, so it is erased and there is no runtime cycle back to the module
   that imports this one. The table union is the real contract — writing
   `string` here would let a caller name a table with no `linked_ac_dtlkey`. */
import type { AcLineTable } from './autocount-outbox';
/* VALUE import, not type-only: the four downstream item tables are read off it
   rather than re-listed. No cycle — autocount-convert-lines imports types from
   services/autocount-writeback, never from this file. */
import { DOWNSTREAM } from './autocount-convert-lines';

/**
 * The payload and row fields this function reads, named structurally rather than
 * taken as whole `AcOutboxPayload` / `AcOutboxRow` values. A tighter contract:
 * the log label needs two fields, not the entire queue row.
 */
export interface LineKeyTarget {
  table: AcLineTable;
  ids: Array<string | string[]>;
  codes: string[];
  desc2?: Array<string | null>;
}

/** Just enough of the outbox row to label the log line. */
export interface LineKeyRowLabel {
  op: string;
  doc_no: string;
}

/* The same `SupabaseClient<any, any, any>` alias `autocount-outbox` passes in,
   narrowed to the one method used here. It stays `any` for the SAME reason the
   original does: `schema.pg.ts` covers none of the SCM tables, so a precise
   return type would be invented rather than derived, and a hand-written shape
   that is subtly wrong is worse than an honest `any` — it makes the compiler
   agree with a fiction. CLAUDE.md's remedy is drizzle-kit pull, not a cast.
   Written at the site with its reason rather than as a ratchet number. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM tables have no generated types; see the note above
type Sb = { from: (table: string) => any };

/**
 * Store the DtlKeys a create/convert returned onto the ERP line rows.
 *
 * VERIFIES BEFORE IT WRITES, and writes nothing at all if the check fails.
 *
 * The zip is by index: the Nth line AutoCount reports is the Nth detail we sent.
 * That is true because AcSyncService returns them ordered by DtlKey, which is
 * creation order, and we created them in payload order. But "true because of a
 * chain of reasoning" is not good enough for line identity — a wrong DtlKey does
 * not fail, it silently edits a DIFFERENT line in a live account book on the
 * next save. A missing key is refused loudly by composeEdit; a wrong one is not
 * refused at all. So the count must match and every ItemCode must match, or the
 * whole batch is abandoned and the document simply keeps NULL keys.
 *
 * Never throws and never changes the outcome of the dispatch: the document IS in
 * AutoCount and the row IS sent. Failing to record identity is a degradation to
 * be logged, not a reason to re-send a document that already exists.
 */
export async function persistLineKeys(
  sb: Sb,
  row: LineKeyRowLabel,
  target: LineKeyTarget,
  lines: AcCreatedLine[],
): Promise<void> {
  const label = `[autocount-outbox] ${row.op} ${row.doc_no} line keys`;
  try {
    /* Not an error. An AcSyncService built before 2026-08-11 returns no lines,
       and the service also degrades to an empty array rather than losing the
       DocNo when its own read-back fails. */
    if (!lines.length) return;

    if (lines.length !== target.ids.length) {
      // eslint-disable-next-line no-console
      console.error(
        `${label}: NOT STORED — AutoCount reported ${lines.length} line(s), the ERP sent `
        + `${target.ids.length}. Storing them by position would attach a key to the wrong line.`,
      );
      return;
    }

    const ordered = [...lines].sort((a, b) => a.Seq - b.Seq);
    const groups = target.ids.map((g) => (Array.isArray(g) ? g : [g]));
    const norm = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase();
    for (let i = 0; i < ordered.length; i += 1) {
      const got = norm(ordered[i].ItemCode);
      const want = norm(target.codes[i]);
      /* An older service may omit ItemCode; only a PRESENT and DIFFERENT code
         is evidence the zip is wrong. */
      if (got && want && got !== want) {
        // eslint-disable-next-line no-console
        console.error(
          `${label}: NOT STORED — position ${i + 1} is '${ordered[i].ItemCode}' in AutoCount but `
          + `'${target.codes[i]}' in the ERP. The two line lists do not correspond.`,
        );
        return;
      }
    }

    /* ItemCode alone stops being an identity check the moment a code repeats,
       and on a CONVERSION that is the normal case, not an edge one: the ERP
       never sends a line list for a conversion — AutoCount chooses the source
       lines itself (AcSyncService.cs:382-411) — so the two orderings are only
       PRESUMED to line up. A sofa document is the concrete failure: several
       lines share one code and differ only in the build written into Desc2, so
       an all-codes-match check passes while the keys land on the wrong lines,
       and the next edit rewrites somebody else's line in a live book.
       Desc2 is what tells those lines apart, so where it is available on both
       sides it must agree too, and a repeated code with no Desc2 to separate it
       is refused outright rather than guessed. */
    const dupes = new Set(
      target.codes.map(norm).filter((c, i, a) => c && a.indexOf(c) !== i),
    );
    for (let i = 0; i < ordered.length; i += 1) {
      const gotD = norm(ordered[i].Desc2);
      const wantD = norm(target.desc2?.[i]);
      /* PREFIX-TOLERANT, because AutoCount's own column truncates. SODTL.Desc2
         is nvarchar(100) and live sofa builds already sit at exactly 100 — the
         account book cut them itself, before the ERP ever saw them. An equality
         test would refuse those legitimately-matching lines. A prefix test keeps
         all the discriminating power that matters here: two different builds of
         the same model diverge in the first few tokens, not after character
         100. */
      const differs = gotD && wantD && !gotD.startsWith(wantD) && !wantD.startsWith(gotD);
      if (differs) {
        // eslint-disable-next-line no-console
        console.error(
          `${label}: NOT STORED — position ${i + 1} carries Desc2 '${ordered[i].Desc2}' in `
          + `AutoCount but '${target.desc2?.[i]}' in the ERP. Same ItemCode, different line.`,
        );
        return;
      }
      if (dupes.has(norm(target.codes[i])) && !(gotD && wantD)) {
        // eslint-disable-next-line no-console
        console.error(
          `${label}: NOT STORED — ItemCode '${target.codes[i]}' appears on more than one line and `
          + 'position ' + (i + 1) + ' has no Desc2 on both sides to tell them apart. '
          + 'Storing by position here would be a guess.',
        );
        return;
      }
    }

    for (let i = 0; i < ordered.length; i += 1) {
      /* Every ERP row behind this AutoCount line gets the SAME key. For a sofa
         that is the build's compartments; composeEdit later accepts the build
         only when all of them still agree on it. */
      for (const id of groups[i]) {
        const { error } = await sb.from(target.table)
          .update({ linked_ac_dtlkey: ordered[i].DtlKey })
          .eq('id', id);
        if (error) {
          // eslint-disable-next-line no-console
          console.error(`${label}: partial — row ${id} failed: ${error.message}`);
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`${label}: not stored:`, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Store the key AutoCount assigned to a line the ERP ADDED on an edit.
 *
 * WHY THIS IS A SECOND FUNCTION AND NOT A FLAG ON THE FIRST. `persistLineKeys`
 * zips the whole document by position, which is sound for a CREATE (payload
 * order IS creation order IS DtlKey order) and unsound for an EDIT: the book
 * orders by DtlKey, which is the document's ORIGINAL insertion order, while the
 * payload is in ERP line order — an added line can sit anywhere in ours and is
 * always last in the book's. Zipping those two would attach a key to the wrong
 * line, and a WRONG key does not fail: it silently edits somebody else's line in
 * a live account book on the next save.
 *
 * So this one does not zip the document at all. It takes the keys the payload
 * ALREADY carried (`knownKeys`) and the lines it declared as new, and reasons
 * only about the difference: the book's keys that were not in the payload are
 * the ones this edit created. AddDetail is called in payload order and AutoCount
 * hands out ascending keys, so the Nth unknown key belongs to the Nth declared
 * line — and that is re-checked against the ItemCode before anything is written.
 *
 * FAILS CLOSED. Any disagreement leaves the rows keyless, which the next edit
 * refuses loudly. Never throws; never changes the dispatch outcome.
 *
 * Bought on HC-SO-013394, 2026-08-31: one added line, its key never learned, and
 * every later edit of that order held back with "the ERP cannot tell which lines
 * AutoCount already has".
 */
export interface NewLineKeyTarget {
  table: AcLineTable;
  /** ERP row ids per declared-new line, in payload order (a sofa build is many). */
  newIds: string[][];
  /** The AutoCount ItemCode sent for each declared-new line, same order. */
  newCodes: string[];
  /** Every DtlKey the payload already carried — the book lines we did NOT add. */
  knownKeys: number[];
}

export async function persistNewLineKeys(
  sb: Sb,
  row: LineKeyRowLabel,
  target: NewLineKeyTarget,
  lines: AcCreatedLine[],
): Promise<void> {
  const label = `[autocount-outbox] ${row.op} ${row.doc_no} new line keys`;
  try {
    if (!target.newIds.length) return;
    /* An AcSyncService built before 2026-08-31 answers an edit with no lines at
       all. That is not an error and not a degradation to shout about — it is the
       old exe, and the behaviour is exactly what it was before this existed. */
    if (!lines.length) return;

    const known = new Set(target.knownKeys.map((k) => Number(k)));
    const fresh = lines
      .filter((l) => Number.isFinite(Number(l.DtlKey)) && !known.has(Number(l.DtlKey)))
      .sort((a, b) => Number(a.DtlKey) - Number(b.DtlKey));

    if (fresh.length !== target.newIds.length) {
      // eslint-disable-next-line no-console
      console.error(
        `${label}: NOT STORED — the ERP added ${target.newIds.length} line(s) and the account book `
        + `reports ${fresh.length} it did not already have. Storing by position would be a guess.`,
      );
      return;
    }

    const norm = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase();
    for (let i = 0; i < fresh.length; i += 1) {
      const got = norm(fresh[i].ItemCode);
      const want = norm(target.newCodes[i]);
      if (got && want && got !== want) {
        // eslint-disable-next-line no-console
        console.error(
          `${label}: NOT STORED — the new line at position ${i + 1} is '${fresh[i].ItemCode}' in `
          + `AutoCount but '${target.newCodes[i]}' in the ERP.`,
        );
        return;
      }
    }

    for (let i = 0; i < fresh.length; i += 1) {
      for (const id of target.newIds[i]) {
        const { error } = await sb.from(target.table)
          .update({ linked_ac_dtlkey: fresh[i].DtlKey })
          .eq('id', id);
        if (error) {
          // eslint-disable-next-line no-console
          console.error(`${label}: partial — row ${id} failed: ${error.message}`);
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`${label}: not stored:`, e instanceof Error ? e.message : String(e));
  }
}

/* CORRECTED 2026-08-31. This said "two entries, not six", on the reasoning that
 * only the sales order and the purchase order have a route that inserts a line
 * by hand — the others being built by conversion. That reasoning was never
 * checked, and it is wrong: every one of the six carries a `POST /:id/items`.
 * The owner asked for the remaining four to be wired (「全部都做完」), and this is
 * the map they need.
 *
 * STILL NOT A SECOND COPY of "the documents this ERP syncs with AutoCount" —
 * that question has one home (`REQUEUE_DOC_TYPES`) and `audit:duplicated-
 * decisions` refuses another. The four downstream tables are DERIVED from
 * `DOWNSTREAM`, which already had to name each one's item table for the
 * conversions; only the two the ERP originates are written here. */
export const NEW_LINE_TABLE: Record<string, AcLineTable> = {
  SO: 'mfg_sales_order_items',
  PO: 'purchase_order_items',
  ...Object.fromEntries(
    Object.entries(DOWNSTREAM).map(([docType, spec]) => [docType, spec.itemTable]),
  ),
};

/**
 * What an edit's declared-new lines were, read off the payload the edit SENT.
 *
 * Derived rather than carried: the body already states which details were
 * declared new (`IsNewLine`), which ERP rows sit behind each (`ErpLineIds`, put
 * there by composeEdit) and which keys the document already held. Returns null
 * when the edit added nothing, which is almost every edit.
 */
export function newLineTargetOf(docType: string, payload: { body?: unknown }): NewLineKeyTarget | null {
  const table = (NEW_LINE_TABLE as Record<string, AcLineTable | undefined>)[String(docType).toUpperCase()];
  if (!table) return null;
  const body = (payload.body ?? {}) as { Lines?: unknown; Rebuild?: unknown };
  /* A REBUILD cleared the details, so every line came back NEW and not one key
     the payload carried still exists. Reading it the ordinary way stored
     nothing — `IsNewLine` is absent — and left the ERP holding dead keys that
     the next edit would send to EditDetail. docs/bugs/0621. */
  const rebuilt = body.Rebuild === true;
  const lines = Array.isArray(body.Lines) ? (body.Lines as Array<Record<string, unknown>>) : [];
  const newIds: string[][] = [];
  const newCodes: string[] = [];
  const knownKeys: number[] = [];
  for (const l of lines) {
    const key = Number(l.DtlKey);
    if (!rebuilt && Number.isFinite(key) && key > 0) knownKeys.push(key);
    if (!rebuilt && l.IsNewLine !== true) continue;
    const ids = Array.isArray(l.ErpLineIds)
      ? (l.ErpLineIds as unknown[]).filter((v): v is string => typeof v === 'string' && !!v)
      : [];
    /* A declared-new line with no ids cannot be stored back, and storing the
       OTHERS by position would then be a guess — refuse the whole batch. */
    if (!ids.length) return null;
    newIds.push(ids);
    newCodes.push(String(l.ItemCode ?? ''));
  }
  return newIds.length ? { table, newIds, newCodes, knownKeys } : null;
}
