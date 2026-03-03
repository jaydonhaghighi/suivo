import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createHmac, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import { RawContentCryptoService } from '../../common/crypto/raw-content-crypto.service';
import { DatabaseService } from '../../common/db/database.service';
import { UserContext } from '../../common/auth/user-context';
import { GmailProviderClient } from './providers/gmail.provider';
import { OutlookProviderClient } from './providers/outlook.provider';

interface OauthStatePayload {
  nonce: string;
  teamId: string;
  userId: string;
  role: 'AGENT' | 'TEAM_LEAD';
  provider: 'gmail' | 'outlook';
  issued_at: number;
  app_redirect_uri?: string | undefined;
}

interface OauthStartOptions {
  app_redirect_uri?: string | undefined;
  login_hint?: string | undefined;
}

interface OauthCallbackParams {
  code?: string | undefined;
  state?: string | undefined;
  email_address?: string | undefined;
  mailbox_type?: string | undefined;
  delegated_from?: string | undefined;
}

interface MailboxAuthRow {
  id: string;
  provider: 'gmail' | 'outlook';
  email_address: string;
  oauth_access_token: Buffer | null;
  oauth_refresh_token: Buffer | null;
  oauth_token_expires_at: string | null;
  oauth_scope: string | null;
}

@Injectable()
export class MailboxesService implements OnModuleDestroy {
  private readonly queue: Queue;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    private readonly rawContentCryptoService: RawContentCryptoService,
    private readonly gmailProviderClient: GmailProviderClient,
    private readonly outlookProviderClient: OutlookProviderClient
  ) {
    this.queue = new Queue('mail-sync', {
      connection: {
        url: this.configService.getOrThrow<string>('REDIS_URL')
      }
    });
  }

  async list(user: UserContext): Promise<Record<string, unknown>[]> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query(
        `SELECT id, user_id, provider, email_address, mailbox_type, delegated_from, status, created_at, updated_at
         FROM "MailboxConnection"
         ORDER BY created_at DESC`
      );
      return result.rows;
    });
  }

  createOauthStartUrl(
    provider: 'gmail' | 'outlook',
    user: UserContext,
    options?: OauthStartOptions
  ): { url: string; state: string } {
    const validatedAppRedirectUri = this.validateAppRedirectUri(options?.app_redirect_uri);
    const state = this.encodeOauthState({
      nonce: uuidv4(),
      teamId: user.teamId,
      userId: user.userId,
      role: user.role,
      provider,
      issued_at: Date.now(),
      app_redirect_uri: validatedAppRedirectUri
    });

    const url =
      provider === 'gmail'
        ? this.gmailProviderClient.createOauthUrl(state, { loginHint: options?.login_hint })
        : this.outlookProviderClient.createOauthUrl(state, { loginHint: options?.login_hint });

    return { url, state };
  }

  async oauthCallback(
    provider: 'gmail' | 'outlook',
    query: OauthCallbackParams
  ): Promise<{ connected: true; mailbox_connection_id: string; redirect_url?: string | undefined }> {
    if (!query.state || !query.code) {
      throw new BadRequestException('OAuth callback missing state/code');
    }

    const decoded = this.decodeOauthState(query.state, provider);
    let gmailAuthData: Awaited<ReturnType<GmailProviderClient['exchangeCodeForMailboxData']>> | null = null;
    let providerEmail: string;
    if (provider === 'gmail') {
      gmailAuthData = await this.gmailProviderClient.exchangeCodeForMailboxData(query.code);
      providerEmail = gmailAuthData.email;
    } else {
      providerEmail = await this.outlookProviderClient.exchangeCodeForEmail(query.code);
    }

    const emailAddress = (query.email_address ?? providerEmail).toLowerCase();
    const mailboxType = this.validateMailboxType(query.mailbox_type);
    const delegatedFrom = query.delegated_from ?? null;
    const encryptedAccessToken = gmailAuthData?.accessToken
      ? this.rawContentCryptoService.encrypt(gmailAuthData.accessToken)
      : null;
    const encryptedRefreshToken = gmailAuthData?.refreshToken
      ? this.rawContentCryptoService.encrypt(gmailAuthData.refreshToken)
      : null;
    const accessTokenExpiresAt = gmailAuthData?.accessTokenExpiresAt ?? null;
    const oauthScope = gmailAuthData?.scope ?? null;

    let mailboxConnectionId = uuidv4();
    await this.databaseService.withUserTransaction(
      {
        userId: decoded.userId,
        teamId: decoded.teamId,
        role: decoded.role
      },
      async (client) => {
        const userResult = await client.query(
          `SELECT id
           FROM "User"
           WHERE id = $1
             AND team_id = $2
           LIMIT 1`,
          [decoded.userId, decoded.teamId]
        );

        if (!userResult.rowCount || !userResult.rows[0]) {
          throw new NotFoundException('User for OAuth state no longer exists');
        }

        const connectionResult = await client.query(
          `INSERT INTO "MailboxConnection" (
            id,
            user_id,
            provider,
            email_address,
            mailbox_type,
            delegated_from,
            oauth_access_token,
            oauth_refresh_token,
            oauth_token_expires_at,
            oauth_scope,
            status,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', now(), now())
          ON CONFLICT (user_id, provider, email_address, mailbox_type, delegated_from)
          DO UPDATE SET
            status = 'active',
            oauth_access_token = COALESCE(EXCLUDED.oauth_access_token, "MailboxConnection".oauth_access_token),
            oauth_refresh_token = COALESCE(EXCLUDED.oauth_refresh_token, "MailboxConnection".oauth_refresh_token),
            oauth_token_expires_at = COALESCE(EXCLUDED.oauth_token_expires_at, "MailboxConnection".oauth_token_expires_at),
            oauth_scope = COALESCE(EXCLUDED.oauth_scope, "MailboxConnection".oauth_scope),
            updated_at = now()
          RETURNING id`,
          [
            mailboxConnectionId,
            decoded.userId,
            provider,
            emailAddress,
            mailboxType,
            delegatedFrom,
            encryptedAccessToken,
            encryptedRefreshToken,
            accessTokenExpiresAt,
            oauthScope
          ]
        );

        mailboxConnectionId = connectionResult.rows[0].id as string;
      }
    );

    const result: { connected: true; mailbox_connection_id: string; redirect_url?: string | undefined } = {
      connected: true,
      mailbox_connection_id: mailboxConnectionId
    };

    if (decoded.app_redirect_uri) {
      result.redirect_url = this.buildAppRedirect(decoded.app_redirect_uri, provider, mailboxConnectionId);
    }

    return result;
  }

  async enqueueBackfill(user: UserContext, mailboxId: string): Promise<{ queued: true; mailbox_id: string }> {
    let provider: 'gmail' | 'outlook' = 'gmail';

    await this.databaseService.withUserTransaction(user, async (client) => {
      const check = await client.query(
        'SELECT id, provider FROM "MailboxConnection" WHERE id = $1 LIMIT 1',
        [mailboxId]
      );
      if (!check.rowCount || !check.rows[0]) {
        throw new NotFoundException('Mailbox not found');
      }
      provider = check.rows[0].provider;
    });

    if (provider === 'gmail') {
      await this.gmailProviderClient.backfill(mailboxId);
    } else {
      await this.outlookProviderClient.backfill(mailboxId);
    }

    await this.queue.add(
      'mailbox-backfill',
      {
        mailboxId,
        initiatedBy: user.userId,
        teamId: user.teamId
      },
      {
        removeOnComplete: 100,
        removeOnFail: 100
      }
    );

    return { queued: true, mailbox_id: mailboxId };
  }

  async testGmailLastHour(user: UserContext, mailboxId: string): Promise<Record<string, unknown>> {
    const mailbox = await this.getMailboxAuthRow(user, mailboxId);
    if (mailbox.provider !== 'gmail') {
      throw new BadRequestException('Mailbox provider must be gmail for this test endpoint');
    }

    const refreshToken = this.decryptToken(mailbox.oauth_refresh_token);
    let accessToken = this.decryptToken(mailbox.oauth_access_token);
    let accessTokenExpiresAt = mailbox.oauth_token_expires_at;
    let tokenRefreshed = false;

    if (!accessToken || this.isAccessTokenStale(mailbox.oauth_token_expires_at)) {
      if (!refreshToken) {
        throw new BadRequestException(
          'No Gmail refresh token available. Reconnect Gmail with consent to grant offline access.'
        );
      }

      const refreshed = await this.gmailProviderClient.refreshAccessToken(refreshToken);
      accessToken = refreshed.accessToken;
      accessTokenExpiresAt = refreshed.accessTokenExpiresAt?.toISOString() ?? null;
      tokenRefreshed = true;
      await this.persistMailboxAccessToken(user, mailboxId, accessToken, refreshed.accessTokenExpiresAt, refreshed.scope);
    }

    if (!accessToken) {
      throw new BadRequestException('No Gmail access token available for mailbox');
    }

    const gmailResponse = await this.gmailProviderClient.fetchRecentInboxDebug(accessToken, 10);
    return {
      mailbox_connection_id: mailbox.id,
      provider: mailbox.provider,
      email_address: mailbox.email_address,
      queried_window: 'last_hour',
      token_refreshed: tokenRefreshed,
      token_expires_at: accessTokenExpiresAt,
      gmail_response: gmailResponse
    };
  }

  private async getMailboxAuthRow(user: UserContext, mailboxId: string): Promise<MailboxAuthRow> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query<MailboxAuthRow>(
        `SELECT
          id,
          provider,
          email_address,
          oauth_access_token,
          oauth_refresh_token,
          oauth_token_expires_at,
          oauth_scope
         FROM "MailboxConnection"
         WHERE id = $1
         LIMIT 1`,
        [mailboxId]
      );

      if (!result.rowCount || !result.rows[0]) {
        throw new NotFoundException('Mailbox not found');
      }

      return result.rows[0];
    });
  }

  private async persistMailboxAccessToken(
    user: UserContext,
    mailboxId: string,
    accessToken: string,
    expiresAt: Date | undefined,
    scope: string | undefined
  ): Promise<void> {
    await this.databaseService.withUserTransaction(user, async (client) => {
      await client.query(
        `UPDATE "MailboxConnection"
         SET oauth_access_token = $2,
             oauth_token_expires_at = $3,
             oauth_scope = COALESCE($4, oauth_scope),
             updated_at = now()
         WHERE id = $1`,
        [mailboxId, this.rawContentCryptoService.encrypt(accessToken), expiresAt ?? null, scope ?? null]
      );
    });
  }

  private decryptToken(ciphertext: Buffer | null): string | null {
    return this.rawContentCryptoService.decrypt(ciphertext);
  }

  private isAccessTokenStale(expiresAtIso: string | null): boolean {
    if (!expiresAtIso) {
      return true;
    }

    const expiresAtMs = Date.parse(expiresAtIso);
    if (Number.isNaN(expiresAtMs)) {
      return true;
    }

    return expiresAtMs <= Date.now() + 30_000;
  }

  private encodeOauthState(payload: OauthStatePayload): string {
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.getStateSecret()).update(encodedPayload).digest('base64url');
    return `${encodedPayload}.${signature}`;
  }

  private decodeOauthState(state: string, provider: 'gmail' | 'outlook'): OauthStatePayload {
    const [payloadPart, signaturePart] = state.split('.', 2);
    if (!payloadPart || !signaturePart) {
      throw new NotFoundException('Invalid OAuth state');
    }

    const expectedSignature = createHmac('sha256', this.getStateSecret()).update(payloadPart).digest();
    let providedSignature: Buffer;
    try {
      providedSignature = Buffer.from(signaturePart, 'base64url');
    } catch (_error) {
      throw new NotFoundException('Invalid OAuth state');
    }

    if (providedSignature.length !== expectedSignature.length || !timingSafeEqual(providedSignature, expectedSignature)) {
      throw new NotFoundException('Invalid OAuth state signature');
    }

    let decoded: OauthStatePayload;
    try {
      decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as OauthStatePayload;
    } catch (_error) {
      throw new NotFoundException('Invalid OAuth state payload');
    }

    if (decoded.provider !== provider) {
      throw new NotFoundException('OAuth provider mismatch');
    }

    if (decoded.role !== 'AGENT' && decoded.role !== 'TEAM_LEAD') {
      decoded.role = 'AGENT';
    }

    const ageMs = Date.now() - decoded.issued_at;
    if (ageMs < 0 || ageMs > 1000 * 60 * 15) {
      throw new NotFoundException('OAuth state expired');
    }

    return decoded;
  }

  private getStateSecret(): string {
    const explicitSecret = this.configService.get<string>('OAUTH_STATE_SECRET');
    if (explicitSecret) {
      return explicitSecret;
    }

    const fallbackSecret = this.configService.get<string>('WEBHOOK_SHARED_SECRET');
    if (fallbackSecret) {
      return fallbackSecret;
    }

    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new Error('OAUTH_STATE_SECRET (or WEBHOOK_SHARED_SECRET) is required in production');
    }

    return 'dev-insecure-oauth-state-secret';
  }

  private validateMailboxType(mailboxType: string | undefined): 'primary' | 'shared' | 'delegated' {
    if (!mailboxType || mailboxType === 'primary') {
      return 'primary';
    }
    if (mailboxType === 'shared') {
      return 'shared';
    }
    if (mailboxType === 'delegated') {
      return 'delegated';
    }
    throw new BadRequestException('Invalid mailbox_type');
  }

  private buildAppRedirect(baseUri: string, provider: 'gmail' | 'outlook', mailboxConnectionId: string): string {
    const validatedUri = this.validateAppRedirectUri(baseUri);
    if (!validatedUri) {
      throw new BadRequestException('app_redirect_uri is not allowed');
    }
    const url = new URL(validatedUri);
    url.searchParams.set('connected', 'true');
    url.searchParams.set('provider', provider);
    url.searchParams.set('mailbox_connection_id', mailboxConnectionId);
    return url.toString();
  }

  private validateAppRedirectUri(uri: string | undefined): string | undefined {
    if (!uri) {
      return undefined;
    }

    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch (_error) {
      throw new BadRequestException('Invalid app_redirect_uri');
    }

    const allowlistRaw = this.configService.get<string>('APP_REDIRECT_ALLOWLIST');
    if (!allowlistRaw) {
      throw new BadRequestException('app_redirect_uri is not allowed');
    }

    const allowlist = allowlistRaw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const candidate = parsed.toString();
    const matches = allowlist.some((allowed) => candidate.startsWith(allowed));
    if (!matches) {
      throw new BadRequestException('app_redirect_uri is not in the allowlist');
    }

    return candidate;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
