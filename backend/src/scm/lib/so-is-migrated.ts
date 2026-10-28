/* ---------------------------------------------------------------------------
   IS THIS SALES ORDER AN AUTOCOUNT IMPORT?

   One fact, one home. `so-revision.ts` derives its amendment pricing trust from
   it, and since `docs/bugs/0600-*` the plain line PATCH does too — a migrated
   line's stored selling price is the BOOK's answer, and neither the special-order
   surcharge nor the fabric surcharge may recompute over it (owner 2026-09-02:
   「我们的 selling price 是根据我们 manually 填入的，不应该被这种影响」).

   ⚠️ `linked_ac_docno IS NOT NULL` IS NOT THE ANSWER, and used to be.
   That column means "this document exists in AutoCount", which is TWO
   populations (`docs/bugs/0703-*`):

     1. CARRIED OVER by the 2026-08 cutover import. It is what this file is
        about — the ERP never priced it and the sync will write over it.
     2. PUSHED TO AutoCount by our own write-back. On success the outbox stamps
        the same column on a document the ERP created minutes earlier
        (`scm/lib/autocount-outbox.ts`), so a brand-new sales order started
        reading as an import and went view-only. That is 「只开新单」 producing
        the exact opposite of itself, and it happened to a real order:
        `HC-SO-2609-001`, created 14:06:51 MYT, written back 14:11, counted as
        migrated by 14:12.

   THE TWO POPULATIONS ARE TOLD APART BY THE NUMBER'S OWN SHAPE, and the shape
   is not an accident — it is how each population is BUILT:

     • the cutover import writes `docNo: "HC-" + acDoc`
       (`backend/scripts/import-ac-outstanding-so.mjs`), and
       `backend/scripts/renumber-migrated-docs.mjs` exists to repair any
       migrated document that drifted off that shape back onto it;
     • the write-back sends the ERP's OWN number and AutoCount answers with it,
       so the two strings are EQUAL.

   Measured on production before this was shipped — Actions -> *SO migrated
   shape*, run `34214516108`, 2026-09-08: of 2,883 company-1 sales orders
   carrying the column, 2,882 are `HC-` + the book number, 1 is equal to it, and
   **0 are neither**. The same 2,883 rows classify identically by a second,
   independent signal (an `scm.autocount_outbox` `create_so` row), with no
   disagreement.

   WHY NOT A COLUMN. Because the owner has already ruled on it, in his own
   words: adding a marker to a migrated row IS a change to the migrated data
   (「你换不一样就代表我们的数据从 autocount 搬过来的就不一样了啊」,
   `docs/migrated-so-lock.md` §2). A predicate over the numbers the import
   already wrote changes no row at all. `docs/bugs/0703-*` carries the options
   and what it would take to choose a column instead.

   FAILS CLOSED — twice, in two different ways, and both are deliberate.

     • The READ throws rather than answering false. "Not migrated" is the
       PERMISSIVE answer here: it puts the surcharges back on an imported price
       and it opens a document the owner ruled shut. A read that could not run
       must not be able to look like that, so the caller has to handle the
       failure instead of inheriting a wrong default.
     • A number pair that fits NEITHER shape answers TRUE. It cannot be produced
       by the cutover import, so in principle it is a write-back AutoCount filed
       under a different number — but `renumber-sales-orders.mjs` can also give
       a migrated order a new `doc_no`, and reading that as "the ERP made this"
       would open it. Locking a document nobody can classify is recoverable in a
       minute; opening one is not. That bucket is EMPTY on production today and
       the check above is what says so — run it again before assuming it still
       is.
   --------------------------------------------------------------------------- */

export type SoNumberShape =
  /** No AutoCount number at all — the ERP made it and nothing has pushed it. */
  | 'no-book-number'
  /** `doc_no` IS the book number: the book took OUR number, so we made it. */
  | 'equal'
  /** `doc_no` is a prefix + the book number: the cutover import built it. */
  | 'prefixed'
  /** Fits neither. Cannot come from the import; see `soIsMigratedShape`. */
  | 'neither';

