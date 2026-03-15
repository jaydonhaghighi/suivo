BEGIN;

CREATE TABLE "VoiceQualificationSession" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES "Team"(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES "Lead"(id) ON DELETE CASCADE,
  owner_agent_id UUID NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  initiated_by_user_id UUID REFERENCES "User"(id) ON DELETE SET NULL,
  trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('manual', 'auto')),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'dialing', 'in_progress', 'completed', 'failed', 'opt_out', 'escalated', 'unreachable', 'cancelled')
  ),
  destination_number TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts >= 1),
  next_attempt_at TIMESTAMPTZ,
  provider TEXT NOT NULL DEFAULT 'telnyx',
  provider_call_control_id TEXT,
  provider_call_leg_id TEXT,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  qualification_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary TEXT,
  error_text TEXT,
  transcript_event_id UUID REFERENCES "ConversationEvent"(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  last_webhook_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_voice_session_team_created
ON "VoiceQualificationSession"(team_id, created_at DESC);

CREATE INDEX idx_voice_session_lead_created
ON "VoiceQualificationSession"(lead_id, created_at DESC);

CREATE INDEX idx_voice_session_due_dispatch
ON "VoiceQualificationSession"(next_attempt_at ASC)
WHERE status = 'queued' AND next_attempt_at IS NOT NULL;

CREATE UNIQUE INDEX ux_voice_session_open_auto_per_lead
ON "VoiceQualificationSession"(lead_id)
WHERE trigger_mode = 'auto' AND status IN ('queued', 'dialing', 'in_progress');

CREATE UNIQUE INDEX ux_voice_session_provider_call_control
ON "VoiceQualificationSession"(provider_call_control_id)
WHERE provider_call_control_id IS NOT NULL;

CREATE TRIGGER trg_voice_qualification_session_updated_at
BEFORE UPDATE ON "VoiceQualificationSession"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "VoiceQualificationSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VoiceQualificationSession" FORCE ROW LEVEL SECURITY;

CREATE POLICY voice_session_select_policy ON "VoiceQualificationSession"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM "Lead" l
      WHERE l.id = "VoiceQualificationSession".lead_id
        AND l.team_id = app_team_id()
        AND (
          app_role() = 'TEAM_LEAD'
          OR l.owner_agent_id = app_user_id()
        )
    )
  );

CREATE POLICY voice_session_insert_policy ON "VoiceQualificationSession"
  FOR INSERT
  WITH CHECK (
    team_id = app_team_id()
    AND EXISTS (
      SELECT 1
      FROM "Lead" l
      WHERE l.id = "VoiceQualificationSession".lead_id
        AND l.team_id = app_team_id()
        AND (
          app_role() = 'TEAM_LEAD'
          OR (
            l.owner_agent_id = app_user_id()
            AND "VoiceQualificationSession".owner_agent_id = app_user_id()
          )
        )
    )
  );

CREATE POLICY voice_session_update_policy ON "VoiceQualificationSession"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM "Lead" l
      WHERE l.id = "VoiceQualificationSession".lead_id
        AND l.team_id = app_team_id()
        AND (
          app_role() = 'TEAM_LEAD'
          OR l.owner_agent_id = app_user_id()
        )
    )
  )
  WITH CHECK (
    team_id = app_team_id()
    AND EXISTS (
      SELECT 1
      FROM "Lead" l
      WHERE l.id = "VoiceQualificationSession".lead_id
        AND l.team_id = app_team_id()
        AND (
          app_role() = 'TEAM_LEAD'
          OR (
            l.owner_agent_id = app_user_id()
            AND "VoiceQualificationSession".owner_agent_id = app_user_id()
          )
        )
    )
  );

COMMIT;
