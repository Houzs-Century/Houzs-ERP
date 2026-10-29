#!/usr/bin/env node
// check-rate-cards.mjs — READ ONLY. How each carrier stands on Delivery Rate Cards,
// and how it really bills (owner 2026-10-29: 帮我检查 rate card 我要怎样去设置):
//   1. the 3PL companies, their card (basis, charge per, min / cap / rounding) and rules;
//   2. what their bills said since FROM — the lines the 3PL invoices tab read off the
//      AP invoices, their words and amounts, how many DOs each names;
//   3. per DO: what was billed beside the DO's own size (lines, pieces) and place;
//   4. every transport-looking supplier's AP invoices since FROM, set up as a 3PL
//      company or not — their accounts and line words.
// Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-08-01).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-08-01');
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const rm = (sen) => (sen == null ? '-' : `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const out = (s) => console.log(`ROW|${s}`);
const cut = (s, n = 70) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

try {
  /* 1. Carriers, cards, rules. */
  const carriers = await sql`SELECT id::text AS id, name, is_active FROM scm.threepl_companies WHERE company_id = ${CO} ORDER BY name`;
  const cards = await sql`
    SELECT id::text AS id, name, carrier_company_id::text AS carrier, carrier_label, is_own_fleet, basis, aggregation,
           min_charge_sen, cap_sen, rounding, is_active, notes
      FROM scm.delivery_rate_cards WHERE company_id = ${CO} ORDER BY name`;
  const rules = cards.length === 0 ? [] : await sql`
    SELECT card_id::text AS card_id, rule_type, tier_position, bracket_min, bracket_max, zone, amount_sen
      FROM scm.delivery_rate_rules WHERE card_id::text = ANY(${cards.map((c) => c.id)}) ORDER BY card_id, rule_type, sort_order, tier_position`;
  const nameOf = new Map(carriers.map((c) => [c.id, c.name]));
  out(`== ${carriers.length} carriers, ${cards.length} cards`);
  for (const c of carriers) out(`carrier ${c.name}${c.is_active ? '' : ' (inactive)'}`);
  for (const k of cards) {
    out(`CARD ${k.name} — carrier ${nameOf.get(k.carrier) ?? k.carrier_label ?? '-'}${k.is_own_fleet ? ' (own fleet)' : ''}: basis ${k.basis}, per ${k.aggregation}, min ${rm(k.min_charge_sen)}, cap ${rm(k.cap_sen)}, rounding ${k.rounding}, ${k.is_active ? 'active' : 'inactive'}${k.notes ? ` — ${cut(k.notes, 80)}` : ''}`);
    const mine = rules.filter((r) => r.card_id === k.id);
    const byType = new Map();
    for (const r of mine) {
      const what = r.rule_type === 'POSITIONAL_TIER' ? `#${r.tier_position}`
        : r.rule_type === 'OVERAGE' ? `>${r.tier_position}`
        : r.rule_type === 'SOFA_BRACKET' ? `${r.bracket_min}-${r.bracket_max ?? '+'}c`
        : (r.rule_type === 'OUTSTATION' || r.rule_type === 'OUTSTATION_TRIP') ? String(r.zone ?? '?') : '';
      byType.set(r.rule_type, [...(byType.get(r.rule_type) ?? []), `${what}${what ? ' ' : ''}${(Number(r.amount_sen) / 100).toFixed(2)}`]);
    }
    for (const [t, xs] of byType) out(`  ${t} (${xs.length}): ${xs.join(' · ').slice(0, 900)}`);
  }

  /* 2. What their bills said. */
  const supCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'suppliers'`).map((x) => x.column_name);
  const supName = ['name', 'supplier_name', 'company_name', 'creditor_name'].find((x) => supCols.includes(x)) ?? 'id';
  const lines = await sql.unsafe(
    `SELECT l.threepl_company_id::text AS carrier, l.kind, l.text, l.amount_sen, l.assign, cardinality(l.do_ids) AS n_dos,
            inv.invoice_number, inv.invoice_date::text AS invoice_date, s.${supName}::text AS supplier
       FROM scm.threepl_bill_lines l JOIN scm.ap_invoices inv ON inv.id = l.ap_invoice_id
       LEFT JOIN scm.suppliers s ON s.id = inv.supplier_id
      WHERE l.company_id = $1 AND inv.invoice_date >= $2::date AND inv.status <> 'CANCELLED'
      ORDER BY inv.invoice_date, inv.invoice_number`,
    [CO, FROM],
  );
  const bySup = new Map();
  for (const l of lines) bySup.set(l.supplier, [...(bySup.get(l.supplier) ?? []), l]);
  for (const [sup, ls] of bySup) {
    const invs = new Set(ls.map((l) => l.invoice_number));
    const total = ls.reduce((s, l) => s + Number(l.amount_sen ?? 0), 0);
    const nd = new Map();
    for (const l of ls) nd.set(l.n_dos, (nd.get(l.n_dos) ?? 0) + 1);
    out(`BILLS ${sup} (carrier ${nameOf.get(l0(ls)) ?? '-'}): ${invs.size} invoices, ${ls.length} lines, ${rm(total)}; DOs per line ${[...nd].map(([k, v]) => `${k}:${v}`).join(' ')}; assign ${[...new Set(ls.map((l) => l.assign ?? 'open'))].join('/')}`);
    for (const l of ls.slice(0, 14)) out(`  ${l.invoice_date} ${l.invoice_number} [${l.kind}/${l.assign ?? 'open'}/${l.n_dos} DO] ${cut(l.text, 80)}: ${rm(l.amount_sen)}`);
  }

  /* 3. Per DO: billed beside the DO's own size and place. */
  const per = await sql`
    SELECT ch.threepl_company_id::text AS carrier, ch.billed_sen, d.do_number, d.state, d.city,
           count(i.id)::int AS n_lines, coalesce(sum(i.qty), 0)::numeric AS pieces,
           string_agg(DISTINCT left(coalesce(i.item_code, ''), 18), ',') AS codes
      FROM scm.threepl_do_charges ch JOIN scm.delivery_orders d ON d.id = ch.do_id
      LEFT JOIN scm.delivery_order_items i ON i.delivery_order_id = d.id
     WHERE ch.company_id = ${CO} AND coalesce(ch.invoice_date, d.do_date) >= ${FROM}::date
     GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 3`;
  const perBy = new Map();
  for (const p of per) perBy.set(p.carrier, [...(perBy.get(p.carrier) ?? []), p]);
  for (const [cid, ps] of perBy) {
    out(`PER DO ${nameOf.get(cid) ?? cid}: ${ps.length} DOs, billed ${rm(ps.reduce((s, p) => s + Number(p.billed_sen), 0))}`);
    for (const p of ps.slice(0, 16)) out(`  ${p.do_number} ${cut(p.city, 18)}/${cut(p.state, 14)}: ${p.n_lines} lines ${Number(p.pieces)} pcs [${cut(p.codes, 60)}] billed ${rm(p.billed_sen)}`);
  }

  /* 4. Every transport-looking supplier's AP invoices. */
  const ap = await sql.unsafe(
    `SELECT s.${supName}::text AS supplier, inv.invoice_number, inv.invoice_date::text AS invoice_date, inv.status, inv.total_sen,
            l.debit_account_code AS acc, l.description, l.amount_sen
       FROM scm.ap_invoices inv JOIN scm.suppliers s ON s.id = inv.supplier_id
       JOIN scm.ap_invoice_lines l ON l.invoice_id = inv.id
      WHERE inv.company_id = $1 AND inv.invoice_date >= $2::date AND inv.status <> 'CANCELLED'
        AND (s.${supName}::text ~* '(transport|logistic|freight|shri|muni|hong yee|united ways|msj|eignretep|brightsun|cv smart|keong|lorry|lori|cargo|express|forward)'
             OR l.debit_account_code ~ '-T0(0[5-7]|1[5-9]|2[0-9]|3[0-6])$')
      ORDER BY 1, inv.invoice_date, inv.invoice_number`,
    [CO, FROM],
  );
  const apBy = new Map();
  for (const a of ap) apBy.set(a.supplier, [...(apBy.get(a.supplier) ?? []), a]);
  for (const [sup, as] of apBy) {
    const invs = new Map(as.map((a) => [a.invoice_number, a]));
    const accs = new Map();
    for (const a of as) accs.set(a.acc, (accs.get(a.acc) ?? 0) + Number(a.amount_sen));
    out(`AP ${sup}: ${invs.size} invoices ${rm([...invs.values()].reduce((s, a) => s + Number(a.total_sen), 0))} — ${[...accs].map(([k, v]) => `${k} ${rm(v)}`).join(', ')}`);
    for (const a of as.slice(0, 8)) out(`  ${a.invoice_date} ${a.invoice_number} ${a.status} [${a.acc}] ${cut(a.description, 80)}: ${rm(a.amount_sen)}`);
  }
} catch (e) {
  out(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}

function l0(ls) {
  return ls.find((l) => l.carrier)?.carrier ?? null;
}
