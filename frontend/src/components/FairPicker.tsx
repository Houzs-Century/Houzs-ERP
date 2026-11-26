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
//     HC-SO-2609-071 in edit mode: 「应该是venue的」). An order with no fair link,
//     and every auto-filled default, arrives here as a place with no organizer —
//     which this control used to render as the "Others" sentinel with the place
//     pushed into a second box. "Others" is an ACTION the operator takes to open
//     the venue master, never the resting state of a saved answer.
//  7. A RECORDED PICK READS BACK AS ITS EVENT (owner 2026-09-24). The edit forms
//     seed the organizer and dates from the order's fair link (`fairPick.ts`), so
//     the row that was picked is the row shown; the edit save sends the picked
//     event and the server links exactly that one.
//  8. THE DAY IS PART OF THE PICK (owner 2026-09-24): the event runs 7-9, and
//     「他一选完那个 event，这边下拉菜单就要拉出来 7、8、9 三天给他选」, so the order
//     records which day it was written on, not just which event. `FairDayPicker`
//     below is that second column. Picking another event, Others or a clear
//     empties the day; nothing guesses it from today's date.
//  9. THE BOOTH ONLY WHEN THE SYSTEM CANNOT TELL (owner 2026-10-27, HC-0161 /
//     Lim). An event can have several brand booths; the brand of the order's
//     lines, then the keyer's own booth, decide which (rule 3). When neither
//     does — a pillow-only order at a 3-booth MLE, a bedframe at an AKEMI-only
//     fair — a Booth pick appears under the row. The server answers when to ask
//     (POST /fair-booth, the save's own rule) and takes the pick only then.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  useFairBooth, useFairDefault, useFairOptions, fairLabel, type FairBoothRequest, type FairOption, type FairWhy,
} from '../vendor/scm/lib/fair-options-queries';
import { fmtDayMonth } from '../../../shared/src/vendor/shared/format';
import { fairDaysOf, soleFairDay } from './fairPick';

/** What the SO form stores. `organizer` is null whenever the form holds a place
 *  but no fair row: a pick through Others, an order with no fair link, or an
 *  auto-filled default. The server resolves a null organizer from venue + date +
 *  brand; the picker shows that place as itself. */
export type FairPickValue = {
  venue: string | null;
  organizer: string | null;
  startDate: string | null;
  endDate: string | null;
  day: string | null;
  booth?: number | null;
};

export type FairPickerProps = {
  value: FairPickValue;
  soDate: string | null;
  onChange: (next: FairPickValue) => void;
  disabled?: boolean;
  selectClassName?: string;
  wrapClassName?: string;
  hint?: ReactNode;
  id?: string;
  boothFor?: Pick<FairBoothRequest, 'docNo' | 'items'>;
};

const OTHERS = '__others__';
const PLACE = '__place__';

function optionValue(o: FairOption): string {
  return `fair:${o.key}`;
}

function matches(o: FairOption, v: FairPickValue): boolean {
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
  if (!same(o.venue, v.venue) || !same(o.organizer, v.organizer)) return false;
  return v.startDate ? o.startDate === v.startDate : true;
}