/**
 * WHICH of the four shapes this pair of numbers has — the whole rule, pure, so
 * the tests can pin it without a database.
 *
 * `acDocNo` is `scm.mfg_sales_orders.linked_ac_docno`; `docNo` is the ERP
 * document number on the same row.
 *
 * Exported alongside the boolean because the read-only census
 * (`backend/scripts/check-so-migrated-shape.mjs`) reports the DISTRIBUTION and
 * must not carry its own copy of the rule — one home is the whole point of this
 * module, and the census is where a second copy would be hardest to notice.
 *
 * Trimmed and case-folded, matching `frontend/src/lib/autocountRegister.ts`,
 * which computes the same test for the AutoCount register's column: a document
 * number travels as text through two systems and a difference of case or a
 * trailing space is not a different document.
 *
 * THE PREFIX MUST END AT A SEPARATOR. That is the trap the register's comment
 * records and it is why this is not `endsWith` alone: `SO-013361` ends with
 * `13361`, and treating a bare suffix as "the same document without its prefix"
 * would quietly excuse a book number that really is a different, shorter
 * document. A real prefix ends in `-`.
 *
 * DERIVED FROM THE PAIR, never from a hard-coded list of prefixes. `HC-` is the
 * only one in use today (measured: 2,882 of 2,882) and the next company is a
 * migration away; a rule that named it would be wrong the day one is added.
 */
export function soNumberShape(
  docNo: string | null | undefined,
  acDocNo: string | null | undefined,
): SoNumberShape {
  const book = String(acDocNo ?? '').trim().toLowerCase();
  if (book === '') return 'no-book-number';

  const erp = String(docNo ?? '').trim().toLowerCase();
  if (erp === book) return 'equal';

  if (erp.length > book.length && erp.endsWith(book)
      && erp.slice(0, erp.length - book.length).endsWith('-')) return 'prefixed';

  return 'neither';
}

/** Did this sales order come FROM AutoCount? The answer every caller wants. */
export function soIsMigratedShape(
  docNo: string | null | undefined,
  acDocNo: string | null | undefined,
): boolean {
  /* `neither` LOCKS, with `prefixed`. See the header: it cannot be produced by
     the cutover import, but `renumber-sales-orders.mjs` can give a migrated
     order a new doc_no, and reading that as "the ERP made this" would open a
     document the owner ruled shut. */
  const shape = soNumberShape(docNo, acDocNo);
  return shape === 'prefixed' || shape === 'neither';
}

/* The reader, not the client. Typing the supabase client structurally here made
   the compiler unroll its generics at the line-PATCH call site (TS2589,
   "excessively deep"); the header PATCH's identical shape compiles, so the
   difference is the surrounding inference and not this file. Taking a FUNCTION
   sidesteps it and is the better boundary anyway — this module needs one answer,
   not a database client. */
export type MigratedReader = (docNo: string) => PromiseLike<{ data: unknown; error: unknown }>;

/**
 * Ask the database. The reader must select BOTH `doc_no` and `linked_ac_docno`:
 * the rule is about the two numbers together, and a select that forgot one
 * would answer from half the fact.
 *
 * Both spellings of the column are accepted for the reason `amendmentSoDocNo`
 * gives one door along: this repo has been caught by a PostgREST read coming
 * back camelCase where the code expected snake_case, and here that mistake
 * would read as "no book number" — open, not shut.
 */
export async function soIsMigrated(read: MigratedReader, docNo: string): Promise<boolean> {
  const { data, error } = await read(docNo);
  if (error) throw new Error(`soIsMigrated: ${(error as { message?: string }).message ?? 'read failed'}`);
  const row = data as { doc_no?: unknown; docNo?: unknown; linked_ac_docno?: unknown; linkedAcDocno?: unknown } | null;
  if (row == null) return false; // no such order — the handler will 404
  const rowDocNo = row.doc_no ?? row.docNo;
  const link = row.linked_ac_docno ?? row.linkedAcDocno;
  return soIsMigratedShape(
    typeof rowDocNo === 'string' ? rowDocNo : docNo,
    typeof link === 'string' ? link : null,
  );
}
