// notifySaveProblems — one decision, three surfaces, and the half that is NOT
// shared.
//
// The controls here guard the thing the extraction could have broken: each
// surface's own fallback. Collapsing those would have taken the inline banner
// off the SO Detail page and replaced the mobile wizard's wording, and neither
// would have failed a typecheck.
import { describe, expect, test } from 'vitest';
import { notifySaveProblems, saveProblemsTitle } from './SaveProblemsList';

const spy = () => {
  const popups: string[] = [];
  const others: string[] = [];
  return {
    popups,
    others,
    notify: async (o: { title: string }) => { popups.push(o.title); },
    onOther: (m: string) => { others.push(m); },
  };
};

/** A 422 body in the aggregated `validation_failed` shape the gates return. */
const gateRefusal = (n: number) => ({
  body: JSON.stringify({
    error: 'validation_failed',
    problems: Array.from({ length: n }, (_, i) => ({
      code: 'salesperson_required', message: `reason ${i + 1}`,
    })),
  }),
});

describe('an aggregated gate refusal', () => {
  test('opens the popup, titled by the COUNT, and never the fallback', async () => {
    const s = spy();
    await notifySaveProblems(s.notify, gateRefusal(3), s.onOther);
    expect(s.popups).toEqual([saveProblemsTitle(3)]);
    expect(s.others).toEqual([]);
  });

  test('one reason and several read the same way — the count is the only change', async () => {
    const one = spy(); await notifySaveProblems(one.notify, gateRefusal(1), one.onOther);
    const two = spy(); await notifySaveProblems(two.notify, gateRefusal(2), two.onOther);
    expect(one.popups[0]).toBe(saveProblemsTitle(1));
    expect(two.popups[0]).toBe(saveProblemsTitle(2));
  });
});

describe('anything that is NOT one — each surface keeps its own answer', () => {
  test('CONTROL — an ordinary error goes to the fallback, not the popup', async () => {
    const s = spy();
    await notifySaveProblems(s.notify, new Error('network down'), s.onOther);
    expect(s.popups).toEqual([]);
    expect(s.others).toEqual(['network down']);
  });

  test('CONTROL — a failure with no message of its own uses the surface\'s wording', async () => {
    const s = spy();
    await notifySaveProblems(s.notify, { status: 500 }, s.onOther, "Couldn't save. Try again.");
    expect(s.others).toEqual(["Couldn't save. Try again."]);
  });

  test('CONTROL — a body that is not a problem list is not a gate refusal', async () => {
    for (const err of [
      { body: '{"error":"qty_exceeds_remaining"}' },
      { body: '{"error":"validation_failed","problems":[]}' },
      { body: 'not json at all' },
      {},
      null,
    ]) {
      const s = spy();
      await notifySaveProblems(s.notify, err, s.onOther);
      expect(s.popups, JSON.stringify(err)).toEqual([]);
      expect(s.others).toHaveLength(1);
    }
  });
});
