import { describe, expect, test } from 'vitest';
import scanSoSrc from '../src/scm/routes/scan-so.ts?raw';
import soSrc from '../src/scm/routes/mfg-sales-orders.ts?raw';
import payRowSrc from '../src/scm/lib/so-payment-row.ts?raw';

// HC-0006 speed: the SO scan job's save stage now overlaps independent steps.
// There is no harness that runs runScanJob end to end (see scanDocumentTypeWiring),
// so this pins the two things a refactor could silently break.

const between = (hay: string, startAnchor: string, endAnchor: string): string => {
  const start = hay.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = hay.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `anchor not found after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return hay.slice(start, end);
};

describe('scan job: sample save runs alongside postProcessSlip', () => {
  const block = between(scanSoSrc, 'const parsed = call.parsed;', "timer.mark('save', 'sample')");

  test('the learning sample and photo pick get the raw model read, copied before postProcessSlip', () => {
    expect(block.indexOf('structuredClone(parsed)')).toBeLessThan(block.indexOf('postProcessSlip('));
    expect(block).toContain('parsed: rawParsed');
    expect(block).toMatch(/storeScanImages\([^)]*rawParsed\)/);
  });

  test('the duplicate check still waits for the sample id (it excludes its own sample)', () => {
    // From the job's sample await on: the dup check comes before the draft create.
    const job = scanSoSrc.slice(scanSoSrc.indexOf("timer.mark('save', 'sample')"));
    const dup = job.indexOf('findDuplicateSo(svc, { imageSha256, excludeSampleId: sampleId');
    expect(dup).toBeGreaterThanOrEqual(0);
    expect(dup).toBeLessThan(job.indexOf('createDraftSalesOrder('));
  });
});

describe('SO create: the eight independent reads run together', () => {
  const core = between(soSrc, 'async function createSalesOrderCore', 'const lineProducts');
  const group = between(core, 'await Promise.all([', ']);');
  const loaders = [
    'loadMaintenanceConfig(sb, companyId)', 'loadSpecialAddons(sb, companyId)', 'loadProductsAndModels(', 'loadFabricTierAddonConfig(',
    'loadModelFabricTierOverrides(sb)', 'loadCompartmentFabricTierOverrides(sb)', 'validateSoDropdownFields(', 'loadProductsByCodes(',
  ];

  test('each is in the one Promise.all, and none is awaited on its own again', () => {
    for (const l of loaders) {
      expect(group, l).toContain(l);
      expect(core, `${l} is awaited one by one again`).not.toContain(`await ${l}`);
    }
  });

  test('the sofa-combo read (it can throw) stays out of the group, after the allowed-options refusal', () => {
    expect(group).not.toContain('loadSellingSofaCombos');
    const at = ['if (pmErr)', 'checkAllowedOptions(', 'await loadSellingSofaCombos(sb, c)', 'if (dropdownErr)'].map((x) => core.indexOf(x));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });
});

// HC-0006: why the SO scan's create took ~13 s and its tail ~6 s.
describe('SO create: no global allocation re-walk for a DRAFT', () => {
  const core = between(soSrc, 'async function createSalesOrderCore', 'mfgSalesOrders.post(');

  test('the post-create re-walk is gated on a live (non-draft) create', () => {
    const gate = "if ((body as { asDraft?: unknown }).asDraft !== true) {";
    const walk = core.indexOf('await recomputeSoStockAllocation(sb)');
    expect(walk).toBeGreaterThanOrEqual(0);
    // The nearest gate above the walk is the draft gate, and the walk is the only await in it.
    const opened = core.lastIndexOf(gate, walk);
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(core.slice(opened + gate.length, walk).trim()).toBe('try {');
  });
});

describe('payment row: the best-effort hooks run together, the invoice re-roll after the booking', () => {
  const fn = between(payRowSrc, 'export async function recordSoPaymentRow', 'return { payment: data as Record<string, unknown>, errorMessage: null };');
  const group = between(fn, 'await Promise.all([', ']);');

  test('link, audit, AutoCount enqueue and booking are in one Promise.all, none awaited alone', () => {
    for (const h of ['linkPaymentScan(', 'recordSoAudit(', 'enqueueSoPaymentEdit(', 'bookSoPaymentBestEffort(']) {
      expect(group, h).toContain(h);
      expect(fn, `${h} is awaited on its own again`).not.toContain(`await ${h}`);
    }
  });

  test('the invoice re-roll is chained after the booking, not run beside it', () => {
    expect(group).toMatch(/bookSoPaymentBestEffort\([^)]*\)[\s\S]*?\.then\(\(\) => recomputeSiPaidForOrder\(/);
    expect(fn).not.toContain('await recomputeSiPaidForOrder(');
  });
});

describe('scan job: every create attempt is counted on the timer', () => {
  test('createDraftSalesOrder is called only through the counting replay', () => {
    const job = scanSoSrc.slice(scanSoSrc.indexOf("timer.mark('save', 'dup')"), scanSoSrc.indexOf("timer.mark('save', 'create')"));
    expect(job.split('createDraftSalesOrder(').length - 1).toBe(1);
    expect(between(job, 'const replay = ', 'createDraftSalesOrder(')).toContain('timer.createAttempt()');
  });
});
