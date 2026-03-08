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

