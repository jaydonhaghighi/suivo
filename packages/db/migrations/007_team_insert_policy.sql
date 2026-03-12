BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'Team'
      AND policyname = 'team_insert_policy'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY team_insert_policy ON "Team"
        FOR INSERT
        WITH CHECK (id = app_team_id() AND app_role() = 'TEAM_LEAD')
    $policy$;
  END IF;
END
$$;

COMMIT;
