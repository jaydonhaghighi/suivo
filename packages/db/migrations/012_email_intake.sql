BEGIN;

CREATE TABLE "EmailIntake" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES "Team"(id) ON DELETE CASCADE,
  mailbox_connection_id UUID NOT NULL REFERENCES "MailboxConnection"(id) ON DELETE RESTRICT,
  mailbox_user_id UUID NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  provider_event_id TEXT NOT NULL,
  ingest_source TEXT NOT NULL CHECK (ingest_source IN ('webhook', 'poll', 'backfill')),
  sender_email CITEXT NOT NULL,
  sender_domain CITEXT NOT NULL,
  sender_localpart TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  raw_body BYTEA NOT NULL,
  body_fingerprint TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  classifier_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  decision TEXT NOT NULL CHECK (decision IN ('create_lead', 'needs_review', 'reject')),
  decision_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_assignee_user_id UUID REFERENCES "User"(id) ON DELETE SET NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('none', 'review_pending', 'lead_created', 'rejected')),
  review_note TEXT,
  reviewed_by_user_id UUID REFERENCES "User"(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  lead_id UUID REFERENCES "Lead"(id) ON DELETE SET NULL,
  conversation_event_id UUID REFERENCES "ConversationEvent"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_connection_id, provider_event_id)
);

CREATE TABLE "EmailIntakeAudit" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_intake_id UUID NOT NULL REFERENCES "EmailIntake"(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES "Team"(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES "User"(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_intake_team_review
ON "EmailIntake"(team_id, review_status, review_assignee_user_id);

CREATE INDEX idx_email_intake_decision
ON "EmailIntake"(decision);

CREATE INDEX idx_email_intake_created_at
ON "EmailIntake"(created_at DESC);

CREATE INDEX idx_email_intake_audit_intake_created
ON "EmailIntakeAudit"(email_intake_id, created_at DESC);

CREATE INDEX idx_email_intake_audit_team_created
ON "EmailIntakeAudit"(team_id, created_at DESC);

CREATE TRIGGER trg_email_intake_updated_at
BEFORE UPDATE ON "EmailIntake"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

ALTER TABLE "EmailIntake" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailIntakeAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailIntake" FORCE ROW LEVEL SECURITY;
ALTER TABLE "EmailIntakeAudit" FORCE ROW LEVEL SECURITY;

CREATE POLICY email_intake_select_policy ON "EmailIntake"
  FOR SELECT
  USING (
    team_id = app_team_id()
    AND (
      app_role() = 'TEAM_LEAD'
      OR (app_role() = 'AGENT' AND review_assignee_user_id = app_user_id())
    )
  );

CREATE POLICY email_intake_insert_policy ON "EmailIntake"
  FOR INSERT
  WITH CHECK (
    team_id = app_team_id()
    AND (
      app_role() = 'TEAM_LEAD'
      OR (app_role() = 'AGENT' AND review_assignee_user_id = app_user_id())
    )
  );

CREATE POLICY email_intake_update_policy ON "EmailIntake"
  FOR UPDATE
  USING (
    team_id = app_team_id()
    AND (
      app_role() = 'TEAM_LEAD'
      OR (app_role() = 'AGENT' AND review_assignee_user_id = app_user_id())
    )
  )
  WITH CHECK (
    team_id = app_team_id()
    AND (
      app_role() = 'TEAM_LEAD'
      OR (app_role() = 'AGENT' AND review_assignee_user_id = app_user_id())
    )
  );

CREATE POLICY email_intake_audit_select_policy ON "EmailIntakeAudit"
  FOR SELECT
  USING (
    team_id = app_team_id()
    AND EXISTS (
      SELECT 1
      FROM "EmailIntake" i
      WHERE i.id = "EmailIntakeAudit".email_intake_id
        AND i.team_id = app_team_id()
        AND (
          app_role() = 'TEAM_LEAD'
          OR (app_role() = 'AGENT' AND i.review_assignee_user_id = app_user_id())
        )
    )
  );

CREATE POLICY email_intake_audit_insert_policy ON "EmailIntakeAudit"
  FOR INSERT
  WITH CHECK (
    team_id = app_team_id()
    AND actor_user_id = app_user_id()
    AND EXISTS (
      SELECT 1
      FROM "EmailIntake" i
      WHERE i.id = "EmailIntakeAudit".email_intake_id
        AND i.team_id = app_team_id()
        AND (
          app_role() = 'TEAM_LEAD'
          OR (app_role() = 'AGENT' AND i.review_assignee_user_id = app_user_id())
        )
    )
  );

COMMIT;
