// ----------------------------------------------------------------------------
// so-agent — who the ERP records as having sold a Sales Order, in the ONE
// column AutoCount is given.
//
// 2026-08-13, the day the ERP -> AutoCount write-back went live, two re-queued
// sales orders retried four times each and the live AED_HOUZS book answered,
// verbatim:
//
//   Foreign Key Error (Constraint Name=FK_SO_SalesAgent)
//
// Traced: `composeCreateSo` sends `mfg_sales_orders.agent` and nothing else,
// `agent` is a legacy free-text column filled only from `body.agent`, and no
// current SO form sends that field — so every order created since the cutover
// carried an EMPTY agent. An empty Agent reaches AcSyncService as `""`
// (`Set(() => so.Agent = Str(p, "Agent"))`, and `Str` turns an absent key into
// the empty string), `""` is not a row in `dbo.SalesAgent`, and the whole
// document is refused before it lands. `/ensure-masters` could not save it
// either: `mastersOf` only asks for an agent when the payload names one, so an
// empty agent opens nothing and the create dies on the foreign key.
//
// The ERP's REAL salesperson identity is `mfg_sales_orders.salesperson_id` ->
// `scm.staff`, stamped at create. The SO detail page has been hiding the gap
// for months — `salespersonNameOf(salesOrder.agent, salesOrder.salesperson_id)`
// falls back to the id, so a name appears on screen even when `agent` is empty.
//
// So `agent` is stamped from the salesperson the order is actually attributed
// to. The write-back's own half of this rule (what is SENT, after AGENT_MAP)
// lives in `resolveAcAgent` in src/services/autocount-writeback.ts — two
// questions, deliberately in two places: this one decides what the ERP STORES,
// that one decides how the account book SPELLS it.
// ----------------------------------------------------------------------------

/**
 * Minimal PostgREST surface, pinned exactly as `VenueBindingSb` pins it — this
 * reader only ever calls `.from().select().eq().maybeSingle()`, and naming that
 * much keeps SupabaseClient's generics from being instantiated here (they are
 * deep enough to trip TS2589 at the call site otherwise).
 */
export type StaffAgentSb = {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): { maybeSingle(): PromiseLike<{ data: unknown }> };
    };
  };
};

/**
 * The `agent` text a Sales Order should carry.
 *
 * AN EXPLICITLY SUPPLIED AGENT ALWAYS WINS. A caller that names one is stating
 * something the salesperson link does not — an order sold under a house name,
 * an imported document keeping its original rep — and deriving over it would
 * throw that statement away. Only an ABSENT (or blank) agent falls back, which
 * is the same contract `salespersonIdToStamp` runs under one field along.
 *
 * A blank string is not a supplied agent: it is what an untouched form control
 * posts, and storing `''` reproduces the empty-Agent bug this rule exists to
 * close.
 */
export function soAgentToStamp(
  suppliedAgent: unknown,
  salespersonName: string | null,
): string | null {
  const supplied = typeof suppliedAgent === 'string' ? suppliedAgent.trim() : '';
  if (supplied) return supplied;
  const derived = (salespersonName ?? '').trim();
  return derived || null;
}

/**
 * The salesperson's display NAME, from `scm.staff`.
 *
 * `staff.name` is deliberately the same field the SO PDF prints
 * ("Salesperson: name · phone") and the SO list resolves through
 * `useStaffLookup`, so the account book learns a rep under the spelling the
 * rest of the ERP already shows. Whatever is written here is what
 * `/ensure-masters` will be asked to open, because it creates the agent under
 * exactly the string in the payload (`AcSyncService.EnsureMasters`, its
 * `Agents` loop).
 *
 * BEST-EFFORT ON PURPOSE. This runs inside a create that has already priced,
 * gated and reserved; a staff lookup that fails must cost the order its agent
 * text, never its save. The write-back's own reader is the opposite — there a
 * failed read is an `AcReadError` and the document is refused with the reason
 * written down, because by then the choice is between a refusal an operator can
 * read and a foreign key nobody sees.
 */
export async function readStaffAgentName(
  sb: StaffAgentSb,
  staffId: string | null | undefined,
): Promise<string | null> {
  return (await readStaffForStamp(sb, staffId))?.name ?? null;
}

/**
 * The two things a create stamps off the SELECTED salesperson's `scm.staff` row.
 *
 * One read, because there were about to be two: the venue chain already fetched
 * this row for `venue_id` and the agent needs `name` off the same row, one
 * `salespersonIdToStamp` apart. The route file may only shrink
 * (`scripts/file-size-ceilings.json`), which is the mechanical reason this is
 * here — and the right shape anyway.
 *
 * `venueId` is returned verbatim; the caller still applies its own priority
 * (explicit body.venueId, then the salesperson's, then the caller's own when
 * they are a POS-side role) and its own uuid guard. This function decides
 * nothing about venue, it only carries the column.
 */
export async function readStaffForStamp(
  sb: StaffAgentSb,
  staffId: string | null | undefined,
): Promise<{ name: string | null; venueId: string | null } | null> {
  const id = typeof staffId === 'string' ? staffId.trim() : '';
  /* `.eq('id', null)` is not "no salesperson", it is a malformed filter. */
  if (!id) return null;
  try {
    const { data } = await sb.from('staff').select('name, venue_id').eq('id', id).maybeSingle();
    const row = data as { name?: string | null; venue_id?: string | null } | null;
    if (!row) return null;
    return {
      name: (row.name ?? '').trim() || null,
      venueId: (row.venue_id as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * `agent` FOLLOWS A REASSIGNED SALESPERSON on the header PATCH.
 *
 * The create-time stamp is what makes staleness REACHABLE: until it landed the
 * column was empty on every new order and the write-back fell back to
 * `salesperson_id` every time. Now `agent` holds a name, and moving the
 * salesperson without it would leave the account book — and the SO list, and the
 * Detail Listing — naming the previous rep.
 *
 * Same precedence as the create: a PATCH that names `agent` itself wins.
 *
 * `body` is updated alongside `updates` because `diffFields()` audits from
 * `body` through the same field map, and a column written with no entry there
 * changes the order with nothing in its history to say so. Call it BEFORE the
 * change-detection read, so an agent that already matches storage drops out as
 * the no-op it is.
 *
 * A salesperson CLEARED to null leaves `agent` alone: it is the last record of
 * who sold the order, and the write-back reads it exactly when `salesperson_id`
 * is empty. So is a name that cannot be read — a stale agent beats none.
 */
export async function followSalespersonToAgent(
  sb: StaffAgentSb,
  updates: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<void> {
  if (typeof updates.salesperson_id !== 'string' || updates.agent !== undefined) return;
  const followed = await readStaffAgentName(sb, updates.salesperson_id);
  if (!followed) return;
  updates.agent = followed;
  body.agent = followed;
}
