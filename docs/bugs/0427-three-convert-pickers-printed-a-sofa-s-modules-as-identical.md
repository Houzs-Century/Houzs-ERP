## Three convert pickers printed a sofa's modules as identical rows — no variants shown [high]

<!-- area: Sofa, fabric, variants -->

**白话.** 一张沙发拆成好几个 module（9028-1A(LHF)、9028-1A(RHF)、9028-1NA），名字
一模一样，分别只在布码、座高、脚高。以前有三个转单画面只印名字不印这些，所以老板在收货
的时候看到的是三行长得一样的东西，根本分不出在收哪一个。手机上更严重：手机的转单精灵
（SO→DO、SO→PO、DO→SI、PO→GRN 四个全部）连一行 variant 都没有。现在这三个画面都补上
了跟其他画面同一条 variant 文字，资料本来就有，不用改后端。

**Symptom.** Owner rule, 2026-08-19: *"我们全部 Transaction Workflow 该有的相关
文件，by right 应该都是要有那些 variants 的… 只要有 variants 的，你就应该要显示
variants"*. Three line-pickers rendered only a name: a sofa model's modules came
out as N identical-looking rows, and the operator ticking one was guessing.

**Root cause (traced in source, and the "the data isn't there" theory refuted by
reading the handlers).** Two separate misses, both purely display-side:

- `PurchaseConsignmentReceiveFromOrder.tsx` and
  `PurchaseConsignmentReturnFromReceive.tsx` printed `r.materialName` alone and
  used `r.description` only inside `searchValue`. Neither imported
  `VariantDescription`, which the other ten `*From*.tsx` pickers all use.
- `MobileConvertWizard.tsx` — the phone's ONLY create-by-convert surface for DO,
  SI, GRN and PO — threw the fields away at the map: its local `PickLine` had
  `label: description || itemCode` and no variant field at all, and its
  `SoDeliverableLine` / `DoInvoiceableLine` / `OutstandingSoLine` payload types
  omitted `itemGroup` and `variants`. The GRN branch's `GrnPickLine` *did* carry
  both (the create needs them) and still printed neither.

The variants were never missing from the wire. All four reads already select and
return them — `routes/delivery-orders-mfg.ts:2258/:2266`,
`lib/do-line-remaining.ts:292/:303`, `routes/mfg-purchase-orders.ts:694/:699`,
`lib/outstanding-po-lines.ts:418`, `routes/purchase-consignment-receives.ts:601/:628`,
`routes/purchase-consignment-returns.ts:340/:366`. Every one was read in the
handler, not inferred from a payload type: a field in a TS type is not a field
on the wire, and a rendered `<VariantDescription>` over a row whose endpoint
never selected `variants` shows nothing and looks exactly like a missing
component. The other nine pickers were audited the same way and all pass.

**Fix.** The two consignment pickers get the same `VariantDescription` the other
ten use (and the summary joins their `searchValue`, so searching `SEAT 24"`
finds the row). The mobile wizard carries `itemGroup` + `variants` through the
map and prints the shared `buildVariantSummary` string under the name on ALL
FOUR targets — the same string the desktop renders, so the two surfaces cannot
word a module differently. On the phone the line is omitted when the summary is
empty rather than printing `Standard` filler (the existing mobile convention,
`MobileModuleDetail.tsx:491`). No endpoint changed; no money touched.

**Test.** `frontend/src/pages/scm-v2/convertPickerVariants.test.tsx` and
`frontend/src/mobile/mobileConvertWizardVariants.test.tsx` mount the REAL
screens with only the data hook / `authedFetch` faked, and assert the operator
SEES `PC151-01 Pearl / SEAT 24" / LEG 6"` — not that a component is imported,
which is the half-fix these files exist to keep out. One case uses a BEDFRAME
bag so a wrong `item_group` (which silently renders the wrong summary branch)
fails too. All six cases fail on the pre-fix files, verified by reverting each
file and re-running: `Unable to find an element with the text: PC151-01 Pearl /
SEAT 24" / LEG 6"`, while the sibling assertion that both rows print the shared
name `9028 SOFA` still passed — so the harness was rendering and only the
variant line was absent.

**Ref.** 2026-08-19, branch `fix/variants-on-every-picker`.
