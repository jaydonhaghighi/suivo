import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface MicrosoftTokenResponse {
  access_token?: string | undefined;
  refresh_token?: string | undefined;
  expires_in?: number | undefined;
  scope?: string | undefined;
}

interface MicrosoftUserResponse {
  mail?: string | undefined;
  userPrincipalName?: string | undefined;
}

interface MicrosoftGraphMessageResponse {
  value?: MicrosoftGraphMessage[] | undefined;
  '@odata.nextLink'?: string | undefined;
}

interface MicrosoftGraphMessage {
  id?: string | undefined;
  subject?: string | undefined;
  bodyPreview?: string | undefined;
  body?: {
    contentType?: string | undefined;
    content?: string | undefined;
  } | undefined;
  from?: {
    emailAddress?: {
      address?: string | undefined;
    } | undefined;
  } | undefined;
  conversationId?: string | undefined;
  receivedDateTime?: string | undefined;
}

interface OutlookOauthUrlOptions {
  loginHint?: string | undefined;
}

export interface OutlookMailboxAuthData {
  email: string;
  accessToken: string;
  refreshToken?: string | undefined;
  accessTokenExpiresAt?: Date | undefined;
  scope?: string | undefined;
}

export interface OutlookInboxMessageForIngestion {
  provider_event_id: string;
  from_email: string;
  subject: string;
  body: string;
  thread_id?: string | undefined;
  timestamp?: string | undefined;
}

@Injectable()
export class OutlookProviderClient {
  private readonly logger = new Logger(OutlookProviderClient.name);

  constructor(private readonly configService: ConfigService) {}

