import { ConflictException, NotFoundException } from '@nestjs/common';

import { OnboardingService } from './onboarding.service';

describe('OnboardingService.register', () => {
  it('retries team lead registration when join code collision is identified by table/detail fallback', async () => {
    let teamInsertAttempts = 0;
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('set_config')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "Team"')) {
        teamInsertAttempts += 1;
        if (teamInsertAttempts === 1) {
          const error = Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
            table: 'Team',
            detail: 'Key (join_code_hash)=(hash-collision) already exists.'
          });
          throw error;
        }
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "User"')) {
        return {
          rowCount: 1,
          rows: [{ id: 'user-retry-fallback', team_id: 'team-retry-fallback', role: 'TEAM_LEAD' }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const db = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      withSystemTransaction: async (
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      generate: jest
        .fn()
        .mockReturnValueOnce({
          code: 'TEAMCODE-COLLIDE-FALLBACK',
          hash: 'hash-collision',
          encrypted: Buffer.from('cipher-collision')
        })
        .mockReturnValueOnce({
          code: 'TEAMCODE-FRESH-FALLBACK',
          hash: 'hash-fresh-fallback',
          encrypted: Buffer.from('cipher-fresh-fallback')
        }),
      normalize: jest.fn(),
      hash: jest.fn(),
      decrypt: jest.fn()
    };

    const service = new OnboardingService(db as never, teamCodeService as never);
    const result = await service.register('clerk-retry-fallback', { role: 'TEAM_LEAD' });

    expect(result).toEqual({
      user_id: 'user-retry-fallback',
      team_id: 'team-retry-fallback',
      role: 'TEAM_LEAD',
      onboarding_completed: true
    });
    expect(teamCodeService.generate).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT onboarding_team_lead_attempt');
  });

  it('retries team lead registration when join code hash collides', async () => {
    let teamInsertAttempts = 0;
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('set_config')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "Team"')) {
        teamInsertAttempts += 1;
        if (teamInsertAttempts === 1) {
          const error = Object.assign(new Error('duplicate key value violates unique constraint "ux_team_join_code_hash"'), {
            code: '23505',
            constraint: 'ux_team_join_code_hash'
          });
          throw error;
        }
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "User"')) {
        return {
          rowCount: 1,
          rows: [{ id: 'user-retry', team_id: 'team-retry', role: 'TEAM_LEAD' }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const db = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      withSystemTransaction: async (
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      generate: jest
        .fn()
        .mockReturnValueOnce({
          code: 'TEAMCODE-COLLIDE',
          hash: 'hash-collide',
          encrypted: Buffer.from('cipher-collide')
        })
        .mockReturnValueOnce({
          code: 'TEAMCODE-FRESH',
          hash: 'hash-fresh',
          encrypted: Buffer.from('cipher-fresh')
        }),
      normalize: jest.fn(),
      hash: jest.fn(),
      decrypt: jest.fn()
    };

    const service = new OnboardingService(db as never, teamCodeService as never);
    const result = await service.register('clerk-retry', { role: 'TEAM_LEAD' });

    expect(result).toEqual({
      user_id: 'user-retry',
      team_id: 'team-retry',
      role: 'TEAM_LEAD',
      onboarding_completed: true
    });
    expect(teamCodeService.generate).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT onboarding_team_lead_attempt');
  });

  it('creates a team lead, team, and join code', async () => {
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('set_config')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "Team"')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "User"')) {
        return {
          rowCount: 1,
          rows: [{ id: 'user-1', team_id: 'team-1', role: 'TEAM_LEAD' }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const db = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      withSystemTransaction: async (
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      generate: jest.fn().mockReturnValue({
        code: 'TEAMCODE10',
        hash: 'code-hash',
        encrypted: Buffer.from('cipher')
      }),
      normalize: jest.fn(),
      hash: jest.fn(),
      decrypt: jest.fn()
    };

    const service = new OnboardingService(db as never, teamCodeService as never);

    const result = await service.register('clerk-1', { role: 'TEAM_LEAD' });

    expect(result).toEqual({
      user_id: 'user-1',
      team_id: 'team-1',
      role: 'TEAM_LEAD',
      onboarding_completed: true
    });
    expect(teamCodeService.generate).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalled();
  });

  it('registers an agent into a team from a valid code', async () => {
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('SELECT id') && text.includes('join_code_hash')) {
        return { rowCount: 1, rows: [{ id: 'team-99' }] };
      }
      if (text.includes('set_config')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "User"')) {
        return {
          rowCount: 1,
          rows: [{ id: 'agent-1', team_id: 'team-99', role: 'AGENT' }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const db = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      withSystemTransaction: async (
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      generate: jest.fn(),
      normalize: jest.fn().mockReturnValue('ABCD1234'),
      hash: jest.fn().mockReturnValue('hashed-code'),
      decrypt: jest.fn()
    };

    const service = new OnboardingService(db as never, teamCodeService as never);
    const result = await service.register('clerk-2', { role: 'AGENT', team_code: 'abcd-1234' });

    expect(result).toEqual({
      user_id: 'agent-1',
      team_id: 'team-99',
      role: 'AGENT',
      onboarding_completed: true
    });
    expect(query).toHaveBeenCalledWith(
      "SELECT set_config('app.team_join_code_hash', $1, true)",
      ['hashed-code']
    );
    expect(teamCodeService.normalize).toHaveBeenCalledWith('abcd-1234');
    expect(teamCodeService.hash).toHaveBeenCalledWith('ABCD1234');
  });

  it('rejects invalid agent team codes', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const db = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      withSystemTransaction: async (
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      generate: jest.fn(),
      normalize: jest.fn().mockReturnValue('BADCODE'),
      hash: jest.fn().mockReturnValue('missing'),
      decrypt: jest.fn()
    };

    const service = new OnboardingService(db as never, teamCodeService as never);

    await expect(
      service.register('clerk-3', { role: 'AGENT', team_code: 'bad-code' })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns existing account for idempotent same-role registration', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({
        rowCount: 1,
        rows: [{ id: 'agent-9', team_id: 'team-8', role: 'AGENT' }]
      }),
      withSystemTransaction: jest.fn()
    };

    const teamCodeService = {
      generate: jest.fn(),
      normalize: jest.fn(),
      hash: jest.fn(),
      decrypt: jest.fn()
    };

    const service = new OnboardingService(db as never, teamCodeService as never);
    const result = await service.register('clerk-9', { role: 'AGENT', team_code: 'ANY' });

    expect(result).toEqual({
      user_id: 'agent-9',
      team_id: 'team-8',
      role: 'AGENT',
      onboarding_completed: true
    });
    expect(db.withSystemTransaction).not.toHaveBeenCalled();
  });

  it('handles legacy clerk_id unique constraint names during registration race', async () => {
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('"User"') && text.includes('clerk_id = $1')) {
        return {
          rowCount: 1,
          rows: [{ id: 'lead-race', team_id: 'team-existing', role: 'TEAM_LEAD' }]
        };
      }
      if (text.includes('set_config')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "Team"')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "User"')) {
        const error = Object.assign(new Error('duplicate key value violates unique constraint "User_clerk_id_key"'), {
          code: '23505',
          constraint: 'User_clerk_id_key',
          table: 'User',
          detail: 'Key (clerk_id)=(clerk-race) already exists.'
        });
        throw error;
      }

      return { rowCount: 0, rows: [] };
    });

    const db = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      withSystemTransaction: async (
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      generate: jest.fn().mockReturnValue({
        code: 'TEAMCODE11',
        hash: 'code-hash-2',
        encrypted: Buffer.from('cipher-2')
      }),
      normalize: jest.fn(),
      hash: jest.fn(),
      decrypt: jest.fn()
    };

    const service = new OnboardingService(db as never, teamCodeService as never);

    const result = await service.register('clerk-race', { role: 'TEAM_LEAD' });
    expect(result).toEqual({
      user_id: 'lead-race',
      team_id: 'team-existing',
      role: 'TEAM_LEAD',
      onboarding_completed: true
    });
    expect(query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT onboarding_team_lead_attempt');
    expect(query).toHaveBeenCalledWith('RELEASE SAVEPOINT onboarding_team_lead_attempt');
  });

  it('handles clerk_id unique violation by table/detail fallback during registration race', async () => {
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('"User"') && text.includes('clerk_id = $1')) {
        return {
          rowCount: 1,
          rows: [{ id: 'lead-race-fallback', team_id: 'team-existing-fallback', role: 'TEAM_LEAD' }]
        };
      }
      if (text.includes('set_config')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "Team"')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "User"')) {
        const error = Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          table: 'User',
          detail: 'Key (clerk_id)=(clerk-race-fallback) already exists.'
        });
        throw error;
      }

      return { rowCount: 0, rows: [] };
    });

    const db = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      withSystemTransaction: async (
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      generate: jest.fn().mockReturnValue({
        code: 'TEAMCODE11-FALLBACK',
        hash: 'code-hash-2-fallback',
        encrypted: Buffer.from('cipher-2-fallback')
      }),
      normalize: jest.fn(),
      hash: jest.fn(),
      decrypt: jest.fn()
    };

    const service = new OnboardingService(db as never, teamCodeService as never);

    const result = await service.register('clerk-race-fallback', { role: 'TEAM_LEAD' });
    expect(result).toEqual({
      user_id: 'lead-race-fallback',
      team_id: 'team-existing-fallback',
      role: 'TEAM_LEAD',
      onboarding_completed: true
    });
    expect(query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT onboarding_team_lead_attempt');
    expect(query).toHaveBeenCalledWith('RELEASE SAVEPOINT onboarding_team_lead_attempt');
  });

  it('rolls back to savepoint for agent clerk_id race before resolving existing account', async () => {
    const query = jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('"User"') && text.includes('clerk_id = $1')) {
        return {
          rowCount: 1,
          rows: [{ id: 'agent-existing', team_id: 'team-100', role: 'AGENT' }]
        };
      }
      if (text.includes('SELECT id') && text.includes('join_code_hash')) {
        return { rowCount: 1, rows: [{ id: 'team-100' }] };
      }
      if (text.includes('set_config')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO "User"')) {
        const error = Object.assign(new Error('duplicate key value violates unique constraint "User_clerk_id_key"'), {
          code: '23505',
          constraint: 'User_clerk_id_key',
          table: 'User',
          detail: 'Key (clerk_id)=(clerk-agent-race) already exists.'
        });
        throw error;
      }

      return { rowCount: 0, rows: [] };
    });

    const db = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      withSystemTransaction: async (
        fn: (client: { query: typeof query }) => Promise<unknown>
      ) => fn({ query })
    };

    const teamCodeService = {
      generate: jest.fn(),
      normalize: jest.fn().mockReturnValue('ABCDE12345'),
      hash: jest.fn().mockReturnValue('team-hash-100'),
      decrypt: jest.fn()
    };

    const service = new OnboardingService(db as never, teamCodeService as never);

    const result = await service.register('clerk-agent-race', { role: 'AGENT', team_code: 'abcde-12345' });
    expect(result).toEqual({
      user_id: 'agent-existing',
      team_id: 'team-100',
      role: 'AGENT',
      onboarding_completed: true
    });
    expect(query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT onboarding_agent_insert');
    expect(query).toHaveBeenCalledWith('RELEASE SAVEPOINT onboarding_agent_insert');
  });

  it('rejects registration when existing account has a different role', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({
        rowCount: 1,
        rows: [{ id: 'lead-1', team_id: 'team-1', role: 'TEAM_LEAD' }]
      }),
      withSystemTransaction: jest.fn()
    };

    const teamCodeService = {
      generate: jest.fn(),
      normalize: jest.fn(),
      hash: jest.fn(),
      decrypt: jest.fn()
    };

    const service = new OnboardingService(db as never, teamCodeService as never);

    await expect(
      service.register('clerk-4', { role: 'AGENT', team_code: 'ABCD' })
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
