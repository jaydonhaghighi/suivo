export interface GmailTokenResponse {
  access_token?: string | undefined;
  refresh_token?: string | undefined;
  expires_in?: number | undefined;
  scope?: string | undefined;
  token_type?: string | undefined;
}

export interface GmailUserInfoResponse {
  email?: string | undefined;
}

export interface GmailOauthUrlOptions {
  loginHint?: string | undefined;
}

export interface GmailMailboxAuthData {
  email: string;
  accessToken: string;
  refreshToken?: string | undefined;
  accessTokenExpiresAt?: Date | undefined;
  scope?: string | undefined;
}

export interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId?: string | undefined }> | undefined;
  nextPageToken?: string | undefined;
  resultSizeEstimate?: number | undefined;
}

export interface GmailMessageDetailResponse {
  id?: string | undefined;
  threadId?: string | undefined;
  labelIds?: string[] | undefined;
  snippet?: string | undefined;
  internalDate?: string | undefined;
  payload?: GmailMessagePayloadPart | undefined;
}

export interface GmailMessagePayloadPart {
  mimeType?: string | undefined;
  headers?: Array<{ name?: string | undefined; value?: string | undefined }> | undefined;
  body?: { data?: string | undefined } | undefined;
  parts?: GmailMessagePayloadPart[] | undefined;
}

export interface GmailRecentInboxDebugResult {
  query: {
    q: string;
    maxResults: number;
    includeSpamTrash: boolean;
  };
  listResponse: GmailMessageListResponse;
  messages: GmailMessageDetailResponse[];
}

export interface GmailInboxMessageForIngestion {
  provider_event_id: string;
  from_email: string;
  subject: string;
  body: string;
  thread_id?: string | undefined;
  timestamp?: string | undefined;
}

export interface MicrosoftTokenResponse {
  access_token?: string | undefined;
}

export interface MicrosoftUserResponse {
  mail?: string | undefined;
  userPrincipalName?: string | undefined;
}

export interface OutlookOauthUrlOptions {
  loginHint?: string | undefined;
}
