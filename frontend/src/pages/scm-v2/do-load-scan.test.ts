// The "scan to mark loaded" wiring — QR on the DO print, landing page, route.
//
// 2026-08-21, owner: the warehouse confirms loading by scanning the paper that
// travels with the goods. The QR is armed by an EXPLICIT `loadScanId` (never a
// generic id) because the Consignment Note print reuses the DO renderer and a
// CN must never grow a control that flips a DELIVERY ORDER's status. The landing
// page's only write is the ordinary status PATCH to LOADED.
//
// SCANNING NOW MOVES STOCK, SINCE 2026-08-22. This file used to assert
// "loading moves NO stock — the OUT fires on DISPATCHED", and that premise is
// gone: the owner put the inventory OUT on the confirm step, LOADED joined
// DO_SHIPPED_STATES, and the PATCH this page sends is what deducts. What is
// still true, and is the property worth pinning, is that the PAGE does not move
// stock ITSELF — it writes one status and the server owns the ledger. The
// operator-facing sentence is pinned too, because the person reading it is
// standing at the dock deciding whether to press the button.
//
// AND THE PAGE HAS THREE MORE RUNGS SINCE 2026-08-26. The owner's three scans —
// storekeeper loads, driver departs, driver delivers — mean the page no longer
// writes one hard-coded status. Two assertions here were about the OLD premise
// and are rewritten below rather than deleted, because the properties underneath
// them survive the change: ONE call site, and NO status literal typed on the
// page. The ladder and its copy moved to vendor/scm/lib/do-next-step.ts and are
// pinned by DoLoadScan.ladder.test.tsx, which mounts the page and presses the
// button instead of reading its source.
//
// Structural pins; the page itself needs a session + live API.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const PAGE = read('./DoLoadScan.tsx');
const PDF = read('../../vendor/scm/lib/delivery-order-pdf.ts');
const PDF_CODE = PDF.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const APP = read('../../App.tsx');
const CN = read('./ConsignmentNoteDetail.tsx');
const LADDER_SRC = read('../../vendor/shared/do-scan-ladder.ts');
const PUBLIC_PAGE = read('../PublicDoScan.tsx');

describe('the DO print QR', () => {
  /* IT POINTS AT THE PUBLIC PAGE SINCE 2026-08-26. It encoded
     /scm/do-load?id=<uuid> until then, which only a signed-in office user could
     open — useless to the driver the code is printed for. The owner chose the
     no-login scan (「就跟hookka一样」), so the QR carries a 64-hex token and the
     link is /d/<token>. `loadScanId` is gone with it: it was not an id any more
     and the code had stopped being about "load". */
  it('is gated on the explicit scanToken, and encodes the PUBLIC /d/ link', () => {
    expect(PDF).toContain('header.scanToken && typeof window');
    expect(PDF).toContain('/d/${encodeURIComponent(header.scanToken)}');
    expect(PDF).toContain('drawQrIntoPdf');
    expect(PDF_CODE, 'the authed link must not still be printed anywhere').not.toContain('/scm/do-load?id=');
  });

  it('the caption names the repeated scan, not one rung', () => {
    expect(PDF).toContain("doc.text('SCAN AT EACH STEP'");
    expect(PDF_CODE).not.toContain('MARK LOADED');
  });

  it('is never armed by the Consignment Note print', () => {
    expect(CN).not.toContain('scanToken');
    expect(CN).not.toContain('loadScanId');
  });

  it('the DO surfaces arm it through the ONE shared helper', () => {
    for (const p of ['./DeliveryOrderDetailV2.tsx', '../../mobile/MobileModuleDetail.tsx', '../../lib/printDocumentPdf.ts']) {
      expect(read(p), `${p} does not arm the scan token`).toContain('armDoScanToken');
    }
    expect(read('./MfgDeliveryOrdersListV2.tsx')).toContain('fetchPrintBundle');
  });
});

describe('the landing page', () => {
  it('has ONE write site, and types no status literal of its own', () => {
    const writes = PAGE.match(/updateStatus\.mutate\(/g) ?? [];
    expect(writes.length).toBe(1);
    expect(PAGE).toContain('status: step.status');
    const code = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/status: ['"](DRAFT|LOADED|DISPATCHED|IN_TRANSIT|SIGNED|DELIVERED|INVOICED|CANCELLED)['"]/);
  });

  it('never touches the ledger itself — the server owns the stock write', () => {
    const code = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/deductInventory|writeMovements|resyncInventory/);
  });

  it('tells the operator that confirming takes the goods out of stock', () => {
    expect(LADDER_SRC).toContain('takes the goods out of warehouse stock');
    expect(LADDER_SRC + PAGE + PUBLIC_PAGE).not.toContain('Stock leaves the warehouse when the');
  });

  it('is routed at /scm/do-load behind the delivery guard', () => {
    expect(APP).toContain('path="/scm/do-load"');
    const route = APP.slice(APP.indexOf('path="/scm/do-load"'), APP.indexOf('\n', APP.indexOf('path="/scm/do-load"')));
    expect(route).toContain('area="scm.sales.delivery"');
  });
});
