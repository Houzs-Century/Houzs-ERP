-- 20261123T0300_hr_punch_corrections.sql
-- HC-0125 self-service make-up punch (补卡). A worker who forgot to clock in
-- or out files a correction for a work date — the in and/or out time they say
-- they actually worked, plus a reason; a supervisor with hr.punch.approve
-- approves or rejects. On approval the day's hr_attendance is written exactly as
-- an HR correction would write it (status PRESENT, the requested times, MANUAL
-- source, working-hours re-synced). Minutes from midnight, like hr_ot_claims.
--
-- No seed here.
--
-- REVERSAL: DROP TABLE IF EXISTS public.hr_punch_corrections;
--   (Safe: the table is new. An already-APPROVED correction has already written
--   its hr_attendance row; that row is not undone by dropping this table.)

CREATE TABLE IF NOT EXISTS public.hr_punch_corrections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL,
  employee_id bigint NOT NULL,
  work_date date NOT NULL,
  req_in_min integer,
  req_out_min integer,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PENDING',
  reject_reason text,
  reviewed_by integer,
  reviewed_at timestamptz,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_punch_corrections_status_check CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  -- At least one side must be given, and an in-and-out pair must be ordered.
  CONSTRAINT hr_punch_corrections_side_check CHECK (req_in_min IS NOT NULL OR req_out_min IS NOT NULL),
  CONSTRAINT hr_punch_corrections_order_check CHECK (req_in_min IS NULL OR req_out_min IS NULL OR req_out_min > req_in_min)
);
CREATE INDEX IF NOT EXISTS idx_hr_punch_corrections_emp ON public.hr_punch_corrections (company_id, employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_hr_punch_corrections_status ON public.hr_punch_corrections (company_id, status, work_date);
