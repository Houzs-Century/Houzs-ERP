// ----------------------------------------------------------------------------
// FairPicker — the SO form's "which exhibition is this" control.
//
// ONE component for desktop and mobile. The owner's standing rule is one shared
// logic layer with the two surfaces differing only in presentation, and this
// control decides which fair's P&L a sale lands in — the exact kind of rule that
// must not exist twice. Both call sites pass their own class names; nothing else
// differs.
//
// ── WHAT IT REPLACED (owner, 2026-09-13) ────────────────────────────────────
// A free-text-backed venue dropdown that recorded a PLACE and nothing else. On
// production that day, all 2,946 of Houzs Century's sales orders had a NULL
// `project_id`: not one order could say which FAIR it was written at. The venue
// text could not answer it either — four different fairs were running at MID
// VALLEY on the same three days, one per brand.
//
// ── THE RULES THIS CONTROL OBEYS ────────────────────────────────────────────
//  1. A row is a PLACE plus an ORGANIZER, no dates. *"我觉得不需要日期啦…只需要
//     选 event 和 organizer 就好了"*. The server sets `showDates` on the one case
//     that needs them (same venue + organizer twice in a month).
//  2. NOBODY TYPES. *"dont let them write in manual, third option just pick
//     others"* — Others opens a second PICK over the company's 92-row venue
//     master, which covers every venue any 2026 fair uses. Free text is what
//     produced the mess this control replaces.
//  3. The BRAND is never asked for. It is derived from the order's SKUs on save
//     (`derive-line-branding.ts`) and the server uses it to decide which brand
//     booth at the picked event this order belongs to.
//  4. A fair that is not in PMS yet is NORMAL, not an error: 23% of fairs reach
//     the system within a week of opening and 13 of 114 arrived after they had
//     already started. Those orders go through Others and the nightly reconcile
//     links them once the fair exists.
// ----------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { useFairOptions, fairLabel, type FairOption } from '../vendor/scm/lib/fair-options-queries';

/** What the SO form stores. `organizer` is null when the operator came through
 *  Others and picked a place only — which is a different statement from "an
 *  organizer I could not find", and the server treats it as one. */
export type FairPickValue = { venue: string | null; organizer: string | null };

export type FairPickerProps = {
  value: FairPickValue;
  /** The ORDER's date, `YYYY-MM-DD`. A backdated slip must offer the fair that
   *  was running the day it was written, so this is REQUIRED rather than
   *  optional: a caller that forgets it would silently get today's fairs, and an
   *  optional argument whose absence changes the answer is the bug class this
   *  repo has paid for repeatedly. Pass null explicitly for "today". */
  soDate: string | null;
  onChange: (next: FairPickValue) => void;
  disabled?: boolean;
  selectClassName?: string;
  wrapClassName?: string;
  /** Rendered under the control — the auto-fill hint on the SO form. */
  hint?: ReactNode;
  id?: string;
};

const OTHERS = '__others__';

function optionValue(o: FairOption): string {
  return `fair:${o.key}`;
}

/** Is this stored value one of the offered fairs? Matched on venue+organizer,
 *  not on the key, because an order saved last week must still light up its row
 *  today even though the key carries the period. */
function matches(o: FairOption, v: FairPickValue): boolean {
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
  return same(o.venue, v.venue) && same(o.organizer, v.organizer);
}

export function FairPicker(props: FairPickerProps) {
  const { value, soDate, onChange, disabled, selectClassName, wrapClassName, hint, id } = props;
  const q = useFairOptions(soDate);
  const running = q.data?.running ?? [];
  const month = q.data?.month ?? [];
  const venues = q.data?.venues ?? [];

  const all = [...running, ...month];
  const picked = all.find((o) => matches(o, value)) ?? null;
  /* A venue with no organizer is the Others path. So is a venue that no longer
     appears in the list — an order written at a fair that has since been
     cancelled or re-dated must keep showing its venue rather than silently
     reading as blank. */
  const onOthers = !picked && !!(value.venue ?? '').trim();
  const selected = picked ? optionValue(picked) : onOthers ? OTHERS : '';

  /* An order can carry a venue the master no longer lists (renamed, deactivated,
     or imported from AutoCount). Offer it as its own row rather than dropping
     the operator's saved answer on the floor the moment they open the form. */
  const knownVenue = venues.some(
    (v) => v.name.trim().toLowerCase() === (value.venue ?? '').trim().toLowerCase(),
  );
  const strayVenue = onOthers && !knownVenue ? (value.venue as string).trim() : null;

  function handleTop(next: string) {
    if (next === '') return onChange({ venue: null, organizer: null });
    if (next === OTHERS) {
      /* Keep whatever place is already on the order — switching to Others is
         "the list did not have my fair", not "clear the venue". */
      return onChange({ venue: value.venue ?? null, organizer: null });
    }
    const key = next.slice('fair:'.length);
    const hit = all.find((o) => o.key === key);
    if (hit) onChange({ venue: hit.venue, organizer: hit.organizer });
  }

  return (
    <span className={wrapClassName}>
      <select
        id={id}
        className={selectClassName}
        value={selected}
        disabled={disabled}
        onChange={(e) => handleTop(e.target.value)}
        aria-label="Fair"
      >
        <option value="">—</option>
        {running.length > 0 && (
          <optgroup label="Running now">
            {running.map((o) => (
              <option key={o.key} value={optionValue(o)}>{fairLabel(o)}</option>
            ))}
          </optgroup>
        )}
        {month.length > 0 && (
          <optgroup label="Later this month">
            {month.map((o) => (
              <option key={o.key} value={optionValue(o)}>{fairLabel(o)}</option>
            ))}
          </optgroup>
        )}
        <optgroup label="Not listed">
          <option value={OTHERS}>Others — pick a place instead</option>
        </optgroup>
      </select>

      {onOthers && (
        <select
          id={id ? `${id}-venue` : undefined}
          className={selectClassName}
          value={value.venue ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ venue: e.target.value || null, organizer: null })}
          aria-label="Place"
          style={{ marginTop: '6px' }}
        >
          <option value="">— pick a place —</option>
          {strayVenue && <option value={strayVenue}>{strayVenue}</option>}
          {venues.map((v) => (
            <option key={v.id} value={v.name}>{v.name}</option>
          ))}
        </select>
      )}

      {hint}
    </span>
  );
}

export default FairPicker;
