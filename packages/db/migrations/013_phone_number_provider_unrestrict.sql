BEGIN;

ALTER TABLE "PhoneNumber"
DROP CONSTRAINT IF EXISTS "PhoneNumber_provider_check";

COMMIT;
