## A saved default layout made its own hidden columns un-tickable, and a sticky funnel had nothing to clear it [medium]

**Symptom.** A Purchaser reported 5 of 60 purchase orders missing. The owner
signed in as the same account on his own machine and saw all 60. Chasing that,
the GRN No checkbox in the Columns drawer would not tick at all.

**Root cause — two, in the same component.** The short list was a column funnel
the user had ticked once. Funnels persist to `dt:filters:<table>`, apply from the
first paint, and are visible nowhere but the header carrying them — per browser,
which is why the owner's login could not reproduce it. The toolbar Reset could
not help: the 15 pages that pass `resetFilters` (`git grep -l "resetFilters={"
-- frontend/src`, less this component's own test) define "active" as their own
pills, view and search, and their `onReset` clears URL params and sort, never the
stored funnels.

The dead checkbox was worse. A table with no prefs of its own renders the
company's default layout, and while that baseline is in play `effectiveHidden`
reads the PRESET's hidden/shown lists and skips the user's — but `toggleColumn`
wrote the skipped ones. Revealing writes to the hidden list (already empty, a
no-op) and to the shown list only for a `defaultHidden` column. GRN No carries no
such flag, so the click wrote nothing whatsoever. That is every hidden column on
a list whose defaults live entirely in a saved layout — Delivered and Assigned SO
too — and Show all was dead there for the same reason.

The same gap had a quieter third face: hiding one column under a default stored
only that column. The first stored pref of any kind ends the baseline for good,
so the next mount read "hid this one, arranged nothing else", unhid every other
preset-hidden column and re-sorted the table into definition order. Nobody
reported it; the layout-sync test had pinned it as correct.

**Fix.** `DataTable` folds its own `colFilters` into the Reset button's `active`
and clears them on click, and renders the button unconditionally so the 24 lists
that render a `DataTable` without passing `resetFilters` get one too. Visibility
gestures move to `dataTableColumnPrefs.ts` and bank the baseline into real prefs
— order included — before applying themselves, which is what picking a layout
from the drawer already did, so a toggle and a Show all no longer have a "preset
mode" to escape from.

**What this does not change.** A funnel still persists, and still applies from
the first paint. That is the design — it is the only way a narrowed view survives
a reload. What changed is that the toolbar now admits one is on.
