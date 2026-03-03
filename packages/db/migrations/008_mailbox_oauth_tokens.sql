BEGIN;

ALTER TABLE "MailboxConnection"
  ADD COLUMN IF NOT EXISTS oauth_access_token BYTEA,
  ADD COLUMN IF NOT EXISTS oauth_refresh_token BYTEA,
  ADD COLUMN IF NOT EXISTS oauth_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS oauth_scope TEXT;

COMMIT;
