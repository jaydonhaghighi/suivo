import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { DatabaseService } from '../db/database.service';
import { JwtVerifierService } from './jwt-verifier.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { RequestWithUser, UserContext } from './user-context';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly jwtVerifierService: JwtVerifierService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<
      RequestWithUser & { headers: Record<string, string | string[] | undefined> }
    >();
    const allowDevHeaderAuth = this.isDevHeaderAuthEnabled();

    const authHeader = request.headers.authorization;
    if (authHeader) {
      const clerkId = await this.jwtVerifierService.getSubjectFromAuthorizationHeader(authHeader);
      request.user = await this.resolveUser(clerkId);
      return true;
    }

    if (allowDevHeaderAuth) {
      const devUser = this.parseDevHeaderUser(request.headers);
      if (devUser) {
        request.user = devUser;
        return true;
      }
    }

    throw new UnauthorizedException('Authentication required');
  }

  private isDevHeaderAuthEnabled(): boolean {
    return this.configService.get<boolean>('ALLOW_DEV_HEADER_AUTH', false)
      && this.configService.get<string>('NODE_ENV') === 'development';
  }

  private parseDevHeaderUser(
    headers: Record<string, string | string[] | undefined>
  ): UserContext | null {
    const userId = headers['x-user-id'];
    const teamId = headers['x-team-id'];
    const role = headers['x-role'];
    if (
      typeof userId === 'string'
      && typeof teamId === 'string'
      && (role === 'AGENT' || role === 'TEAM_LEAD')
    ) {
      return { userId, teamId, role };
    }

    return null;
  }

  private async resolveUser(clerkId: string): Promise<UserContext> {
    const existing = await this.findByClerkId(clerkId);

    if (existing.rows[0]) {
      return {
        userId: existing.rows[0].id,
        teamId: existing.rows[0].team_id,
        role: existing.rows[0].role
      };
    }

    throw new UnauthorizedException(
      'No linked user account found. Ask a team admin to provision your account.'
    );
  }

  private findByClerkId(clerkId: string) {
    return this.databaseService.query<{
      id: string;
      team_id: string;
      role: 'AGENT' | 'TEAM_LEAD';
    }>(
      `WITH clerk_context AS (
         SELECT set_config('app.clerk_id', $1, true)
       )
       SELECT u.id, u.team_id, u.role
       FROM clerk_context, "User" u
       WHERE u.clerk_id = $1
       LIMIT 1`,
      [clerkId]
    );
  }
}
