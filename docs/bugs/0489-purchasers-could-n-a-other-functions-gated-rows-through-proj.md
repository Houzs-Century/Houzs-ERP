## Purchasers could N/A other functions' gated rows through projects.write [medium]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner 2026-08-21: "dont allowed purchase (sim and farra) edit or
can click any button on other task. becoz now sim can click button on other
task" — after the 0488 fix let the keyless purchaser N/A her own gated rows,
she could also N/A BD's gated rows (2D/3D Design, Display Floor Plan,
Agreement).

**Root cause (traced).** The status route's role-badge gate exempts
`projects.write` holders entirely, and BOTH Purchaser roles carried
`projects.write`. The 0488 change opened the keyless na/pending path on gated
rows; combined with the write exemption, a purchaser passed both gates on ANY
gated row, not just PURCHASER-badged ones. The desktop client guard mirrored
the same hole.

**Fix.** Two halves. (1) Code: the keyless na/pending path now requires
`roleLabelAdmits(item.role_label, role)` regardless of projects.write
(`projects.manage` still passes), mirrored in the desktop guard. (2) Data:
`projects.write` removed from the Purchaser role (id 330, Sim + Farra) —
they keep `projects.checklist.tick`, so every role_label gate in the
attach / status / review routes now scopes them to PURCHASER-badged rows,
which is the owner's stated intent.

**Ref.** fix/purchaser-scope-and-review-routing, 2026-08-21.
