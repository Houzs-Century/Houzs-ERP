import { describe, expect, test } from 'vitest';
import scanSoSrc from '../src/scm/routes/scan-so.ts?raw';
import soSrc from '../src/scm/routes/mfg-sales-orders.ts?raw';

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
    const job = scanSoSrc.slice(scanSoSrc.indexOf('await savedP'));
    const dup = job.indexOf('findDuplicateSo(svc, { imageSha256, excludeSampleId: sampleId');
    expect(dup).toBeGreaterThanOrEqual(0);
    expect(dup).toBeLessThan(job.indexOf('createDraftSalesOrder('));
  });
});

describe('SO create: the nine independent reads start together', () => {
  const core = between(soSrc, 'async function createSalesOrderCore', 'const lineProducts');
  const loaders = [
    'loadMaintenanceConfig(sb)', 'loadSpecialAddons(sb)', 'loadProductsAndModels(', 'loadSellingSofaCombos(sb, c)',
    'loadFabricTierAddonConfig(', 'loadModelFabricTierOverrides(sb)', 'loadCompartmentFabricTierOverrides(sb)',
    'validateSoDropdownFields(', 'loadProductsByCodes(',
  ];

  test('each is started with startEarly before the first of them is awaited', () => {
    const firstAwait = core.indexOf('await configP');
    for (const l of loaders) {
      const at = core.indexOf(`startEarly(${l}`);
      expect(at, l).toBeGreaterThanOrEqual(0);
      expect(at, l).toBeLessThan(firstAwait);
      expect(core, `${l} is awaited one by one again`).not.toContain(`await ${l}`);
    }
  });

  test('the early refusals are still checked in their old order', () => {
    const order = ['await configP', 'await pmP', 'if (pmErr)', 'await combosP', 'await dropdownErrP', 'if (dropdownErr)', 'await productRowByCodeP'];
    const at = order.map((s) => core.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});
