// Teaching a supplier's printed codes (HC-0120): what the scan card offers, and
// that a taught code then matches by code on the next delivery order.
import { describe, expect, test } from 'vitest';
import { buildTeachOptions } from './grn-scan-codes';
import { matchGrnScanToPoLines, type OpenPoLine, type ScannedGrnLine, type SupplierSkuBinding } from './grn-scan-match';

const line = (n: number, itemCode: string, materialName: string, over: Partial<OpenPoLine> = {}): OpenPoLine => ({
  poItemId: `pi-${n}`, poId: 'po-84', poNumber: 'HC-PO-2610-084', supplierId: 'diglant', itemCode, materialName,
  supplierSku: null, remaining: 1, locationCode: null, ...over,
});
const scan = (itemCode: string | null, description: string, qty: number): ScannedGrnLine => ({ itemCode, barcode: null, description, qty });

const open: OpenPoLine[] = [
  line(1, 'AKEMI BULWARK MATT (K)', 'AKEMI BULWARK MATTRESS (183X190X36CM)'),
  line(2, 'HAPPI SLEEP SOLITUDE MATT (Q)', 'HAPPI SLEEP SOLITUDE MATTRESS (152X190CM)'),
  line(3, 'HAPPI SLEEP SOLITUDE MATT (Q)', 'HAPPI SLEEP SOLITUDE MATTRESS (152X190CM)'),
  line(4, 'AKEMI ULTIMATE MATT (K)', 'AKEMI ULTIMATE MATTRESS (183X190X36CM)'),
  line(9, 'OTHER SUPPLIER ITEM', 'X', { supplierId: 'someone-else', poNumber: 'HC-PO-2610-001' }),
];
const delivery = [
  scan('T1MAMWA0MK', 'Mattress Akemi Medi+Health Bulwark K King', 1),
  scan('T1MPSIA0MQ', 'Mattress Happi Sleep Solitude Q Queen', 1),
  scan('T1MPSIA0MQ', 'Penang Akemi HomeDec Mattress Happi Sleep Solitude Q Queen', 1),
  scan('AFKPAK25A23J29W', 'GWP Pillow Acc', 4),
  scan(null, 'Delivery charge', 1),
];

describe('buildTeachOptions', () => {
  const match = matchGrnScanToPoLines('HC-PO-2610-084', delivery, open, [], 'diglant');
  const options = buildTeachOptions(delivery, match, open, 'diglant');

  test('one row per printed code, name matches pre-filled, codeless rows left out', () => {
    expect(options.rows).toEqual([
      { printedCode: 'T1MAMWA0MK', description: 'Mattress Akemi Medi+Health Bulwark K King', qty: 1, status: 'name_matched', suggestedPoItemId: 'pi-1' },
      { printedCode: 'T1MPSIA0MQ', description: 'Mattress Happi Sleep Solitude Q Queen', qty: 2, status: 'name_matched', suggestedPoItemId: 'pi-2' },
      { printedCode: 'AFKPAK25A23J29W', description: 'GWP Pillow Acc', qty: 4, status: 'not_matched', suggestedPoItemId: null },
    ]);
  });

  test('offers only the named PO of this supplier', () => {
    expect(options.poLines.map((l) => l.poItemId)).toEqual(['pi-1', 'pi-2', 'pi-3', 'pi-4']);
  });

  test('with no PO named, offers every open line of the supplier and none of another', () => {
    const m = matchGrnScanToPoLines(null, delivery, open, [], 'diglant');
    expect(buildTeachOptions(delivery, m, open, 'diglant').poLines.map((l) => l.poItemId)).toEqual(['pi-1', 'pi-2', 'pi-3', 'pi-4']);
  });
});

describe('a taught code on the next delivery order', () => {
  // What saveScanCodes stores and loadScanCodes hands back as bindings.
  const taught: SupplierSkuBinding[] = [
    { supplierSku: 'T1MAMWA0MK', acItemCode: null, itemCode: 'AKEMI BULWARK MATT (K)' },
    { supplierSku: 'T1MPSIA0MQ', acItemCode: null, itemCode: 'HAPPI SLEEP SOLITUDE MATT (Q)' },
  ];

  test('matches by code, sharing a code across identical PO lines, with no name check', () => {
    const next = [scan('T1MAMWA0MK', 'Seremban roadshow stock', 1), scan('T1MPSIA0MQ', 'Sabah fair stock', 2)];
    const res = matchGrnScanToPoLines('HC-PO-2610-084', next, open, taught, 'diglant');
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 1 }, { poItemId: 'pi-2', qty: 1 }, { poItemId: 'pi-3', qty: 1 }]);
    expect(res.nameMatches).toEqual([]);
    expect(res.unmatched).toEqual([]);
  });

  test('identical lines on two different POs are still not guessed between', () => {
    const twoPos = [...open, line(5, 'AKEMI BULWARK MATT (K)', 'AKEMI BULWARK MATTRESS (183X190X36CM)', { poNumber: 'HC-PO-2610-099' })];
    const res = matchGrnScanToPoLines(null, [scan('T1MAMWA0MK', '', 1)], twoPos, taught, 'diglant');
    expect(res.picks).toEqual([]);
    expect(res.unmatched.map((u) => u.reason)).toEqual(['ambiguous']);
  });
});
