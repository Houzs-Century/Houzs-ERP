// Give the test rig the ERP side of a REAL merchant report.
//
// DEV ONLY. The owner, on his own Public Bank file: 我测试pbb的，但会比较难试是
// 因为pbb太多transaction了. The difficulty was never PBB — the rig's fake ERP
// holds a dozen invented payments, so every one of his real transactions
// correctly read as "no sale in the ERP" and there was nothing to watch match.
//
// This reads a real report with the REAL parser and writes the payments that
// should be behind it — one sale per line, its own date, amount and approval
// code, booked through the REAL posting engine. Then uploading that same file
// on the merchant screen matches it the way it will in production.
//
//   node scripts/demo-seed-from.mjs PBB "C:/…/HOUZSCENTURY_CSV_20260809 （PBB）.csv"
//   node scripts/demo-seed-from.mjs PBB "…file…" --perfect
//
// By default it leaves TWO things wrong on purpose, because a file where
// everything matches only proves the easy path:
//   · the last line gets no payment       -> "no sale in the ERP"
//   · the first payment's code is mistyped -> falls to amount+date, offered
//                                             pre-ticked for a human
// `--perfect` seeds a clean set instead.

import { readFileSync } from 'node:fs';

const [code, file, ...flags] = process.argv.slice(2);
const API = process.env.SETTLEMENT_DEMO_API ?? 'http://localhost:8788';

if (!code || !file) {
  console.error('usage: node scripts/demo-seed-from.mjs <ACQUIRER> <file> [--perfect]');
  console.error('       ACQUIRER is one of MBB PBB HLB GHL AEON');
  process.exit(1);
}

const content = readFileSync(file, 'utf8');
const res = await fetch(`${API}/api/scm/demo/seed-from-statement`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ acquirerCode: code, content, imperfect: !flags.includes('--perfect') }),
});
const body = await res.json();

if (!res.ok) {
  console.error(`REFUSED: ${body.message ?? body.error}`);
  process.exit(1);
}

console.log(`${code}: ${body.linesInFile} line(s) in the file, ${body.paymentsCreated} payment(s) created.`);
if (body.note) console.log(`  ${body.note}`);
console.log(`Now upload the same file on the merchant screen — it should match nearly everything.`);
