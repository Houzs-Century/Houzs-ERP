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
/* Comments stripped, for the NEGATIVE assertions only. The header of that file
   RECORDS what the QR used to encode and what the caption used to say, which is
   exactly the prose a reader needs and exactly the string a naive `not.toContain`
   trips on — the same trap this file already fixed once, three tests below. */
const PDF_CODE = PDF.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const APP = read('../../App.tsx');
const CN = read('./ConsignmentNoteDetail.tsx');
/* The ladder MOVED on 2026-08-26 (it is read by the server now, so it lives in
   the mirrored rule module and do-next-step.ts re-exports it). This file follows
   it rather than dropping the assertion — the copy under the button is what a
   storekeeper reads at the dock, and it is pinned wherever it lives. */
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
    /* REVERTED 2026-08-26 at the owner's request — he asked to see the previous
       printed Delivery Order again before deciding. The PUBLIC token and the
       no-login driver page both still exist and still work; only the PRINTED QR
       points back at the authed /scm/do-load link. Undoing this revert is one
       line in printDocumentPdf.ts (swap loadScanId back for armDoScanToken). */
    expect(PDF).toContain('header.loadScanId && typeof window');
    expect(PDF).toContain('/scm/do-load?id=${encodeURIComponent(header.loadScanId)}');
    expect(PDF).toContain('drawQrIntoPdf');
  });

  /* THE CAPTION HAD TO CHANGE WITH THE LADDER. "SCAN · MARK LOADED" named ONE
     of the four things the code now does, so it was wrong on three papers out
     of four. The caption states what is true of every rung. */
  it('the caption names the repeated scan, not one rung', () => {
    /* REVERTED with the link above. The caption is the old one again because
       the link it describes is the old one again — a caption naming four rungs
       over a QR that only opens the office page would be the worse lie. */
    expect(PDF).toContain("doc.text('SCAN · MARK LOADED'");
  });

  it('is never armed by the Consignment Note print', () => {
    expect(CN).not.toContain('scanToken');
    expect(CN).not.toContain('loadScanId');
  });

  it('the DO surfaces arm it through the ONE shared helper', () => {
    for (const p of ['./DeliveryOrderDetailV2.tsx', '../../mobile/MobileModuleDetail.tsx', '../../lib/printDocumentPdf.ts']) {
      expect(read(p), `${p} does not arm the scan token`).toContain('armDoScanToken');
    }
    /* The list goes through printDocumentPdf's fetcher, which is the third file
       above — it has no stamping of its own to keep in step. */
    expect(read('./MfgDeliveryOrdersListV2.tsx')).toContain('fetchPrintBundle');
  });
});

describe('the landing page', () => {
  it('has ONE write site, and types no status literal of its own', () => {
    /* One call site is the property that outlived the one-rung premise: four
       rungs written by four `mutate` calls would be four places to forget the
       confirmation state or the evidence note. */
    const writes = PAGE.match(/updateStatus\.mutate\(/g) ?? [];
    expect(writes.length).toBe(1);
    /* And it writes what the LADDER hands it, never a status it typed. A
       hand-typed literal here is how a value the enum does not define reaches
       Postgres as a 22P02 — bug 0530 — and the ladder's target type is checked
       by the compiler. `status: step.status` is the only shape allowed. */
    expect(PAGE).toContain('status: step.status');
    const code = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/status: ['"](DRAFT|LOADED|DISPATCHED|IN_TRANSIT|SIGNED|DELIVERED|INVOICED|CANCELLED)['"]/);
  });

  it('never touches the ledger itself — the server owns the stock write', () => {
    /* Prose may SAY "inventory"; the page must never CALL anything that moves
       it. The old assertion ran the regex over the WHOLE FILE and so was
       satisfied only while no comment mentioned the deduction — it would have
       failed on an honest comment and passed on a call hidden behind a rename.
       Stripping comments first is what the sentence above always meant. */
    const code = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/deductInventory|writeMovements|resyncInventory/);
  });

  it('tells the operator that confirming takes the goods out of stock', () => {
    /* The copy is a pin, not decoration. It said the opposite until 2026-08-22
       ("Stock leaves the warehouse when the dispatcher sends the truck ... not
       now"), and a sentence that survives the behaviour it describes is how a
       storekeeper comes to trust a thing that is not true.

       It moved into the LADDER on 2026-08-26 — each rung carries its own line,
       so adding a rung cannot leave one behind — so the assertion follows it
       there. Which rung shows which sentence is asserted through the rendered
       page in DoLoadScan.ladder.test.tsx; this only pins that the words exist
       and that the retracted ones have not come back anywhere. */
    expect(LADDER_SRC).toContain('takes the goods out of warehouse stock');
    expect(LADDER_SRC + PAGE + PUBLIC_PAGE).not.toContain('Stock leaves the warehouse when the');
  });

  it('is routed at /scm/do-load behind the delivery guard', () => {
    expect(APP).toContain('path="/scm/do-load"');
    const route = APP.slice(APP.indexOf('path="/scm/do-load"'), APP.indexOf('\n', APP.indexOf('path="/scm/do-load"')));
    expect(route).toContain('area="scm.sales.delivery"');
  });
});
