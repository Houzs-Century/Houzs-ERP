/* THE SERVER STOPPED ACCEPTING A DELIVERY SIGNATURE.
 *
 * Owner, 2026-08-21: 「签收签名不需要 先 delete掉」.
 *
 * The measurement behind the ruling (census run 32462178224,
 * `backend/scripts/check-pod-evidence.mjs`): across all 39 delivery orders that
 * exist, every status, all time — `signature 0, photo 0, gps 0`. The capture
 * path was never broken; nothing has ever travelled it. So the field is removed
 * from the write side rather than left as an endpoint nobody calls.
 *
 * WHAT IS NOT DONE HERE, deliberately. `delivery_orders.signature_data` is NOT
 * dropped. It holds 0 rows, but a column drop is irreversible and is a separate
 * decision for the owner; the column stays and simply has no writer. That is the
 * property below — "no writer", not "no column".
 *
 * WHY A SOURCE SCAN. `delivery-orders-mfg.ts` is ~5,900 lines and its status
 * handler reaches for a live PostgREST client, a company scope and an inventory
 * ledger; standing all of that up would test the mocks. The repo's own precedent
 * for pinning a property of this file is a scan (`doDeliveredOneHome.test.ts`).
 * The scan is narrowed to the handler body so an unrelated mention elsewhere in
 * the router cannot make it pass or fail by accident, and comments are stripped
 * first because this change is EXPLAINED in prose right beside the code it
 * removed — documentation is not a write.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROUTE = join(HERE, '..', 'src', 'scm', 'routes', 'delivery-orders-mfg.ts');
const AGENT = join(HERE, '..', 'src', 'services', 'agents', 'delivery-agent.ts');

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** The body of `patchDeliveryOrderStatusHandler`, comments removed. */
function statusHandlerBody(): string {
  const src = stripComments(readFileSync(ROUTE, 'utf8'));
  const start = src.indexOf('patchDeliveryOrderStatusHandler');
  expect(start, 'the status handler must still be findable').toBeGreaterThan(-1);
  /* The next top-level `export const` after it ends the handler. Anchored to
     the line start so a nested one cannot cut the window short. */
  const rest = src.slice(start);
  const end = rest.slice(1).search(/\nexport (const|async function|function) /);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe('the delivery-order status handler has no signature writer', () => {
  test('it does not read a signature off the request body', () => {
    expect(statusHandlerBody()).not.toMatch(/signatureData/);
  });

  test('it does not write scm.delivery_orders.signature_data', () => {
    expect(statusHandlerBody()).not.toMatch(/signature_data/);
  });

  test('the photo and the GPS quartet are KEPT — the owner named the signature only', () => {
    /* A removal that quietly took the rest of the proof-of-delivery chain with
       it would be a different change from the one that was asked for. */
    const body = statusHandlerBody();
    for (const kept of ['podKey', 'pod_r2_key', 'podLat', 'pod_lat', 'podLng', 'pod_lng', 'pod_located_at']) {
      expect(body, kept).toContain(kept);
    }
  });
});

describe('the Delivery Agent stops chasing a signature nobody can give', () => {
  test('POD_CHASE selects and filters on the photo alone', () => {
    /* `POD_CHASE` is the ONLY consumer of these columns in the system. Left as
       it was, it would go on asking whether a retired field is null — a question
       whose answer is now "always", for a reason that has nothing to do with the
       delivery. It chases the photo, which is still captured. */
    const src = stripComments(readFileSync(AGENT, 'utf8'));
    expect(src).not.toMatch(/signature_data/);
    expect(src).toContain('pod_r2_key');
  });
});
