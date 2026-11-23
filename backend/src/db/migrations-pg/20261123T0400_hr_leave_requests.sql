-- 20261123T0400_hr_leave_requests.sql
-- HC-0125 self-service leave. A worker files a leave type (annual / medical /
-- unpaid), a date range and a reason; a supervisor with hr.leave.approve
-- approves or rejects. On approval each day in the range is written onto
-- hr_attendance with the matching leave status (ANNUAL_LEAVE / MEDICAL_LEAVE /
-- UNPAID_LEAVE), which payroll already prices — paid leave is not docked, unpaid
-- is not paid. No leave-balance tracking yet; the HRIS has it, this does not.
--
-- No seed here.
--
-- REVERSAL: DROP TABLE IF EXISTS public.hr_leave_requests;
--   (The hr_attendance leave days an APPROVED request already wrote are not
--   undone by dropping this table — clear them on the Attendance page if the
--   feature is rolled back.)

CREATE TABLE IF NOT EXISTS public.hr_leave_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL,
  employee_id bigint NOT NULL,
  leave_status text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PENDING',
  reject_reason text,
  reviewed_by integer,
  reviewed_at timestamptz,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_leave_requests_status_check CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT hr_leave_requests_type_check CHECK (leave_status IN ('ANNUAL_LEAVE', 'MEDICAL_LEAVE', 'UNPAID_LEAVE')),
  CONSTRAINT hr_leave_requests_range_check CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_emp ON public.hr_leave_requests (company_id, employee_id, start_date);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_status ON public.hr_leave_requests (company_id, status, start_date);
