import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createHmac, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import { RawContentCryptoService } from '../../common/crypto/raw-content-crypto.service';
import { DatabaseService } from '../../common/db/database.service';
import { UserContext } from '../../common/auth/user-context';
import { EmailIngestResult, WebhooksService } from '../webhooks/webhooks.service';
import { EmailIngestSource } from '../webhooks/email-intake-qualification.service';
import { GmailInboxMessageForIngestion, GmailProviderClient } from './providers/gmail.provider';
import {
  OutlookInboxMessageForIngestion,
  OutlookMailboxAuthData,
  OutlookProviderClient
} from './providers/outlook.provider';

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

interface OauthAccessTokenResult {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  tokenRefreshed: boolean;
}

interface ActiveMailboxRow {
  mailbox_id: string;
  provider: 'gmail' | 'outlook';
  user_id: string;
  team_id: string;
  role: 'AGENT' | 'TEAM_LEAD';
}

interface MailboxStoredEmailRow {
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

interface PullGmailInboxOptions {
  newer_than_hours?: number | undefined;
  max_results?: number | undefined;
  await_classification?: boolean | undefined;
  preview_limit?: number | undefined;
  ingest_source?: EmailIngestSource | undefined;
}

interface PullOutlookInboxOptions extends PullGmailInboxOptions {}

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
  lead_created_count: number;
  needs_review_count: number;
  rejected_count: number;
  classification_completed: number;
  classification_queued: number;
  classification_failed: number;
  recent_emails: MailboxEmailRecord[];
}

export interface PullOutlookInboxResult extends PullGmailInboxResult {}

