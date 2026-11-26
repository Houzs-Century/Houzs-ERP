import { authedFetch } from './authed-fetch';


/** The run's public scan token, or `null` when it could not be obtained. */
export async function armPackingScanToken(tripId: string): Promise<string | null> {
  if (!tripId) return null;
  try {
    const { scanToken } = await authedFetch<{ scanToken?: string }>(
      `/trips/${encodeURIComponent(tripId)}/scan-token`,
    );
    return scanToken ?? null;
  } catch {
    return null;
  }
}
