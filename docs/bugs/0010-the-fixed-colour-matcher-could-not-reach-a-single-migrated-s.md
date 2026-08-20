## The fixed colour matcher could not reach a single migrated SOFA line [high]

**Symptom** — the shared matcher landed and 18 genuinely-missing colours were
created on the same day, and the number of migrated sofa lines carrying a bound
fabric did not move. Both fixes were real; neither was visible in the data.

**Root cause (traced, not guessed)** — nothing sweeps sofa.
`refresh-so-variants.mjs` re-parses and re-stamps the migrated lines, but its
`WHERE` is `item_group = 'bedframe' OR item_code ILIKE '%(SP)%'`, and
`refresh-po-variants.mjs` is `item_group = 'bedframe'` alone. There has never
been a sofa equivalent, so a matcher improvement could only ever reach rows
created AFTER it — and company 1's sofa rows were all created during the
cutover, before it. The entry below fixed which matcher the writers call; this
one is about there being no writer at all for these rows.

**Fix** — `backend/scripts/refresh-sofa-colours.mjs` +
`.github/workflows/refresh-sofa-colours.yml`. It reads the colour out of the
line's OWN `description2` through the shared sofa decoder (`parse-sofa.mjs`,
`o.color` — not a private regex, that extraction has been copied enough times
already), resolves it through the shared matcher, and writes the same five keys
the SO importer writes (`fabricId`, `colourId`, `fabricCode`, `colourLabel`,
`fabricLabel`) on both `scm.mfg_sales_order_items` and
`scm.purchase_order_items`. Three rules it holds to:

1. **Fill only, never overwrite.** A line holding any of fabricId / colourId /
   fabricCode is skipped, and the UPDATE repeats that test in SQL so a pick made
   between the scan and the write still wins.
2. **Merge, do not rewrite.** `variants = variants || $1::jsonb`, so seatHeight,
   specials and buildKey survive. A sofa line's variants block is not ours alone.
3. **TBC / KIV is an answer.** It means not chosen yet; those lines are counted
   and left blank rather than being reported as a matcher miss.

**The class, for next time** — a fix to a shared decoder changes what the system
would import today. It changes NOTHING about the rows already stored. Every such
fix needs its sweep named in the same PR, or the improvement is real and
invisible.

**Ref** — 2026-08-10, PR #1903 (feat/restamp-sofa-colours).
