// The staged lift names L2 AREAS, and the freeze middleware resolves a request
// path to one of them from a table that is a COPY of the scmAreaGuard mounts in
// scm/index.ts. A copy that drifts is the worst failure this feature has: a
// stale table makes a module silently un-liftable, or — far worse — resolves a
// path to the WRONG area, so lifting sales orders would open somebody else's
// router. So the copy is not trusted. This suite re-derives the mapping from
// index.ts itself and demands exact equality.
import { describe, it, expect } from 'vitest';
// ?raw so the assertion reads the real source, in any test runtime.
import scmIndexSource from '../src/scm/index.ts?raw';
import {
  SCM_AREAS,
  SCM_AREA_LABELS,
  SCM_AREA_MOUNTS,
  SCM_UNGUARDED_PREFIXES,
  areaForPath,
  areaLabel,
  prefixesForArea,
} from '../src/scm/lib/scm-areas';

/* Strip whole-line `//` comments so the doc example at the top of the L2 block
   ("scm.use('/<prefix>/*', scmAreaGuard('<area>'))") is not read as a mount.
   Block comments are NOT stripped: several mount paths legitimately contain the
   `/*` sequence (e.g. "/products/*"), and a naive block-comment strip eats the
   file. Requiring the captured area to start with `scm.` is what excludes the
   placeholder instead. */
const code = scmIndexSource
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n');

