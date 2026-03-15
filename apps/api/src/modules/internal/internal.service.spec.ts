import { InternalService } from './internal.service';

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    close: jest.fn()
  }))
}));

describe('InternalService mailbox backfill', () => {
  const makeConfigService = (overrides?: Record<string, string>) => ({
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379';
      }
      throw new Error(`Missing config: ${key}`);
    }),
    get: jest.fn((key: string) => overrides?.[key])
  });

  const makeDatabaseService = (row: Record<string, unknown> | null) => {
    const query = jest.fn().mockResolvedValue({
      rows: row ? [row] : [],
      rowCount: row ? 1 : 0
    });

    return {
      withSystemTransaction: jest.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) =>
        fn({ query })
      )
    };
  };

  it('returns skipped when mailbox does not exist', async () => {
    const configService = makeConfigService();
    const databaseService = makeDatabaseService(null);
    const mailboxesService = {
      pullAllActiveGmailMailboxes: jest.fn(),
      pullGmailInbox: jest.fn(),
      pullOutlookInbox: jest.fn()
    };
    const voiceService = {
      dispatchDueSessions: jest.fn()
    };

    const service = new InternalService(
      configService as never,
      databaseService as never,
      mailboxesService as never,
      voiceService as never
    );
    const result = await service.triggerMailboxBackfill({
      mailbox_id: '8d4f0ee9-3f90-4e6a-b2d6-bc7964a17f6e'
    });

    expect(result).toEqual({
      status: 'skipped',
      mailbox_connection_id: '8d4f0ee9-3f90-4e6a-b2d6-bc7964a17f6e',
      reason: 'mailbox_not_found'
    });
    expect(mailboxesService.pullGmailInbox).not.toHaveBeenCalled();
  });

  it('runs outlook backfill through pullOutlookInbox', async () => {
    const configService = makeConfigService();
    const databaseService = makeDatabaseService({
      mailbox_id: 'f5fd26c3-4574-40dd-8d1f-4a28f2cb95eb',
      provider: 'outlook',
      status: 'active',
      user_id: 'user-1',
      team_id: 'team-1',
      role: 'AGENT'
    });
    const mailboxesService = {
      pullAllActiveGmailMailboxes: jest.fn(),
      pullGmailInbox: jest.fn(),
      pullOutlookInbox: jest.fn().mockResolvedValue({
        mailbox_connection_id: 'f5fd26c3-4574-40dd-8d1f-4a28f2cb95eb',
        pulled: 7,
        accepted: 6,
        deduped: 1,
        created_or_updated: 5,
        lead_count: 2,
        lead_created_count: 3,
        needs_review_count: 2,
        rejected_count: 1,
        classification_completed: 0,
        classification_queued: 5,
        classification_failed: 0,
        recent_emails: []
      })
    };
    const voiceService = {
      dispatchDueSessions: jest.fn()
    };

    const service = new InternalService(
      configService as never,
      databaseService as never,
      mailboxesService as never,
      voiceService as never
    );
    const result = await service.triggerMailboxBackfill({
      mailbox_id: 'f5fd26c3-4574-40dd-8d1f-4a28f2cb95eb'
    });

    expect(mailboxesService.pullOutlookInbox).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        teamId: 'team-1',
        role: 'AGENT'
      },
      'f5fd26c3-4574-40dd-8d1f-4a28f2cb95eb',
      {
        newer_than_hours: 24 * 365,
        max_results: 5000,
        await_classification: false,
        preview_limit: 10,
        ingest_source: 'backfill'
      }
    );
    expect(result).toMatchObject({
      status: 'completed',
      provider: 'outlook',
      mailbox_connection_id: 'f5fd26c3-4574-40dd-8d1f-4a28f2cb95eb',
      pulled: 7
    });
  });

  it('runs gmail backfill through pullGmailInbox', async () => {
    const configService = makeConfigService();
    const databaseService = makeDatabaseService({
      mailbox_id: '4b9836c5-b628-4256-95ec-ea6bd084a826',
      provider: 'gmail',
      status: 'active',
      user_id: 'user-1',
      team_id: 'team-1',
      role: 'TEAM_LEAD'
    });
    const mailboxesService = {
      pullAllActiveGmailMailboxes: jest.fn(),
      pullGmailInbox: jest.fn().mockResolvedValue({
        mailbox_connection_id: '4b9836c5-b628-4256-95ec-ea6bd084a826',
        pulled: 5,
        accepted: 4,
        deduped: 1,
        created_or_updated: 3,
        lead_count: 2,
        lead_created_count: 2,
        needs_review_count: 1,
        rejected_count: 1,
        classification_completed: 0,
        classification_queued: 3,
        classification_failed: 0,
        recent_emails: []
      }),
      pullOutlookInbox: jest.fn()
    };
    const voiceService = {
      dispatchDueSessions: jest.fn()
    };

    const service = new InternalService(
      configService as never,
      databaseService as never,
      mailboxesService as never,
      voiceService as never
    );
    const result = await service.triggerMailboxBackfill({
      mailbox_id: '4b9836c5-b628-4256-95ec-ea6bd084a826',
      newer_than_hours: 48,
      max_results: 200,
      await_classification: false,
      preview_limit: 5
    });

    expect(mailboxesService.pullGmailInbox).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        teamId: 'team-1',
        role: 'TEAM_LEAD'
      },
      '4b9836c5-b628-4256-95ec-ea6bd084a826',
      {
        newer_than_hours: 48,
        max_results: 200,
        await_classification: false,
        preview_limit: 5,
        ingest_source: 'backfill'
      }
    );
    expect(result).toMatchObject({
      status: 'completed',
      provider: 'gmail',
      mailbox_connection_id: '4b9836c5-b628-4256-95ec-ea6bd084a826',
      pulled: 5
    });
  });
});
