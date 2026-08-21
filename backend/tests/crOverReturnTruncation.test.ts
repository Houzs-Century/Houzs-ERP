// The consignment over-return guard survives its own success.
//
// 2026-08-21 full-flow audit, item A6: three reads in the consignment sales
// trio fetched "live documents" with a bare .neq('status','CANCELLED') — one
// un-paged response, capped at 1000 rows by PostgREST, company-blind so the
// other tenant's rows spent the same budget. Past the cap:
//   · checkCrOverRemaining treated an unlisted return as CANCELLED, dropped
//     its quantity, and passed a SECOND full return of the same note line —
//     double stock IN, and uq_inv_mov_cs_dr_source cannot catch it because
//     the second return is a DIFFERENT source_doc_id;
//   · /returnable-note-lines re-offered fully-returned lines;
//   · /deliverable-order-lines re-offered fully-shipped CO lines.
// A truncated page is error-free, so the guard's fail-closed error arm never
// fired. Paging is the only fix; scoping keeps the budget honest.
//
// Structural pins; the handlers need a live DB.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CR = readFileSync(resolve(__dirname, '../src/scm/routes/consignment-returns.ts'), 'utf8');
const CN = readFileSync(resolve(__dirname, '../src/scm/routes/consignment-notes.ts'), 'utf8');

function guardBody(): string {
  const start = CR.indexOf('async function checkCrOverRemaining(');
  expect(start).toBeGreaterThan(-1);
  const end = CR.indexOf('const offenders:', start);
  expect(end).toBeGreaterThan(start);
  return CR.slice(start, end);
}

describe('checkCrOverRemaining — the write-time guard', () => {
  it('pages AND scopes the live-returns read', () => {
    const seg = guardBody();
    const at = seg.indexOf("from('consignment_delivery_returns')");
    expect(at).toBeGreaterThan(-1);
    const around = seg.slice(Math.max(0, at - 400), at + 400);
    expect(around).toContain('paginateAll');
    expect(around).toContain('scopeToCompany');
  });

  it('chunks the return-items read, so a big id set cannot truncate either', () => {
    const seg = guardBody();
    const at = seg.indexOf("from('consignment_delivery_return_items')");
    expect(at).toBeGreaterThan(-1);
    expect(seg.slice(Math.max(0, at - 300), at)).toContain('chunkIn');
  });

  it('takes the request context, and its three callers pass it', () => {
    expect(guardBody()).toContain('c: any');
    expect(CR.split('checkCrOverRemaining(sb, c,').length - 1).toBe(3);
  });

  it('still fails CLOSED on a read error', () => {
    const seg = guardBody();
    expect(seg.split('OVER_REMAINING_UNPROVEN').length - 1).toBeGreaterThanOrEqual(3);
  });
});

describe('the two pickers', () => {
  it('returnable-note-lines pages + scopes + binds the live-returns read', () => {
    const at = CR.indexOf('Already-returned per note line');
    expect(at).toBeGreaterThan(-1);
    const seg = CR.slice(at, at + 900);
    expect(seg).toContain('paginateAll');
    expect(seg).toContain('scopeToCompany');
    expect(seg).toContain('relErr');
  });

  it('deliverable-order-lines pages + scopes + binds the live-notes read', () => {
    const at = CN.indexOf('Already-delivered per CO line');
    expect(at).toBeGreaterThan(-1);
    const seg = CN.slice(at, at + 900);
    expect(seg).toContain('paginateAll');
    expect(seg).toContain('scopeToCompany');
    expect(seg).toContain('noteErr');
  });
});