@Injectable()
export class MailboxesService implements OnModuleDestroy {
  private readonly logger = new Logger(MailboxesService.name);
  private readonly queue: Queue;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    private readonly rawContentCryptoService: RawContentCryptoService,
    private readonly gmailProviderClient: GmailProviderClient,
    private readonly outlookProviderClient: OutlookProviderClient,
    private readonly webhooksService: WebhooksService
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
        `SELECT
            m.id,
            m.user_id,
            m.provider,
            m.email_address,
            m.mailbox_type,
            m.delegated_from,
            m.status,
            m.created_at,
            m.updated_at
         FROM "MailboxConnection" m
         WHERE m.user_id = $1
         ORDER BY m.created_at DESC`,
        [user.userId]
      );
      return result.rows;
    });
  }

  async listMailboxEmails(
    user: UserContext,
    mailboxId: string,
    options?: { limit?: number | undefined; include_body?: boolean | undefined }
  ): Promise<{ mailbox_connection_id: string; emails: MailboxEmailRecord[] }> {
    const mailbox = await this.getMailboxAuthRow(user, mailboxId);
    const limit = Math.max(1, Math.min(200, options?.limit ?? 25));
    const includeBody = options?.include_body ?? false;

    const rows = await this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query<MailboxStoredEmailRow>(
        `SELECT
            e.id AS event_id,
            e.lead_id,
            e.provider_event_id,
            e.direction,
            e.raw_body,
            e.meta,
            e.created_at,
            l.primary_email AS lead_email,
            m.email_address AS mailbox_email
         FROM "ConversationEvent" e
         JOIN "Lead" l ON l.id = e.lead_id
         JOIN "MailboxConnection" m ON m.id = e.mailbox_connection_id
         WHERE e.channel = 'email'
           AND e.mailbox_connection_id = $1
         ORDER BY e.created_at DESC
         LIMIT $2`,
        [mailbox.id, limit]
      );

      return result.rows;
    });

    const emails = rows.map((row) => this.toMailboxEmailRecord(row, includeBody));
    return {
      mailbox_connection_id: mailbox.id,
      emails
    };
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
    let outlookAuthData: OutlookMailboxAuthData | null = null;
    let providerEmail: string;
    if (provider === 'gmail') {
      gmailAuthData = await this.gmailProviderClient.exchangeCodeForMailboxData(query.code);
      providerEmail = gmailAuthData.email;
    } else {
      outlookAuthData = await this.outlookProviderClient.exchangeCodeForMailboxData(query.code);
      providerEmail = outlookAuthData.email;
    }

    const emailAddress = (query.email_address ?? providerEmail).toLowerCase();
    const mailboxType = this.validateMailboxType(query.mailbox_type);
    const delegatedFrom = query.delegated_from ?? null;
    const oauthAccessToken = gmailAuthData?.accessToken ?? outlookAuthData?.accessToken;
    const oauthRefreshToken = gmailAuthData?.refreshToken ?? outlookAuthData?.refreshToken;
    const accessTokenExpiresAt = gmailAuthData?.accessTokenExpiresAt ?? outlookAuthData?.accessTokenExpiresAt ?? null;
    const oauthScope = gmailAuthData?.scope ?? outlookAuthData?.scope ?? null;
    const encryptedAccessToken = oauthAccessToken ? this.rawContentCryptoService.encrypt(oauthAccessToken) : null;
    const encryptedRefreshToken = oauthRefreshToken ? this.rawContentCryptoService.encrypt(oauthRefreshToken) : null;

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
        `SELECT m.id, m.provider
         FROM "MailboxConnection" m
         WHERE m.id = $1
           AND m.user_id = $2
         LIMIT 1`,
        [mailboxId, user.userId]
      );
      if (!check.rowCount || !check.rows[0]) {
        throw new NotFoundException('Mailbox not found');
      }
      provider = check.rows[0].provider;
    });

    this.logger.log(`Queueing mailbox backfill for ${mailboxId} (${provider})`);

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

    const token = await this.getValidGmailAccessToken(user, mailbox);

    const gmailResponse = await this.gmailProviderClient.fetchRecentInboxDebug(token.accessToken, 10);
    return {
      mailbox_connection_id: mailbox.id,
      provider: mailbox.provider,
      email_address: mailbox.email_address,
      queried_window: 'last_hour',
      token_refreshed: token.tokenRefreshed,
      token_expires_at: token.accessTokenExpiresAt,
      gmail_response: gmailResponse
    };
  }

  async pullGmailInbox(
    user: UserContext,
    mailboxId: string,
    options?: PullGmailInboxOptions
  ): Promise<PullGmailInboxResult> {
    const mailbox = await this.getMailboxAuthRow(user, mailboxId);
    if (mailbox.provider !== 'gmail') {
      throw new BadRequestException('Mailbox provider must be gmail for inbox pull');
    }

    const token = await this.getValidGmailAccessToken(user, mailbox);
    const inboxMessages = await this.gmailProviderClient.fetchInboxForIngestion(token.accessToken, {
      newerThanHours: options?.newer_than_hours ?? 24,
      maxResults: options?.max_results ?? 10,
      mailboxEmail: mailbox.email_address
    });

    let accepted = 0;
    let deduped = 0;
    let classificationCompleted = 0;
    let classificationQueued = 0;
    let classificationFailed = 0;
    let leadCreatedCount = 0;
    let needsReviewCount = 0;
    let rejectedCount = 0;
    const leadIds = new Set<string>();
    for (const email of inboxMessages) {
      const ingestResult = await this.ingestPulledGmailMessage(
        mailbox.id,
        email,
        options?.await_classification,
        options?.ingest_source ?? 'poll'
      );
      if (ingestResult.accepted) {
        accepted += 1;
      }
      if (ingestResult.deduped) {
        deduped += 1;
      }
      if (ingestResult.lead_id) {
        leadIds.add(ingestResult.lead_id);
      }
      if (ingestResult.classification_status === 'completed') {
        classificationCompleted += 1;
      } else if (ingestResult.classification_status === 'queued') {
        classificationQueued += 1;
      } else if (ingestResult.classification_status === 'failed') {
        classificationFailed += 1;
      }

      if (ingestResult.accepted && !ingestResult.deduped) {
        if (ingestResult.intake_decision === 'create_lead') {
          leadCreatedCount += 1;
        } else if (ingestResult.intake_decision === 'needs_review') {
          needsReviewCount += 1;
        } else if (ingestResult.intake_decision === 'reject') {
          rejectedCount += 1;
        } else if (ingestResult.lead_id) {
          leadCreatedCount += 1;
        }
      }
    }

    const previewLimit = Math.max(1, Math.min(50, options?.preview_limit ?? 10));
    const preview = await this.listMailboxEmails(user, mailbox.id, {
      limit: previewLimit,
      include_body: false
    });

    return {
      mailbox_connection_id: mailbox.id,
      pulled: inboxMessages.length,
      accepted,
      deduped,
      created_or_updated: accepted - deduped,
      lead_count: leadIds.size,
      lead_created_count: leadCreatedCount,
      needs_review_count: needsReviewCount,
      rejected_count: rejectedCount,
      classification_completed: classificationCompleted,
      classification_queued: classificationQueued,
      classification_failed: classificationFailed,
      recent_emails: preview.emails
    };
  }

  async pullOutlookInbox(
    user: UserContext,
    mailboxId: string,
    options?: PullOutlookInboxOptions
  ): Promise<PullOutlookInboxResult> {
    const mailbox = await this.getMailboxAuthRow(user, mailboxId);
    if (mailbox.provider !== 'outlook') {
      throw new BadRequestException('Mailbox provider must be outlook for inbox pull');
    }

    const token = await this.getValidOutlookAccessToken(user, mailbox);
    const inboxMessages = await this.outlookProviderClient.fetchInboxForIngestion(token.accessToken, {
      newerThanHours: options?.newer_than_hours ?? 24,
      maxResults: options?.max_results ?? 10,
      mailboxEmail: mailbox.email_address
    });

    let accepted = 0;
    let deduped = 0;
    let classificationCompleted = 0;
    let classificationQueued = 0;
    let classificationFailed = 0;
    let leadCreatedCount = 0;
    let needsReviewCount = 0;
    let rejectedCount = 0;
    const leadIds = new Set<string>();
    for (const email of inboxMessages) {
      const ingestResult = await this.ingestPulledOutlookMessage(
        mailbox.id,
        email,
        options?.await_classification,
        options?.ingest_source ?? 'poll'
      );
      if (ingestResult.accepted) {
        accepted += 1;
      }
      if (ingestResult.deduped) {
        deduped += 1;
      }
      if (ingestResult.lead_id) {
        leadIds.add(ingestResult.lead_id);
      }
      if (ingestResult.classification_status === 'completed') {
        classificationCompleted += 1;
      } else if (ingestResult.classification_status === 'queued') {
        classificationQueued += 1;
      } else if (ingestResult.classification_status === 'failed') {
        classificationFailed += 1;
      }

      if (ingestResult.accepted && !ingestResult.deduped) {
        if (ingestResult.intake_decision === 'create_lead') {
          leadCreatedCount += 1;
        } else if (ingestResult.intake_decision === 'needs_review') {
          needsReviewCount += 1;
        } else if (ingestResult.intake_decision === 'reject') {
          rejectedCount += 1;
        } else if (ingestResult.lead_id) {
          leadCreatedCount += 1;
        }
      }
    }

    const previewLimit = Math.max(1, Math.min(50, options?.preview_limit ?? 10));
    const preview = await this.listMailboxEmails(user, mailbox.id, {
      limit: previewLimit,
      include_body: false
    });

    return {
      mailbox_connection_id: mailbox.id,
      pulled: inboxMessages.length,
      accepted,
      deduped,
      created_or_updated: accepted - deduped,
      lead_count: leadIds.size,
      lead_created_count: leadCreatedCount,
      needs_review_count: needsReviewCount,
      rejected_count: rejectedCount,
      classification_completed: classificationCompleted,
      classification_queued: classificationQueued,
      classification_failed: classificationFailed,
      recent_emails: preview.emails
    };
  }

  async pullAllActiveGmailMailboxes(options?: {
    newer_than_hours?: number | undefined;
    max_results?: number | undefined;
    mailbox_limit?: number | undefined;
  }): Promise<{
    scanned_mailboxes: number;
    successful_mailboxes: number;
    failed_mailboxes: number;
    pulled: number;
    accepted: number;
    deduped: number;
    created_or_updated: number;
    lead_count: number;
    lead_created_count: number;
    needs_review_count: number;
    rejected_count: number;
  }> {
    const mailboxLimit = Math.max(1, Math.min(500, options?.mailbox_limit ?? 50));
    const mailboxRows = await this.databaseService.withSystemTransaction(async (client) => {
      const result = await client.query<ActiveMailboxRow>(
        `SELECT
            m.id AS mailbox_id,
            m.provider,
            u.id AS user_id,
            u.team_id,
            u.role
         FROM "MailboxConnection" m
         JOIN "User" u ON u.id = m.user_id
         WHERE m.provider IN ('gmail', 'outlook')
           AND m.status = 'active'
         ORDER BY m.updated_at DESC
         LIMIT $1`,
        [mailboxLimit]
      );

      return result.rows;
    });

    let successfulMailboxes = 0;
    let failedMailboxes = 0;
    let totalPulled = 0;
    let totalAccepted = 0;
    let totalDeduped = 0;
    let totalLeadCount = 0;
    let totalLeadCreatedCount = 0;
    let totalNeedsReviewCount = 0;
    let totalRejectedCount = 0;

    for (const mailbox of mailboxRows) {
      try {
        const userContext: UserContext = {
          userId: mailbox.user_id,
          teamId: mailbox.team_id,
          role: mailbox.role
        };
        const pullOptions = {
          newer_than_hours: options?.newer_than_hours,
          max_results: options?.max_results
        };
        const result =
          mailbox.provider === 'gmail'
            ? await this.pullGmailInbox(userContext, mailbox.mailbox_id, pullOptions)
            : await this.pullOutlookInbox(userContext, mailbox.mailbox_id, pullOptions);

        successfulMailboxes += 1;
        totalPulled += result.pulled;
        totalAccepted += result.accepted;
        totalDeduped += result.deduped;
        totalLeadCount += result.lead_count;
        totalLeadCreatedCount += result.lead_created_count;
        totalNeedsReviewCount += result.needs_review_count;
        totalRejectedCount += result.rejected_count;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(`Failed to pull mailbox ${mailbox.mailbox_id}: ${message}`);
        failedMailboxes += 1;
      }
    }

    return {
      scanned_mailboxes: mailboxRows.length,
      successful_mailboxes: successfulMailboxes,
      failed_mailboxes: failedMailboxes,
      pulled: totalPulled,
      accepted: totalAccepted,
      deduped: totalDeduped,
      created_or_updated: totalAccepted - totalDeduped,
      lead_count: totalLeadCount,
      lead_created_count: totalLeadCreatedCount,
      needs_review_count: totalNeedsReviewCount,
      rejected_count: totalRejectedCount
    };
  }

  private async ingestPulledGmailMessage(
    mailboxConnectionId: string,
    email: GmailInboxMessageForIngestion,
    awaitClassification = false,
    ingestSource: EmailIngestSource = 'poll'
  ): Promise<EmailIngestResult> {
    return this.webhooksService.ingestEmailDetailed(
      'gmail',
      {
        provider_event_id: email.provider_event_id,
        mailbox_connection_id: mailboxConnectionId,
        from_email: email.from_email,
        direction: 'inbound',
        subject: email.subject,
        body: email.body,
        thread_id: email.thread_id,
        timestamp: email.timestamp
      },
      {
        awaitClassification,
        ingestSource
      }
    );
  }

  private async ingestPulledOutlookMessage(
    mailboxConnectionId: string,
    email: OutlookInboxMessageForIngestion,
    awaitClassification = false,
    ingestSource: EmailIngestSource = 'poll'
  ): Promise<EmailIngestResult> {
    return this.webhooksService.ingestEmailDetailed(
      'outlook',
      {
        provider_event_id: email.provider_event_id,
        mailbox_connection_id: mailboxConnectionId,
        from_email: email.from_email,
        direction: 'inbound',
        subject: email.subject,
        body: email.body,
        thread_id: email.thread_id,
        timestamp: email.timestamp
      },
      {
        awaitClassification,
        ingestSource
      }
    );
  }

  private toMailboxEmailRecord(row: MailboxStoredEmailRow, includeBody: boolean): MailboxEmailRecord {
    const meta = this.toRecord(row.meta) ?? {};
    const subject = typeof meta.subject === 'string' ? meta.subject : '';
    const threadId = typeof meta.thread_id === 'string' ? meta.thread_id : null;
    const provider = typeof meta.provider === 'string' ? meta.provider : null;
    const classification = this.toRecord(meta.ai_classification ?? null);

    const receivedAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;

    let classificationStatus: MailboxEmailRecord['classification_status'] = 'not_applicable';
    if (row.direction === 'inbound') {
      classificationStatus = classification ? 'completed' : 'pending';
    }

    const senderEmail = row.direction === 'inbound' ? row.lead_email : row.mailbox_email;
    const recipientEmail = row.direction === 'inbound' ? row.mailbox_email : row.lead_email;
    const base: MailboxEmailRecord = {
      event_id: row.event_id,
      lead_id: row.lead_id,
      provider_event_id: row.provider_event_id,
      direction: row.direction,
      sender_email: senderEmail,
      recipient_email: recipientEmail,
      subject,
      thread_id: threadId,
      provider,
      received_at: receivedAt,
      classification_status: classificationStatus,
      classification
    };

    if (includeBody) {
      base.body = this.rawContentCryptoService.decrypt(row.raw_body) ?? '';
    }

    return base;
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return null;
  }

  private async getValidGmailAccessToken(user: UserContext, mailbox: MailboxAuthRow): Promise<OauthAccessTokenResult> {
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
      await this.persistMailboxAccessToken(user, mailbox.id, accessToken, refreshed.accessTokenExpiresAt, refreshed.scope);
    }

    if (!accessToken) {
      throw new BadRequestException('No Gmail access token available for mailbox');
    }

    return {
      accessToken,
      accessTokenExpiresAt,
      tokenRefreshed
    };
  }

  private async getValidOutlookAccessToken(user: UserContext, mailbox: MailboxAuthRow): Promise<OauthAccessTokenResult> {
    const refreshToken = this.decryptToken(mailbox.oauth_refresh_token);
    let accessToken = this.decryptToken(mailbox.oauth_access_token);
    let accessTokenExpiresAt = mailbox.oauth_token_expires_at;
    let tokenRefreshed = false;

    if (!accessToken || this.isAccessTokenStale(mailbox.oauth_token_expires_at)) {
      if (!refreshToken) {
        throw new BadRequestException(
          'No Outlook refresh token available. Reconnect Outlook with consent to grant offline access.'
        );
      }

      const refreshed = await this.outlookProviderClient.refreshAccessToken(refreshToken);
      accessToken = refreshed.accessToken;
      accessTokenExpiresAt = refreshed.accessTokenExpiresAt?.toISOString() ?? null;
      tokenRefreshed = true;
      await this.persistMailboxAccessToken(user, mailbox.id, accessToken, refreshed.accessTokenExpiresAt, refreshed.scope);
    }

    if (!accessToken) {
      throw new BadRequestException('No Outlook access token available for mailbox');
    }

    return {
      accessToken,
      accessTokenExpiresAt,
      tokenRefreshed
    };
  }

  private async getMailboxAuthRow(user: UserContext, mailboxId: string): Promise<MailboxAuthRow> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query<MailboxAuthRow>(
        `SELECT
            m.id,
            m.provider,
            m.email_address,
            m.oauth_access_token,
            m.oauth_refresh_token,
            m.oauth_token_expires_at,
            m.oauth_scope
         FROM "MailboxConnection" m
         WHERE m.id = $1
           AND m.user_id = $2
         LIMIT 1`,
        [mailboxId, user.userId]
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
