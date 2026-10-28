#!/usr/bin/env node
/* check-2990-retail-price-sentinel.mjs — is anything still rewriting company 2's
 * RETAIL prices?
 *
 * READ-ONLY: one `SET TRANSACTION READ ONLY` transaction of SELECTs. No writes,
 * no DDL, and nothing here can be made to write by any input.
 *
 * The reasoning, every verdict, and what this cannot see are in
 * scripts/lib/retail-price-sentinel.mjs. Short version: 2990's POS SKU Master
 * is the only surface allowed to author their retail prices, the trigger
 * enforces that inside `seat_height_prices`, and the flat columns
 * (sell_price_sen, pwp_price_sen) carry no signal a trigger could read — so
 * they are watched here instead, against scm.master_price_history.
 *
 * USAGE
 *   node scripts/check-2990-retail-price-sentinel.mjs          # report, exit 0
 *   ALARM=1 node scripts/check-2990-retail-price-sentinel.mjs  # exit 1 on a finding
 *   COMPANY_ID=2 (default)
 *
 * ALARM=1 is what the schedule passes, so a healthy day is silent and a finding
 * is an e-mail that names the SKU. Run it by hand without ALARM and it always
 * exits 0: the answer is the report.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import {
  DERIVE_FLAG_SQL,
  FLAT_COUNTS_SQL,
  FLAT_OFFENDERS_SQL,
  GUARD_COUNT_SQL,
  GUARD_LOG_SQL,
  GUARD_ROWS_SQL,
  SEAT_COUNTS_SQL,
  SEAT_OFFENDERS_SQL,
  verdict,
} from './lib/retail-price-sentinel.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
  process.exit(2);
}

const COMPANY_ID = Number(process.env.COMPANY_ID ?? 2);
const ALARM = process.env.ALARM === '1';
const GH = !!process.env.GITHUB_ACTIONS;
const say = (m = '') => console.log(m);
const note = (m) => console.log(GH ? `::notice::${m}` : m);
const bad = (m) => console.log(GH ? `::error::${m}` : `ALARM  ${m}`);

/** Money, for a human reading an alarm at 09:00. */
const rm = (sen) => (sen == null ? '(none)' : `RM ${(Number(sen) / 100).toFixed(2)}`);
/** At most `n` rows printed; the COUNT always comes from count(*), never from this. */
const HEAD = 20;

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  const out = await sql.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL statement_timeout = '120s'`;

    const [seat] = await tx.unsafe(SEAT_COUNTS_SQL, [COMPANY_ID]);
    const seatOffenders = await tx.unsafe(SEAT_OFFENDERS_SQL, [COMPANY_ID]);
    const flat = await tx.unsafe(FLAT_COUNTS_SQL, [COMPANY_ID]);
    const flatOffenders = await tx.unsafe(FLAT_OFFENDERS_SQL, [COMPANY_ID]);
    const [{ present }] = await tx.unsafe(GUARD_LOG_SQL);
    const guard = present
      ? { present, ...(await tx.unsafe(GUARD_COUNT_SQL, [COMPANY_ID]))[0] }
      : { present, rows: 0, newest: null };
    const guardRows = present ? await tx.unsafe(GUARD_ROWS_SQL, [COMPANY_ID]) : [];
    const flags = await tx.unsafe(DERIVE_FLAG_SQL);
    return { seat, seatOffenders, flat, flatOffenders, guard, guardRows, flags };
  });

  const { ok, alarms, notes } = verdict({
    companyId: COMPANY_ID,
    seat: out.seat,
    flat: out.flat,
    guard: out.guard,
    flags: out.flags,
  });

  say(`=== company ${COMPANY_ID} retail prices vs scm.master_price_history ===`);
  say(
    `seat slots (jsonb): audited ${out.seat.expected_slots}, live ${out.seat.live_slots}, ` +
      `missing ${out.seat.missing}, disagreeing ${out.seat.disagreeing}, unaudited ${out.seat.unaudited} ` +
      `(from ${out.seat.history_rows} history rows)`,
  );
  for (const r of out.seatOffenders.slice(0, HEAD)) {
    say(`  ${r.kind.padEnd(11)} ${r.item_code} ${r.height}/${r.tier}: audited ${rm(r.want_sen)}, row holds ${rm(r.have_sen)}`);
  }
  if (out.seatOffenders.length > HEAD) say(`  … ${out.seatOffenders.length - HEAD} more`);

  for (const r of out.flat) {
    say(
      `${r.field}: audited ${r.audited_skus} SKU(s), missing ${r.missing}, disagreeing ${r.disagreeing}` +
        (Number(r.sku_gone) > 0 ? `, ${r.sku_gone} SKU(s) no longer exist` : ''),
    );
  }
  for (const r of out.flatOffenders.slice(0, HEAD)) {
    say(`  ${r.kind.padEnd(11)} ${r.item_code} ${r.field}: audited ${rm(r.want_sen)}, row holds ${rm(r.have_sen)}`);
  }
  if (out.flatOffenders.length > HEAD) say(`  … ${out.flatOffenders.length - HEAD} more`);

  say(
    out.guard.present
      ? `retail_price_guard_log: ${out.guard.rows} intervention(s)${out.guard.newest ? `, newest ${out.guard.newest}` : ''}`
      : 'retail_price_guard_log: not present on this database',
  );
  for (const r of out.guardRows.slice(0, HEAD)) {
    say(`  ${r.at} ${r.item_code}: carried ${r.slots_carried_forward}, re-added ${r.slots_readded}`);
  }

  say(
    `auto-derive flag: ${
      out.flags.length === 0 ? 'no row for any company (= off everywhere)' : out.flags.map((f) => `company ${f.company_id}=${f.value}`).join(', ')
    }`,
  );
  say();

  for (const n of notes) note(n);
  for (const a of alarms) bad(a);

  if (ok) {
    note(`2990 retail prices: clean. Every audited value is on the row, and nothing has had to be put back.`);
    process.exit(0);
  }
  say();
  say(`${alarms.length} finding(s). The audit trail is the source of truth for what these prices SHOULD be:`);
  say("  SELECT * FROM scm.master_price_history WHERE company_id = 2 AND item_code = '<code>' ORDER BY changed_at DESC;");
  process.exit(ALARM ? 1 : 0);
} catch (err) {
  // A sentinel that cannot read must never look like a sentinel that found
  // nothing. This exits non-zero regardless of ALARM.
  console.error(`::error::retail price sentinel could not run: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
} finally {
  await sql.end({ timeout: 5 });
}
