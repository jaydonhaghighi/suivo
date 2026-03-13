export type SourceEntity = 'lead' | 'conversation_event' | 'task';
export type NotificationCategory = 'lead' | 'message' | 'call' | 'task' | 'note' | 'system';

export interface NotificationSourceRow {
  id: string;
  source_entity: SourceEntity;
  lead_id: string | null;
  channel: string | null;
  source_type: string;
  direction: string | null;
  created_at: string;
  due_at: string | null;
  lead_state: string | null;
  lead_source: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  summary: string | null;
  meta: Record<string, unknown> | null;
  read_at: string | null;
}

export interface NotificationFeedItem {
  id: string;
  lead_id: string | null;
  source_entity: SourceEntity;
  source_type: string;
  notification_type: string;
  category: NotificationCategory;
  title: string;
  body: string;
  ui_label: string;
  route_path: '/lead/[id]' | '/task-deck';
  channel: string | null;
  direction: string | null;
  created_at: string;
  due_at: string | null;
  lead_state: string | null;
  lead_source: string | null;
  primary_contact: string;
  primary_email: string | null;
  primary_phone: string | null;
  summary: string | null;
  read_at: string | null;
  is_read: boolean;
  attributes: Record<string, unknown>;
}
