// The "scan to mark loaded" wiring — QR on the DO print, landing page, route.
//
// 2026-08-21, owner: the warehouse confirms loading by scanning the paper that
// travels with the goods. The QR is armed by an EXPLICIT `loadScanId` (never a
// generic id) because the Consignment Note print reuses the DO renderer and a
// CN must never grow a control that flips a DELIVERY ORDER's status. Loading
// moves NO stock — the OUT fires on DISPATCHED — and the landing page's only
// write is the ordinary status PATCH to LOADED.
//
// Structural pins; the page itself needs a session + live API.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const PAGE = read('./DoLoadScan.tsx');
const PDF = read('../../vendor/scm/lib/delivery-order-pdf.ts');
const APP = read('../../App.tsx');
const CN = read('./ConsignmentNoteDetail.tsx');

describe('the DO print QR', () => {
  it('is gated on the explicit loadScanId, and encodes the /scm/do-load link', () => {
    expect(PDF).toContain('header.loadScanId && typeof window');
    expect(PDF).toContain('/scm/do-load?id=');
    expect(PDF).toContain('drawQrIntoPdf');
  });

  it('is never armed by the Consignment Note print', () => {
    expect(CN).not.toContain('loadScanId');
  });

  it('the three DO surfaces arm it', () => {
    for (const p of ['./DeliveryOrderDetailV2.tsx', './MfgDeliveryOrdersListV2.tsx', '../../mobile/MobileModuleDetail.tsx']) {
      expect(read(p), `${p} does not arm loadScanId`).toContain('loadScanId');
    }
  });
});

describe('the landing page', () => {
  it('writes exactly one status, LOADED, through the ordinary status hook', () => {
    expect(PAGE).toContain("status: 'LOADED'");
    // No other status literal is ever written from this page.
    const writes = PAGE.match(/updateStatus\.mutate\(/g) ?? [];
    expect(writes.length).toBe(1);
  });

  it('moves no stock and says so to the operator', () => {
    // Prose may SAY "inventory"; the page must never CALL anything that moves it.
    expect(PAGE).not.toMatch(/deductInventory|writeMovements|resyncInventory/);
    expect(PAGE).toContain('Stock leaves the warehouse when the');
  });

  it('is routed at /scm/do-load behind the delivery guard', () => {
    expect(APP).toContain('path="/scm/do-load"');
    const route = APP.slice(APP.indexOf('path="/scm/do-load"'), APP.indexOf('\n', APP.indexOf('path="/scm/do-load"')));
    expect(route).toContain('area="scm.sales.delivery"');
  });
});
