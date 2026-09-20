-- Idempotent on purpose: this migration was already applied in dev/prod from an
-- earlier revision of this file (which also created two indexes that were later
-- removed from the schema). Re-running a plain ADD COLUMN would fail with
-- `column "harness_index" already exists` and block the release.
ALTER TABLE "v2"."session_turns" ADD COLUMN IF NOT EXISTS "harness_index" jsonb;
