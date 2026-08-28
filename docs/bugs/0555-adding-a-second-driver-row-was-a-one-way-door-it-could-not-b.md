## Adding a second driver row was a one-way door — it could not be taken back [medium]

**Symptom.** 2026-08-27, logistic (Syu) on the Setup & Dismantle crew editor:
she wanted to add a helper, mis-clicked **+ Add driver**, and then could not get
the Driver 2 row off the screen. Reported as "cannot remove the driver name".

**Root cause, traced.** `PhaseCrewEditor` hides the optional Driver 2 / Helper 2
rows until they are needed (owner 2026-07-22), keyed on a UI-only set:

```ts
const [openSlot2, setOpenSlot2] = useState<Set<string>>(new Set());
const showSlot2 = (li, kind) => setOpenSlot2((s) => new Set(s).add(`${li}${kind}`));
```

`showSlot2` was the ONLY writer, and it only ever ADDS. The row's render
condition is `!!lorry.drivers[1]?.name || openSlot2.has(...)`, so once the flag
was set nothing could clear it for the rest of the session — clearing the name
did not help, because the flag alone keeps the row up. The comment beside it
said so plainly and was treated as acceptable: *"UI-only state: collapsing back
happens by clearing the name (row hides on next open)"* — i.e. not until the
page is reloaded, which is not a thing an operator knows to do.

**Not a permission problem.** `LogisticsCrewSection.canEditLogistics` admits
position `Logistic Admin` or role `Logistic`, and the code names Syu explicitly.
She had full edit rights throughout; there was simply no control to press.

**Fix.** `CrewSlotRow` takes an optional `onRemove`, rendering an `×` beside the
name select (hidden when `readOnly`). `PhaseCrewEditor` passes `removeSlot2` for
the two slot-2 rows, which drops BOTH halves of the row's existence:

- the local `openSlot2` flag, and
- the saved entry — `l[kind].slice(0, 1)` — but only when slot 2 actually holds
  someone. An untouched row closes with no PATCH at all, because on a crew that
  has never been saved the write would persist a blank lorry card (the editor
  renders one placeholder lorry that is deliberately not persisted until filled).

Slot 1 is structural and keeps clearing through the blank `Name…` option; the
whole lorry card still goes with the `×` beside its plate.

**Desktop only.** Mobile renders the crew read-only ("Planned crew",
`MobilePMS.tsx` `CrewLine`) — there is no second editor to keep in step.

**Known, NOT fixed here.** `openSlot2` is keyed by lorry INDEX (`${li}d`), so
removing a lorry above an open slot-2 row shifts the indices under the flags and
the wrong row can appear open. Pre-existing, unchanged by this fix, and it needs
a stable per-lorry key rather than an index to close properly.

**Not verified by a run.** `node` is not installed on the machine this was
authored on — `typecheck`, `lint` and `vitest` were NOT executed, and
`PhaseCrewEditor` has no test today. **Run
`npm --prefix frontend run typecheck && npm --prefix frontend test` before
merge**, and add a case that opens a slot-2 row, removes it, and asserts both
that the row unmounts and that no PATCH fired for an empty slot.

**Ref.** 2026-08-27, `Projects.tsx` `CrewSlotRow` + `PhaseCrewEditor`;
`docs/modules/projects-pms.md` §3 "Setup & Dismantle crew editor".
