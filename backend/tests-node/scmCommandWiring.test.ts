import { describe, expect, test } from 'vitest';
import { soRouterSource } from '../tests/lib/so-router-source';
import amendmentSource from '../src/scm/routes/so-amendments.ts?raw';
const salesOrderSource = soRouterSource();

describe('SCM atomic command wiring', () => {
  for (const [handler, path] of [
    ['tbcUpdateCommandHandler', "post('/:docNo/items/:itemId/tbc-update'"],
    ['tbcSwapCommandHandler', "post('/:docNo/items/:itemId/tbc-swap'"],
    ['tbcSwapSofaCommandHandler', "post('/:docNo/items/:itemId/tbc-swap-sofa'"],
  ] as const) {
    test(`${path} is fail-closed behind the PG transaction + lease row lock`, () => {
      const handlerAt = salesOrderSource.indexOf(`export async function ${handler}`);
      const routeAt = salesOrderSource.indexOf(`mfgSalesOrders.${path}`);
      expect(handlerAt).toBeGreaterThanOrEqual(0);
      expect(routeAt).toBeGreaterThan(handlerAt);
      const registration = salesOrderSource.slice(routeAt, routeAt + 600);
      expect(registration).toContain('runScmPgCommand');
      expect(registration).toContain("docNo: c.req.param('docNo')");
      expect(registration).toContain("leaseToken: c.req.header('X-SO-Edit-Lease')");
    });
  }

  test('approve-so applies and finalizes the amendment inside one PG transaction', () => {
    const handlerAt = amendmentSource.indexOf('export async function approveSoCommandHandler');
    const routeAt = amendmentSource.indexOf("soAmendments.patch('/:id/approve-so'");
    expect(handlerAt).toBeGreaterThanOrEqual(0);
    expect(routeAt).toBeGreaterThan(handlerAt);
    const handler = amendmentSource.slice(handlerAt, routeAt);
    expect(handler).toContain('applySoAmendment(sb');
    expect(handler).toContain("sb.from('so_amendments').update");
    expect(amendmentSource.slice(routeAt, routeAt + 250)).toContain('runScmPgCommand');
  });

  test('approve-po revises every bound PO and finalizes through one PG transaction', () => {
    const handlerAt = amendmentSource.indexOf('export async function approvePoCommandHandler');
    const routeAt = amendmentSource.indexOf("soAmendments.patch('/:id/approve-po'");
    expect(handlerAt).toBeGreaterThanOrEqual(0);
    expect(routeAt).toBeGreaterThan(handlerAt);
    const handler = amendmentSource.slice(handlerAt, routeAt);
    expect(handler).toContain('reviseBoundPo(sb');
    expect(handler).toContain("sb.from('so_amendments').update");
    expect(handler).toContain(".eq('version', applyVersion)");
    expect(amendmentSource.slice(routeAt, routeAt + 250)).toContain('runScmPgCommand');
  });

  test('every terminal amendment action advances the row generation by CAS', () => {
    for (const [path, nextPath] of [
      ["patch('/:id/send'", "patch('/:id/reject'"],
      ["patch('/:id/reject'", "patch('/:id/withdraw'"],
      ["patch('/:id/withdraw'", null],
    ] as const) {
      const start = amendmentSource.indexOf(`soAmendments.${path}`);
      const end = nextPath ? amendmentSource.indexOf(`soAmendments.${nextPath}`, start) : amendmentSource.length;
      expect(start).toBeGreaterThanOrEqual(0);
      const handler = amendmentSource.slice(start, end);
      expect(handler).toContain(".eq('status', amendment.status)");
      expect(handler).toContain(".eq('version', Number(amendment.version ?? 1))");
      expect(handler).toContain("error: 'amendment_version_conflict'");
    }
  });

  test('mirrored amendment dispatch waits until the local command transaction commits', () => {
    const dispatchAt = amendmentSource.indexOf('async function dispatchMirroredCommand');
    const dispatch = amendmentSource.slice(dispatchAt, dispatchAt + 5000);
    expect(dispatch).toContain("dispatchOne(c.get('supabase')");
    expect(dispatch).toContain('deferScmAfterCommit(c, dispatch)');
    expect(dispatch).not.toContain('dispatchOne(sb, cfg.config');
  });

  test('sofa R2 cleanup and global allocation are explicitly after-commit effects', () => {
    expect(salesOrderSource).toContain('deferScmAfterCommit(c, async () =>');
    const cleanup = salesOrderSource.indexOf('const oldPhotoKeys');
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(salesOrderSource.slice(cleanup, cleanup + 500)).toContain('deferScmAfterCommit');
  });

  test('every atomic line/amendment command transactionally queues allocation reconciliation', () => {
    for (const reason of ['tbc-update:', 'tbc-swap:', 'tbc-swap-sofa:']) {
      expect(salesOrderSource).toContain('scheduleStockAllocationAfterCommand(c, sb, `' + reason);
    }
    expect(amendmentSource).toContain('scheduleStockAllocationAfterCommand(c, sb, `amendment-approve-so:');
  });
});
