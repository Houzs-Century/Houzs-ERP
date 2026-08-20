## The /mine view-all branch queried the wrong schema, so the first director to use it got a 500 [high]

**Symptom.** Minutes after #2359 deployed, the POS My-orders board failed to
load for a Sales Director on "All salespeople":
`500 {"error":"load_failed","reason":"column mfg_sales_orders.company_id does not exist"}`.

**Root cause (traced, not guessed).** The view-all branch of
`GET /mfg-sales-orders/mine` swapped in its own client:

    const admin = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, ...)

Ported 2990 logic: there, the request client was RLS-scoped, so view-all needed
a service-role client. In Houzs both premises are false. `sb` already IS the
service-role client, and — the actual break — `getSupabaseService` pins
`db: { schema: 'scm' }` while a raw `createClient` defaults to PUBLIC, where
Houzs's own AutoCount-named tables live and `mfg_sales_orders` has no
`company_id`. So the branch was not redundant-but-harmless; it pointed the whole
board at the wrong schema.

It never fired before #2359 because the gate in front of it was the bare
`scm.so.view_all` flat key, which no caller held. The gate was widened to the
director tier, the branch became reachable, and its first caller ever found the
bug. Latent since the port.

**Fix.** The branch no longer builds a client — it only sets the scope flags,
and every query in `/mine` rides `sb`. Net-negative lines (the file is under the
shrink-only size gate). The structural test gains a third assertion: the /mine
block must not assign a `createClient(` of its own, so the ported pattern cannot
come back.

**Residual risk, and what holds it.** The same ported `createClient` shape
exists once more in this file (the one-shot SKU mint probe, ~:5330) and its
failure is deliberately swallowed ("never fail the SO on a mint error") — if
one-shot mints are silently not deduplicating, this is the first place to look.
Not touched here: it is load-bearing on the SO create path and deserves its own
verification rather than a drive-by edit.
