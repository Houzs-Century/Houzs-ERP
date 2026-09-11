// What did the queue actually SEND for this document, and what is the ERP line
// underneath it?
//
// WHY IT EXISTS. `HC-SO-009373` is refused by AutoCount with
//
//   The quantity of the item code HOK-2041 (A) (Q) is less than the quantity it
//   was partially transferred to Purchase Order, save aborted.
//
// and reasoning about it produced two wrong answers in a row on 2026-09-09 —
// first "we re-resolve the item code on an edit" (composeEdit already strips it
// on a keyed line, and says so in its own comment), then "it must be a rebuild"
// (a rebuild needs a line-set change, and none of today's 379 sends carried
// one). Both were readings of the code standing in for a reading of the ROW.
//
// So this prints the row: the stored payload's lines, and the ERP lines beside
// them. A refusal about a quantity is settled by the quantity that was sent, not
// by which branch of the composer looked most likely.
//
// Read-only. Scoped to the documents named in DOC_NOS and prints nothing about
// any other. It does print item codes and quantities for those documents — the
// same fields the outbox health log already prints in its refusal messages —
// because a quantity dispute cannot be settled without them.
//
//   DOC_NOS=HC-SO-009373    required; comma separated
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const DOC_NOS = (process.env.DOC_NOS || '').split(',').map((s) => s.trim()).filter(Boolean);

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) { console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.'); process.exit(0); }
if (!DOC_NOS.length) { console.error('DOC_NOS not set. Name the documents, comma separated.'); process.exit(0); }

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  console.log(`Asking about ${DOC_NOS.length} document(s): ${DOC_NOS.join(', ')}`);

  /* ── 1. THE ERP LINES, with the flags the composer reads ────────────────
     `cancelled` is the one the reasoning kept skipping: a cancelled line is
     sent as Retire, the host zeroes it, and zero IS less than a quantity
     already transferred to a purchase order. */
  console.log('');
  console.log('=== 1. WHAT THE ERP HOLDS ===');
  const lines = await pg`SELECT doc_no, id, item_code, qty, cancelled, linked_ac_dtlkey, created_at
                           FROM scm.mfg_sales_order_items
                          WHERE doc_no = ANY(${DOC_NOS})
                          ORDER BY doc_no, created_at, id`;
  const seen = new Map();
  for (const r of lines) {
    const pos = (seen.get(r.doc_no) ?? 0) + 1;
    seen.set(r.doc_no, pos);
    console.log(`  ${r.doc_no}  line ${String(pos).padStart(2)}  key ${String(r.linked_ac_dtlkey ?? '-').padStart(7)}  qty ${String(r.qty).padStart(3)}  ${r.cancelled ? 'CANCELLED' : '         '}  ${r.item_code}`);
  }
  console.log(`  ${lines.length} line(s); cancelled: ${lines.filter((r) => r.cancelled).length}`);

  /* ── 2. THE PAYLOAD THAT WAS SENT ──────────────────────────────────────
     The stored payload is what the account book was actually asked to do. A
     requeue REPLAYS it, so it is also what will be sent again. */
  console.log('');
  console.log('=== 2. WHAT THE QUEUE SENT ===');
  const rows = await pg`SELECT id, op, status, attempts, created_at, payload, last_error
                          FROM scm.autocount_outbox
                         WHERE doc_no = ANY(${DOC_NOS})
                         ORDER BY created_at DESC
                         LIMIT 6`;
  for (const r of rows) {
    console.log('');
    console.log(`  ${r.op}  ${r.status}  ${r.attempts} attempt(s)  ${String(r.created_at).slice(0, 19)}`);
    const p = r.payload ?? {};
    const body = p.body ?? p.Body ?? p;
    const dl = body.Details ?? body.Lines ?? body.details ?? null;
    console.log(`    top-level keys: ${Object.keys(p).join(', ') || '(none)'}`);
    console.log(`    Rebuild: ${JSON.stringify(body.Rebuild ?? p.Rebuild ?? null)}`);
    if (Array.isArray(dl)) {
      console.log(`    ${dl.length} line(s) sent:`);
      for (const d of dl) {
        const bits = [
          d.DtlKey != null ? `key ${d.DtlKey}` : 'NO KEY',
          d.ItemCode != null ? `item ${d.ItemCode}` : 'no ItemCode sent',
          d.Qty != null ? `qty ${d.Qty}` : 'no Qty',
          d.Retire ? 'RETIRE' : null,
        ].filter(Boolean);
        console.log(`      ${bits.join('  ')}`);
      }
    } else {
      console.log(`    (no line array found; body keys: ${Object.keys(body).join(', ')})`);
    }
    if (r.last_error) console.log(`    last_error: ${String(r.last_error).slice(0, 220)}`);
  }
  if (!rows.length) console.log('  no outbox row for these documents');
} catch (e) {
  console.error('DB unreachable or query failed:', e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
