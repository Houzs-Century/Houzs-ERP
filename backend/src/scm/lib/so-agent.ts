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
  const id = typeof staffId === 'string' ? staffId.trim() : '';
  if (!id) return null;
  try {
    const { data } = await sb.from('staff').select('name').eq('id', id).maybeSingle();
    const name = ((data as { name?: string | null } | null)?.name ?? '').trim();
    return name || null;
  } catch {
    return null;
  }
}
