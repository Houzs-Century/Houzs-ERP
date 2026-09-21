// stock-bucket-accounts — the nine child accounts the three closing stocks book
// on (owner 2026-09-21: closing stock - customer / display / service; chart of
// account 那边也需要分出来): under STOCK (330-0000), STOCKS AT THE BEGINNING OF
// YEAR (600-0000) and STOCKS AT THE END OF YEAR (620-0000), one child per
// bucket, -0001 customer, -0002 display, -0003 service — the parent's type,
// section and special marker, the parent's name with the bucket after it.
// Pure: no database, no clock. The seeding script and its test both call it.

export const BUCKET_SUFFIX = Object.freeze({ customer: '0001', display: '0002', service: '0003' });
export const BUCKETS = Object.freeze(['customer', 'display', 'service']);

/** The three parents (AutoCount's own codes; acc/rules.ts DEFAULT_ROLE_CODES). */
export const STOCK_PARENTS = Object.freeze([
  { code: '330-0000', name: 'STOCK', type: 'ASSET', section: 'CURRENT ASSETS', special: 'SBS' },
  { code: '600-0000', name: 'STOCKS AT THE BEGINNING OF YEAR', type: 'EXPENSE', section: 'COST OF GOODS SOLD', special: 'SOS' },
  { code: '620-0000', name: 'STOCKS AT THE END OF YEAR', type: 'EXPENSE', section: 'COST OF GOODS SOLD', special: 'SCS' },
]);

/** The nine children, in code order. */
export function stockBucketAccounts() {
  return STOCK_PARENTS.flatMap((p) => BUCKETS.map((b) => ({
    code: `${p.code.slice(0, 4)}${BUCKET_SUFFIX[b]}`,
    name: `${p.name} - ${b.toUpperCase()}`,
    type: p.type,
    parentCode: p.code,
    section: p.section,
    special: p.special,
    bucket: b,
  })));
}

/**
 * What one company needs: the children it lacks, the ones it has, and any
 * parent it lacks (then nothing is planned for that parent — a chart without
 * STOCK gets no STOCK - CUSTOMER).
 * @param {Array<{code: string, parentCode?: string | null, active?: boolean}>} chart — the company's accounts
 */
export function planFor(chart) {
  const byCode = new Map(chart.map((a) => [String(a.code).trim(), a]));
  const parentsMissing = STOCK_PARENTS.filter((p) => !byCode.has(p.code)).map((p) => p.code);
  const missing = [];
  const present = [];
  for (const a of stockBucketAccounts()) {
    if (parentsMissing.includes(a.parentCode)) continue;
    const have = byCode.get(a.code);
    if (have) present.push({ ...a, active: have.active !== false, parentOk: (have.parentCode ?? null) === a.parentCode });
    else missing.push(a);
  }
  return { missing, present, parentsMissing };
}
