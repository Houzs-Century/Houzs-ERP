-- REVERSAL: UPDATE public.roles SET permissions = (SELECT jsonb_agg(k)::text FROM jsonb_array_elements_text(permissions::jsonb) AS t(k) WHERE k NOT IN ('scm.amendment.approve_lines','scm.amendment.approve_delivery','scm.po_amendment.approve')) WHERE name = 'Owner';
--
-- 20260909T1000_owner_role_amendment_approver_keys.sql
-- Owner 2026-09-09: give the Owner ROLE the three LITERAL amendment approver
-- keys it has only ever passed through the '*' wildcard.
--
-- WHY THIS IS A ROLE CHANGE AND NOT A CODE CHANGE
--   The amendment surfaces read a permission set two ways on purpose:
--     · the NOTICE audience and the sidebar's pending COUNTS ask LITERALLY —
--       who is this work addressed to (services/permissionHolders.ts,
--       so-amendments.ts /pending-count) — where '*' is deliberately excluded,
--       or the owner lands on every card and every count ever produced;
--     · every access GATE asks with the wildcard honoured, so Owner and IT
--       Admin can still do anything. That half is untouched here.
--
--   The owner signs in as the shared HOUZS CENTURY account (users.id 1, the
--   role's only active holder) and needs to step in when an approving desk is
--   away: "我是用 owner 账号登录 需要及时处理如果当审批人不在或者突发状况".
--   Widening the badge to every '*' holder would have shown it to four Super
--   Admins as well (Loo, Vivian, Chew, Tan Yong Hong). Granting the real keys
--   to the one role that needs them is the narrower instrument, and it fixes
--   the notice at the same time — the owner's account was, until now, not on
--   any amendment notice at all.
--
-- NOT GRANTED: scm.amendment.approve_so, the LEGACY (lane IS NULL) key. That
-- flow is a CLOSED set — no new NULL-lane row can be created — and it holds
-- ZERO open rows as of this migration. A key for an audience that can never
-- grow is noise; the Owner still passes the legacy gate itself via '*'.
--
-- Conventions copied from 0225_legacy_amendment_approver_grants.sql, the last
-- grant of these same keys: the role is is_system=1 so the Roles UI refuses
-- permission edits and a migration is the sanctioned channel; targeted by NAME
-- (ids drift between environments); public. qualified; jsonb union dedupes so a
-- re-run converges; permissions is a TEXT column holding a JSON array.
--
-- Precedent worth noting: this role ALREADY carries literal keys beside the
-- wildcard (agreement.approve, stock_transfer.approve, stock_in.approve,
-- projects.approve), for the same reason — a wildcard opens a gate but does not
-- put a name on a list.

UPDATE public.roles SET permissions = (
  SELECT jsonb_agg(DISTINCT k)::text FROM (
    SELECT jsonb_array_elements_text(permissions::jsonb) AS k
    UNION
    SELECT unnest(ARRAY[
      'scm.amendment.approve_lines',
      'scm.amendment.approve_delivery',
      'scm.po_amendment.approve'
    ])
  ) AS u(k)
)
WHERE name = 'Owner' AND permissions IS NOT NULL;
