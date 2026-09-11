## The plan run passed while the write was broken — it never exercised the cast [high]
<!-- area: Repo tooling: tests, ratchets, generators -->
<!-- status: fixed -->

**Symptom.** `close-fee-only-sales-orders.mjs` reported a clean plan against
production — 29 orders, 23 to DELIVERED, 6 to CLOSED — twice, once locally and
once through the workflow (run 34440730561, `success`). The apply immediately
after it (run 34440869582) died on the first row:

```
code: '42704', routine: 'typenameType', position: '62'
at main (close-fee-only-sales-orders.mjs:124)
```

`42704` is *undefined_object*: the script cast to `::scm.so_status` and the
column's type is **`scm.mfg_so_status`**.

**Root cause (traced).** The plan branch only ever SELECTs. The cast lives in the
UPDATE, which the plan returns before reaching. So "the plan passed" and "the
write will parse" were two different questions, and the first was being read as
evidence for the second — the exact trap CLAUDE.md names as *the check that
answers a different question*.

**What it cost, and what it nearly cost.** Nothing was written: the failure hit
the first row of the loop, and a re-read confirmed **0** company-1 orders moved to
DELIVERED/CLOSED in the ten minutes around the run. That is luck, not design — the
same script fails identically on the LAST row of a loop that has already written
28, and this one has no transaction around the batch. A plan whose green cannot
distinguish those two outcomes is not a rehearsal.

**Fix.** The plan now casts every target status it is about to use, against the
real type, before it prints its verdict:

```js
for (const status of [...new Set(rows.map((r) => r.to_status))]) {
  const [{ ok }] = await sql`SELECT ${status}::scm.mfg_so_status::text AS ok`;
  if (ok !== status) throw new Error(`status cast check failed for ${status}`);
}
```

A wrong type name now fails in plan, with no rows at risk, and the log names the
type it checked against.

**The general shape, for the next script.** A plan mode earns its green only for
the statements it actually executes. Where the write path has a piece the read
path does not touch — a cast, an enum value, a NOT NULL column, a constraint —
the plan has to exercise that piece explicitly or say it did not. Release
discipline already demands a plan default, a CONFIRM phrase, a fresh-connection
shape check and a RE-RUN line; none of those four asks whether the plan covers
the write, and this is the gap that showed.

**Verification.** Re-ran the plan against production with the check in place:

```
mode=plan company=1
orders whose GOODS are all delivered and only a charge line is open: 29
  -> DELIVERED (something shipped): 23
  -> CLOSED    (nothing ever shipped): 6
status cast checked against scm.mfg_so_status: DELIVERED, CLOSED
```

The cast itself was confirmed read-only first: `SELECT 'DELIVERED'::scm.mfg_so_status`
returns `DELIVERED`, and `pg_attribute` gives the column's type as
`scm.mfg_so_status`. The apply run is dispatched after this lands; its run id goes
in `docs/bugs/0775`.

**Ref.** `fix/close-fee-only-so-enum-cast`, 2026-09-10. The script it fixes is
`docs/bugs/0775`.