function mountsFromSource(): Array<[string, string]> {
  const re = /scm\.use\(\s*["']([^"']+)["']\s*,\s*scmAreaGuard\(\s*["'](scm\.[^"']+)["']/g;
  const out: Array<[string, string]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push([m[1], m[2]]);
  return out;
}

function routedPrefixesFromSource(): string[] {
  const re = /scm\.route\(\s*["']([^"']+)["']/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push(m[1]);
  return [...new Set(out)];
}

describe('the area table mirrors scm/index.ts', () => {
  it('finds the mounts at all (guards the regex, not the table)', () => {
    // If index.ts is ever reformatted so the regex stops matching, every other
    // assertion here would pass vacuously. Pin the order of magnitude.
    expect(mountsFromSource().length).toBeGreaterThan(60);
  });

  it('is EXACTLY the scmAreaGuard mounts, in order', () => {
    expect(SCM_AREA_MOUNTS.map(([p, a]) => [p, a])).toEqual(mountsFromSource());
  });

  it('lists every routed prefix that has no guard, and nothing else', () => {
    /* /write-freeze is the freeze's OWN status surface, not an SCM data router:
       it is GET-only (so the freeze never reaches it) and gates itself on the
       bypass perms. Listing it among the never-liftable data routers would tell
       the operator something false. It is the only such exclusion. */
    const NOT_A_DATA_ROUTER = new Set(['/write-freeze']);
    const guarded = new Set(mountsFromSource().map(([p]) => p.replace(/\/\*$/, '')));
    const unguarded = routedPrefixesFromSource()
      .filter((r) => !guarded.has(r) && !NOT_A_DATA_ROUTER.has(r));
    expect([...SCM_UNGUARDED_PREFIXES].sort()).toEqual(unguarded.sort());
  });

  it('gives every area a plain-English label', () => {
    for (const area of SCM_AREAS) expect(SCM_AREA_LABELS[area], area).toBeTruthy();
  });

  it('has no label for an area that does not exist', () => {
    for (const key of Object.keys(SCM_AREA_LABELS)) expect(SCM_AREAS.has(key), key).toBe(true);
  });
});

describe('the areas the owner named resolve to the routers he means', () => {
  // A lift that opens the wrong router is worse than no lift, so each of the
  // six areas in the go-live sequence is pinned to its ACTUAL entry point.
  const cases: Array<[string, string, string]> = [
    ['sales orders', '/api/scm/mfg-sales-orders', 'scm.sales.orders'],
    ['purchase orders', '/api/scm/mfg-purchase-orders', 'scm.procurement.po'],
    ['delivery orders', '/api/scm/delivery-orders-mfg', 'scm.sales.delivery'],
    ['goods receipts', '/api/scm/grns', 'scm.procurement.grn'],
    ['purchase invoices', '/api/scm/purchase-invoices', 'scm.procurement.pi'],
    ['sales invoices', '/api/scm/sales-invoices', 'scm.sales.invoices'],
  ];
  for (const [name, path, area] of cases) {
    it(`${name}: ${path} -> ${area}`, () => {
      expect(areaForPath(path)).toBe(area);
      expect(areaForPath(`${path}/SO-2608-001`)).toBe(area);
    });
  }

  it('sales orders is SEVEN routers, not just the SO API', () => {
    /* The owner asks for "sales orders"; the key he must type also carries
       amendments, quotes, the PWP codes and the three scan/slip intake routes.
       That is what the lift will actually open, and the runbook says so. */
    expect(prefixesForArea('scm.sales.orders').sort()).toEqual([
      '/mfg-sales-orders/*',
      '/pwp-codes/*',
      '/quotes/*',
      '/scan-payment/*',
      '/scan-so/*',
      '/slips/*',
      '/so-amendments/*',
    ]);
  });

  it('purchase orders also carries PO amendments', () => {
    expect(prefixesForArea('scm.procurement.po').sort()).toEqual([
      '/mfg-purchase-orders/*',
      '/po-amendments/*',
    ]);
  });
});

describe('areaForPath', () => {
  it('accepts the path with or without the /api/scm mount, and a query string', () => {
    expect(areaForPath('/api/scm/grns')).toBe('scm.procurement.grn');
    expect(areaForPath('/grns')).toBe('scm.procurement.grn');
    expect(areaForPath('/api/scm/grns/12?expand=lines')).toBe('scm.procurement.grn');
    expect(areaForPath('/api/scm/grns/')).toBe('scm.procurement.grn');
  });

  it('picks the MOST SPECIFIC mount, mirroring Hono', () => {
    // scm/index.ts registers the exact /inventory/adjustments guard before the
    // broad /inventory/* one precisely so adjustments is its own permission.
    expect(areaForPath('/api/scm/inventory/adjustments')).toBe('scm.warehouse.adjustments');
    expect(areaForPath('/api/scm/inventory/buckets')).toBe('scm.warehouse.inventory');
    expect(areaForPath('/api/scm/maintenance-config/sofa-compartments/4'))
      .toBe('scm.procurement.products');
  });

  it('does not let a prefix swallow a longer sibling name', () => {
    // '/mrp/*' must not claim '/mrp-lead-times' by string prefix alone; both
    // happen to be the same area, so assert the mechanism on a pair that differs.
    expect(areaForPath('/api/scm/delivery-returns')).toBe('scm.sales.returns');
    expect(areaForPath('/api/scm/delivery-orders-mfg')).toBe('scm.sales.delivery');
    expect(areaForPath('/api/scm/delivery-zones')).toBe('scm.transportation.drivers');
  });

  it('returns null for a router behind no guard — the never-liftable set', () => {
    for (const prefix of SCM_UNGUARDED_PREFIXES) {
      expect(areaForPath(`/api/scm${prefix}`), prefix).toBeNull();
      expect(areaForPath(`/api/scm${prefix}/anything`), prefix).toBeNull();
    }
  });

  it('returns null for a path nobody mounted', () => {
    expect(areaForPath('/api/scm/not-a-router')).toBeNull();
    expect(areaForPath('/api/scm')).toBeNull();
  });
});

describe('areaLabel', () => {
  it('never renders undefined into a sentence', () => {
    expect(areaLabel('scm.sales.orders')).toBe('sales orders');
    expect(areaLabel('scm.made.up')).toBe('scm.made.up');
  });
});

describe('GET /api/scm/write-freeze — the operator view', () => {
  // Only the gate is exercised here: the success path reads app_config, and the
  // refusal path must be provably reachable without one. The 403 is the half
  // that decides who can see the freeze's shape, so it is the half worth pinning.
  const mount = async (caller: unknown) => {
    const { Hono } = await import('hono');
    const { writeFreezeStatus } = await import('../src/scm/routes/write-freeze-status');
    const app = new Hono();
    app.use('/api/scm/*', async (c, next) => {
      if (caller) c.set('user' as never, caller as never);
      await next();
    });
    app.route('/api/scm/write-freeze', writeFreezeStatus as never);
    return app;
  };

  it('refuses a caller who could not act on the answer', async () => {
    for (const perms of [['scm.access'], ['scm.sales.write'], []]) {
      const app = await mount({ permissions: perms });
      const res = await app.request('/api/scm/write-freeze');
      expect(res.status, JSON.stringify(perms)).toBe(403);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await (await mount(undefined)).request('/api/scm/write-freeze');
    expect(res.status).toBe(403);
  });

  it('does not refuse the bypass cohort at the gate', async () => {
    // Past the gate it reads app_config, which this bare app cannot provide —
    // so anything other than 403 means the gate let them through, which is the
    // assertion. The read itself is covered by the middleware suite.
    for (const perms of [['*'], ['scm.admin']]) {
      const app = await mount({ permissions: perms });
      const res = await app.request('/api/scm/write-freeze');
      expect(res.status, JSON.stringify(perms)).not.toBe(403);
    }
  });
});
