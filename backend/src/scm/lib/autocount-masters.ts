// ----------------------------------------------------------------------------
// autocount-masters — the masters a payload NAMES, in the shape
// `/ensure-masters` consumes.
//
// SPLIT OUT OF autocount-outbox.ts on 2026-08-14, when that file crossed the
// 2,000-line cap. It is a clean seam rather than a convenient one: this is a
// PURE function over the payload, the only part of the outbox module that
// touches no database and no client, and it is the half a reviewer has to read
// on its own anyway — everything below is about which foreign key a missing
// master fails on, and none of it is about queueing.
//
// The rule the whole file exists to serve: A DOCUMENT NAMING A MASTER AUTOCOUNT
// DOES NOT HAVE IS NOT REFUSED POLITELY. It fails on a FOREIGN KEY at Save()
// and the whole document is lost, which the live book proved by answering
// FK_SODTL_Location to a create whose lines carried no stock location. So the
// drain sends /ensure-masters FIRST, and this is what it sends.
// ----------------------------------------------------------------------------

/**
 * The masters a payload NAMES, in the shape /ensure-masters consumes.
 *
 * Read off the payload that is about to be sent, never recomposed from the
 * database: the payload is the snapshot of what the user's save produced, and a
 * master derived from anything else could differ from the one the document
 * actually references.
 *
 * The debtor is deliberately absent. Houzs writes every order against ONE fixed
 * AutoCount debtor and overwrites the name field per customer, so there is no
 * per-customer account to open — and opening one would create an AR account
 * nobody asked for. If that convention ever changes, this is where it changes.
 *
 * AN EDIT KEEPS ITS HEADER ONE LEVEL DOWN, and this function used to miss it
 * entirely. `dispatchOne` calls `mastersOf` for `create_so`, `create_po` AND
 * `edit`, but an edit payload is `{DocType, DocNo, Header{…, UDF{…}}, Lines[]}`
 * — so `body.Agent`, `body.SalesLocation`, `body.CreditorCode` and `body.UDF`
 * were all read at a level where an edit has none of them, and only the line
 * items were ever opened. That was harmless exactly as long as `soEditHeader`
 * sent nothing the book did not already hold; the moment a venue or a location
 * is allowed to pass through unmapped it stops being harmless, which is why
 * this landed in the SAME pull request as the pass-through (audit finding 11).
 */
export function mastersOf(body: Record<string, unknown>): Record<string, unknown> | null {
  /* The header of an EDIT, or the payload itself for a CREATE. Read through
     one accessor so a field added to either shape cannot be opened on one path
     and silently dropped on the other. */
  const header = (body.Header ?? null) as Record<string, unknown> | null;
  const at = (key: string): unknown => body[key] ?? header?.[key];
  const items = new Map<string, { ItemCode: string; Description: string; UOM?: string }>();
  const details = [
    ...(Array.isArray(body.Details) ? body.Details : []),
    ...(Array.isArray(body.Lines) ? body.Lines : []),
  ] as Array<Record<string, unknown>>;
  for (const d of details) {
    const code = typeof d?.ItemCode === 'string' ? d.ItemCode.trim() : '';
    /* A retired line names a code the book already has, by construction — it is
       addressed by a DtlKey AutoCount issued. Nothing to open. */
    if (!code || d?.Retire === true) continue;
    if (!items.has(code)) {
      items.set(code, {
        ItemCode: code,
        Description: typeof d.Description === 'string' && d.Description ? d.Description : code,
        ...(typeof d.UOM === 'string' && d.UOM ? { UOM: d.UOM } : {}),
      });
    }
  }

  /* A PURCHASE agent is a different master from a sales one: different table
     (dbo.PurchaseAgent), different foreign key (FK_PO_PurchaseAgent), different
     SDK command. Opening 'OTHERS' as a sales agent does nothing for a purchase
     order that names it — /create-po is refused and the whole document is lost.
     Proved on the live book 2026-08-12, after ensure-masters had already
     reported agent:OTHERS as existing.
     CreditorCode is the discriminator because it is the one field only a
     purchase document carries; CreatePo applies it unconditionally.
     An EDIT does not carry one at all — composePoState sends only CreditorName
     and Description — so DocType is the discriminator there. Getting this wrong
     opens the agent in the wrong table, which reads as success and refuses the
     document anyway (the 2026-08-12 finding, in one line). */
  const cred = typeof at('CreditorCode') === 'string' ? (at('CreditorCode') as string).trim() : '';
  const purchaseDoc = new Set(['PO', 'GR', 'PI']);
  const isPurchase = cred.length > 0
    || (typeof body.DocType === 'string' && purchaseDoc.has(body.DocType.toUpperCase()));
  const agents: Array<{ Agent: string }> = [];
  const purchaseAgents: Array<{ PurchaseAgent: string }> = [];
  const agent = typeof at('Agent') === 'string' ? (at('Agent') as string).trim() : '';
  if (agent) {
    if (isPurchase) purchaseAgents.push({ PurchaseAgent: agent });
    else agents.push({ Agent: agent });
  }

  /* A PURCHASE ORDER NAMES A CREDITOR, and CreatePo applies CreditorCode
     unconditionally — so a supplier the account book does not have fails the
     same foreign key a missing item does, and takes the whole PO with it. The
     DEBTOR stays absent for the opposite reason: Houzs writes every order
     against ONE fixed account and overwrites the name, so there is no
     per-customer account to open. */
  const creditors: Array<{ AccNo: string; CompanyName: string }> = [];
  if (cred) {
    const name = at('CreditorName');
    creditors.push({
      AccNo: cred,
      CompanyName: typeof name === 'string' && name ? name : cred,
    });
  }

  /* THE STOCK LOCATIONS THE DOCUMENT ACTUALLY USES — the header's sales
     location and every line's own. This is the one the live book already
     proved: FK_SODTL_Location, on a line whose Location was empty. */
  const locations = new Map<string, { Location: string }>();
  const addLoc = (v: unknown) => {
    const code = typeof v === 'string' ? v.trim() : '';
    if (code && !locations.has(code)) locations.set(code, { Location: code });
  };
  addLoc(at('SalesLocation'));
  /* The purchase-side twin, sent from 2026-08-20 (scm.purchase_orders.purchase_location_id
     -> AutoCount's PurchaseLocation). `PurchaseHeader` applies it through Set(),
     which SWALLOWS — so a warehouse code dbo.Location does not have would not
     fail the document, it would silently not be on it. Opening the master here
     is what makes the value land instead of disappearing. */
  addLoc(at('PurchaseLocation'));
  for (const d of details) if (d?.Retire !== true) addLoc(d?.Location);

  /* THE DROPDOWN OPTIONS. Read off the UDF block the payload is sending, so
     the list only ever learns a value a real document is carrying. */
  const udfOptions: Array<{ List: string; Value: string }> = [];
  const udf = (at('UDF') ?? null) as Record<string, unknown> | null;
  for (const listName of ['BRANDING', 'VENUE']) {
    const v = udf && typeof udf[listName] === 'string' ? (udf[listName] as string).trim() : '';
    if (v) udfOptions.push({ List: listName, Value: v });
  }

  if (!items.size && !agents.length && !purchaseAgents.length && !creditors.length
      && !locations.size && !udfOptions.length) return null;
  return {
    Items: [...items.values()],
    Agents: agents,
    PurchaseAgents: purchaseAgents,
    Creditors: creditors,
    Locations: [...locations.values()],
    UdfOptions: udfOptions,
  };
}
