/* The rules behind set-opening-bill-goods.mjs: what each opening bill (an
   AutoCount purchase invoice brought over at go-live) bought, by product group,
   read from AutoCount's own lines, so the Cash Flow can read a payment of it as
   sofa, bed frames, mattresses… (owner 2026-11-25, 「如果系统可以分得出purchase
   of sofa 和purchase of bedding 更加好」). Imported by
   backend/tests/openingBillGoodsPlan.test.mjs. */

/* AutoCount names two product groups differently from scm.acc_item_group_accounts. */
const ERP_GROUP = { ACC: 'ACCESSORY', OTHER: 'OTHERS' };
/** A product group in the ERP's words; '' = a line with no product group. */
export const erpGroup = (g) => {
  const k = String(g ?? '').trim().toUpperCase();
  return ERP_GROUP[k] ?? k;
};

/** The AutoCount purchase invoice an opening bill was brought over from, as its text names it. */
export const acDocOf = (notes) => /AUTOCOUNT ((?:HC-)?PI-\d+(?:-\d+)*)/.exec(String(notes ?? ''))?.[1] ?? null;

const sen = (v) => Math.round(Number(v ?? 0) * 100);

/** One line's value in MYR sen before tax: its subtotal ex tax (else its subtotal) at its document's rate. */
export const lineSen = (r) => sen(Number(r.SubTotalExTax ?? r.SubTotal ?? 0) * (Number(r.CurrencyRate ?? 1) || 1));

/** The source's purchase invoices by number: the creditor, cancelled or not, the MYR total, and the value per product group. */
export function invoicesOf(rows) {
  const out = new Map();
  for (const r of rows) {
    if (r?.T !== 'PI') continue;
    const doc = String(r.DocNo);
    const inv = out.get(doc) ?? { party: String(r.PartyCode ?? ''), cancelled: r.Cancelled === 'T', totalSen: sen(r.LocalNetTotal), groups: new Map() };
    const g = erpGroup(r.ItemGroup);
    inv.groups.set(g, (inv.groups.get(g) ?? 0) + lineSen(r));
    out.set(doc, inv);
  }
  return out;
}

/** A bill's groups as one comparable text: "BEDFRAME:1200|SOFA:300", in group order. */
export const goodsText = (groups) => (groups === null || groups.size === 0 ? '(none)'
  : [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([g, s]) => `${g || '-'}:${s}`).join('|'));

/** A bill's value in MYR sen, at its own rate when it is not in ringgit. */
export const billMyrSen = (b) => (!b.currency || b.currency === 'MYR' ? Number(b.totalSen) : Math.round(Number(b.totalSen) * Number(b.rate ?? 1)));

/* An opening bill carries what was still owed on its invoice at go-live: never more than the
   invoice. A bill above its invoice by more than a ringgit is not that invoice. */
const SLACK_SEN = 100;

/**
 * The plan for one company. `bills`: its opening bills, { id, number, supplierCode, notes, totalSen, currency, rate }.
 * `invoices`: invoicesOf(the source). `current`: bill id → Map(group → sen), the rows held now.
 * A bill reads the lines of the AutoCount purchase invoice its text names, when the source has that
 * invoice, it is not cancelled, and the bill is not more than it. A bill the source lacks keeps what it holds.
 */
export function planFor(bills, invoices, current) {
  const changes = [];
  const skipped = [];
  const read = [];
  const missing = [];
  for (const b of bills) {
    const doc = acDocOf(b.notes);
    const inv = doc === null ? undefined : invoices.get(doc);
    if (!inv) { missing.push({ bill: b, doc }); continue; }
    if (inv.cancelled) { skipped.push({ bill: b, doc, why: 'its AutoCount invoice is cancelled' }); continue; }
    if (billMyrSen(b) > inv.totalSen + SLACK_SEN) { skipped.push({ bill: b, doc, why: 'the bill is more than its AutoCount invoice' }); continue; }
    const to = new Map([...inv.groups].filter(([, s]) => s !== 0));
    if (![...to.values()].some((s) => s > 0)) { skipped.push({ bill: b, doc, why: 'its AutoCount lines carry no value' }); continue; }
    read.push({ bill: b, doc, groups: to, otherParty: inv.party !== b.supplierCode });
    const from = current.get(b.id) ?? null;
    if (goodsText(from) !== goodsText(to)) changes.push({ id: b.id, number: b.number, supplierCode: b.supplierCode, doc, from, to });
  }
  return { changes, skipped, read, missing };
}

/** Per supplier code: bills read, not in the source, skipped, and the share of each group in what was read. */
export function summaryOf(plan) {
  const per = new Map();
  const of = (code) => {
    if (!per.has(code)) per.set(code, { read: 0, missing: 0, skipped: 0, groups: new Map() });
    return per.get(code);
  };
  for (const r of plan.read) {
    const s = of(r.bill.supplierCode);
    s.read += 1;
    for (const [g, v] of r.groups) s.groups.set(g, (s.groups.get(g) ?? 0) + v);
  }
  for (const m of plan.missing) of(m.bill.supplierCode).missing += 1;
  for (const k of plan.skipped) of(k.bill.supplierCode).skipped += 1;
  return [...per].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, s]) => {
    const total = [...s.groups.values()].filter((v) => v > 0).reduce((a, v) => a + v, 0);
    const shares = [...s.groups].filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a)
      .map(([g, v]) => `${g || '(no group)'} ${Math.round((100 * v) / total)}%`).join(' · ');
    return { code, read: s.read, missing: s.missing, skipped: s.skipped, shares };
  });
}

/** What is wrong with the rows as re-read: a planned bill whose groups did not land, or a row of the wrong shape. */
export function shapeProblems(changes, now, openingBillIds) {
  const out = [];
  for (const c of changes) {
    const got = now.get(c.id) ?? null;
    if (goodsText(got) !== goodsText(c.to)) out.push(`bill ${c.number} holds ${goodsText(got)}, planned ${goodsText(c.to)}`);
  }
  for (const [id, groups] of now) {
    if (!openingBillIds.has(id)) out.push(`bill ${id} is not an opening bill of this company`);
    for (const [g, s] of groups) if (!Number.isSafeInteger(s) || g !== g.trim().toUpperCase()) out.push(`bill ${id} holds ${g || '-'}:${s}`);
  }
  return out;
}
