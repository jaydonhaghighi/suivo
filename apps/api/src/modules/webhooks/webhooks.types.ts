export interface EmailWebhookPayload {
  provider_event_id: string;
  mailbox_connection_id?: string | undefined;
  mailbox_email?: string | undefined;
  from_email: string;
  direction: 'inbound' | 'outbound';
  subject?: string | undefined;
  body?: string | undefined;
  thread_id?: string | undefined;
  timestamp?: string | undefined;
}

export interface SmsWebhookPayload {
  provider_event_id: string;
  phone_number_id?: string | undefined;
  to_number?: string | undefined;
  from_number: string;
  direction: 'inbound' | 'outbound';
  body?: string | undefined;
  timestamp?: string | undefined;
}

export interface CallWebhookPayload {
  provider_event_id: string;
  phone_number_id?: string | undefined;
  to_number?: string | undefined;
  from_number: string;
  direction: 'inbound' | 'outbound';
  status: string;
  duration_seconds?: number | undefined;
  timestamp?: string | undefined;
}

export interface BrokerIntakeSettings {
  mailbox_connection_ids: string[];
  phone_number_ids: string[];
}

export interface EmailIngestDbResult {
  accepted: boolean;
  deduped: boolean;
  lead_id?: string | undefined;
  event_id?: string | undefined;
  should_classify?: boolean | undefined;
}

export type EmailClassificationStatus = 'not_applicable' | 'queued' | 'completed' | 'failed';

export interface IngestEmailOptions {
  awaitClassification?: boolean | undefined;
}

export interface EmailIngestResult {
  accepted: boolean;
  deduped: boolean;
  lead_id?: string | undefined;
  event_id?: string | undefined;
  classification_status: EmailClassificationStatus;
}
