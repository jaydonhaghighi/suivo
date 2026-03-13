export interface EmailReplyPayload {
  lead_id: string;
  mailbox_connection_id?: string | undefined;
  provider_event_id?: string | undefined;
  thread_id?: string | undefined;
  subject: string;
  body: string;
}

export interface SmsSendPayload {
  lead_id: string;
  phone_number_id: string;
  provider_event_id?: string | undefined;
  body: string;
}
