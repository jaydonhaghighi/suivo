import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GmailInboxMessageForIngestion,
  GmailMailboxAuthData,
  GmailMessageDetailResponse,
  GmailMessageListResponse,
  GmailMessagePayloadPart,
  GmailOauthUrlOptions,
  GmailRecentInboxDebugResult,
  GmailTokenResponse,
  GmailUserInfoResponse
} from './mailbox-provider.types';
export type { GmailInboxMessageForIngestion } from './mailbox-provider.types';

@Injectable()
export class GmailProviderClient {
  private readonly logger = new Logger(GmailProviderClient.name);

  constructor(private readonly configService: ConfigService) {}

  createOauthUrl(state: string, options?: GmailOauthUrlOptions): string {
    const clientId = this.getRequiredConfig('GOOGLE_CLIENT_ID');
    const redirectUri = this.getRequiredConfig('GOOGLE_REDIRECT_URI');
    const scope = [
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send'
    ].join(' ');

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state
    });

    if (options?.loginHint) {
      params.set('login_hint', options.loginHint);
    }

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCodeForMailboxData(code: string): Promise<GmailMailboxAuthData> {
    const clientId = this.getRequiredConfig('GOOGLE_CLIENT_ID');
    const clientSecret = this.getRequiredConfig('GOOGLE_CLIENT_SECRET');
    const redirectUri = this.getRequiredConfig('GOOGLE_REDIRECT_URI');

    const tokenBody = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString()
    });

    if (!tokenResponse.ok) {
      const details = await this.safeReadBody(tokenResponse);
      this.logger.error(`Google token exchange failed (${tokenResponse.status}): ${details}`);
      throw new BadGatewayException('Google OAuth token exchange failed');
    }

    const tokenData = (await tokenResponse.json()) as GmailTokenResponse;
    if (!tokenData.access_token) {
      throw new BadGatewayException('Google OAuth token response missing access token');
    }

    const userInfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${tokenData.access_token}`
      }
    });

    if (!userInfoResponse.ok) {
      const details = await this.safeReadBody(userInfoResponse);
      this.logger.error(`Google user info request failed (${userInfoResponse.status}): ${details}`);
      throw new BadGatewayException('Google OAuth user profile lookup failed');
    }

    const userInfo = (await userInfoResponse.json()) as GmailUserInfoResponse;
    if (!userInfo.email) {
      throw new BadGatewayException('Google OAuth user profile missing email');
    }

    return {
      email: userInfo.email.toLowerCase(),
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      accessTokenExpiresAt:
        typeof tokenData.expires_in === 'number'
          ? new Date(Date.now() + tokenData.expires_in * 1000)
          : undefined,
      scope: tokenData.scope
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    accessTokenExpiresAt?: Date | undefined;
    scope?: string | undefined;
  }> {
    const clientId = this.getRequiredConfig('GOOGLE_CLIENT_ID');
    const clientSecret = this.getRequiredConfig('GOOGLE_CLIENT_SECRET');

    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString()
    });

    if (!tokenResponse.ok) {
      const details = await this.safeReadBody(tokenResponse);
      this.logger.error(`Google refresh token exchange failed (${tokenResponse.status}): ${details}`);
      throw new BadGatewayException('Google OAuth refresh token exchange failed');
    }

    const tokenData = (await tokenResponse.json()) as GmailTokenResponse;
    if (!tokenData.access_token) {
      throw new BadGatewayException('Google OAuth refresh response missing access token');
    }

    return {
      accessToken: tokenData.access_token,
      accessTokenExpiresAt:
        typeof tokenData.expires_in === 'number'
          ? new Date(Date.now() + tokenData.expires_in * 1000)
          : undefined,
      scope: tokenData.scope
    };
  }

  async fetchRecentInboxDebug(accessToken: string, maxResults = 10): Promise<GmailRecentInboxDebugResult> {
    const q = 'in:inbox newer_than:1h';
    const listParams = new URLSearchParams({
      q,
      maxResults: String(maxResults),
      includeSpamTrash: 'false'
    });
    const listResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${listParams.toString()}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!listResponse.ok) {
      const details = await this.safeReadBody(listResponse);
      this.logger.error(`Gmail message list failed (${listResponse.status}): ${details}`);
      throw new BadGatewayException('Failed to fetch Gmail inbox list');
    }

    const parsedList = (await listResponse.json()) as GmailMessageListResponse;
    const messageRefs = parsedList.messages ?? [];
    const messages = await Promise.all(
      messageRefs.map(async (messageRef) => {
        const detailParams = new URLSearchParams({ format: 'metadata' });
        detailParams.append('metadataHeaders', 'From');
        detailParams.append('metadataHeaders', 'To');
        detailParams.append('metadataHeaders', 'Subject');
        detailParams.append('metadataHeaders', 'Date');

        const detailResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageRef.id)}?${detailParams.toString()}`,
          {
            method: 'GET',
            headers: {
              authorization: `Bearer ${accessToken}`
            }
          }
        );

        if (!detailResponse.ok) {
          const details = await this.safeReadBody(detailResponse);
          this.logger.error(`Gmail message detail failed (${detailResponse.status}): ${details}`);
          throw new BadGatewayException(`Failed to fetch Gmail message ${messageRef.id}`);
        }

        return (await detailResponse.json()) as GmailMessageDetailResponse;
      })
    );

    return {
      query: {
        q,
        maxResults,
        includeSpamTrash: false
      },
      listResponse: parsedList,
      messages
    };
  }

  async fetchInboxForIngestion(
    accessToken: string,
    options?: {
      newerThanHours?: number | undefined;
      maxResults?: number | undefined;
      mailboxEmail?: string | undefined;
    }
  ): Promise<GmailInboxMessageForIngestion[]> {
    const newerThanHours = Math.max(1, Math.min(24 * 365, options?.newerThanHours ?? 24));
    const maxMessages = Math.max(1, Math.min(5000, options?.maxResults ?? 100));
    const mailboxEmail = options?.mailboxEmail?.toLowerCase().trim();
    const q = `in:inbox newer_than:${newerThanHours}h`;
    const messages: GmailInboxMessageForIngestion[] = [];
    let nextPageToken: string | undefined;

    while (messages.length < maxMessages) {
      const remaining = maxMessages - messages.length;
      const pageSize = Math.max(1, Math.min(100, remaining));
      const listParams = new URLSearchParams({
        q,
        maxResults: String(pageSize),
        includeSpamTrash: 'false'
      });
      if (nextPageToken) {
        listParams.set('pageToken', nextPageToken);
      }

      const listResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${listParams.toString()}`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${accessToken}`
          }
        }
      );

      if (!listResponse.ok) {
        const details = await this.safeReadBody(listResponse);
        this.logger.error(`Gmail ingestion list failed (${listResponse.status}): ${details}`);
        throw new BadGatewayException('Failed to fetch Gmail inbox list for ingestion');
      }

      const parsedList = (await listResponse.json()) as GmailMessageListResponse;
      for (const messageRef of parsedList.messages ?? []) {
        const detail = await this.fetchMessageDetail(accessToken, messageRef.id, 'full');
        const fromHeader = this.getHeaderValue(detail.payload?.headers, 'From');
        const fromEmail = this.extractEmailAddress(fromHeader);
        if (!fromEmail) {
          continue;
        }

        if (mailboxEmail && fromEmail === mailboxEmail) {
          continue;
        }

        const subject = this.getHeaderValue(detail.payload?.headers, 'Subject') ?? '';
        const body = this.extractMessageBody(detail.payload, detail.snippet);
        const timestamp = this.toIsoTimestamp(detail.internalDate);
        if (!detail.id) {
          continue;
        }

        messages.push({
          provider_event_id: detail.id,
          from_email: fromEmail,
          subject,
          body,
          thread_id: detail.threadId,
          timestamp
        });

        if (messages.length >= maxMessages) {
          break;
        }
      }

      if (messages.length >= maxMessages) {
        break;
      }

      nextPageToken = parsedList.nextPageToken ?? undefined;
      if (!nextPageToken) {
        break;
      }
    }

    return messages;
  }

  async syncIncremental(mailboxConnectionId: string): Promise<{ mailbox_connection_id: string; status: string }> {
    this.logger.log(`Sync incremental Gmail mailbox ${mailboxConnectionId}`);
    return { mailbox_connection_id: mailboxConnectionId, status: 'queued' };
  }

  async backfill(mailboxConnectionId: string): Promise<{ mailbox_connection_id: string; status: string }> {
    this.logger.log(`Backfill Gmail mailbox ${mailboxConnectionId}`);
    return { mailbox_connection_id: mailboxConnectionId, status: 'queued' };
  }

  private async fetchMessageDetail(
    accessToken: string,
    messageId: string,
    format: 'metadata' | 'full'
  ): Promise<GmailMessageDetailResponse> {
    const detailParams = new URLSearchParams({ format });
    if (format === 'metadata') {
      detailParams.append('metadataHeaders', 'From');
      detailParams.append('metadataHeaders', 'To');
      detailParams.append('metadataHeaders', 'Subject');
      detailParams.append('metadataHeaders', 'Date');
    }

    const detailResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?${detailParams.toString()}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!detailResponse.ok) {
      const details = await this.safeReadBody(detailResponse);
      this.logger.error(`Gmail message detail failed (${detailResponse.status}): ${details}`);
      throw new BadGatewayException(`Failed to fetch Gmail message ${messageId}`);
    }

    return (await detailResponse.json()) as GmailMessageDetailResponse;
  }

  private getHeaderValue(
    headers: Array<{ name?: string | undefined; value?: string | undefined }> | undefined,
    key: string
  ): string | undefined {
    const header = headers?.find((item) => item.name?.toLowerCase() === key.toLowerCase());
    const value = header?.value?.trim();
    return value || undefined;
  }

  private extractEmailAddress(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    const matched = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return matched?.[0]?.toLowerCase();
  }

  private extractMessageBody(payload: GmailMessagePayloadPart | undefined, snippet: string | undefined): string {
    const plain = this.findPartBody(payload, ['text/plain']);
    if (plain) {
      return plain.slice(0, 5000);
    }

    const html = this.findPartBody(payload, ['text/html']);
    if (html) {
      const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return stripped.slice(0, 5000);
    }

    return (snippet ?? '').slice(0, 5000);
  }

  private findPartBody(payload: GmailMessagePayloadPart | undefined, mimeTypes: string[]): string | null {
    if (!payload) {
      return null;
    }

    const mimeType = payload.mimeType?.toLowerCase();
    if (mimeType && mimeTypes.includes(mimeType)) {
      const decoded = this.decodeBase64Url(payload.body?.data);
      if (decoded) {
        return decoded;
      }
    }

    for (const part of payload.parts ?? []) {
      const nested = this.findPartBody(part, mimeTypes);
      if (nested) {
        return nested;
      }
    }

    const fallback = this.decodeBase64Url(payload.body?.data);
    if (fallback) {
      return fallback;
    }

    return null;
  }

  private decodeBase64Url(value: string | undefined): string | null {
    if (!value) {
      return null;
    }

    try {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4;
      const padded = padding === 0 ? normalized : normalized + '='.repeat(4 - padding);
      return Buffer.from(padded, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  private toIsoTimestamp(internalDateMs: string | undefined): string | undefined {
    if (!internalDateMs) {
      return undefined;
    }

    const asNumber = Number.parseInt(internalDateMs, 10);
    if (Number.isNaN(asNumber)) {
      return undefined;
    }

    const date = new Date(asNumber);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  private async safeReadBody(response: Response): Promise<string> {
    try {
      const body = await response.text();
      return body.slice(0, 500);
    } catch (_error) {
      return 'unreadable response body';
    }
  }

  private getRequiredConfig(key: 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'GOOGLE_REDIRECT_URI'): string {
    const value = this.configService.get<string>(key);
    if (!value) {
      throw new BadRequestException(`${key} is not configured`);
    }
    return value;
  }
}
