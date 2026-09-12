
---

## History drawer (change log)

The History button opens the recorded change log for this purchase invoice — every field
change, who made it and when — read from `scm.entity_audit_log` through
`GET /entity-audit-log/:entityType/:entityId`.

Mounted with `DocumentHistoryDrawer` (`frontend/src/pages/scm-v2/DocumentHistoryDrawer.tsx`),
which holds the per-document label and status vocabulary in one registry. The
drawer is keyed on the header row's UUID, not the document number: pass the
number and it returns an empty history that looks real.

Before 2026-09-13 this did not work, and it failed silently — the frontend's
list of auditable document types was a hand-copy of the backend's and had fallen
five names behind, so nothing could ask for this document's history while the
routes were recording it. That list is now pinned by a test that reads the
backend source. Trace:
`docs/bugs/0847-four-documents-kept-a-change-log-nobody-could-read.md`, and
`docs/modules/change-log.md` for how the drawer and the company-wide page fit
together.
