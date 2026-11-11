// Places under a delivery zone (mig 20261111T1100; owner 2026-11-11: the 3PL
// rate cards use the same areas as Delivery Zones, 做): the towns a card prices,
// filed under the zone their postcodes fall in. A rate card reads a town only for
// an address whose postcode is in that zone, so Jalan Ipoh in Kuala Lumpur is not
// Ipoh. The zone's panel lists its towns with the cards that price each, files a
// pasted list, moves a town to another zone, and removes a town no card prices.
import { useState } from 'react';
import { useAddPlaces, useMovePlace, usePlaces, useRemovePlace } from '../../../vendor/scm/lib/delivery-places-queries';
import { writeFailedAs } from '../../../vendor/scm/lib/mutation-error';
import { parseTowns, townLabel } from '../carriers/rateCardAreas';
import { ZONE_NAME, zoneName } from './zoneModel';

const NO_ZONE = '';
const ZONE_KEYS = Object.keys(ZONE_NAME);

/** The towns rate cards price that no zone holds yet: until each is filed, a
 *  card reads it anywhere in the address. Nothing when every town has a zone. */
export function UnplacedTowns() {
  const places = usePlaces();
  const towns = places.data?.unplaced ?? [];
  if (towns.length === 0) return null;
  const names = towns.map((t) => townLabel(t.name));
  return (
    <p role="status" className="rounded-xl bg-[color:var(--hz-dk-warning-bg,#f6ecd4)] px-4 py-3 text-[13px] text-[#80501c]">
      {towns.length === 1 ? '1 town on the rate cards has' : `${towns.length} towns on the rate cards have`} no zone yet: {names.join(', ')}.
      {' '}Add each under its zone (Places, beside the map); until then a rate card reads it anywhere in the address.
    </p>
  );
}

export function ZonePlaces({ zone }: { zone: string | null }) {
  const places = usePlaces();
  const add = useAddPlaces();
  const move = useMovePlace();
  const remove = useRemovePlace();
  const [text, setText] = useState('');
  const where = zone ? zoneName(zone) : 'no zone';
  const mine = (places.data?.places ?? []).filter((p) => p.zone === zone).sort((a, b) => a.name.localeCompare(b.name));
  const typed = parseTowns(text);

  const submit = () => {
    if (typed.length === 0) return;
    add.mutate({ zone, names: typed }, { onSuccess: () => setText(''), onError: writeFailedAs('The places were not added') });
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[14px] font-semibold text-ink">Places <span className="font-normal text-ink-muted">· {mine.length}</span></h3>
        <p className="text-[12.5px] text-ink-muted">
          {zone
            ? `Towns a 3PL rate card prices in ${where}. A town counts only for an address whose postcode is in ${where}.`
            : 'Towns outside every zone, such as abroad. A rate card reads them by name only.'}
        </p>
      </div>

      {places.isLoading ? (
        <div className="h-16 animate-pulse rounded-md bg-surface-2" aria-hidden />
      ) : places.isError ? (
        <p className="text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">The places could not be loaded. Refresh to try again.</p>
      ) : mine.length === 0 ? (
        <p className="text-[13px] text-ink-muted">No places in {where} yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label={`Places in ${where}`} className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">
                <th scope="col" className="py-1.5 pr-3 font-semibold">Place</th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">Priced on</th>
                <th scope="col" className="py-1.5 text-right font-semibold">Zone</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((p) => {
                const label = townLabel(p.name);
                return (
                  <tr key={p.id} className="border-t border-border-subtle align-top">
                    <td className="py-2 pr-3 font-semibold text-ink">{label}</td>
                    <td className="py-2 pr-3 text-ink-muted">{p.cards.length > 0 ? p.cards.join(', ') : 'No rate card yet'}</td>
                    <td className="py-2">
                      <div className="flex items-center justify-end gap-2">
                        <select aria-label={`Zone of ${label}`} value={p.zone ?? NO_ZONE}
                          onChange={(e) => move.mutate({ id: p.id, zone: e.target.value || null }, { onError: writeFailedAs('The place was not moved') })}
                          className="h-8 max-w-[150px] rounded-md border border-border bg-surface px-1.5 text-[12.5px] text-ink">
                          {ZONE_KEYS.map((z) => <option key={z} value={z}>{zoneName(z)}</option>)}
                          <option value={NO_ZONE}>No zone</option>
                        </select>
                        {p.cards.length === 0 && (
                          <button type="button" aria-label={`Remove ${label}`}
                            onClick={() => remove.mutate(p.id, { onError: writeFailedAs('The place was not removed') })}
                            className="text-[12.5px] font-semibold text-primary hover:underline">Remove</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <textarea aria-label={`Add towns to ${where}`} rows={2} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Towns, separated by commas or new lines"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink" />
        <button type="submit" disabled={add.isPending || typed.length === 0}
          className="min-h-[36px] self-start rounded-md bg-primary px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-50">Add</button>
      </form>
    </div>
  );
}
