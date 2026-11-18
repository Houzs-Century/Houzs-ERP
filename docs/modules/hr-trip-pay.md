# HR Trip Pay

Employees & Attendance > Trip Pay: each driver's commission and the trip
allowances of drivers and helpers, paid on the payslip of the same month.
Code: `backend/src/scm/shared/hr-trip-pay.ts` (all money rules; byte-identical
copy in `frontend/src/vendor/shared/hr-trip-pay.ts`), `backend/src/routes/lib/hr-trip-store.ts`
(loading a month, reading Delivery Planning and Projects), `backend/src/routes/lib/hr-trip-sync.ts`
(the non-destructive read and the nightly run), `backend/src/routes/hr-trip-pay.ts` (routes),
`frontend/src/pages/hr/TripPayTab.tsx`, `TripRatesDrawer.tsx`.

## Trip month

- Runs from the 23rd of the previous month to the 22nd (`tripMonthBounds`), paid on
  that month's payslip.
- Frozen once the payslip month of the same name is approved or paid
  (`tripMonthLocked`): no row, missed-day or rate change, and the nightly read skips it.
- Money is never stored: it is computed on every read from the rows and the rates in
  force on the month's last day, so a rate change applies without a re-read.

## Rows (`hr_trip_rows`)

- Sources: `PLANNING` (Delivery Planning stops and Projects Setup / Dismantle),
  `SHEET` (pasted Trip Report), `MANUAL` (added by hand).
- Job type = Delivery Planning's own (`DP_ENTRY_MENU`): Delivery order, Setup, Dismantle,
  Supplier, Transfer item, Lorry service, ASSR - Inspection / Pickup / Service, plus
  No allowance. Filled from the stop when read; HR may correct it.
- A row stored before the redesign has `job_type` NULL and is read from its old `kind`
  (`jobTypeOfKind`: FAIR* = Setup, or Dismantle when its Doc No. says so). New rows still
  write `kind` (`kindOfJobType`) so old rates versions can read them.
- Setup / Dismantle carry the project's event type: slug `solo` (or a name with
  "roadshow") = Roadshow, any other event type = Exhibition, none = unknown (pays the
  Exhibition rate).
- State and postcode come from the DO, else the service case (its address, then its
  order), else the manual DP job, else the project. No state = no outstation until HR
  fills it (the page warns).
- `trip_ref` (the DP trip id, or `project:<id>:<phase>:<lorry>`) and `venue_key`
  (`P<project id>`) drive the 2nd-trip rule.
- `hr_edited`: set by any HR edit. A read never overwrites such a row. A Planning row from
  before the redesign whose `updated_at` is later than `created_at` counts as edited.
- Removing a Planning row sets `removed_at` (kept, hidden, paid nothing) so no read adds
  it back. Pasted and manual rows are deleted.
- `source_missing_at`: the row's stop was cancelled or deleted. Flagged on the page; it
  still counts until HR removes it. Cleared if the stop comes back.

## Reading Delivery Planning

- Stops of our own lorry runs in the month (outsourced and cancelled runs, cancelled DOs
  left out); crew from the DO's crew record, else the run's; crew matched to employees
  by user id, else by name (`trip_names`, then the full name).
- Delivery orders (`deliveryOrderRows`): SO deliveries reach Last Mile through the DO
  crew record, not trip stops, so each DO our own lorries ran is a Delivery order row
  (`source_ref` `do:<id>`): date = `do_date` (as the Last Mile History tab), Local Total,
  the DO's state / postcode, crew from `delivery_order_crew` (driver 1 falls back to the
  DO's driver; a seat with no master id keeps the typed name), crew size from that crew.
  Counted: shipped (not DRAFT / CANCELLED), a lorry on the crew. Left out: drop-ship, a
  3PL charge on the DO, an outsourced lorry (`is_internal` false), and a DO a live trip
  stop carries (the stop is its row).
- Projects module Setup / Dismantle (`projects.setup_start_at` / `dismantle_start_at`,
  date = first 10 characters, company-scoped): one row per lorry of the phase's crew JSON
  (`setup_crew` / `dismantle_crew`), names matched by name; no crew = the legacy single
  driver. A phase Delivery Planning already carries as a stop (same project, job type,
  date) is not read twice.
- Rules (`planSync`): a new stop is added; a changed stop updates its row unless HR edited
  or removed it; a stop that is gone flags its row.
- "Read Delivery Planning" runs these rules over the whole month now and deletes pasted
  (SHEET) rows. "Paste Trip Report" replaces SHEET and PLANNING rows.

## Nightly read

- Cron `5 16 * * *` (00:05 MYT), job `hr-trip-sync` in System Health; every company.
- Months: yesterday's trip month and the one before; locked months skipped; a month with
  pasted rows skipped (HR chose the sheet).
- Days touched (`selectSyncDays`): yesterday; older days whose source changed since the
  company's watermark (`hr_trip_sync_state.watermark`: `updated_at` on trips, dp_orders,
  delivery_orders, delivery_order_crew, projects; `created_at` on trip_stops); and days whose set of stops
  differs from the stored rows (catches deletions). Never today or later. No watermark
  yet = every day up to yesterday.

## Rates (`hr_trip_rate_versions`, effective-dated JSON)

- New shape has `schema: 2`. Saving requires it; the server strips `legacy`.
- A version without `schema: 2` (saved before 2026-11-17) is normalized into the new
  shape for display and keeps its original values in `legacy`; while it is the version in
  force the month is computed by the old rules unchanged (`computeLegacyTripPay`). Never
  rewrite stored versions. No version at all = `DEFAULT_TRIP_RATES` (new rules).
- A version may start on a past date, never inside an approved payroll month.
- Validation (`tripRatesProblem`): commission at most 10%; at most 31 listed cut days; a
  job type + event type once; Setup / Dismantle need an event type; No allowance has no
  rate; a state in one outstation group only; tiers between 22:00 and 04:00, no repeats.

## Pay rules (`computeTripMonth`)

- Commission: drivers only, % of the Local Total of Delivery order rows; crew of 2 and
  crew of 3 (3+ people on the row) rates. Missed working days (Mon-Sat, not a holiday, no
  hours and no leave; or HR's count) cut the rate by the listed percentage points per
  day, added up, then "each later day".
- Allowance per job: drivers only (helpers earn none), the rate of the row's job type
  (Setup / Dismantle also by event type). No rate row = nothing.
- 2nd trip (Setup / Dismantle only), per driver + lorry + day: each distinct (lorry run,
  venue) is a trip; the first pays per trip, each later one the 2nd-trip rate (empty =
  per trip). So a second venue on the same trip, a second run, and Setup then Dismantle
  all pay the 2nd-trip rate. The same run and venue again is the same job, paid once.
- Outstation: once per person per day, the highest-priced group among the states of
  that day's rows (driver or helper price by their role on that row). No allowance rows
  do not count. States in no group = home area.
- Overnight: from the punches. Per night (work date) the highest tier whose clock-out
  time was reached (time measured from noon of the work date, so 01:30 is after 00:00);
  only when the shift lasted over N hours (0 = always); only after a day with a ticked
  job type (none ticked = every night, trip or not). Driver price when they drove that
  day, else helper price.
- Per-row columns on the page (Allowance / Outstation / Overnight) are the crew's
  amounts attributed to the row; old-rules months show none.

## Permissions

- Read: `hr.employees.read` (mounted under `/api/hr`). Change rows, missed days, rates,
  read Planning: `hr.employees.manage`.