export function FairPicker(props: FairPickerProps) {
  const { value, soDate, onChange, disabled, selectClassName, wrapClassName, hint, id, boothFor } = props;
  const q = useFairOptions(soDate);
  const running = q.data?.running ?? [];
  const earlier = q.data?.earlier ?? [];
  const venues = q.data?.venues ?? [];

  const all = [...running, ...earlier];
  const picked = all.find((o) => matches(o, value)) ?? null;
  const place = (value.venue ?? '').trim();
  const [choosingPlace, setChoosingPlace] = useState(false);
  const selected = picked ? optionValue(picked) : place ? PLACE : choosingPlace ? OTHERS : '';
  const placeLabel = value.organizer && value.startDate
    ? fairLabel({ venue: place, organizer: value.organizer, startDate: value.startDate, endDate: value.endDate })
    : value.organizer ? `${place} — ${value.organizer}` : place;
  const showPlaceList = !picked && choosingPlace;
  const boothReq = boothFor && place && value.organizer && value.startDate
    ? { fairVenue: place, fairOrganizer: value.organizer, fairStart: value.startDate, fairEnd: value.endDate, ...boothFor }
    : null;
  const boothQ = useFairBooth(boothReq);
  const askBooth = boothReq && boothQ.data?.ask ? boothQ.data : null;
  const booth = askBooth?.booths.some((b) => b.projectId === value.booth) ? value.booth! : null;

  const knownVenue = venues.some((v) => v.name.trim().toLowerCase() === place.toLowerCase());
  const strayVenue = place && !knownVenue ? place : null;

  function handleTop(next: string) {
    if (next === PLACE) return setChoosingPlace(false);
    if (next === '') {
      setChoosingPlace(false);
      return onChange({ venue: null, organizer: null, startDate: null, endDate: null, day: null });
    }
    if (next === OTHERS) {
      setChoosingPlace(true);
      return onChange({ venue: value.venue ?? null, organizer: null, startDate: null, endDate: null, day: null });
    }
    const key = next.slice('fair:'.length);
    const hit = all.find((o) => o.key === key);
    if (hit) {
      setChoosingPlace(false);
      onChange({
        venue: hit.venue,
        organizer: hit.organizer,
        startDate: hit.startDate,
        endDate: hit.endDate,
        day: soleFairDay(hit, q.data?.date ?? null),
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
            onChange({ venue: e.target.value || null, organizer: null, startDate: null, endDate: null, day: null })
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

      {askBooth && (
        <select
          id={id ? `${id}-booth` : undefined}
          className={selectClassName}
          value={booth ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, booth: e.target.value ? Number(e.target.value) : null })}
          aria-label="Booth"
          style={{ marginTop: '6px' }}
        >
          <option value="">— pick the booth —</option>
          {askBooth.booths.map((b) => (
            <option key={b.projectId} value={b.projectId}>{b.brand ?? 'No brand'} booth</option>
          ))}
        </select>
      )}
      {askBooth && booth == null && askBooth.message && (
        <span role="note" style={{ display: 'block', fontSize: '11px', marginTop: '4px', color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>{askBooth.message}</span>
      )}

      {hint}
    </span>
  );
}

export type FairDayPickerProps = {
  value: FairPickValue;
  soDate: string | null;
  onChange: (next: FairPickValue) => void;
  disabled?: boolean;
  selectClassName?: string;
  wrapClassName?: string;
  id?: string;
};

/** The second column (rule 8): which DAY of the picked event. Renders nothing
 *  until an event is picked — a place alone has no days — so a caller shows its
 *  labelled field only while `fairEventOf(value)` is set. */
export function FairDayPicker(props: FairDayPickerProps) {
  const { value, soDate, onChange, disabled, selectClassName, wrapClassName, id } = props;
  const q = useFairOptions(soDate);
  if (!value.organizer || !value.startDate) return null;
  const days = fairDaysOf(value, q.data?.date ?? null);
  const options = value.day && !days.includes(value.day) ? [value.day, ...days] : days;
  return (
    <span className={wrapClassName}>
      <select
        id={id}
        className={selectClassName}
        value={value.day ?? ''}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, day: e.target.value || null })}
        aria-label="Fair day"
      >
        <option value="">—</option>
        {options.map((d) => (
          <option key={d} value={d}>{fmtDayMonth(d)}</option>
        ))}
      </select>
    </span>
  );
}

export type AutoFair = {
  why: FairWhy | null;
  hint: ReactNode;
};

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * A NEW order starts with the KEYER's fair (owner 2026-10-19, the boss's rule):
 * the fair they stand at today, else the latest one within a month. The rule is
 * the server's (GET /fair-default); this fills the picker ONCE, through the
 * form's own pick handler — so a filled-in fair clears No fair exactly as a
 * picked one does — and words the line under it. Nothing is forced: the
 * operator changes it like any pick, and it never fills in again.
 *
 * Only a form with no EVENT yet is filled: a place the form defaulted to
 * (/active-venue) gives way, a fair someone already picked does not.
 *
 * @param enabled A new order whose operator has not ticked No fair. An edit keeps
 *   its own fair, and a No fair tick is a decision this never undoes.
 */
export function useAutoFair(
  enabled: boolean,
  value: FairPickValue,
  onChange: (next: FairPickValue) => void,
): AutoFair {
  const d = useFairDefault(enabled).data ?? null;
  const filled = useRef(false);
  useEffect(() => {
    if (filled.current || !enabled || !d) return;
    filled.current = true;
    const e = d.event;
    if (!e || value.organizer) return;
    onChange({ venue: e.venue, organizer: e.organizer, startDate: e.startDate, endDate: e.endDate, day: soleFairDay(e, d.date) });
  }, [d, enabled]);

  if (!enabled || !d) return { why: null, hint: null };
  const e = d.event;
  const showing = e && sameText(e.venue, value.venue) && sameText(e.organizer, value.organizer) && e.startDate === value.startDate;
  const line = { display: 'block', fontSize: '11px', marginTop: '4px' } as const;
  const hint = showing
    ? <span style={{ ...line, opacity: 0.75 }}>
        {d.how === 'ongoing' ? 'Filled in: your fair today.' : 'Filled in: your latest fair.'} Change it if this order is for another fair.
      </span>
    : !e && d.whyMessage && !value.organizer
      ? <span role="note" style={{ ...line, color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>{d.whyMessage}</span>
      : null;
  return { why: d.why, hint };
}

export default FairPicker;
