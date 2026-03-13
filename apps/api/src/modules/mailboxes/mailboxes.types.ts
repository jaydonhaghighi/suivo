export interface OauthStatePayload {
  nonce: string;
  teamId: string;
  userId: string;
  role: 'AGENT' | 'TEAM_LEAD';
  provider: 'gmail' | 'outlook';
  issued_at: number;
  app_redirect_uri?: string | undefined;
}

export interface OauthStartOptions {
  app_redirect_uri?: string | undefined;
  login_hint?: string | undefined;
}

export interface OauthCallbackParams {
  code?: string | undefined;
  state?: string | undefined;
  email_address?: string | undefined;
  mailbox_type?: string | undefined;
  delegated_from?: string | undefined;
}

export interface MailboxAuthRow {
  id: string;
  provider: 'gmail' | 'outlook';
  email_address: string;
  oauth_access_token: Buffer | null;
  oauth_refresh_token: Buffer | null;
  oauth_token_expires_at: string | null;
  oauth_scope: string | null;
}

export interface GmailAccessTokenResult {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  tokenRefreshed: boolean;
}

export interface ActiveGmailMailboxRow {
  mailbox_id: string;
  user_id: string;
  team_id: string;
  role: 'AGENT' | 'TEAM_LEAD';
}

export interface MailboxStoredEmailRow {
  event_id: string;
  lead_id: string;
  provider_event_id: string | null;
  direction: 'inbound' | 'outbound' | 'internal';
  raw_body: Buffer | null;
  meta: Record<string, unknown> | null;
  created_at: string | Date;
  lead_email: string | null;
  mailbox_email: string;
}

export interface PullGmailInboxOptions {
  newer_than_hours?: number | undefined;
  max_results?: number | undefined;
  await_classification?: boolean | undefined;
  preview_limit?: number | undefined;
}

export interface MailboxEmailRecord {
  event_id: string;
  lead_id: string;
  provider_event_id: string | null;
  direction: 'inbound' | 'outbound' | 'internal';
  sender_email: string | null;
  recipient_email: string | null;
  subject: string;
  body?: string | undefined;
  thread_id: string | null;
  provider: string | null;
  received_at: string;
  classification_status: 'completed' | 'pending' | 'not_applicable';
  classification: Record<string, unknown> | null;
}

export interface PullGmailInboxResult {
  mailbox_connection_id: string;
  pulled: number;
  accepted: number;
  deduped: number;
  created_or_updated: number;
  lead_count: number;
  classification_completed: number;
  classification_queued: number;
  classification_failed: number;
  recent_emails: MailboxEmailRecord[];
}
