-- Contact phone on workspace users (captured at invite). Mirrors the prod
-- Postgres migration migrations-pg/0013_users_phone.sql. D1 is test-only now
-- (prod is on Postgres), so this keeps the vitest D1 schema in lockstep with
-- the Drizzle schema (schema.pg.ts users.phone) so user queries that select
-- `phone` don't fail in the suite.
ALTER TABLE users ADD COLUMN phone TEXT;
