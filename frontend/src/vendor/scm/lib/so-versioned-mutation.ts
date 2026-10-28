import type { QueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

type SoDetailCache = { salesOrder?: { version?: number | string } };
type LeaseReservation = { version: number; leaseToken: string };

const leaseToken = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `so-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

/**
 * The highest version the SERVER has told us about for an order, in this tab.
 *
 * WHY A SECOND PLACE TO LOOK. The detail cache is a copy of the order as it was
 * READ; these mutations LEARN a newer version as they write, and the reservation
 * below advances it every time. `invalidateQueries` only MARKS the cached entry
 * — the old object stays readable until a refetch lands — so a second write
 * started in that window read the version the first one had already superseded
 * and was refused as a concurrent edit, with nobody else involved (owner
 * 2026-08-31, a batch of photo uploads).
 *
 * Not a competing source of truth: the value only ever comes from a server
 * response for THAT order, and a version only ever increases, so taking the
 * larger of this and the cache is self-correcting — a refetch that returns a
 * higher number wins immediately, and a number another user advanced past is
 * still refused by the server, which is the whole point of the check.
 *
 * It lives on the QueryClient, not in a module variable: it is per-client state
 * like every other cache entry here, so it cannot leak between tabs or tests,
 * and it dies with the client. Nothing invalidates this key — react-query
 * matches an array key element by element, so the SO invalidation roots
 * (`mfg-sales-orders`, `mfg-sales-order-detail`) do not reach it.
 */
const knownVersionKey = (docNo: string) => ['mfg-sales-order-known-version', docNo];

const rememberSoVersion = (qc: QueryClient, docNo: string, raw: unknown): void => {
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) return;
  const known = Number(qc.getQueryData(knownVersionKey(docNo)) ?? 0);
  if (version > known) qc.setQueryData(knownVersionKey(docNo), version);
};

export async function resolveLoadedSoVersion(qc: QueryClient, docNo: string): Promise<number> {
  const cached = qc.getQueryData<SoDetailCache>(['mfg-sales-order-detail', docNo]);
  let raw = cached?.salesOrder?.version;
  if (raw === undefined) {
    const loaded = await authedFetch<SoDetailCache>(`/mfg-sales-orders/${docNo}`);
    raw = loaded.salesOrder?.version;
    qc.setQueryData(['mfg-sales-order-detail', docNo], loaded);
  }
  rememberSoVersion(qc, docNo, raw);
  const version = Number(qc.getQueryData(knownVersionKey(docNo)) ?? raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('This order has no concurrency version. Refresh the order before changing it.');
  }
  return version;
}

/**
 * Runs one standalone line mutation inside the same version/lease protocol as
 * the page-level composite save. A stale screen loses at reservation time, so
 * its action is never sent; a failed action retains all caller input and the
 * lease is released in finally.
 */
export async function runSoVersionedMutation<T>(
  qc: QueryClient,
  docNo: string,
  actionName: string,
  action: (reservation: LeaseReservation) => Promise<T>,
): Promise<T> {
  const token = leaseToken();
  const version = await resolveLoadedSoVersion(qc, docNo);
  const reserved = await authedFetch<{ version: number; leaseToken: string }>(
    `/mfg-sales-orders/${docNo}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        version,
        reserveLineWrites: true,
        lineWriteLeaseToken: token,
      }),
    },
  );
  const reservation = { version: Number(reserved.version), leaseToken: reserved.leaseToken || token };
  /* The reservation is itself a header write, so the order is already one
     version ahead of anything on screen. Record it before the action runs: an
     upload that fails still leaves the server advanced, and the NEXT attempt
     must reserve from the new number rather than retry the stale one. */
  rememberSoVersion(qc, docNo, reservation.version);
  try {
    return await action(reservation);
  } finally {
    try {
      await authedFetch(`/mfg-sales-orders/${docNo}`, {
        method: 'PATCH',
        headers: { 'X-SO-Edit-Action': actionName },
        body: JSON.stringify({
          version: reservation.version,
          completeLineWrites: true,
          lineWriteLeaseToken: reservation.leaseToken,
        }),
      });
    } catch (releaseError) {
      // Never turn a successfully committed action into a visible failure just
      // because its expiring lease could not be cleared. The detail refresh
      // below advances the version; the five-minute expiry is the backstop.
      console.warn('[so-versioned-mutation] lease release failed', releaseError);
    }
    qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', docNo] });
  }
}
