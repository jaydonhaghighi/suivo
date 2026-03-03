import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface GmailTokenResponse {
  access_token?: string | undefined;
  refresh_token?: string | undefined;
  expires_in?: number | undefined;
  scope?: string | undefined;
  token_type?: string | undefined;
}

interface GmailUserInfoResponse {
  email?: string | undefined;
}

interface GmailOauthUrlOptions {
  loginHint?: string | undefined;
}

export interface GmailMailboxAuthData {
  email: string;
  accessToken: string;
  refreshToken?: string | undefined;
  accessTokenExpiresAt?: Date | undefined;
  scope?: string | undefined;
}

interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId?: string | undefined }> | undefined;
  nextPageToken?: string | undefined;
  resultSizeEstimate?: number | undefined;
}

interface GmailMessageDetailResponse {
  id?: string | undefined;
  threadId?: string | undefined;
  labelIds?: string[] | undefined;
  snippet?: string | undefined;
  internalDate?: string | undefined;
  payload?: {
    headers?: Array<{ name?: string | undefined; value?: string | undefined }> | undefined;
  } | undefined;
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

  async syncIncremental(mailboxConnectionId: string): Promise<{ mailbox_connection_id: string; status: string }> {
    this.logger.log(`Sync incremental Gmail mailbox ${mailboxConnectionId}`);
    return { mailbox_connection_id: mailboxConnectionId, status: 'queued' };
  }

  async backfill(mailboxConnectionId: string): Promise<{ mailbox_connection_id: string; status: string }> {
    this.logger.log(`Backfill Gmail mailbox ${mailboxConnectionId}`);
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

  private getRequiredConfig(key: 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'GOOGLE_REDIRECT_URI'): string {
    const value = this.configService.get<string>(key);
    if (!value) {
      throw new BadRequestException(`${key} is not configured`);
    }
    return value;
  }
}
