BEGIN;

CREATE OR REPLACE FUNCTION app_team_join_code_hash()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.team_join_code_hash', true), '');
$$;

ALTER POLICY team_select_policy ON "Team"
  USING (
    id = app_team_id()
    OR join_code_hash = app_team_join_code_hash()
  );

COMMIT;
