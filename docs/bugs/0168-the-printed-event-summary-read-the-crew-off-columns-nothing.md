## The printed Event Summary read the crew off columns nothing writes, and printed the setup call 8 hours late [med]

**Symptom.** Owner, looking at the live sheet for `2026-07-MYHOME-KL-SPCC-AKEMI`:
the Logistics block showed `—` for lorry, driver and both helpers, and a setup
call entered as **11:00** printed as **19:00**.

**Root cause, two independent faults.**

1. *Crew.* The sheet read `projects.setup_driver_user_id` / `setup_lorry_id` /
   `setup_helper_*_id`. Measured on production: 903 projects, 224 with a setup
   driver, 211 with a lorry, and **0 with `setup_helper_1_id`** — because the
   logistics form does not write those columns. It writes a JSON blob into
   `projects.setup_crew` / `dismantle_crew`, and that blob has been through three
   shapes: crew nested per lorry under `lorry_crew`, an older flat
   `drivers`/`helpers`/`lorries`, and `outsourced` as either `{enabled,
   entries[]}` or a single `{name, phone, plate}`.
2. *Times.* `setup_start_at` comes from an `<input type="datetime-local">` and is
   stored naive (`2026-07-30T11:00`) — already MYT wall clock. `fmtDateTime` was
   adding the +8h that true instants (`created_at`, which carry `Z`) need, so
   every crew time printed 8 hours late.

**Fix.** `parseCrew()` normalises all three blob shapes, prints the
Grab/Lalamove outsource rows and both remark fields, and treats
`outsourced.enabled === false` as "the user removed this". The old columns stay
as a fallback for the ~220 projects that only have them. `fmtDateTime` shifts
only values carrying a zone marker; naive local strings print exactly as typed.

**The class, for next time.** A column that exists is not a column that is
written. Before reading one on a report, count how many rows are non-null — the
helper columns were dead on arrival and the sheet said `—` for months without
anyone being able to tell the difference between "no crew" and "wrong source".

**Ref** — 2026-08-14, `fix/print-crew-json` and `fix/print-crew-times-stage`.
