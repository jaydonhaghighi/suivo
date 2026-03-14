import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { LeadsService } from './leads.service';

describe('LeadsService raw access', () => {
  it('denies team lead raw access for non-stale lead', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'lead-1', team_id: 'team-1', owner_agent_id: 'agent-1', state: 'Active' }]
      });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const crypto = {
      decrypt: jest.fn()
    };

    const service = new LeadsService(db as never, crypto as never);

    await expect(
      service.getRawEvents(
        { userId: 'lead-1', teamId: 'team-1', role: 'TEAM_LEAD' },
        'lead-1',
        'investigate'
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies team lead derived profile for non-owned non-stale leads', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rowCount: 0,
      rows: []
    });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const crypto = {
      decrypt: jest.fn()
    };

    const service = new LeadsService(db as never, crypto as never);

    await expect(
      service.getDerivedProfile(
        { userId: 'team-lead-1', teamId: 'team-1', role: 'TEAM_LEAD' },
        'lead-1'
      )
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('loads team lead metadata from ConversationEvent after access check', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'lead-1', team_id: 'team-1', owner_agent_id: 'agent-1', state: 'Stale' }]
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'event-1', channel: 'email', type: 'email_received', direction: 'inbound', created_at: '2026-03-13T00:00:00.000Z' }]
      });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const crypto = {
      decrypt: jest.fn()
    };

    const service = new LeadsService(db as never, crypto as never);
    const result = await service.getEventMetadata(
      { userId: 'team-lead-1', teamId: 'team-1', role: 'TEAM_LEAD' },
      'lead-1'
    );

    expect(result).toEqual([
      { id: 'event-1', channel: 'email', type: 'email_received', direction: 'inbound', created_at: '2026-03-13T00:00:00.000Z' }
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('FROM "ConversationEvent"');
    expect(query.mock.calls[1]?.[0]).not.toContain('team_event_metadata');
  });
});
