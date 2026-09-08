## A special order the picker has a code for was carried as free text, so the book reads as unmet [low]

<!-- status: open -->

<!-- area: AutoCount sync + write-back -->

**白话.** `HC-SO-013496` 那张单，账本写「change 8030 back rest」，选项表里本来就有
这个选项，叫「Change 8030 Backcushion」，而且是**免费**的。可是那条 line 上写的是
人手打的 `CHANGE8030BACKREST` —— 意思一样，字不一样。对账程式认字不认意思，就报
「账本要的这个选项，单上没有」。**东西没做错，是写法没跟选项表。** 老板的规矩是：
选项表里没有的才用自由文字写进去；有的就要用选项表的。

**Symptom.** The sales-order tally reports it as the one specials difference:

```
SO-013496 DtlKey 926843 (ERP HC-SO-013496 9058-1S):
  AutoCount "change 8030 back rest Nilon bottom HR 805-90"
  vs ERP "Nilon bottom | CHANGE8030BACKREST | Nylon Fabric | ..."
  — the book asks for Change 8030 Backcushion and the line does not carry it
```

**Root cause (measured on production, not inferred).** Probe run `34249150622`
read the live `scm.special_addons` for company 1:

| what | measured |
| --- | --- |
| rows matching `change 8030` / `8030 back` in ANY category | **1** — `Change 8030 Backcushion` |
| is `CHANGE8030BACKREST` a live option code? | **no**, in no category |
| `Change 8030 Backcushion` | `active=true`, `categories=["SOFA"]`, `selling_price_sen=0`, `cost_price_sen=0` |

So the line holds a hand-typed spelling of an option the picker already carries.
`check-ac-erp-reconcile.mjs`'s `specialCarried` compares on `skey` — letters and
digits only, `nilon` folded to `nylon` — and asks whether either spelling
contains the other. `CHANGE8030BACKCUSHION` and `CHANGE8030BACKREST` contain
neither, correctly: "backrest" and "backcushion" are different words, and a
matcher loose enough to call them equal would call other options equal too.

The comparison is right. **The line's data is what is wrong**, and only in its
spelling: 「没有的才用 customs others 那边写进去」 — free text is for what the
picker has NO code for.

**Fix.** `backend/scripts/align-line-specials-to-catalogue.mjs` replaces the
free-text spelling with the catalogue's own code in `variants.specials`, from an
allow-list naming each line by DocNo and DtlKey
(`data/line-specials-spelling.json`).

The money guarantee is a GATE, not an afterwards-check: only a target whose
`selling_price_sen` AND `cost_price_sen` are both zero may be written, so a
repriceable option is impossible rather than merely unobserved. A priced one is
refused and named — stamping a priced code into `variants.specials` is how a
document reprices itself on its next edit, which is the case the owner's
2026-09-03 ruling 甲 exists for, and it is his decision, not this script's.
Three further refusals: the target must exist, be `active`, and carry the line's
own item-group category.

Only `variants.specials` is written. `custom_specials` is DERIVED from it and is
nulled whenever that array is empty, so a value written there directly is one
edit away from vanishing. The line's two other specials are untouched —
`Nylon Fabric` is already a live code, and `Nilon bottom` is free text the picker
has no code for, which is exactly what the owner said free text is for.

**Ref.** `fix/so-last-6-and-gr-transpose`, 2026-09-08. Catalogue measured in
probe run `34249150622`. Marked `open` until the apply run is pasted here — the
writer exists and has not yet been run against production at the time of writing.
