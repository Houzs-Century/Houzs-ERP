/* docs/bugs/0652 — every write of a customer payment row must be followed by
   the booking hook. The panel path (lib/so-payment-row) always was; the two
   SO-create inserts (the POS split payments and the deposit) were not, so no
   deposit taken at order creation ever reached the books — 64 of the 78 rows
   2990 recorded after the hook landed. This pins the SHAPE of the source: each
   `.from('mfg_sales_order_payments').insert(` in the writers below is followed,
   within reach, by `postSoPayment(`. RED on the unfixed tree (two inserts, no
   hook), green after. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.resolve(here, '..', rel), 'utf8');

describe('every customer payment row insert is followed by the booking hook', () => {
  for (const file of ['src/scm/routes/mfg-sales-orders.ts', 'src/scm/lib/so-payment-row.ts']) {
    it(file, () => {
      const src = read(file);
      const re = /\.from\('mfg_sales_order_payments'\)\s*\.insert\(/g;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(src)) !== null) {
        count += 1;
        const window = src.slice(m.index, m.index + 12_000);
        expect(window.indexOf('postSoPayment('), `${file}: the payment insert at offset ${m.index} is not followed by postSoPayment(`).toBeGreaterThan(-1);
      }
      expect(count, `${file}: expected at least one payment insert`).toBeGreaterThan(0);
    });
  }
});
