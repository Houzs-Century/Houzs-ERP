import { describe, expect, it } from 'vitest';
import {
  RATE_RULE_TYPES, RULE_CATEGORY, RULE_LABEL, RULE_JOB_TYPE,
  RATE_RULE_CATEGORIES, rulesByCategory, pricedJobTypes, DISPATCHABLE_JOB_TYPES,
  type RateRuleType,
} from './rate-rule-taxonomy';
/**
 * Owner, 2026-08-02: "我的 job type 有什么类型，它就应该有什么类型" and "job type
 * 的名字也要跟我们的 DP 那一边是一样的".
 *
 * The drift these guard against is silent: someone adds a dispatchable job
 * type, nobody adds a way to charge for it, and the fleet does the work for
 * free until an accountant notices. That is exactly how SUPPLIER_PICKUP —
 * dispatchable since mig 0128, one of only three types the New-DP-Order drawer
 * offers — went unbillable until 0243.
 */

/* These run in workerd (vitest-pool-workers), which has no filesystem — so they
   check the CODE's view of the world. The other half of the guarantee, that this
   view still matches the migrations, is `npm run audit:job-types`, wired into
   the backend-typecheck job beside audit:routes. Neither half is sufficient
   alone: a pure test over a stale constant proves nothing. */

describe('the rate card prices the jobs we dispatch', () => {
  it('every dispatchable job type can be priced by some rule', () => {
    const priced = new Set(pricedJobTypes());
    const unbillable = DISPATCHABLE_JOB_TYPES.filter((j) => !priced.has(j));
    expect(unbillable).toEqual([]);
  });

  it('the names are the DP names, not a parallel vocabulary', () => {
    const dispatchable = new Set<string>(DISPATCHABLE_JOB_TYPES);
    for (const [rule, job] of Object.entries(RULE_JOB_TYPE)) {
      if (job === null) continue;
      expect(dispatchable.has(job), `${rule} claims job type ${job}, which is not a dispatchable job`).toBe(true);
    }
  });
});

describe('the taxonomy is complete', () => {
  it('every rule type has a category, a label and a job-type verdict', () => {
    for (const t of RATE_RULE_TYPES) {
      expect(RULE_CATEGORY[t], `${t} has no category`).toBeTruthy();
      expect(RULE_LABEL[t], `${t} has no label`).toBeTruthy();
      expect(t in RULE_JOB_TYPE, `${t} has no job-type verdict — null is a verdict, absent is an omission`).toBe(true);
    }
  });

  it('the maps carry nothing that is not a rule type', () => {
    const known = new Set<string>(RATE_RULE_TYPES);
    for (const map of [RULE_CATEGORY, RULE_LABEL, RULE_JOB_TYPE]) {
      for (const k of Object.keys(map)) expect(known.has(k), `${k} is not a rule type`).toBe(true);
    }
  });

  it('grouping loses nothing and duplicates nothing', () => {
    const flat = rulesByCategory().flatMap((g) => g.types);
    expect(flat.sort()).toEqual([...RATE_RULE_TYPES].sort());
    expect(new Set(flat).size).toBe(RATE_RULE_TYPES.length);
  });

  it('every category is populated — an empty group is a heading with nothing under it', () => {
    for (const { category, types } of rulesByCategory()) {
      expect(types.length, `${category} is empty`).toBeGreaterThan(0);
    }
    expect(rulesByCategory().map((g) => g.category)).toEqual([...RATE_RULE_CATEGORIES]);
  });
});

describe('the add-ons are absent by decision, not by oversight', () => {
  it('DISPOSE and TRANSFER are deliberately not job types', () => {
    // They ride whatever job carried them. Recorded so the next reader does not
    // "fix" it by inventing a DISPOSE trip stop.
    expect(RULE_JOB_TYPE.DISPOSE).toBeNull();
    expect(RULE_JOB_TYPE.TRANSFER).toBeNull();
  });

  it('the delivery group prices DELIVERY through three cooperating rules', () => {
    const delivery = (['POSITIONAL_TIER', 'OVERAGE', 'SOFA_BRACKET'] as RateRuleType[]);
    for (const t of delivery) expect(RULE_JOB_TYPE[t]).toBe('DELIVERY');
    expect(RULE_CATEGORY.DISPOSE).toBe('DELIVERY'); // grouped with it, but not a job
  });

  it('outstation is a surcharge on any job, never a job of its own', () => {
    expect(RULE_JOB_TYPE.OUTSTATION).toBeNull();
    expect(RULE_JOB_TYPE.OUTSTATION_TRIP).toBeNull();
  });
});
