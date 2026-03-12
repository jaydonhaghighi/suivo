BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_team_primary_email
ON "Lead"(team_id, primary_email)
WHERE primary_email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_team_primary_phone
ON "Lead"(team_id, primary_phone)
WHERE primary_phone IS NOT NULL;

COMMIT;
