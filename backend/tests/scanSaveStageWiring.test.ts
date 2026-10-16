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
    'loadMaintenanceConfig(sb)', 'loadSpecialAddons(sb)', 'loadProductsAndModels(', 'loadFabricTierAddonConfig(',
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
