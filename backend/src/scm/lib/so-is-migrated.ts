/* ---------------------------------------------------------------------------
   IS THIS SALES ORDER AN AUTOCOUNT IMPORT?

   One fact, one home. `so-revision.ts` derives its amendment pricing trust from
   it, and since `docs/bugs/0600-*` the plain line PATCH does too — a migrated
   line's stored selling price is the BOOK's answer, and neither the special-order
   surcharge nor the fabric surcharge may recompute over it (owner 2026-09-02:
   「我们的 selling price 是根据我们 manually 填入的，不应该被这种影响」).

   FAILS CLOSED — it THROWS rather than returning false. "Not migrated" is the
   PERMISSIVE answer here: it puts the surcharges back on an imported price. A
   read that could not run must not be able to look like that, so the caller has
   to handle the failure instead of inheriting a wrong default.
   --------------------------------------------------------------------------- */

/* The reader, not the client. Typing the supabase client structurally here made
   the compiler unroll its generics at the line-PATCH call site (TS2589,
   "excessively deep"); the header PATCH's identical shape compiles, so the
   difference is the surrounding inference and not this file. Taking a FUNCTION
   sidesteps it and is the better boundary anyway — this module needs one answer,
   not a database client. */
export type MigratedReader = (docNo: string) => PromiseLike<{ data: unknown; error: unknown }>;

export async function soIsMigrated(read: MigratedReader, docNo: string): Promise<boolean> {
  const { data, error } = await read(docNo);
  if (error) throw new Error(`soIsMigrated: ${(error as { message?: string }).message ?? 'read failed'}`);
  return !!(data as { linked_ac_docno?: string | null } | null)?.linked_ac_docno;
}
