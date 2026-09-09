## Three sales-order drawings we hold no longer exist in the account book [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The committed photo manifest snapshot holds 2,762 sales-order
picture rows. A census of the live book taken 2026-09-09 with NO checkpoint
found 2,758 photographed lines carrying 2,759 pictures. Three manifest rows
name a line the book does not show:

    SO-000383  DtlKey 34737   SO-000383__34737_1.jpg
    SO-012826  DtlKey 873098  SO-012826__873098_1.jpg
    SO-013394  DtlKey 917140  SO-013394__917140_1.jpg

**Root cause (asked of the book, not inferred).** The three keys were queried
directly, in one bounded `DtlKey IN (?,?,?)` statement:

    DtlKey=34737   DocNo=SO-000383  FurtherDescription = 230 bytes, NO picture
    DtlKey=873098  DocNo=SO-012826  FurtherDescription = 230 bytes, NO picture
    DtlKey=917140  ** no longer in SODTL — the line was deleted **

So two lines had their drawing ERASED (230 bytes is the empty RTF stub — the
same shape `SO-013495` carries), and one line was deleted outright. The census
is right and the snapshot is three rows stale. The JPEGs are also absent from
the operator store `.ac-photos/so`, so we no longer hold the pictures either.

**Why it is `medium` and not `high`.** Nothing is broken on the ERP side. The
gap probe reports SALES ORDER `MISSING 0`, and the dead-address census reports
0 dead addresses across all 839 photographed sales-order rows — the addresses
these three lines carry still name objects that exist in R2. An operator opening
those documents sees a picture. What is wrong is only that the picture is one
the account book has since withdrawn.

**Not acted on, deliberately.** The owner's rule is `一律跟账本` — the book
wins on every axis except the sofa build — which would argue for removing them.
The countervailing rule is that we never delete, only cancel, and
`prune-dead-line-photo-keys` already refuses to drop an address that would leave
a row blank precisely because that is the owner's call and not a script's. These
three would each leave their row blank. So they are REPORTED here and left
alone. Removing them needs his word.

**How it was found, and the instrument.** `backend/scripts/census-ac-line-photos.py`
walks the whole `DtlKey` range under READ UNCOMMITTED in bounded windows, with
the picture count computed server-side so the RTF never crosses the link;
`backend/scripts/lib/line-photo-census.mjs` makes the comparison, and counts a
manifest row as held only when its JPEG is really on disk. The checkpoint resume
could not have found any of this: it only ever asks for `DtlKey > last`.

**Ref.** chore/ac-photo-census-2026-09-09, 2026-09-09.
