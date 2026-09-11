# The drawings are NOT only on sales orders — 2026-09-09

「确定是SO而已？」 — the owner, after it was found that the build the factory works
from is a photograph of the handwritten slip pasted into the document LINE's own
rich-text field, `<TYPE>DTL.FurtherDescription`.

**The answer is no.** Measured against the live book `AED_HOUZS` on 2026-09-09,
with the same predicate `export-ac-line-photos.py` uses (`FurtherDescription
LIKE '%{\pict%'`):

| detail table | lines | lines holding rich text | **lines carrying a DRAWING** | ever exported? |
| --- | ---: | ---: | ---: | --- |
| `SODTL` | 62,769 | 27,743 | 2,758 | yes — the exporter reads this |
| `PODTL` | 18,890 | 11,993 | 2,411 | yes — the exporter reads this |
| **`GRDTL`** | 21,746 | 12,423 | **2,337** | **never** |
| **`DODTL`** | 48,822 | 19,915 | **2,194** | **never** |
| **`IVDTL`** | 45,950 | 17,605 | **1,952** | **never** |
| **`PIDTL`** | 22,633 | 12,279 | **2,298** | **never** |

**8,781 drawings on receipts, delivery orders and invoices have never been taken
out of the book.** Reproduce with `backend/scripts/count-ac-line-pictures.py`
(read-only; `SODTL`/`PODTL` are printed as the control — if those two ever stop
matching the exporter's manifest the predicate has drifted).

Company 1 vs the rest, by the header's own DocNo prefix — the filter the
exporter applies (`NOT LIKE 'HC-%'`, `NOT LIKE 'ZZ%'`):
`GRDTL` GR-=2,336 GGR=1 · `DODTL` DO-=2,186 D0-=3 HC-=5 · `IVDTL` I-2=1,931
I-0=21 · `PIDTL` PI-=2,298. Only 5 delivery-order lines fall outside company 1.

## The part that turns this into work: 14 of the 17 lines the tally says it CANNOT READ have a drawing

The `CANNOT BE COMPARED` column names the book's own `DtlKey` on every row. So
the question is not statistical — it can be asked of the exact line. Run
`34297150727` (2026-09-09 00:57 UTC), every named line, checked directly:

| table | `DtlKey` the tally named | book DocNo | `FurtherDescription` | drawing? |
| --- | ---: | --- | ---: | --- |
| `GRDTL` | 84952 | GR-000287 | empty | no |
| `GRDTL` | 242896 | GR-000997 | 853,670 B | **YES** |
| `GRDTL` | 846992 | GR-004863 | 1,508,142 B | **YES** |
| `GRDTL` | 892337 | GR-005209 | 692,158 B | **YES** |
| `GRDTL` | 913241 | GR-005303 | 692,160 B | **YES** |
| `GRDTL` | 913784 | GR-005306 | 519,360 B | **YES** |
| `DODTL` | 71412 | DO-000542 | empty | no |
| `DODTL` | 250972 | DO-002158 | 444,482 B | **YES** |
| `DODTL` | 740452 | DO-009112 | 516,478 B | **YES** |
| `DODTL` | 875518 | DO-010936 | 530,878 B | **YES** |
| `DODTL` | 875520 | DO-010936 | 450,238 B | **YES** |
| `DODTL` | 924640 | DO-011518 | 522,238 B | **YES** |
| `DODTL` | 927365 | HC-DO-2609-011 | 588,478 B | **YES** |
| `IVDTL` | 81589 | I-000745 | empty | no |
| `IVDTL` | 265177 | I-2412-0065 | 444,482 B | **YES** |
| `PIDTL` | 839093 | PI-007114 | 689,278 B | **YES** |
| `PIDTL` | 839095 | PI-007114 | 692,158 B | **YES** |

**14 of 17.** The three empties (84952 / 71412 / 81589) are the SAME sale seen
as receipt, delivery order and invoice — `5526-L(LHF)`, note "T" — so its slip
is on the sales-order line, which the other lane is already rescanning.

Every one of these was recorded as *"your drawing decides these"*. The drawing
existed the whole time, in the book, on the line the checker was reading.

## The whole open list, by document

Documents the tally currently holds open that carry at least one drawing:

| type | DIFFER | CANNOT BE COMPARED |
| --- | --- | --- |
| GR | **5 of 11** (15 drawing lines) | **5 of 6** (11) |
| DO | **8 of 12** (9) | **5 of 6** (7) |
| SI (`IV`) | **3 of 12** (5) | **1 of 2** (1) |
| PI | **12 of the 20 named** (16) | **1 of 1** (2) |

**40 of the 70 open documents this lane could name carry a drawing — 66 drawing
lines in total.** The PI `DIFFER` column holds 48 documents; the verdict log
prints only the first 20 (`SHOW`), and this lane did NOT raise it, because
`po-gr-tally-verdict.yml` declares `concurrency: cancel-in-progress: true` and
dispatching it would have killed another lane's run.

**NOT MEASURED, and not guessed:** how many of the four tables' 8,781 drawings
sit on an in-scope migrated document overall. That needs the ERP's own list of
compared documents (GR 400, DO 186, IV 45, PI 55 per run `34297150727`), and
`DATABASE_URL` exists only as a GitHub secret — no local DSN, and the only
workflow that reads it is the one this lane must not dispatch. The 70 named
above are exact; the population figure is owed by whoever runs the tally next.

## Three decoded, to show what is on them

Extracted with the repo's own tested reader (`lib/rtf-picture.mjs` via
`further-description-rtf.mjs inspect --extract`) and the exporter's own
`wmf_to_jpeg`. No second decoder was written. All three are `wmetafile8` and all
three came out through the DIB path, no GDI fallback.

| line | book Desc2 — all the ERP had | the drawing says |
| --- | --- | --- |
| `GRDTL` 913784 · GR-005306 · `AMN-SF9058` | `colour : MODENZA 01- Houston Cream / wrap bottom to Nilon` | a five-piece sofa layout sketched as blocks, plus handwritten notes. The checker's complaint on this line was literally *"no structure tokens"* — the structure is in the picture |
| `DODTL` 927365 · HC-DO-2609-011 · `DSL-8051` | `STOOL/B0315-3` | the stool drawn to size, dimensioned 28" x 30". The ERP holds `STOOL` and no size at all |
| `PIDTL` 839095 · PI-007114 · `DSL-8050` | `BO315-11 metal/75cm/1S` | `DSL 8050 (1S(R))`, the R piece boxed at 75cm, and three specials the Desc2 never mentions: nylon fabric at bottom, seat firmer 20%, headrest firmer 10% |

The third one is the pattern in one row: the book's text carried the size, and
the drawing carried three build instructions the factory needs and the ERP does
not hold.

## Handover — this lane built no exporter, deliberately

`export-ac-line-photos.py` is keyed to `SIDES = {so, po}`. Extending it to the
other four is the sales/purchase lane's machinery to extend; a second uploader
is the duplication this repo has already paid for. What is handed over:

1. `backend/scripts/count-ac-line-pictures.py` — the count, re-runnable, and a
   `DOCS=` mode that answers it per document.
2. The 14 `DtlKey`s above — the shortest possible first batch, because each one
   is a document the owner is currently being asked to adjudicate by hand.
3. The predicate and the WMF form are unchanged from `SODTL`/`PODTL`, so the
   existing extract path works as-is; only the table names are new.

Nothing was written to AutoCount. Every query above ran READ UNCOMMITTED in
bounded `DtlKey` windows and never selected an RTF body except for the three
samples.
