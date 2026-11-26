import { describe, expect, it } from 'vitest';
import type { RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { BILLABLE_JOB_TYPES, CATEGORY_LABEL, JOB_LABEL, RULE_LABEL } from '../../../vendor/scm/lib/rate-rule-taxonomy';
import { isDefaultJobs, jobsLabel, jobsOf, sharedJobs, surchargeSkipped, toggleJob } from './appliesTo';
import { EMPTY_FORM, readFacts, withJob } from './priceCheckFacts';
import { flatTypesOf } from './rateCardLayout';

let n = 0;
const rule = (over: Partial<RateRule>): RateRule => ({
  id: `r${++n}`, cardId: 'c', ruleType: 'OUTSTATION', tierPosition: null, bracketMin: null, bracketMax: null,
  zone: 'JOHOR', amountSen: 1000, params: null, sortOrder: 0, ...over,
});

describe('every job can be priced from a tab', () => {
  it('Setup & dismantle offers Setup and Dismantle; Service calls offers Supplier, Transfer item and the ASSR jobs', () => {
    expect(flatTypesOf('SITE_WORK').map((t) => RULE_LABEL[t])).toEqual(['Setup', 'Dismantle']);
    expect(flatTypesOf('SERVICE_CALL').map((t) => RULE_LABEL[t]).sort()).toEqual(
      ['ASSR - Inspection', 'ASSR - Pickup', 'ASSR - Service', 'Supplier', 'Transfer item'],
    );
    expect(CATEGORY_LABEL.SITE_WORK).toBe('Setup & dismantle');
  });
  it('names the jobs as Delivery Planning does', () => {
    expect(BILLABLE_JOB_TYPES.map((j) => JOB_LABEL[j])).toEqual([
      'Delivery order', 'Setup', 'Dismantle', 'Supplier', 'Transfer item', 'ASSR - Inspection', 'ASSR - Pickup', 'ASSR - Service',
    ]);
  });
});

describe('Applies to', () => {
  it('reads Delivery order when a rule names nothing', () => {
    expect(jobsOf(rule({}))).toEqual(['DELIVERY']);
    expect(jobsOf(rule({ appliesTo: ['SETUP', 'DELIVERY'] }))).toEqual(['DELIVERY', 'SETUP']);
    expect(jobsOf(rule({ params: { appliesTo: ['SERVICE'] } }))).toEqual(['SERVICE']);
    expect(isDefaultJobs(['DELIVERY'])).toBe(true);
    expect(isDefaultJobs(['DELIVERY', 'SETUP'])).toBe(false);
  });
  it('ticks keep DP order and the last one stays', () => {
    expect(toggleJob(['DELIVERY'], 'SERVICE')).toEqual(['DELIVERY', 'SERVICE']);
    expect(toggleJob(['SERVICE', 'DELIVERY'], 'SETUP')).toEqual(['DELIVERY', 'SETUP', 'SERVICE']);
    expect(toggleJob(['DELIVERY'], 'DELIVERY')).toEqual(['DELIVERY']);
    expect(jobsLabel(['DELIVERY', 'SETUP'])).toBe('Delivery order, Setup');
  });
  it('the card says one answer only when every surcharge agrees', () => {
    expect(sharedJobs([rule({}), rule({ zone: 'MELAKA', ruleType: 'OUTSTATION_TRIP' })])).toEqual(['DELIVERY']);
    expect(sharedJobs([rule({}), rule({ zone: 'MELAKA', appliesTo: ['SETUP'] })])).toBeNull();
    expect(sharedJobs([rule({ ruleType: 'SETUP', zone: null })])).toBeNull();
  });
  it('Price check notices a surcharge that does not apply to the job', () => {
    const rules = [rule({})];
    expect(surchargeSkipped(rules, 'johor', 'SETUP')).toBe(true);
    expect(surchargeSkipped(rules, 'JOHOR', 'DELIVERY')).toBe(false);
    expect(surchargeSkipped(rules, 'MELAKA', 'SETUP')).toBe(false);
    expect(surchargeSkipped([rule({ appliesTo: ['SETUP'] })], 'JOHOR', 'SETUP')).toBe(false);
  });
});

describe('Price check job', () => {
  const card = { basis: 'SET', aggregation: 'UNIT' } as const;
  const priced = new Set(['POSITIONAL_TIER', 'SETUP', 'SERVICE']);
  it('a delivery order sends the facts it always did', () => {
    expect(readFacts(EMPTY_FORM, card, priced)).toEqual({ ok: true, facts: { setCount: 1, setupCount: 0, serviceCount: 0, destinationZone: null } });
  });
  it('another job names itself, carries no sets and counts itself once', () => {
    const f = withJob({ ...EMPTY_FORM, town: 'JOHOR' }, 'SETUP', priced);
    expect(f).toMatchObject({ job: 'SETUP', count: '0', counts: { SETUP: '1' } });
    expect(readFacts(f, card, priced)).toEqual({
      ok: true, facts: { setCount: 0, setupCount: 1, serviceCount: 0, destinationZone: 'JOHOR', jobType: 'SETUP' },
    });
    expect(withJob(f, 'DELIVERY', priced)).toMatchObject({ job: 'DELIVERY', count: '1', counts: {} });
    expect(withJob(f, 'SERVICE', priced).counts).toEqual({ SERVICE: '1' });
    expect(withJob(EMPTY_FORM, 'TRANSFER', priced).counts).toEqual({});
  });
});
