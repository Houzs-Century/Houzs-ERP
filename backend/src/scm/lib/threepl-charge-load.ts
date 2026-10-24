// ----------------------------------------------------------------------------
// threepl-charge-load — the reads the 3PL invoices tab prices a delivery order
// with: every carrier's active rate card, and each DO's facts (its order's
// sets / items and delivery zone). Shared by the list (threepl-do-charges.ts)
// and the read of an AP invoice's bill (threepl-from-ap.ts), so the Rate card
// amount a bill is tallied against is the one the list then shows.
// ----------------------------------------------------------------------------
import { scopeToCompanyId } from './companyScope';
import { DEFAULT_ZONE_PREFIX_MAP, zoneForAddress } from './zone-classify';
import type { SetLine } from './set-count';
import type { DeliveryFacts, RateCardSpec } from './delivery-rate-card';
import { doFacts } from './threepl-do-charge';
import { cardOut, ruleOut, toCardSpec } from '../routes/delivery-rate-cards';

type Row = Record<string, unknown>;
// The 3PL tables are not in the generated Supabase types; same narrow bridge as
// delivery-rate-cards.ts rc().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (sb: unknown): any => sb;
const str = (v: unknown) => (v == null || v === '' ? null : String(v));

export type CarrierCards = {
  carrierName: Map<string, string>;
  specByCarrier: Map<string, { name: string; spec: RateCardSpec }>;
};

/** The paying company's carriers and the active rate card of each. */
export async function loadCarrierCards(sb: unknown, companyId: number): Promise<{ ok: true; cards: CarrierCards } | { ok: false; reason: string }> {
  const [{ data: carriers, error: e1 }, { data: cardRows, error: e2 }] = await Promise.all([
    scopeToCompanyId(db(sb).from('threepl_companies').select('id, name'), companyId),
    scopeToCompanyId(db(sb).from('delivery_rate_cards').select('*'), companyId).eq('is_active', true),
  ]);
  if (e1 || e2) return { ok: false, reason: (e1 ?? e2).message };
  const carrierName = new Map<string, string>(((carriers ?? []) as Row[]).map((r) => [String(r.id), String(r.name ?? '')]));
  const cards = ((cardRows ?? []) as Row[]).map(cardOut).filter((cd) => cd.carrierCompanyId);
  const { data: ruleRows, error: e3 } = cards.length
    ? await scopeToCompanyId(db(sb).from('delivery_rate_rules').select('*'), companyId).in('card_id', cards.map((x) => x.id))
    : { data: [] as Row[], error: null };
  if (e3) return { ok: false, reason: e3.message };
  const rules = ((ruleRows ?? []) as Row[]).map(ruleOut);
  const specByCarrier = new Map(cards.map((cd) => [cd.carrierCompanyId as string, { name: cd.name, spec: toCardSpec(cd, rules.filter((r) => r.cardId === cd.id)) }]));
  return { ok: true, cards: { carrierName, specByCarrier } };
}

/** Narrows a read to the companies whose orders may be priced — the caller's
 *  allowed companies in a request, every company in the cron (Houzs delivers
 *  for 2990). */
export type CompanyScopeFn = <Q>(query: Q) => Q;

/** Each DO's facts for the rate card, read from its order: the order's lines
 *  (sets / items) and its address (zone). A DO with no order has none. */
export async function loadDoFacts(scope: CompanyScopeFn, sb: unknown, dos: ReadonlyArray<{ id: string; soDocNo: string | null }>): Promise<{ ok: true; facts: Map<string, DeliveryFacts> } | { ok: false; reason: string }> {
  const soDocs = [...new Set(dos.map((d) => d.soDocNo).filter((x): x is string => !!x))];
  const linesBySo = new Map<string, SetLine[]>();
  const zoneBySo = new Map<string, string | null>();
  const addressBySo = new Map<string, string>();
  if (soDocs.length) {
    const [{ data: lineRows, error: e5 }, { data: soRows, error: e6 }] = await Promise.all([
      scope(db(sb).from('mfg_sales_order_items').select('doc_no, item_group, qty, cancelled')).in('doc_no', soDocs),
      scope(db(sb).from('mfg_sales_orders').select('doc_no, postcode, address1, address2')).in('doc_no', soDocs),
    ]);
    if (e5 || e6) return { ok: false, reason: (e5 ?? e6)!.message };
    for (const l of (lineRows ?? []) as Row[]) {
      const arr = linesBySo.get(String(l.doc_no)) ?? [];
      const g = String(l.item_group ?? '').toUpperCase();
      arr.push({
        category: g.includes('BEDFRAME') ? 'BEDFRAME' : g.includes('SOFA') ? 'SOFA' : g.includes('MATTRESS') ? 'MATTRESS' : 'OTHERS',
        qty: Number(l.qty ?? 1), cancelled: l.cancelled === true,
      });
      linesBySo.set(String(l.doc_no), arr);
    }
    for (const so of (soRows ?? []) as Row[]) {
      addressBySo.set(String(so.doc_no), [str(so.address1), str(so.address2), str(so.postcode)].filter(Boolean).join(' '));
      zoneBySo.set(String(so.doc_no), zoneForAddress({ postcode: str(so.postcode), address1: str(so.address1), address2: str(so.address2) }, [...DEFAULT_ZONE_PREFIX_MAP]).zone);
    }
  }
  const facts = new Map<string, DeliveryFacts>();
  for (const d of dos) {
    if (!d.soDocNo) continue;
    facts.set(d.id, doFacts(linesBySo.get(d.soDocNo) ?? [], zoneBySo.get(d.soDocNo) ?? null, addressBySo.get(d.soDocNo) ?? null));
  }
  return { ok: true, facts };
}
