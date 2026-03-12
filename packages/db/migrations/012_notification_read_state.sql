BEGIN;

CREATE TABLE IF NOT EXISTS "NotificationReadState" (
  user_id UUID NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES "Team"(id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_read_state_team_user
ON "NotificationReadState"(team_id, user_id);

CREATE INDEX IF NOT EXISTS idx_notification_read_state_read_at
ON "NotificationReadState"(read_at DESC);

ALTER TABLE "NotificationReadState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationReadState" FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_read_state_select_policy ON "NotificationReadState"
  FOR SELECT
  USING (
    user_id = app_user_id()
    AND team_id = app_team_id()
  );

CREATE POLICY notification_read_state_insert_policy ON "NotificationReadState"
  FOR INSERT
  WITH CHECK (
    user_id = app_user_id()
    AND team_id = app_team_id()
  );

CREATE POLICY notification_read_state_update_policy ON "NotificationReadState"
  FOR UPDATE
  USING (
    user_id = app_user_id()
    AND team_id = app_team_id()
  )
  WITH CHECK (
    user_id = app_user_id()
    AND team_id = app_team_id()
  );

COMMIT;
