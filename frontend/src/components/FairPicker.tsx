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
//  1. A row is a PLACE, an ORGANIZER and the event's DATES, and all three
//     travel on the pick. Dates were added 2026-09-19, reversing the owner's
//     2026-09-13 "no dates" ruling — the list then was one month of mostly-live
//     fairs; it is now four weeks of CLOSED ones, and picking a row means
//     saying WHICH occurrence: *"今天是 10 号…我需要点 1 号的 event…它是一号到
//     三号的，我就点那个"*.
//     THE DATES ARE NOT DECORATION. They are sent back on save and are what the
//     server matches the occurrence on. They used to be dropped at the moment of
//     picking, so an order written up after its fair closed could not be
//     attributed to it by ANY path — the save, the nightly reconcile and the
//     settle-by-hand screen all refused it in turn.
//     BOTH OTHER HALVES ARE ON SCREEN. The organizer was hidden from the label on
//     2026-09-15 (#3999) and the owner reversed it the next morning: 「我是写
//     venue，然后旁边还有 organizer 的名字的，它不是单纯就是 venue only」. Venue
//     alone is not a fair — 15 venue-months in 2026 carry two or more organizers
//     at one venue, so 31 rows would read identically. `fairLabel`'s comment
//     carries the measurement and how it was taken.
//     A SOLO roadshow reads "VENUE — SOLO" (owner 2026-09-18): it has no
//     organizer to name, MALL MGT is only the landlord. Exhibitions are unchanged,
//     and the value sent on a pick is still the real organizer.
//  2. NOBODY TYPES. *"dont let them write in manual, third option just pick
//     others"* — Others opens a second PICK over the company's 92-row venue
//     master, which covers every venue any 2026 fair uses. Free text is what
//     produced the mess this control replaces.
//  3. The BRAND is never asked for. It is derived from the order's SKUs on save
//     (`derive-line-branding.ts`) and the server uses it to decide which brand
//     booth at the picked event this order belongs to.
//  4. THE LIST IS THE LAST FOUR WEEKS, ending at the order date. Never the
//     future: *"日期还没到，还没开单，不可能嘛"*. Never a calendar month either —
//     an order keyed on 2 Oct for an 18-20 Sep fair fell outside both groups and
//     could not be attributed at all. An ARCHIVED fair is never offered; it is
//     one the office withdrew from, and its revenue lands in a project the P&L
//     excludes by definition. `fair-binding.ts` has the measurement.
//  5. A fair that is not in PMS yet is NORMAL, not an error: 23% of fairs reach
//     the system within a week of opening and 13 of 114 arrived after they had
//     already started. Those orders go through Others and the nightly reconcile
//     links them once the fair exists.
//  6. A PLACE ALREADY ON THE ORDER IS THE VALUE (owner, 2026-09-15, looking at
//     HC-SO-2609-071 in edit mode: 「应该是venue的」). No order stores an
//     organizer, so the edit form, mobile edit and every auto-filled default all
//     arrive here as a place with no organizer — which this control used to
//     render as the "Others" sentinel with the place pushed into a second box,
//     on every order that has a venue. "Others" is an ACTION the operator takes
//     to open the venue master, never the resting state of a saved answer.
// ----------------------------------------------------------------------------

import { useState, type ReactNode } from 'react';
import { useFairOptions, fairLabel, type FairOption } from '../vendor/scm/lib/fair-options-queries';

/** What the SO form stores. `organizer` is null whenever the form holds a place
 *  but no fair row: a pick through Others, an order opened for edit (no order
 *  stores an organizer), or an auto-filled default. The server resolves a null
 *  organizer from venue + date + brand; the picker shows that place as itself. */
export type FairPickValue = {
  venue: string | null;
  organizer: string | null;
  /** The PICKED event's period, sent on save so the server can match the exact
   *  occurrence instead of re-deriving one from the order date.
   *
   *  REQUIRED, never optional. Its absence changes which lookup the server runs
   *  — the exact event, or a guess across the venue's fairs in the window — and
   *  an optional argument whose absence changes the answer is the bug class this
   *  repo has paid for repeatedly. A caller with no event (an order opened for
   *  edit, an auto-filled default, a pick through Others) passes null, which
   *  reads as a decision rather than an omission. */
  startDate: string | null;
  endDate: string | null;
};

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
const PLACE = '__place__';

function optionValue(o: FairOption): string {
  return `fair:${o.key}`;
}

