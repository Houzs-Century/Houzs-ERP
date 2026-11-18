-- 20261118T1200_project_forecast.sql
-- REVERSAL: DROP TABLE IF EXISTS public.project_forecast;
--   The table is new; dropping it loses only the forecast figures typed on
--   events' Financial Snapshots. No other table reads it. GRANTS: the ones below.
--
-- WHY (owner 2026-11-18). A future event's Financial Snapshot shows each line
-- in three layers: the last same-organiser-same-venue event's actual, then a
-- figure the user types for the line (this table), then the event's own actual
-- as soon as it exists (services/eventForecast.ts). One row per event and
-- line; amount in sen. company_id is stamped from the project at write time;
-- reads still scope through the project's company_id.
SET search_path = public;

CREATE TABLE IF NOT EXISTS public.project_forecast (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  bigint      NOT NULL,
  project_id  bigint      NOT NULL,
  line_key    text        NOT NULL,
  amount_sen  bigint      NOT NULL CHECK (amount_sen >= 0),
  updated_by  bigint,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_forecast_line ON public.project_forecast (project_id, line_key);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_forecast_project_id_fkey') THEN ALTER TABLE public.project_forecast ADD CONSTRAINT project_forecast_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE; END IF; END $$;

ALTER TABLE public.project_forecast ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_forecast TO service_role;
