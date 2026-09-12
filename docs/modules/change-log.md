# Change log — who changed which document since we opened

`backend/src/scm/routes/change-log.ts`, mounted at `/api/scm/change-log`.
Desktop `frontend/src/pages/ChangeLog.tsx`, phone
`frontend/src/mobile/MobileChangeLog.tsx`, shared layer
`frontend/src/lib/changeLog.ts`.

The owner asked for it on 2026-09-08, when he opened sales orders, delivery
orders, purchase orders and goods receipts to his staff:

> 做可以监督到这期间我们打开系统的数据跟之前谁改了东西 谁改了 都根据他们改的数据为
> 最高标准 跟着

Two things in one sentence. He wants to be able to WATCH what staff change — and
he reversed the direction of authority while he was at it: **from the moment the
system is open, a change a person makes in the ERP is the highest standard, and
AutoCount follows it.** This guide covers the watching half. The following half —
the delta sync refusing to overwrite a person, and pushing their value out to the
account book instead — is `docs/modules/autocount-writeback.md` and
`backend/scripts/sync-ac-delta.mjs`.

---

## What this module is FOR

Answering one question that nothing else in the repo could answer: **what has
been changed across the company since a date.** The History drawer and
`GET /entity-audit-log/:type/:id` both read the same trails ONE DOCUMENT AT A
TIME, which is useless for supervision — you have to already know which document
to open.

It is READ-ONLY and always will be. Both audit tables are append-only by intent.

---

## THE ONE THING THAT MAKES OR BREAKS IT: person versus machine

