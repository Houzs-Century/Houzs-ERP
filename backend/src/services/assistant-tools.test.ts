import { describe, it, expect } from 'vitest';
import type { Env } from '../types';
import type { AssistantScope } from './assistant-scope';
import { REDACTED } from './assistant-scope';
import {
  buildAssistantTools,
  dispatchAssistantTool,
  normalizeSearchQuery,
  shapeSearchResult,
  SEARCH_TOOL,
  type AssistantToolCtx,
} from './assistant-tools';

// The backend test runtime is the Cloudflare Workers pool (workerd), which does
// NOT support vi.mock module replacement — so the reader cannot be stubbed. The
// security-critical logic (query cap, redaction, routing trace) is therefore
// exercised through the PURE helpers the dispatcher is built from, on arbitrary
// hit shapes a real search would never have to emit.

const OWNER: AssistantScope = { wildcard: true, canSeeMargin: true, canSeeCommission: true, orderScope: 'all' };
const REP: AssistantScope = { canSeeMargin: false, canSeeCommission: false, orderScope: 'own' };

function ctxFor(scope: AssistantScope): AssistantToolCtx {
  return { env: {} as Env, scope, companyCtx: { get: () => undefined }, consulted: [] };
}

describe('buildAssistantTools', () => {
  it('offers the search tool to every caller', () => {
    expect(buildAssistantTools(REP).map((t) => t.name)).toContain('search_erp');
    expect(buildAssistantTools(OWNER).map((t) => t.name)).toContain('search_erp');
  });

  it('the search tool declares a required string q', () => {
    expect(SEARCH_TOOL.input_schema).toMatchObject({ required: ['q'] });
  });
});

describe('normalizeSearchQuery', () => {
  it('trims and caps an overlong query to 120 chars', () => {
    expect(normalizeSearchQuery({ q: '  SO-1  ' })).toBe('SO-1');
    expect(normalizeSearchQuery({ q: 'x'.repeat(500) }).length).toBe(120);
  });

  it('treats a non-string (or missing) q as no query', () => {
    expect(normalizeSearchQuery({ q: 42 })).toBe('');
    expect(normalizeSearchQuery({})).toBe('');
  });
});

describe('shapeSearchResult — the redaction boundary', () => {
  it('redacts money keys from a hit for a role that may not see them', () => {
    // A hypothetical priced field on a hit MUST NOT reach a rep's context window.
    const ctx = ctxFor(REP);
    const res = shapeSearchResult(ctx, 'P1', [{ type: 'product', id: 'P1', title: 'P1', margin: 999 }]);
    const hits = res.hits as Array<Record<string, unknown>>;
    expect(hits[0].margin).toBe(REDACTED);
    expect(hits[0].title).toBe('P1');
    expect(res.count).toBe(1);
  });

  it('leaves money visible for a wildcard owner', () => {
    const res = shapeSearchResult(ctxFor(OWNER), 'P1', [{ type: 'product', id: 'P1', margin: 999 }]);
    const hits = res.hits as Array<Record<string, unknown>>;
    expect(hits[0].margin).toBe(999);
  });

  it('records the Search routing trace exactly once across several shapings', () => {
    const ctx = ctxFor(REP);
    shapeSearchResult(ctx, 'a', []);
    shapeSearchResult(ctx, 'b', []);
    expect(ctx.consulted).toEqual([{ key: 'search', label: 'Search' }]);
  });
});

describe('dispatchAssistantTool', () => {
  it('short-circuits an empty query to a note (never reaches the reader)', async () => {
    const ctx = ctxFor(REP);
    const res = (await dispatchAssistantTool(ctx, 'search_erp', { q: '   ' })) as { count: number; note?: string };
    expect(res.count).toBe(0);
    expect(res.note).toBe('empty query');
    expect(ctx.consulted).toHaveLength(0);
  });

  it('returns an error object for an unknown tool rather than throwing', async () => {
    const res = (await dispatchAssistantTool(ctxFor(OWNER), 'delete_everything', {})) as { error?: string };
    expect(res.error).toMatch(/unknown tool/);
  });
});
