import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { DatabaseService } from '../db/database.service';
import { JwtVerifierService } from './jwt-verifier.service';
import { AuthGuard } from './auth.guard';
import { RequestWithUser } from './user-context';

describe('AuthGuard', () => {
  it('resolves user with clerk_id session context under RLS', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false)
    } as unknown as Reflector;
    const configService = {
      get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
        if (key === 'NODE_ENV') {
          return 'development';
        }
        if (key === 'ALLOW_DEV_HEADER_AUTH') {
          return false;
        }
        return defaultValue;
      })
    };
    const databaseService = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 'user-1', team_id: 'team-1', role: 'TEAM_LEAD' }]
      })
    } as unknown as DatabaseService;
    const jwtVerifierService = {
      getSubjectFromAuthorizationHeader: jest.fn().mockResolvedValue('clerk-1')
    } as unknown as JwtVerifierService;

    const guard = new AuthGuard(
      reflector,
      configService as never,
      databaseService,
      jwtVerifierService
    );

    const request: RequestWithUser & { headers: Record<string, string | undefined> } = {
      headers: { authorization: 'Bearer token' }
    } as never;

    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => request
      })
    } as never;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      userId: 'user-1',
      teamId: 'team-1',
      role: 'TEAM_LEAD'
    });
    expect((databaseService.query as jest.Mock).mock.calls[0]?.[0]).toContain("set_config('app.clerk_id'");
  });

  it('throws unauthorized when no linked user exists', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false)
    } as unknown as Reflector;
    const configService = {
      get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
        if (key === 'NODE_ENV') {
          return 'development';
        }
        if (key === 'ALLOW_DEV_HEADER_AUTH') {
          return false;
        }
        return defaultValue;
      })
    };
    const databaseService = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
    } as unknown as DatabaseService;
    const jwtVerifierService = {
      getSubjectFromAuthorizationHeader: jest.fn().mockResolvedValue('clerk-missing')
    } as unknown as JwtVerifierService;

    const guard = new AuthGuard(
      reflector,
      configService as never,
      databaseService,
      jwtVerifierService
    );

    const request: RequestWithUser & { headers: Record<string, string | undefined> } = {
      headers: { authorization: 'Bearer token' }
    } as never;

    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => request
      })
    } as never;

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
