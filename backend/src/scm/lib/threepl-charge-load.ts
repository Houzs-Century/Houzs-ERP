// ----------------------------------------------------------------------------
// threepl-charge-load — the reads the 3PL invoices tab prices a delivery order
// with: every carrier's active rate card, and each DO's facts (its order's
// sets / items and delivery zone). Shared by the list (threepl-do-charges.ts)
// and the read of an AP invoice's bill (threepl-from-ap.ts), so the Rate card
// amount a bill is tallied against is the one the list then shows.
// ----------------------------------------------------------------------------
import { scopeToCompanyId } from './companyScope';
import { DEFAULT_ZONE_PREFIX_MAP, zoneForAddress, type ZonePrefixRule } from './zone-classify';
import type { SetLine } from './set-count';
import type { DeliveryFacts, RateCardSpec } from './delivery-rate-card';
import { doFacts, doGoodsSen, orderAddressText, orderGoodsSen, setLineOf } from './threepl-do-charge';
import { chunkIn } from './paginate-all';
import { areaOut, cardOut, ruleOut, toCardSpec } from '../routes/delivery-rate-cards';
import { loadPlacesFor } from '../routes/delivery-places';
import { MAP_COLS, toPrefixMap, type MapRow } from '../routes/delivery-zones';

type Row = Record<string, unknown>;
// The 3PL tables are not in the generated Supabase types; same narrow bridge as
// delivery-rate-cards.ts rc().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (sb: unknown): any => sb;
const str = (v: unknown) => (v == null || v === '' ? null : String(v));

export type CarrierCards = {
  carrierName: Map<string, string>;
  specByCarrier: Map<string, { name: string; spec: RateCardSpec }>;
  /** The paying company's zone map (Delivery Zones): an order's zone by its postcode. */
  zoneMap: ZonePrefixRule[];
};

/** The paying company's carriers and the active rate card of each. */
export async function loadCarrierCards(sb: unknown, companyId: number): Promise<{ ok: true; cards: CarrierCards } | { ok: false; reason: string }> {
  const [{ data: carriers, error: e1 }, { data: cardRows, error: e2 }, { data: mapRows, error: eMap }, places] = await Promise.all([
    scopeToCompanyId(db(sb).from('threepl_companies').select('id, name'), companyId),
    scopeToCompanyId(db(sb).from('delivery_rate_cards').select('*'), companyId).eq('is_active', true),
    /* The company's zone map and places (Delivery Zones): a town on a card counts only inside its zone. */
    scopeToCompanyId(db(sb).from('delivery_zone_postcodes').select(MAP_COLS), companyId).order('id'),
    loadPlacesFor(sb, companyId),
  ]);
  if (e1 || e2 || eMap) return { ok: false, reason: (e1 ?? e2 ?? eMap).message };
  if (!places.ok) return { ok: false, reason: places.reason };
  const carrierName = new Map<string, string>(((carriers ?? []) as Row[]).map((r) => [String(r.id), String(r.name ?? '')]));
  const cards = ((cardRows ?? []) as Row[]).map(cardOut).filter((cd) => cd.carrierCompanyId);
  const [{ data: ruleRows, error: e3 }, { data: areaRows, error: e4 }] = cards.length
    ? await Promise.all([
      scopeToCompanyId(db(sb).from('delivery_rate_rules').select('*'), companyId).in('card_id', cards.map((x) => x.id)),
      /* Each card's priced areas (mig 20261111T1000). */
      scopeToCompanyId(db(sb).from('delivery_rate_areas').select('*'), companyId).in('card_id', cards.map((x) => x.id)),
    ])
    : [{ data: [] as Row[], error: null }, { data: [] as Row[], error: null }];
  if (e3 || e4) return { ok: false, reason: (e3 ?? e4).message };
  const rules = ((ruleRows ?? []) as Row[]).map(ruleOut);
  const areas = ((areaRows ?? []) as Row[]).map(areaOut);
  const specByCarrier = new Map(cards.map((cd) => [cd.carrierCompanyId as string, { name: cd.name, spec: toCardSpec(cd, rules.filter((r) => r.cardId === cd.id), areas, places.places) }]));
  return { ok: true, cards: { carrierName, specByCarrier, zoneMap: toPrefixMap((mapRows ?? []) as MapRow[]).map } };
}

/** Narrows a read to the companies whose orders may be priced — the caller's
 *  allowed companies in a request, every company in the cron (Houzs delivers
 *  for 2990). */
export type CompanyScopeFn = <Q>(query: Q) => Q;

/** Each DO's facts for the rate card, read from its order: the order's lines
 *  (sets / items), its address (zone) and its goods value (the DO's share of
 *  the order's goods). A DO with no order has none. */
export async function loadDoFacts(
  scope: CompanyScopeFn, sb: unknown, dos: ReadonlyArray<{ id: string; soDocNo: string | null }>,
  zoneMap: readonly ZonePrefixRule[] = DEFAULT_ZONE_PREFIX_MAP,
): Promise<{ ok: true; facts: Map<string, DeliveryFacts> } | { ok: false; reason: string }> {
  const soDocs = [...new Set(dos.map((d) => d.soDocNo).filter((x): x is string => !!x))];
  const linesBySo = new Map<string, SetLine[]>();
  const zoneBySo = new Map<string, string | null>();
  const addressBySo = new Map<string, string>();
  const goodsBySo = new Map<string, { goods: number; total: number }>();
  const doTotal = new Map<string, number | null>();
  if (soDocs.length) {
    const [{ data: lineRows, error: e5 }, { data: soRows, error: e6 }, doRows] = await Promise.all([
      scope(db(sb).from('mfg_sales_order_items').select('doc_no, item_group, qty, cancelled')).in('doc_no', soDocs),
      scope(db(sb).from('mfg_sales_orders').select('doc_no, postcode, address1, address2, address3, address4, city, local_total_sen, mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen')).in('doc_no', soDocs),
      chunkIn<Row>(dos.map((d) => d.id), (b, from, to) => scope(db(sb).from('delivery_orders').select('id, local_total_sen')).in('id', b).order('id').range(from, to)),
    ]);
    if (e5 || e6 || doRows.error) return { ok: false, reason: (e5 ?? e6 ?? doRows.error)!.message };
    for (const d of doRows.data) doTotal.set(String(d.id), d.local_total_sen == null ? null : Number(d.local_total_sen));
    for (const l of (lineRows ?? []) as Row[]) {
      const arr = linesBySo.get(String(l.doc_no)) ?? [];
      arr.push(setLineOf(l));
      linesBySo.set(String(l.doc_no), arr);
    }
    for (const so of (soRows ?? []) as Row[]) {
      addressBySo.set(String(so.doc_no), orderAddressText(so));
      zoneBySo.set(String(so.doc_no), zoneForAddress({ postcode: str(so.postcode), address1: str(so.address1), address2: str(so.address2) }, zoneMap).zone);
      goodsBySo.set(String(so.doc_no), { goods: orderGoodsSen(so), total: Number(so.local_total_sen ?? 0) });
    }
  }
  const facts = new Map<string, DeliveryFacts>();
  for (const d of dos) {
    if (!d.soDocNo) continue;
    const order = goodsBySo.get(d.soDocNo);
    const goods = order ? doGoodsSen(order.goods, order.total, doTotal.get(d.id) ?? null) : null;
    facts.set(d.id, doFacts(linesBySo.get(d.soDocNo) ?? [], zoneBySo.get(d.soDocNo) ?? null, addressBySo.get(d.soDocNo) ?? null, goods));
  }
  return { ok: true, facts };
}
