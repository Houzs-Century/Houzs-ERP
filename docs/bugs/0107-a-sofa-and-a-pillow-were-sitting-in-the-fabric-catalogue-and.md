## A sofa and a pillow were sitting in the fabric catalogue, and nothing on the write path could have stopped them [medium]

**Symptom** - a prod probe on 2026-08-13 (`probe-fabric-leftovers.mjs`) found two
rows in `scm.fabric_trackings` that are not fabrics: `SOFA 5535` described as
"5535 (3+L)", and `SQUARE PILLOW` described as `SQUARE PILLOW (16" X 16")`.
Owner: 「为什么sofa 和square pillow在fabric convert里面？」.

**Root cause (traced)** - they were not typed into the Fabric Converter. Both are
verbatim rows of `backend/_hk.json`, the 153-row dump of the HOOKKA fabric master
committed on 2026-06-23 (12f94a9c) — identical code, identical description,
identical derived id (`SOFA_5535` / `SQUARE_PILLOW`, which is
`fabric-tracking.ts`'s own `code.toUpperCase().replace(/\s+/g,'_')` minting
rule). Two AutoCount product items had been opened as "fabrics" in the source
system, and the wholesale seed carried them into Houzs because neither write path
into that table — `POST /fabric-tracking` nor `POST /fabric-tracking/bulk-upsert`
— looks at what a fabric code IS. `fabricCode` non-empty was the whole
validation. Deleting the rows would not have closed it: re-running that import,
or any spreadsheet whose product column lands under `fabric_code`, puts them
back. (`align-fabric-trackings.mjs` was ruled out as the origin — its CREATE loop
only materialises codes that are already active rows in `scm.fabric_colours`, and
that table is fed only from `fabric_trackings` itself or from hand-curated lists.
It can perpetuate a stray row, not mint one.)

**Fix** - `nonFabricCodeWord()` in `fabric-tracking.ts` refuses a fabric code
whose HEAD is a product-category word, on both write paths (400 `non_fabric_code`
on create; a per-row `errors` entry on bulk-upsert, so the rest of an import
still lands). The word list is the one
`backend/scripts/probe-fabric-leftovers.mjs:43` used to produce the owner's two
rows off the live table. The rule tests the CODE ONLY: nine of those 153 genuine
fabrics describe themselves as "SOFA FABRIC KOONA VELVET PEARL", so a
description test would have refused every one of them. `PATCH /:id/active` and
`DELETE /:id` are untouched, so the two rows already in prod stay fixable.

**Lesson** - **a seed from another system is a write path, and it inherits every
gap in the one it goes through.** The Converter's create form was never going to
be typed full of product codes; the bulk endpoint behind it was handed a whole
foreign master in one call, and the only thing standing between that file and the
price-tier join was a non-empty check. **And when the guard has to reject
something, judge the field that carries identity (the code), not the field that
carries prose (the description) — the prose was full of the exact word.**

**Ref** - 2026-08-13, this PR. Probe: `probe-fabric-leftovers.mjs` group A.
