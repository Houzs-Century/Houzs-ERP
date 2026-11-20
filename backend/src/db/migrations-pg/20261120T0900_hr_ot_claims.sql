-- 20261120T0900_hr_ot_claims.sql
-- HC-0125 worker-reported overtime. A worker files one or more OT segments for a
-- work date (start/end minutes from midnight; end_min may exceed 1440 when the
-- segment crosses midnight, e.g. 23:30-00:30 = 1410..1470) plus what they did; a
-- supervisor confirms or rejects. OT that counts for PAY = sum of CONFIRMED rows
-- for the employee-day. From this migration a phone punch no longer auto-grants
-- OT (the paid-OT source moves to these confirmed claims).
--
-- No seed here.
--
-- REVERSAL: DROP TABLE IF EXISTS public.hr_ot_claims;
--   (Safe: the table is new. NOTE the behaviour change ships in code, not here:
--   after a rollback the OT-from-claims code would find no table — roll the code
--   back together so paid OT returns to the punch-derived value.)

CREATE TABLE IF NOT EXISTS public.hr_ot_claims (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL,
  employee_id bigint NOT NULL,
  work_date date NOT NULL,
  start_min integer NOT NULL,
  end_min integer NOT NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PENDING',
  reject_reason text,
  reviewed_by integer,
  reviewed_at timestamptz,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_ot_claims_status_check CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
  CONSTRAINT hr_ot_claims_span_check CHECK (end_min > start_min)
);
CREATE INDEX IF NOT EXISTS idx_hr_ot_claims_emp ON public.hr_ot_claims (company_id, employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_hr_ot_claims_status ON public.hr_ot_claims (company_id, status, work_date);