  createOauthUrl(state: string, options?: OutlookOauthUrlOptions): string {
    const clientId = this.getRequiredConfig('MICROSOFT_CLIENT_ID');
    const redirectUri = this.getRequiredConfig('MICROSOFT_REDIRECT_URI');
    const tenantId = this.configService.get<string>('MICROSOFT_TENANT_ID') ?? 'common';
    const scope = [
      'openid',
      'profile',
      'offline_access',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/User.Read'
    ].join(' ');

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope,
      state
    });

    if (options?.loginHint) {
      params.set('login_hint', options.loginHint);
    }

    return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCodeForMailboxData(code: string): Promise<OutlookMailboxAuthData> {
    const clientId = this.getRequiredConfig('MICROSOFT_CLIENT_ID');
    const clientSecret = this.getRequiredConfig('MICROSOFT_CLIENT_SECRET');
    const redirectUri = this.getRequiredConfig('MICROSOFT_REDIRECT_URI');
    const tenantId = this.getTenantId();

    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    const tokenResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: tokenBody.toString()
    });

    if (!tokenResponse.ok) {
      const details = await this.safeReadBody(tokenResponse);
      this.logger.error(`Microsoft token exchange failed (${tokenResponse.status}): ${details}`);
      throw new BadGatewayException('Microsoft OAuth token exchange failed');
    }

    const tokenData = (await tokenResponse.json()) as MicrosoftTokenResponse;
    if (!tokenData.access_token) {
      throw new BadGatewayException('Microsoft OAuth token response missing access token');
    }

    const profileResponse = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${tokenData.access_token}`
      }
    });

    if (!profileResponse.ok) {
      const details = await this.safeReadBody(profileResponse);
      this.logger.error(`Microsoft profile request failed (${profileResponse.status}): ${details}`);
      throw new BadGatewayException('Microsoft OAuth user profile lookup failed');
    }

    const profile = (await profileResponse.json()) as MicrosoftUserResponse;
    const email = profile.mail ?? profile.userPrincipalName;
    if (!email) {
      throw new BadGatewayException('Microsoft OAuth profile missing mail/userPrincipalName');
    }

    return {
      email: email.toLowerCase(),
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
    const clientId = this.getRequiredConfig('MICROSOFT_CLIENT_ID');
    const clientSecret = this.getRequiredConfig('MICROSOFT_CLIENT_SECRET');
    const tenantId = this.getTenantId();

    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });

    const tokenResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: tokenBody.toString()
    });

    if (!tokenResponse.ok) {
      const details = await this.safeReadBody(tokenResponse);
      this.logger.error(`Microsoft refresh token exchange failed (${tokenResponse.status}): ${details}`);
      throw new BadGatewayException('Microsoft OAuth refresh token exchange failed');
    }

    const tokenData = (await tokenResponse.json()) as MicrosoftTokenResponse;
    if (!tokenData.access_token) {
      throw new BadGatewayException('Microsoft OAuth refresh response missing access token');
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

  async fetchInboxForIngestion(
    accessToken: string,
    options?: {
      newerThanHours?: number | undefined;
      maxResults?: number | undefined;
      mailboxEmail?: string | undefined;
    }
  ): Promise<OutlookInboxMessageForIngestion[]> {
    const newerThanHours = Math.max(1, Math.min(24 * 365, options?.newerThanHours ?? 24));
    const maxMessages = Math.max(1, Math.min(5000, options?.maxResults ?? 100));
    const mailboxEmail = options?.mailboxEmail?.toLowerCase().trim();
    const cutoffMs = Date.now() - newerThanHours * 60 * 60 * 1000;
    const messages: OutlookInboxMessageForIngestion[] = [];
    let nextLink: string | undefined = this.buildInboxMessagesUrl(Math.min(maxMessages, 50));

    while (nextLink && messages.length < maxMessages) {
      const listResponse = await fetch(nextLink, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      });

      if (!listResponse.ok) {
        const details = await this.safeReadBody(listResponse);
        this.logger.error(`Microsoft inbox list failed (${listResponse.status}): ${details}`);
        throw new BadGatewayException('Failed to fetch Outlook inbox list for ingestion');
      }

      const parsed = (await listResponse.json()) as MicrosoftGraphMessageResponse;
      let reachedOlderThanWindow = false;
      for (const item of parsed.value ?? []) {
        const messageId = item.id?.trim();
        if (!messageId) {
          continue;
        }

        const timestamp = this.toIsoTimestamp(item.receivedDateTime);
        if (timestamp) {
          const timestampMs = Date.parse(timestamp);
          if (!Number.isNaN(timestampMs) && timestampMs < cutoffMs) {
            reachedOlderThanWindow = true;
            break;
          }
        }

        const fromEmail = item.from?.emailAddress?.address?.toLowerCase().trim();
        if (!fromEmail) {
          continue;
        }
        if (mailboxEmail && fromEmail === mailboxEmail) {
          continue;
        }

        messages.push({
          provider_event_id: messageId,
          from_email: fromEmail,
          subject: (item.subject ?? '').trim(),
          body: this.extractBody(item).slice(0, 5000),
          thread_id: item.conversationId?.trim() || undefined,
          timestamp
        });

        if (messages.length >= maxMessages) {
          break;
        }
      }

      if (reachedOlderThanWindow || messages.length >= maxMessages) {
        break;
      }

      nextLink = parsed['@odata.nextLink'] ?? undefined;
    }

    return messages;
  }

  async syncIncremental(mailboxConnectionId: string): Promise<{ mailbox_connection_id: string; status: string }> {
    this.logger.log(`Sync incremental Outlook mailbox ${mailboxConnectionId}`);
    return { mailbox_connection_id: mailboxConnectionId, status: 'queued' };
  }

  async backfill(mailboxConnectionId: string): Promise<{ mailbox_connection_id: string; status: string }> {
    this.logger.log(`Backfill Outlook mailbox ${mailboxConnectionId}`);
    return { mailbox_connection_id: mailboxConnectionId, status: 'queued' };
  }

  private async safeReadBody(response: Response): Promise<string> {
    try {
      const body = await response.text();
      return body.slice(0, 500);
    } catch (_error) {
      return 'unreadable response body';
    }
  }

  private getRequiredConfig(
    key: 'MICROSOFT_CLIENT_ID' | 'MICROSOFT_CLIENT_SECRET' | 'MICROSOFT_REDIRECT_URI'
  ): string {
    const value = this.configService.get<string>(key);
    if (!value) {
      throw new BadRequestException(`${key} is not configured`);
    }
    return value;
  }

  private getTenantId(): string {
    return this.configService.get<string>('MICROSOFT_TENANT_ID') ?? 'common';
  }

  private buildInboxMessagesUrl(top: number): string {
    const params = new URLSearchParams({
      $select: 'id,subject,bodyPreview,body,from,conversationId,receivedDateTime',
      $orderby: 'receivedDateTime desc',
      $top: String(Math.max(1, Math.min(50, top)))
    });
    return `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${params.toString()}`;
  }

  private extractBody(message: MicrosoftGraphMessage): string {
    const bodyContent = message.body?.content ?? '';
    const bodyType = (message.body?.contentType ?? '').toLowerCase();
    if (bodyContent) {
      if (bodyType === 'html') {
        return bodyContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      return bodyContent.trim();
    }

    return (message.bodyPreview ?? '').trim();
  }

  private toIsoTimestamp(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
}
