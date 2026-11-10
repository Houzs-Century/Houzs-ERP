/* The photos a stop's crew have uploaded and not yet completed, shared by every
   crew member of that stop (backend scm/routes/crew-stop-photos.ts). The driver
   and the helper see the same list, with who took each photo. */
import { authedFetch } from './authed-fetch';

export type CrewStopPhoto = {
  uploadSessionId: string;
  r2Key: string;
  contentType: string | null;
  createdAt: string;
  uploadedBy: { id: number; name: string | null };
  mine: boolean;
  canRemove: boolean;
};

/** How often an open stop screen asks again, so one crew member's photo, Remove
 *  or Complete shows on the other's phone without a manual refresh. The read is
 *  ETag-polled (pollEtag.ts), so an unchanged answer costs headers only. */
export const CREW_STOP_POLL_MS = 15_000;

const q = (context: string) => `context=${encodeURIComponent(context)}`;

export async function listCrewStopPhotos(context: string): Promise<CrewStopPhoto[]> {
  const res = await authedFetch<{ photos?: CrewStopPhoto[] }>(`/delivery-jobs/stop-photos?${q(context)}`);
  return res.photos ?? [];
}

/** The API path of one pending stop photo (auth-protected; fetch as a blob). */
export function crewStopPhotoImagePath(uploadSessionId: string, context: string): string {
  return `/api/scm/delivery-jobs/stop-photos/${encodeURIComponent(uploadSessionId)}?${q(context)}`;
}

export async function discardCrewStopPhoto(uploadSessionId: string, context: string): Promise<void> {
  await authedFetch(`/delivery-jobs/stop-photos/${encodeURIComponent(uploadSessionId)}/discard?${q(context)}`, { method: 'POST', body: '{}' });
}