/** Is this stored value one of the offered fairs? Matched on what the value
 *  actually carries: venue + organizer always, and the START DATE too once one
 *  is present. Without the date, two occurrences of the same venue+organizer
 *  inside the window would both light up and the first would win — which is
 *  exactly the ambiguity the period was added to remove. A value with no date
 *  (an order opened for edit, an auto-filled default) still matches on the
 *  first two, so a saved answer keeps lighting up its row. */
function matches(o: FairOption, v: FairPickValue): boolean {
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
  if (!same(o.venue, v.venue) || !same(o.organizer, v.organizer)) return false;
  return v.startDate ? o.startDate === v.startDate : true;
}

export function FairPicker(props: FairPickerProps) {
  const { value, soDate, onChange, disabled, selectClassName, wrapClassName, hint, id } = props;
  const q = useFairOptions(soDate);
  const running = q.data?.running ?? [];
  const earlier = q.data?.earlier ?? [];
  const venues = q.data?.venues ?? [];

  const all = [...running, ...earlier];
  const picked = all.find((o) => matches(o, value)) ?? null;
  const place = (value.venue ?? '').trim();
  /* Opening the venue master is the operator's move in THIS session, so it is
     local state, not something inferred from the value. Inferring it was the
     bug: "a place with no organizer" is also what every saved order looks like,
     and "Others with no place yet" is indistinguishable from a blank form, so the
     list could neither stay shut on a saved order nor open on an empty one. */
  const [choosingPlace, setChoosingPlace] = useState(false);
  /* A place that matches no row — the saved venue on an order, an auto-filled
     default, or an order written at a fair since cancelled or re-dated — is shown
     AS the value. It is never re-read as a fair: picking the row from the venue
     alone could name a fair that was not running on the order's date. */
  const selected = picked ? optionValue(picked) : place ? PLACE : choosingPlace ? OTHERS : '';
  const placeLabel = value.organizer ? `${place} — ${value.organizer}` : place;
  const showPlaceList = !picked && choosingPlace;

  /* An order can carry a venue the master no longer lists (renamed, deactivated,
     or imported from AutoCount). Offer it as its own row rather than dropping
     the operator's saved answer on the floor the moment they open the list. */
  const knownVenue = venues.some((v) => v.name.trim().toLowerCase() === place.toLowerCase());
  const strayVenue = place && !knownVenue ? place : null;

  function handleTop(next: string) {
    if (next === PLACE) return setChoosingPlace(false);
    if (next === '') {
      setChoosingPlace(false);
      return onChange({ venue: null, organizer: null, startDate: null, endDate: null });
    }
    if (next === OTHERS) {
      setChoosingPlace(true);
      /* Keep whatever place is already on the order — switching to Others is
         "the list did not have my fair", not "clear the venue". The PERIOD goes,
         because Others means no event was chosen and a stale period would tell
         the server to match an occurrence the operator just rejected. */
      return onChange({ venue: value.venue ?? null, organizer: null, startDate: null, endDate: null });
    }
    const key = next.slice('fair:'.length);
    const hit = all.find((o) => o.key === key);
    if (hit) {
      setChoosingPlace(false);
      /* The whole row travels, not just its first two fields. The period is what
         tells the server WHICH occurrence this is — dropping it here is what
         made an order written after its fair closed impossible to attribute. */
      onChange({
        venue: hit.venue,
        organizer: hit.organizer,
        startDate: hit.startDate,
        endDate: hit.endDate,
      });
    }
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
        {selected === PLACE && (
          <optgroup label="Place on this order">
            <option value={PLACE}>{placeLabel}</option>
          </optgroup>
        )}
        {running.length > 0 && (
          <optgroup label="Running now">
            {running.map((o) => (
              <option key={o.key} value={optionValue(o)}>{fairLabel(o)}</option>
            ))}
          </optgroup>
        )}
        {earlier.length > 0 && (
          /* Fairs that have already CLOSED, newest first, four weeks back. Never
             anything in the future — the owner does not write an order before
             the event happens, so offering one is only a wrong pick waiting to
             be made. */
          <optgroup label="Recently closed (last 4 weeks)">
            {earlier.map((o) => (
              <option key={o.key} value={optionValue(o)}>{fairLabel(o)}</option>
            ))}
          </optgroup>
        )}
        <optgroup label="Not listed">
          <option value={OTHERS}>Others — pick a place instead</option>
        </optgroup>
      </select>

      {showPlaceList && (
        <select
          id={id ? `${id}-venue` : undefined}
          className={selectClassName}
          value={place}
          disabled={disabled}
          onChange={(e) =>
            onChange({ venue: e.target.value || null, organizer: null, startDate: null, endDate: null })
          }
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
