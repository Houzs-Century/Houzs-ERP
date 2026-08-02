-- 0245 — the three dates a lorry's life is measured from.
--
-- WHY. Owner, 2026-08-02: "每一辆罗里都要有以下这些日期：1. 生产日期 2. 注册
-- (Register) 日期 3. 第一天上班的日期".
--
-- scm.lorries already carries `purchase_date` (mig 0121) and it is NONE of
-- these three. A lorry is built in one year, registered with JPJ in another,
-- bought used some years later, and put to work the week after that — four
-- different dates answering four different questions:
--
--   manufacture_date  how OLD the vehicle is. Drives real depreciation and
--                     tells you whether a part is still made for it.
--   registration_date what the road tax, insurance and PUSPAKOM cycles are
--                     anchored to — the JPJ registration, not our purchase.
--   in_service_date   the first day it worked FOR US. The denominator for
--                     cost-per-day and utilisation; a lorry bought in March
--                     and idle until June did not cost us three months of use.
--   purchase_date     (0121) when WE bought it. Already here.
--
-- ALL NULLABLE, NO BACKFILL. Nothing in the system can infer any of them, and
-- a guessed date is worse than a blank one: it would quietly become the basis
-- of an age or a cost-per-day figure nobody could trace. They fill in as the
-- paperwork is entered.
--
-- NO ORDERING CHECK. It is tempting to require manufacture <= registration <=
-- in_service, and it would be wrong: a reconditioned import is registered here
-- long after it was built elsewhere, and a lorry can be put to work before its
-- transfer paperwork completes. A CHECK would refuse legitimate rows to enforce
-- a tidiness nobody asked for. The UI states the intent instead.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, one
-- transaction. RE-CHECK THE NUMBER AT MERGE — 0245 was next free above 0244.

SET search_path = scm, public;

ALTER TABLE scm.lorries
  ADD COLUMN IF NOT EXISTS manufacture_date  DATE NULL,
  ADD COLUMN IF NOT EXISTS registration_date DATE NULL,
  ADD COLUMN IF NOT EXISTS in_service_date   DATE NULL;
