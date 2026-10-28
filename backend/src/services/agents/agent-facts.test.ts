import { describe, it, expect } from 'vitest';
import type { Env } from '../../types';
import {
  listAgentFacts,
  getAgentFact,
  runAgentFact,
  callAgentFact,
  type AgentFact,
} from './agent-facts';

const ENV = {} as Env;

describe('agent-facts registry', () => {
  it('lists procurement.estimateReadyDate owned by PROCUREMENT, without exposing the handler', () => {
    const facts = listAgentFacts();
    const f = facts.find((x) => x.name === 'procurement.estimateReadyDate');
    expect(f).toBeDefined();
    expect(f?.owner).toBe('PROCUREMENT');
    expect(f?.summary).toMatch(/ready/i);
    expect((f as Record<string, unknown>).run).toBeUndefined();
  });

  it('resolves a known fact and returns undefined for an unknown one', () => {
    expect(getAgentFact('procurement.estimateReadyDate')?.owner).toBe('PROCUREMENT');
    expect(getAgentFact('procurement.nope')).toBeUndefined();
  });
});

describe('runAgentFact — governed dispatch', () => {
  const okFact: AgentFact<{ n: number }, { doubled: number }> = {
    name: 'test.double',
    owner: 'PROCUREMENT',
    summary: 'doubles',
    run: async (_env, input) => ({ doubled: input.n * 2 }),
  };
  const boomFact: AgentFact = {
    name: 'test.boom',
    owner: 'CS',
    summary: 'throws',
    run: async () => {
      throw new Error('kaboom');
    },
  };

  it('wraps a successful handler with ok + name + owner + result', async () => {
    const r = await runAgentFact(okFact as AgentFact, ENV, { n: 21 });
    expect(r).toEqual({ ok: true, name: 'test.double', owner: 'PROCUREMENT', result: { doubled: 42 } });
  });

  it('turns a thrown handler into a typed error, never a crash', async () => {
    const r = await runAgentFact(boomFact, ENV, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/test\.boom failed.*kaboom/);
  });
});

describe('callAgentFact — by name', () => {
  it('returns a typed error for an unknown fact rather than throwing', async () => {
    const r = await callAgentFact(ENV, 'procurement.doesNotExist', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown fact/);
  });
});
