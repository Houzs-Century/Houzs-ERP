-- 20261102T2100_acc_todo_tasks.sql
-- Finance's To do keeps its own work (the owner's Claude Design redesign
-- "Finance 模块重新设计", batch 2, 2026-11-02 —「别停下来，先把可以做的一次做完」):
-- tasks a person adds for themselves or a teammate, the month's routines,
-- remarks on both with their earlier wordings, and which built-in rules are off.
--
-- THE DESIGN'S MODEL, KEPT. A task has a due day and may repeat — every day
-- (or Mon–Fri, or Mon–Sat), on chosen weekdays, monthly on a day or the last
-- day every N months, or yearly. Each occurrence is done, or moved to another
-- day ("this time only"), on its own: one acc_todo_occurrences row per
-- occurrence somebody touched, keyed by the day the repeat gives. A ROUTINE is
-- a repeating task of Finance's rather than a person's, with what its button
-- does (make a voucher, open a page, open the month's checklist). Remarks are
-- a thread per task; editing one keeps the earlier wording in `history`
-- (the design: "the earlier wording is kept"). Nothing here posts to the books.
--
-- THE ROUTINES (owner's answer 2026-11-02): rent on the 1st, salaries on the
-- 7th, EPF/SOCSO/EIS and PCB by the 15th, last month's statements on the 1st,
-- the month-end checklist on the last day — NO SST-02 (「sst-02没有」). Amounts
-- and payees stay blank for Finance to fill. Seeded once per company, each
-- starting at its next day on or after today; `routine_key` keeps the seed
-- from ever running twice.
--
-- HOUSE STYLE. New tables, idempotent, schema-qualified. RE-CHECK THE NUMBER
-- AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_todo_remarks;
--   DROP TABLE IF EXISTS scm.acc_todo_occurrences;
--   DROP TABLE IF EXISTS scm.acc_todo_tasks;
--   DROP TABLE IF EXISTS scm.acc_todo_settings;

CREATE TABLE IF NOT EXISTS scm.acc_todo_tasks (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       integer     NOT NULL,
  kind             text        NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'routine')),
  routine_key      text,
  title            text        NOT NULL CHECK (btrim(title) <> ''),
  group_key        text        NOT NULL DEFAULT 'misc',
  -- public.users ids; NULL assignee = Finance (a routine).
  assignee_id      bigint,
  assignee_name    text,
  created_by_id    bigint,
  created_by_name  text,
  -- The first (or only) occurrence.
  due_date         date        NOT NULL,
  repeat           text        NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'day', 'week', 'month', 'year')),
  day_mode         text        NOT NULL DEFAULT 'all' CHECK (day_mode IN ('all', 'wk', 'ms')),
  weekdays         smallint[]  NOT NULL DEFAULT '{}',
  month_day        text        CHECK (month_day IS NULL OR month_day = 'last' OR month_day ~ '^([1-9]|[12][0-9]|3[01])$'),
  every_months     smallint    NOT NULL DEFAULT 1 CHECK (every_months BETWEEN 1 AND 12),
  -- "by the 15th" rather than "on the 15th" — how a routine is worded.
  by_day           boolean     NOT NULL DEFAULT false,
  -- {type, no, name, to}: the document or page it is about.
  link             jsonb,
  action           text        NOT NULL DEFAULT 'done' CHECK (action IN ('done', 'voucher', 'open', 'checklist')),
  action_to        text,
  amount_sen       bigint      CHECK (amount_sen IS NULL OR amount_sen >= 0),
  payee            text,
  is_off           boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS acc_todo_tasks_routine_once
  ON scm.acc_todo_tasks (company_id, routine_key) WHERE routine_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS acc_todo_tasks_company ON scm.acc_todo_tasks (company_id);

CREATE TABLE IF NOT EXISTS scm.acc_todo_occurrences (
  task_id     uuid        NOT NULL REFERENCES scm.acc_todo_tasks (id) ON DELETE CASCADE,
  company_id  integer     NOT NULL,
  -- The day the repeat gives; moved_to is where it was moved this time only.
  occurs_on   date        NOT NULL,
  moved_to    date,
  done_at     timestamptz,
  done_by     text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, occurs_on)
);
CREATE INDEX IF NOT EXISTS acc_todo_occurrences_done ON scm.acc_todo_occurrences (company_id, done_at);

CREATE TABLE IF NOT EXISTS scm.acc_todo_remarks (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      uuid        NOT NULL REFERENCES scm.acc_todo_tasks (id) ON DELETE CASCADE,
  company_id   integer     NOT NULL,
  author_id    bigint,
  author_name  text        NOT NULL,
  body         text        NOT NULL DEFAULT '',
  -- A remark the done / reopen buttons leave; body may then be empty.
  tag          text        CHECK (tag IS NULL OR tag IN ('done', 'reopen')),
  occurs_on    date,
  -- Earlier wordings, oldest first: [{"text": …, "at": …}].
  history      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  edited_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS acc_todo_remarks_task ON scm.acc_todo_remarks (task_id, id);

CREATE TABLE IF NOT EXISTS scm.acc_todo_settings (
  company_id  integer     PRIMARY KEY,
  -- Built-in rules switched off (Setup › To do rules).
  rules_off   text[]      NOT NULL DEFAULT '{}',
  -- Groups Finance added beside the four: [{"id": …, "label": …}].
  groups      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The routines, once per company, each from its next day on or after today (MYT).
INSERT INTO scm.acc_todo_tasks
  (company_id, kind, routine_key, title, group_key, due_date, repeat, month_day, by_day, action, action_to)
SELECT c.id, 'routine', r.key, r.title, r.grp,
       CASE
         WHEN r.md = 'last' THEN (date_trunc('month', t.d) + interval '1 month - 1 day')::date
         WHEN (date_trunc('month', t.d) + make_interval(days => NULLIF(r.md, 'last')::int - 1))::date >= t.d
           THEN (date_trunc('month', t.d) + make_interval(days => NULLIF(r.md, 'last')::int - 1))::date
         ELSE (date_trunc('month', t.d) + interval '1 month' + make_interval(days => NULLIF(r.md, 'last')::int - 1))::date
       END,
       'month', r.md, r.by_day, r.action, r.action_to
  FROM public.companies c
 CROSS JOIN (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d) t
 CROSS JOIN (VALUES
   ('rent',       'Rent',                           'pay',   '1',    false, 'voucher',   NULL),
   ('salaries',   'Salaries',                       'pay',   '7',    false, 'open',      '/scm/payment-vouchers'),
   ('epf',        'EPF, SOCSO & EIS',               'pay',   '15',   true,  'voucher',   NULL),
   ('pcb',        'PCB tax deduction',              'pay',   '15',   true,  'voucher',   NULL),
   ('statements', 'Upload last month''s statements', 'recon', '1',    false, 'open',      '/scm/bank-recon'),
   ('month-end',  'Month-end checklist',            'other', 'last', false, 'checklist', '/scm/accounting?tab=close')
 ) AS r(key, title, grp, md, by_day, action, action_to)
ON CONFLICT (company_id, routine_key) WHERE routine_key IS NOT NULL DO NOTHING;
