
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
  const header = (body.Header ?? null) as Record<string, unknown> | null;
  const at = (key: string): unknown => body[key] ?? header?.[key];
  const items = new Map<string, { ItemCode: string; Description: string; UOM?: string }>();
  const details = [
    ...(Array.isArray(body.Details) ? body.Details : []),
    ...(Array.isArray(body.Lines) ? body.Lines : []),
  ] as Array<Record<string, unknown>>;
  for (const d of details) {
    const code = typeof d?.ItemCode === 'string' ? d.ItemCode.trim() : '';
    if (!code || d?.Retire === true) continue;
    if (!items.has(code)) {
      items.set(code, {
        ItemCode: code,
        Description: typeof d.Description === 'string' && d.Description ? d.Description : code,
        ...(typeof d.UOM === 'string' && d.UOM ? { UOM: d.UOM } : {}),
      });
    }
  }

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

  const creditors: Array<{ AccNo: string; CompanyName: string }> = [];
  if (cred) {
    const name = at('CreditorName');
    creditors.push({
      AccNo: cred,
      CompanyName: typeof name === 'string' && name ? name : cred,
    });
  }

  const locations = new Map<string, { Location: string }>();
  const addLoc = (v: unknown) => {
    const code = typeof v === 'string' ? v.trim() : '';
    if (code && !locations.has(code)) locations.set(code, { Location: code });
  };
  addLoc(at('SalesLocation'));
  addLoc(at('PurchaseLocation'));
  for (const d of details) if (d?.Retire !== true) addLoc(d?.Location);

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
