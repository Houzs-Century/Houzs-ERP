## A system-wide destructive rename had no permission gate, because two comments each said the other side had it [high]

**Symptom.** `POST /maintenance-config/sofa-compartments/rename` renames a sofa
compartment code across the SKU master, EVERY historical doc-line snapshot,
Modular allowed-options, combos, quick picks and in-flight carts — irreversibly —
and opened straight at `c.req.json()` with no check of any kind.

**Root cause — a gate handed over and never received.** The porting migration
(`scripts/scm-schema/port-missing-functions-triggers.sql:165`) says:

> "The 2990 body opens with `IF NOT is_admin() THEN RAISE forbidden`. scm has no
> is_admin()/auth machinery … **The admin gate now lives in the route/RBAC
> layer** — the DB-level gate is dropped here … (Behaviour change — flagged.)"

The route comment said the opposite:

> "Admin-gated inside the function (is_admin()); 403 surfaces here."

The DB dropped its gate and pointed at the route. The route believed the DB
still had one. **Nobody wrote it.** Both of that handler's siblings in the SAME
file (`POST /changes:237`, `DELETE /changes/:id:347`) do check
`canWriteScmConfig`. The `42501 → 403` branch is dead for the same reason:
service-role client, RLS bypassed, and the `RAISE` was removed with the gate.

**Fix.** `canWriteScmConfig(c)` on the handler, and the lying comment replaced
with the evidence.

**Lesson.** "Flagged" in a migration comment is not a hand-off. When a guard
moves layers, the receiving layer's change belongs in the SAME commit.
