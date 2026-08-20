## Defect-review region routing was a UI hint, not a rule — either reviewer could stamp any state [low]

**Symptom.** Owner, on a Sarawak project: "sabah sarawak defect under shukor ya
not nancy".

**Root cause.** The two-warehouse split (2026-08-11) was enforced in exactly two
places, and neither is a gate: `listProjects`' My Pending lane (Nancy sees the
four region states, Shukor everything else) and the frontend's `canReview`,
which hides the Done / Replace buttons. `POST
/checklist/attachments/:attId/actions` accepted a stamp from **either** reviewer
on **any** project — it only asked "are you a reviewer?". A stale tab, a
deep-linked page or any direct call could close a Sarawak defect as Nancy, and
the timeline would record it as legitimate.

**Fix.** The route now loads the attachment's project state and holds each
reviewer to their own half of the split: the Ops Exec on `Pulau Pinang /
Kelantan / Terengganu / Perak`, the Storekeeper Supervisor on everything else,
including a NULL state. Sabah and Sarawak were never in the region list, so this
puts them where the owner expects — Shukor — by rule instead of by hope. Admins
(`*` / `projects.manage`) and the purchaser/BD closing an escalation are
untouched.

**The class, for next time.** A split that lives in a list query and a button's
`disabled` prop is a suggestion. If the rule matters, the write path has to say
no.

**Ref** — 2026-08-14, `fix/defect-review-region-gate`.