**The audit trail is not a staff signal.** `recomputeSoStockAllocation` writes
`UPDATE_LINE` and `UPDATE_STATUS` rows with exactly the shape a person's edit
produces — `backend/src/scm/lib/so-stock-allocation.ts:998` and `:1082`. A
comment claiming otherwise was reasoning rather than observation, and the check
written on it reported *"50 staff actions on migrated orders"* when all fifty
were the cron (#3177, run `34183368917`). It was corrected to read **0 people,
50 system**.

So the split is the product here, not a detail, and it has **ONE HOME**:

```
backend/src/scm/shared/audit-author.ts
```

**The rule.** A row is MACHINE-written when `actor_name_snapshot` starts with
`system` (case-insensitive). Everything else is a PERSON — including a row with
no name at all, deliberately, because that is the direction that SURFACES a
change rather than hiding it.

**`actor_id` is not consulted, and cannot be.** `scm/middleware/auth.ts` pins
`SCM_SYSTEM_STAFF_ID` (`00000000-0000-4000-8000-000000000001`) onto
`c.get('user').id` for every authenticated SCM caller, and all 21
`recordSoAudit` call sites in `routes/mfg-sales-orders.ts` pass
`actorId: user.id`. The column is a constant.

**That is MEASURED, not read.** `backend/src/scm/shared/audit-author.test.ts`
runs the real `supabaseAuth` middleware over a caller whose Houzs id is 4242 and
asserts what comes back. It is an executed assertion because the claim has been
wrong twice, in opposite directions, and both times it was settled by reading a
file: reading `actor_id` as authorship is what made the delta sync's
never-overwrite-a-human veto refuse nothing at all — first through
`!actor_id` (`docs/bugs/0700`, `docs/bugs/0702`), then through
`actor_id === MIGRATION_ACTOR_ID` (`docs/bugs/0704`).

**`version` is not consulted either, anywhere.** It is an optimistic-locking
token bumped by seven automated paths; `check-so-version-provenance.mjs` (#3042)
measured 80 of 81 "conflicts" as the allocation sweep and exactly one as a
person.

**`source` is REPORTED and decides nothing.** It is a free-form column with 30+
live spellings, several of which are not audit sources at all. Making it a second
arm of the rule would be a second rule wearing the first one's name.

The three readers of the rule: this route,
`scripts/check-so-open-for-new.mjs`, and `scripts/sync-ac-delta.mjs` through
`scripts/lib/ac-human-edit.mjs` — which keeps the field aliasing, the
per-(document, field) index and the refusal wording (none of them decisions) and
delegates only the authorship question. The two scripts import the `.ts` module
and are therefore run with `npx tsx`, not `node`.

The module sits in `src/scm/shared/` rather than `scripts/lib/` for one
mechanical reason: this route runs in the WORKER and a Worker bundle cannot
import out of `backend/scripts`, while a script CAN import a `.ts`. That is the
only direction in which all three callers get one answer.

**And the push half now has to SAY it is a push (2026-09-09).** Every client
`scripts/lib/pgrest-shim.mjs` builds is a *repair* client by default, and a
repair client cannot queue an AutoCount write-back at all — a repair copies a
value out of the account book, so sending it back overwrites the owner's source
of truth (owner: 「你不可以有记录再这边啊 这是你import进来的错误」). That default
would have silenced this module's push half too, so `sync-ac-delta.mjs` opts
back in explicitly, and only on the lane that means it:

```js
// inside if (LANES.has("push")) — every OTHER lane stays suppressed
const sb = pgrestShim(sql, "scm", { writeback: "enqueue" });
```

The direction of authority the owner set — a person's ERP edit is the highest
standard and AutoCount follows it — is exactly what that opt-in preserves. It
is pinned by `backend/tests/acWritebackPushAllowlist.test.mjs`; the mechanism is
`docs/modules/autocount-writeback.md` §4b.

---

## The surface

| route | gate | what it answers |
| --- | --- | --- |
| `GET /api/scm/change-log` | `scm.changelog.read` **or** `settings.manage` (or `*`) | who changed which document, when, and from what to what, over a window |

Query parameters, all optional, all with a decided default:

| parameter | default | values |
| --- | --- | --- |
| `hours` | `168` (7 days), max `2880` | any positive integer |
| `author` | `person` | `person` \| `machine` \| `all` |
| `docType` | every type | `SO`, `PO`, `DO`, `GRN` (comma-separated), or `all` |

An unrecognised `docType` returns EVERYTHING rather than nothing: an empty list
would render as "nobody changed anything", which is the most misleading answer
this endpoint can give.

### The permission

`scm.changelog.read` is catalogued in `backend/src/services/permissions.ts`. It
is its OWN key rather than riding `scm.autocount.read` (watching the account-book
queue and watching your colleagues are different grants) and rather than riding
an SCM area key (a change log spans every area at once). Owner and IT Admin pass
via `*`.

There is **no `scmAreaGuard`** on the route, for `/autocount-outbox`'s reason:
an L2 area key is a PAGE key, and this page belongs to no single SCM area.

### Where it appears

| surface | file | how it is gated |
| --- | --- | --- |
| desktop nav row, `system` section, beside AutoCount Sync | `frontend/src/components/Sidebar.tsx` | `anyPerm: ["*", "scm.changelog.read", "settings.manage"]` |
| desktop route `/change-log` | `frontend/src/App.tsx` | the same three, on a `<Guard>` |
| phone menu row, `System` group | `frontend/src/mobile/MobileApp.tsx` | the live `NAV_TABS` entry for `/change-log` |
| phone screen | `frontend/src/mobile/MobileApp.tsx` | the SCREEN is guarded too, not only the row — a `/change-log` URL must not mount the page or fire its query for someone the endpoint would 403. `TabLocked`, not hidden. |

All four mirror the two keys the endpoint accepts. **None of them is the
boundary** — the server checks the same keys against the REAL caller and returns
403 — so a divergence costs a visible-but-empty page, never access.

---

## Two tables, one answer

| document | table | key |
| --- | --- | --- |
| sales order | `scm.mfg_so_audit_log` | `so_doc_no` |
| everything else | `scm.entity_audit_log` (migration 0139) | `(entity_type, entity_id)`, with `entity_doc_no` alongside |

The column sets are deliberately identical — 0139's header says so — which is
what makes one merged reading honest rather than two half-answers stitched
together. `ENTITY_DOC_TYPES` in the route maps `PO`/`DO`/`GRN` to
`PURCHASE_ORDER`/`DELIVERY_ORDER`/`GRN`; `SO` is absent from it because it lives
in the other table entirely.

`entity_doc_no` is nullable (a create can record before its number is minted), so
the route falls back to the uuid rather than dropping the row — dropping it would
hide the CREATION of a document from a change log.

---

## Three things the response never does

1. **Report a filtered count as the whole truth.** `changesByPerson` and
   `changesBySystem` are both always present and are computed BEFORE the
   `author` filter is applied. That is the direct fix for the "50 staff actions"
   shape.
2. **Stop silently.** `totals.truncated` is true when a read came back with
   fewer rows than the window holds, and both surfaces then print that every
   count is a floor and not a total.

   **It is measured against the server's own exact count** (`count: 'exact'`,
   i.e. Content-Range), per read, and OR'd across the two — never against
   `ROW_CAP`. `ROW_CAP` (4,000) bounds our appetite; PostgREST enforces its own
   `db-max-rows` underneath it, so a read can stop early far below 4,000. The
   flag WAS `rows.length >= ROW_CAP`, and that could not fire: `rows` is the sum
   of two reads each capped by the server, so at the 1,000 this repo assumes
   (`lib/paginate-all.ts` PAGE, still unmeasured — `docs/bugs/0447`) the sum tops
   out at 2,000. It was also wrong the other way for a larger ceiling, comparing
   a two-read SUM with a one-read cap. Same device as `so-handover.ts`
   `/preview`, which has always done it correctly.
3. **Leak finance detail.** `stripAuditFinance` runs on the merged rows, exactly
   as `/entity-audit-log` runs it — stripping the detail while leaving the
   history just moves the leak one endpoint over.

Company scope is `scopeToCompany`, the app-layer predicate. The SCM client is
service-role, so RLS is bypassed and that predicate is the entire boundary.

---

## The two surfaces

One shared layer, `frontend/src/lib/changeLog.ts`: the hook, the window options,
the document-type vocabulary, the verb labels, the field labels, `clWhen` and the
verdict sentence.
The pages hold presentation only — a table on the desktop, cards on a phone,
because a table does not fit 375 px.

Filters live in the URL on the desktop (URL is state) and in component state on
the phone (the mobile shell has no router), with the DEFAULTS coming from the
shared layer so both open on the same view.

**Times are Malaysia local, always, in THE repo's one date format** — `clWhen`
is `fmtDateTime` from `frontend/src/vendor/shared/format.ts`, which converts
through `mytParts`. A UTC stamp here would have the owner doing arithmetic to
decide whether a change happened during working hours; a second formatter here
would be a second date format, which `backend/scripts/check-date-formatting.mjs`
gates against — and did, on the first draft of this file. The surfaces say MYT
once, in the column heading, rather than on every row.

**An unknown verb or field renders as ITSELF.** A renderer that silently swallows
a verb it has not met makes a new kind of change invisible on the one page that
exists to show changes.

Tests: `frontend/src/lib/changeLog.test.ts` (the words and the verdict),
`frontend/src/pages/changeLog.test.tsx` (both surfaces, from the same fixtures),
`backend/src/scm/shared/audit-author.test.ts` (the rule, with every machine
writer in the tree pinned verbatim, and the overwrite proved red then green).

---

## What this module does NOT do

- It does not show WHY a change was made. `note` exists on both tables and is
  not yet surfaced.
- It does not cover sales invoices, purchase invoices, payment vouchers, stock
  takes or transfers. They all record into `entity_audit_log` and adding one is
  a line in `ENTITY_DOC_TYPES` plus a label — deliberately not done here,
  because the owner named four document kinds and a supervision page that shows
  more than he asked for is harder to read, not easier.
- It does not page. A window plus a document-type filter is the navigation; the
  truncation note says when that is not enough.

---

## The PER-DOCUMENT drawer, and the four documents that lacked it until 2026-09-13

This page answers "what changed across the company". The other half of the
owner's 2026-09-12 ruling — 「change log 应该全部都要有」 — is the drawer on the
document itself, and it was missing on four of the six documents.

**What was wrong.** `AuditEntityType` in
`frontend/src/vendor/scm/lib/entity-audit-queries.ts` was a hand-copy of the
backend's `ENTITY_TYPES` and had fallen five names behind. The purchase order,
purchase invoice, sales invoice and delivery order could not be NAMED by the
frontend, so nothing asked for their history — while the routes had been
recording it all along. The delivery order showed a "Change history" modal
synthesized from its own current columns, which is worse than none: it read as
events and changed retrospectively when a date was edited. Full trace:
`docs/bugs/0847-four-documents-kept-a-change-log-nobody-could-read.md`.

**How it is wired now.**

| piece | file |
| --- | --- |
| the list, exported as a VALUE both sides can be compared against | `frontend/src/vendor/scm/lib/entity-audit-queries.ts` |
| the drift guard — reads the backend source, fails on any difference | `frontend/src/vendor/scm/lib/entity-audit-queries.test.ts` |
| one registry: entity name, labels, status vocabulary, per document | `frontend/src/pages/scm-v2/DocumentHistoryDrawer.tsx` |
| the four document vocabularies | `frontend/src/pages/scm-v2/document-audit-labels.ts` |
| the four money/stock vocabularies | `frontend/src/pages/scm-v2/entity-audit-labels.ts` |

A page mounts it in one line with the document's UUID — **not** its document
number, which returns an empty history that looks real.

**Adding a document is a row in `DOCS`,** plus a label dictionary. The registry's
key type is a SUBSET of `AuditEntityType` on purpose: `PURCHASE_RETURN` and
`INVENTORY_ADJUSTMENT` are recorded write-only and no screen asks for them, so
the compiler refuses a `doc` this file cannot render rather than shipping a
drawer with no vocabulary.

**The label dictionaries are checked against the backend, not just written.**
`DocumentHistoryDrawer.test.tsx` reads each route's alias tuples
(`PO_AUDIT_FIELDS`, `SI_AUDIT_FIELDS`, `PI_AUDIT_FIELDS`, `DO_AUDIT_FIELDS`) and
fails if a header field the route diffs has no label here. Line changes arrive
under the SAME keys as header changes — the line's identity is in the entry NOTE
("Line edited: HZ-SOFA-01"), not in the field name — so one dictionary per
document covers both.
