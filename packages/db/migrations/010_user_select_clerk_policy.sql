BEGIN;

CREATE OR REPLACE FUNCTION app_clerk_id() RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.clerk_id', true), '');
$$ LANGUAGE sql STABLE;

ALTER POLICY user_select_policy ON "User"
  USING (
    team_id = app_team_id()
    OR clerk_id = app_clerk_id()
  );

COMMIT;
