import { ConflictException, NotFoundException } from '@nestjs/common';

import { TeamService } from './team.service';

describe('TeamService join code', () => {
  it('returns an existing team join code', async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          join_code_hash: 'existing-hash',
          join_code_encrypted: Buffer.from('cipher'),
          join_code_generated_at: '2026-03-01T10:00:00.000Z'
        }
      ]
    });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      decrypt: jest.fn().mockReturnValue('TEAMCODE10'),
      generate: jest.fn()
    };

    const service = new TeamService(db as never, teamCodeService as never);
    const result = await service.getTeamJoinCode({
      userId: 'lead-1',
      teamId: 'team-1',
      role: 'TEAM_LEAD'
    });

    expect(result).toEqual({
      team_code: 'TEAMCODE10',
      generated_at: '2026-03-01T10:00:00.000Z'
    });
    expect(teamCodeService.generate).not.toHaveBeenCalled();
  });

  it('lazily generates a team join code for legacy teams', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            join_code_hash: null,
            join_code_encrypted: null,
            join_code_generated_at: null
          }
        ]
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            join_code_hash: 'new-hash',
            join_code_encrypted: Buffer.from('cipher'),
            join_code_generated_at: '2026-03-02T10:00:00.000Z'
          }
        ]
      });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      decrypt: jest.fn().mockReturnValue(null),
      generate: jest.fn().mockReturnValue({
        code: 'NEWCODE1234',
        hash: 'new-hash',
        encrypted: Buffer.from('cipher')
      })
    };

    const service = new TeamService(db as never, teamCodeService as never);
    const result = await service.getTeamJoinCode({
      userId: 'lead-1',
      teamId: 'team-1',
      role: 'TEAM_LEAD'
    });

    expect(result).toEqual({
      team_code: 'NEWCODE1234',
      generated_at: '2026-03-02T10:00:00.000Z'
    });
    expect(teamCodeService.generate).toHaveBeenCalledTimes(1);
  });
});

describe('TeamService linkAgentClerkId', () => {
  it('links an unlinked agent to a clerk account', async () => {
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('AND role = \'AGENT\'')) {
        return {
          rowCount: 1,
          rows: [{ id: 'agent-1', team_id: 'team-1', role: 'AGENT', clerk_id: null }]
        };
      }
      if (text.includes('WHERE clerk_id = $1')) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('UPDATE "User"')) {
        return {
          rowCount: 1,
          rows: [{ id: 'agent-1', team_id: 'team-1', role: 'AGENT', clerk_id: 'user_123' }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      decrypt: jest.fn(),
      generate: jest.fn()
    };

    const service = new TeamService(db as never, teamCodeService as never);
    const result = await service.linkAgentClerkId(
      { userId: 'lead-1', teamId: 'team-1', role: 'TEAM_LEAD' },
      'agent-1',
      { clerk_id: 'user_123' }
    );

    expect(result).toEqual({
      user_id: 'agent-1',
      team_id: 'team-1',
      role: 'AGENT',
      clerk_id: 'user_123',
      linked: true
    });
  });

  it('returns idempotent success when agent already has same clerk_id', async () => {
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('AND role = \'AGENT\'')) {
        return {
          rowCount: 1,
          rows: [{ id: 'agent-1', team_id: 'team-1', role: 'AGENT', clerk_id: 'user_123' }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      decrypt: jest.fn(),
      generate: jest.fn()
    };

    const service = new TeamService(db as never, teamCodeService as never);
    const result = await service.linkAgentClerkId(
      { userId: 'lead-1', teamId: 'team-1', role: 'TEAM_LEAD' },
      'agent-1',
      { clerk_id: 'user_123' }
    );

    expect(result).toEqual({
      user_id: 'agent-1',
      team_id: 'team-1',
      role: 'AGENT',
      clerk_id: 'user_123',
      linked: true
    });
  });

  it('rejects when the target agent is not found', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      decrypt: jest.fn(),
      generate: jest.fn()
    };

    const service = new TeamService(db as never, teamCodeService as never);

    await expect(
      service.linkAgentClerkId(
        { userId: 'lead-1', teamId: 'team-1', role: 'TEAM_LEAD' },
        'agent-missing',
        { clerk_id: 'user_123' }
      )
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects when agent is already linked to a different clerk account', async () => {
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('AND role = \'AGENT\'')) {
        return {
          rowCount: 1,
          rows: [{ id: 'agent-1', team_id: 'team-1', role: 'AGENT', clerk_id: 'user_existing' }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      decrypt: jest.fn(),
      generate: jest.fn()
    };

    const service = new TeamService(db as never, teamCodeService as never);

    await expect(
      service.linkAgentClerkId(
        { userId: 'lead-1', teamId: 'team-1', role: 'TEAM_LEAD' },
        'agent-1',
        { clerk_id: 'user_123' }
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects when clerk account is already linked to another user', async () => {
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('AND role = \'AGENT\'')) {
        return {
          rowCount: 1,
          rows: [{ id: 'agent-1', team_id: 'team-1', role: 'AGENT', clerk_id: null }]
        };
      }
      if (text.includes('WHERE clerk_id = $1')) {
        return {
          rowCount: 1,
          rows: [{ id: 'agent-2', team_id: 'team-1', role: 'AGENT', clerk_id: 'user_123' }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      decrypt: jest.fn(),
      generate: jest.fn()
    };

    const service = new TeamService(db as never, teamCodeService as never);

    await expect(
      service.linkAgentClerkId(
        { userId: 'lead-1', teamId: 'team-1', role: 'TEAM_LEAD' },
        'agent-1',
        { clerk_id: 'user_123' }
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps unique violation race on update to conflict', async () => {
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('AND role = \'AGENT\'')) {
        return {
          rowCount: 1,
          rows: [{ id: 'agent-1', team_id: 'team-1', role: 'AGENT', clerk_id: null }]
        };
      }
      if (text.includes('WHERE clerk_id = $1')) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('UPDATE "User"')) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "User_clerk_id_key"'), {
          code: '23505',
          constraint: 'User_clerk_id_key',
          table: 'User',
          detail: 'Key (clerk_id)=(user_123) already exists.'
        });
      }
      return { rowCount: 0, rows: [] };
    });

    const db = {
      withUserTransaction: async (
        _user: unknown,
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      decrypt: jest.fn(),
      generate: jest.fn()
    };

    const service = new TeamService(db as never, teamCodeService as never);

    await expect(
      service.linkAgentClerkId(
        { userId: 'lead-1', teamId: 'team-1', role: 'TEAM_LEAD' },
        'agent-1',
        { clerk_id: 'user_123' }
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
