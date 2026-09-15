## DataTable zebra overpainted a ticked row and every row colour a page passed [medium]

<!-- area: Frontend + mobile -->

**Symptom.** Found while auditing 0941 for other pages whose row colours never
appear. Three row colours never painted:

- **Every table with selection.** A ticked row did not highlight.
- **Team Mailboxes.** An orphaned mailbox did not show red
  (`getRowClassName → "bg-err-bg"`).
- **Team Directory.** A selected member did not show petrol
  (`"bg-primary-soft"`).

**Root cause (traced).** DataTable puts the zebra class and the row's own colour
on the SAME `<tr>`: `rowIdx % 2 === 0 ? "bg-surface" : "bg-surface-dim/35"`, then
`isRowSelected && "bg-primary/10"`, then the page's class
(`frontend/src/components/DataTable.tsx:2772-2773` at `31352ebe3`). The phone
card does the same with a fixed `bg-surface` (`:3019`).

All of these are one-class Tailwind rules of equal specificity, so the one that
appears later in the stylesheet wins. The Tailwind build
(`tailwindcss -i src/index.css --minify`) places them in this order:

| rule | byte offset |
| --- | --- |
| `.bg-err-bg` | 47412 |
| `.bg-primary-soft` | 49768 |
| `.bg-primary/10` | 50156 |
| `.bg-surface` | 51566 |
| `.bg-surface-dim/35` | 52173 |

The zebra comes last, so it always won.

Confirmed in Chromium on the dev stylesheet: a `<tr class="bg-surface
bg-primary/10">` computes `rgb(255, 255, 255)`, and `bg-surface-dim/35
bg-err-bg` computes `rgba(227, 230, 224, 0.35)`.

The zebra has been there since the first commit. The two Team tones arrived with
#2650 (2026-08-22) and never rendered.

**Fix.** A row that has a colour of its own carries no zebra class:

- **Selected rows** get `bg-primary/10` only.
- **Other background classes.** A page class holding a `bg-` or `!bg-` utility
  replaces the zebra.
- **Other classes** (`opacity-60`, `dt-row-cancelled`, CSS-module classes) keep
  the zebra.

The phone card follows the same rule.

Pinned in `frontend/src/components/DataTable.test.tsx` ("DataTable row colours are
not overpainted by the zebra": ticked row, page background vs non-background
class, phone card). All three were RED on the unfixed DataTable and are GREEN
after.

**Not covered.** A pinned (sticky) column cell keeps its inline opaque zebra
colour, which it needs to hide the cells that scroll under it. A toned row's
pinned cells stay white. MRP's wash (0941) avoids this by painting a shadow.

**Ref.** fix/edit-order-and-mrp-colours, 2026-09-15.
