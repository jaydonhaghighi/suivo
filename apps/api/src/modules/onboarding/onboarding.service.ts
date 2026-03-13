import {
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import {
  escalationRuleSchema,
  slaRuleSchema,
  staleRuleSchema
} from '@mvp/shared-types';
import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';

import { TeamCodeService } from '../../common/auth/team-code.service';
import { DatabaseService } from '../../common/db/database.service';
import {
  isTeamJoinCodeUniqueViolation,
  isUserClerkIdUniqueViolation
} from './onboarding-errors';
import {
  DEFAULT_LANGUAGE,
  ExistingUserRow,
  MAX_TEAM_CODE_GENERATION_ATTEMPTS,
  OnboardingRegisterResult,
  OnboardingRole,
  RegisterPayload,
  SAVEPOINT_AGENT_INSERT,
  SAVEPOINT_TEAM_LEAD_ATTEMPT
} from './onboarding.types';

@Injectable()
export class OnboardingService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly teamCodeService: TeamCodeService
  ) {}

  async register(clerkId: string, payload: RegisterPayload): Promise<OnboardingRegisterResult> {
    const existing = await this.findExistingUserByClerkId(clerkId);
    if (existing) {
      if (existing.role !== payload.role) {
        throw new ConflictException('Account is already registered with a different role');
      }
      return this.toRegisterResult(existing);
    }

    if (payload.role === 'TEAM_LEAD') {
      return this.registerTeamLead(clerkId, payload.language ?? DEFAULT_LANGUAGE);
    }

    return this.registerAgent(clerkId, payload.team_code, payload.language ?? DEFAULT_LANGUAGE);
  }

  private async registerTeamLead(clerkId: string, language: string): Promise<OnboardingRegisterResult> {
    return this.databaseService.withSystemTransaction(async (client) => {
      for (let attempt = 0; attempt < MAX_TEAM_CODE_GENERATION_ATTEMPTS; attempt += 1) {
        const teamId = uuidv4();
        const userId = uuidv4();
        const code = this.teamCodeService.generate();

        await client.query(`SAVEPOINT ${SAVEPOINT_TEAM_LEAD_ATTEMPT}`);
        try {
          await this.applyContext(client, userId, teamId, 'TEAM_LEAD');

          await client.query(
            `INSERT INTO "Team" (
               id,
               stale_rules,
               sla_rules,
               escalation_rules,
               join_code_hash,
               join_code_encrypted,
               join_code_generated_at
             ) VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, now())`,
            [
              teamId,
              JSON.stringify(staleRuleSchema.parse({})),
              JSON.stringify(slaRuleSchema.parse({})),
              JSON.stringify(escalationRuleSchema.parse({})),
              code.hash,
              code.encrypted
            ]
          );

          const userInsert = await client.query<ExistingUserRow>(
            `INSERT INTO "User" (id, team_id, role, language, clerk_id)
             VALUES ($1, $2, 'TEAM_LEAD', $3, $4)
             RETURNING id, team_id, role`,
            [userId, teamId, language, clerkId]
          );

          await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_TEAM_LEAD_ATTEMPT}`);
          return this.toRegisterResult(userInsert.rows[0]);
        } catch (error: unknown) {
          await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_TEAM_LEAD_ATTEMPT}`);
          await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_TEAM_LEAD_ATTEMPT}`);

          if (isTeamJoinCodeUniqueViolation(error)) {
            continue;
          }

          if (isUserClerkIdUniqueViolation(error)) {
            return this.resolveRaceOnUserInsert(client, clerkId, 'TEAM_LEAD');
          }

          throw error;
        }
      }
      throw new Error('Unable to generate a unique team code');
    });
  }

  private async registerAgent(
    clerkId: string,
    rawTeamCode: string,
    language: string
  ): Promise<OnboardingRegisterResult> {
    const normalizedCode = this.teamCodeService.normalize(rawTeamCode);
    if (!normalizedCode) {
      throw new NotFoundException('Invalid team code');
    }

    const teamCodeHash = this.teamCodeService.hash(normalizedCode);

    return this.databaseService.withSystemTransaction(async (client) => {
      await client.query(
        `SELECT set_config('app.team_join_code_hash', $1, true)`,
        [teamCodeHash]
      );

      const teamLookup = await client.query<{ id: string }>(
        `SELECT id
         FROM "Team"
         WHERE join_code_hash = $1
         LIMIT 1`,
        [teamCodeHash]
      );

      const targetTeamId = teamLookup.rows[0]?.id;
      if (!targetTeamId) {
        throw new NotFoundException('Invalid team code');
      }

      await client.query(`SAVEPOINT ${SAVEPOINT_AGENT_INSERT}`);
      try {
        const userId = uuidv4();
        await this.applyContext(client, userId, targetTeamId, 'TEAM_LEAD');

        const insertedUser = await client.query<ExistingUserRow>(
          `INSERT INTO "User" (id, team_id, role, language, clerk_id)
           VALUES ($1, $2, 'AGENT', $3, $4)
           RETURNING id, team_id, role`,
          [userId, targetTeamId, language, clerkId]
        );
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_AGENT_INSERT}`);
        return this.toRegisterResult(insertedUser.rows[0]);
      } catch (error: unknown) {
        await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_AGENT_INSERT}`);
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_AGENT_INSERT}`);

        if (isUserClerkIdUniqueViolation(error)) {
          return this.resolveRaceOnUserInsert(client, clerkId, 'AGENT');
        }
        throw error;
      }
    });
  }

  private async resolveRaceOnUserInsert(
    client: PoolClient,
    clerkId: string,
    expectedRole: OnboardingRole
  ): Promise<OnboardingRegisterResult> {
    const existing = await this.findExistingUserByClerkId(clerkId, client);
    if (!existing) {
      throw new ConflictException('Unable to register account. Please retry.');
    }

    if (existing.role !== expectedRole) {
      throw new ConflictException('Account is already registered with a different role');
    }

    return this.toRegisterResult(existing);
  }

  private async findExistingUserByClerkId(
    clerkId: string,
    client?: PoolClient
  ): Promise<ExistingUserRow | null> {
    const queryText = `WITH clerk_context AS (
         SELECT set_config('app.clerk_id', $1, true)
       )
       SELECT u.id, u.team_id, u.role
       FROM clerk_context, "User" u
       WHERE u.clerk_id = $1
       LIMIT 1`;
    const result = client
      ? await client.query<ExistingUserRow>(queryText, [clerkId])
      : await this.databaseService.query<ExistingUserRow>(queryText, [clerkId]);

    return result.rows[0] ?? null;
  }

  private toRegisterResult(user: ExistingUserRow): OnboardingRegisterResult {
    return {
      user_id: user.id,
      team_id: user.team_id,
      role: user.role,
      onboarding_completed: true
    };
  }

  private async applyContext(
    client: PoolClient,
    userId: string,
    teamId: string,
    role: 'AGENT' | 'TEAM_LEAD'
  ): Promise<void> {
    await client.query(
      `SELECT
        set_config('app.user_id', $1, true),
        set_config('app.team_id', $2, true),
        set_config('app.role', $3, true)`,
      [userId, teamId, role]
    );
  }
}
