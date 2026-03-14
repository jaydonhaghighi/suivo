BEGIN;

DROP POLICY IF EXISTS mailbox_select_policy ON "MailboxConnection";
DROP POLICY IF EXISTS mailbox_insert_policy ON "MailboxConnection";
DROP POLICY IF EXISTS mailbox_update_policy ON "MailboxConnection";

CREATE POLICY mailbox_select_policy ON "MailboxConnection"
  FOR SELECT
  USING (user_id = app_user_id());

CREATE POLICY mailbox_insert_policy ON "MailboxConnection"
  FOR INSERT
  WITH CHECK (user_id = app_user_id());

CREATE POLICY mailbox_update_policy ON "MailboxConnection"
  FOR UPDATE
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

COMMIT;
