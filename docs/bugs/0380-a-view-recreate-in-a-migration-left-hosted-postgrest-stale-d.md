## A view recreate in a migration left hosted PostgREST stale — deploy now self-heals [medium]

**Symptom.** After the money rename (0305) DROP/CREATEd 11 views, the Sales Orders
list showed ZERO orders (HTTP 416 "Requested range not satisfiable" = count 0),
though the base table and the recreated view both held every row. Same latent
hazard existed after item-code (0307) recreated 7 inventory views.

**Root cause (traced).** A migration's DDL runs through pg-migrate, whose schema
MODEL reloads — but hosted PostgREST keeps its OWN schema cache, which a model
reload does not clear. It went on serving the OLD view shape, so the route's
`.eq('company_id', …)` against the recreated view returned nothing. #2450 fixed
0305 by a MANUAL `NOTIFY pgrst,'reload schema'`; that manual step does not cover
the NEXT view-recreating migration, which is why 0307 carried the same risk.

**Fix.** pg-migrate.mjs now fires `NOTIFY pgrst,'reload schema'` + `'reload config'`
on every successful deploy, so any view recreate self-heals. Best-effort and last
(migrations already committed; a failed NOTIFY never fails the deploy).

**Ref.** fix/auto-reload-postgrest-on-deploy, 2026-08-19 (follows #2450).
