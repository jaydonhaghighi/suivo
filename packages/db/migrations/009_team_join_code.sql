BEGIN;

ALTER TABLE "Team"
  ADD COLUMN IF NOT EXISTS join_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS join_code_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS join_code_generated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS ux_team_join_code_hash
ON "Team"(join_code_hash)
WHERE join_code_hash IS NOT NULL;

COMMIT;

