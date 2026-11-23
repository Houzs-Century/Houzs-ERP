-- Mail Center L2 "Whole department" (owner 2026-11-21): besides the person's own
-- Org Chart departments, an admin may tick OTHER departments; each ticked one is
-- opened wholly (its department mailbox and every member's own mailbox).
-- REVERSAL: DROP TABLE IF EXISTS mail_scope_departments;
CREATE TABLE IF NOT EXISTS mail_scope_departments (
  user_id       integer NOT NULL,
  department_id integer NOT NULL,
  company_id    integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    integer,
  PRIMARY KEY (user_id, department_id)
);
