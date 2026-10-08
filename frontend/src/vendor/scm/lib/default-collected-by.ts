/** Seeds "Collected By" with the signed-in salesperson on payment rows that have
 *  none yet (DEV-44, desktop parity with PaymentsTable's defaultCollectedBy).
 *  A converted row is skipped: the server fixes its collector. */
export const fillCollectedBy = <P extends { collectedBy: string; convertedFromDocNo?: string }>(
  pays: P[],
  staffId: string,
): P[] => pays.map((p) => (p.collectedBy || p.convertedFromDocNo ? p : { ...p, collectedBy: staffId }));
