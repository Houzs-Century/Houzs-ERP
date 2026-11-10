/* The crew's shared pending photos for one stop go to the /delivery-jobs
   stop-photo routes, always naming the stop. */
import { afterEach, describe, expect, test, vi } from 'vitest';

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock('./authed-fetch', () => ({ authedFetch }));
const { listCrewStopPhotos, crewStopPhotoImagePath, discardCrewStopPhoto } = await import('./crew-stop-photos');

afterEach(() => authedFetch.mockReset());

describe('crew stop photos', () => {
  test('lists the stop\'s photos by its context', async () => {
    authedFetch.mockResolvedValue({ photos: [{ uploadSessionId: 's1', r2Key: 'slips/a.jpg', mine: false, canRemove: false, uploadedBy: { id: 8, name: 'Ali' } }] });
    const rows = await listCrewStopPhotos('job:assr:12:customer_pickup');
    expect(authedFetch).toHaveBeenCalledWith('/delivery-jobs/stop-photos?context=job%3Aassr%3A12%3Acustomer_pickup');
    expect(rows[0]?.uploadedBy.name).toBe('Ali');
  });
  test('an empty answer is an empty list', async () => {
    authedFetch.mockResolvedValue({});
    expect(await listCrewStopPhotos('do:x')).toEqual([]);
  });
  test('image and remove name the stop too', async () => {
    expect(crewStopPhotoImagePath('s 1', 'do:x')).toBe('/api/scm/delivery-jobs/stop-photos/s%201?context=do%3Ax');
    authedFetch.mockResolvedValue({ ok: true });
    await discardCrewStopPhoto('s1', 'do:x');
    expect(authedFetch).toHaveBeenCalledWith('/delivery-jobs/stop-photos/s1/discard?context=do%3Ax', { method: 'POST', body: '{}' });
  });
});
