## The reconcile graded the header-master fields against a different cut from the one their writer reads [medium]

**Symptom.** `sync-ac-delta` lane `hdr` was run against production on 2026-09-08
(run `34183057067`) and wrote **43 header field values across 17 documents** —
`attention` 12, `remark4` 15, `sales_exemption_expiry` 15, `remark2` 1 — every
one of them the book's own value, value-guarded, with `0 skipped because the ERP
value moved after the plan was read`.

The reconcile immediately afterwards (`34183180046`) read, on PROCEEDED company-1
sales orders:

| field | before the write | after the write |
| --- | --- | --- |
| `attention` ERP blank | 12 | **0** |
| `sales exemption expiry` differ | 0 | **13** |
| `remark4` differ | 0 | **3** (+10 "ERP holds a value the book does not") |
| `remark2` differ | 0 | **1** |
| SO copied fields, total differ | 42 | **59** |

Filling a real gap made the backlog go UP by 17. The `attention` half is the
write working; the other 17 are not the ERP being wrong.

**Root cause (traced).** Two committed AutoCount snapshots carry these fields,
cut at different times, and the writer and the checker were reading different
ones.

- `sync-ac-delta.mjs`'s hdr lane copies remark2/3/4, `UDF_Note` and
  `SalesExemptionExpiryDate` out of **`data/ac-doc-headers.json.gz`** —
  `exportedAt 2026-09-08T08:02:45+08:00`, 13,365 sales orders.
- `lib/ac-field-identity-run.mjs` compared them against
  **`data/ac-so-remarks.json.gz`** — a narrower cut, last moved 2026-09-07
  17:48, 2,789 sales orders:

```js
const rem = remByDoc.get(d);
if (rem) Object.assign(h, { Remark2: rem.Remark2, Remark3: rem.Remark3, Remark4: rem.Remark4,
                            UDF_Note: rem.UDF_Note, SalesExemptionExpiryDate: rem.SalesExemptionExpiryDate });
```

The header-master cut IS loaded right above, but merged FILL-ONLY, so a key the
older cut had already set was never reconsidered.

Diffed on the committed files, the two snapshots disagree on exactly:

```
ac-so-remarks (older) vs ac-doc-headers (fresher):
  {"Remark2":1,"Remark4":13,"Seed":13}
    SO-008243 Remark4 old=null fresh=Pending Customer Reply (D)
    SO-008243 SEED   old=2026-09-15 fresh=2026-09-12
    SO-008282 SEED   old=2026-09-14 fresh=2026-09-12
```

1 + 13 + 13 = 27 book values, of which the 17 on PROCEEDED in-scope orders are
precisely the 17 the reconcile started reporting. **Grading a writer against a
source the writer never read measures the gap between two snapshots, not the gap
between the book and the ERP.**

**Fix.** The five header-master fields are read from `ac-doc-headers.json.gz`
where it carries the document, with `ac-so-remarks.json.gz` as the fallback — so
the checker reads the cut the writer reads. The header cut is optional by
design; a checkout without it behaves exactly as before.

The FILL-ONLY rule for every OTHER field is untouched: the migration exports
stay the authority for anything an importer read at insert, which is the whole
reason this section takes them rather than a convenience snapshot.

**Same root cause as `docs/bugs/0687`, one layer up.** There the WRITER read a
staler cut than the checker; here the CHECKER read a staler cut than the writer.
Both are the same rule: a tool and the check that grades it must read one cut,
and whichever is fresher must be the one both use.

**Ref.** fix/recon-remark-source, 2026-09-08. Runs: `34183057067` (the hdr
write), `34183180046` (the reconcile that reported the 17).
