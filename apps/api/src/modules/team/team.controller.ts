import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  InternalServerErrorException,
  Param,
  Post,
  Query,
  Put
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CurrentUser } from '../../common/auth/current-user.decorator';
import { UserContext } from '../../common/auth/user-context';
import { Roles } from '../../common/rbac/roles.decorator';
import { TeamService } from './team.service';
import { VoiceService } from '../voice/voice.service';

@Controller('team')
@Roles('TEAM_LEAD')
export class TeamController {
  constructor(
    private readonly teamService: TeamService,
    private readonly configService: ConfigService,
    private readonly voiceService: VoiceService
  ) {}

  @Get('templates')
  async getTemplates(@CurrentUser() user: UserContext): Promise<Record<string, unknown>[]> {
    return this.teamService.getTemplates(user);
  }

  @Post('templates')
  async createTemplate(@CurrentUser() user: UserContext, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.teamService.createTemplate(user, body);
  }

  @Put('templates/:templateId')
  async updateTemplate(
    @CurrentUser() user: UserContext,
    @Param('templateId') templateId: string,
    @Body() body: unknown
  ): Promise<Record<string, unknown>> {
    return this.teamService.updateTemplate(user, templateId, body);
  }

  @Delete('templates/:templateId')
  async deleteTemplate(
    @CurrentUser() user: UserContext,
    @Param('templateId') templateId: string
  ): Promise<{ id: string; deleted: true }> {
    return this.teamService.deleteTemplate(user, templateId);
  }

  @Get('rescue-sequences')
  async getRescueSequences(@CurrentUser() user: UserContext): Promise<Record<string, unknown>[]> {
    return this.teamService.getRescueSequences(user);
  }

  @Put('rescue-sequences')
  async putRescueSequences(
    @CurrentUser() user: UserContext,
    @Body() body: unknown
  ): Promise<Record<string, unknown>[]> {
    return this.teamService.updateRescueSequences(user, body);
  }

  @Get('sla-dashboard')
  async getSlaDashboard(@CurrentUser() user: UserContext): Promise<Record<string, unknown>> {
    return this.teamService.getSlaDashboard(user);
  }

  @Get('rules')
  async getRules(@CurrentUser() user: UserContext): Promise<Record<string, unknown>> {
    return this.teamService.getRules(user);
  }

  @Get('join-code')
  async getJoinCode(@CurrentUser() user: UserContext): Promise<{ team_code: string; generated_at: string }> {
    try {
      return await this.teamService.getTeamJoinCode(user);
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (this.configService.get<string>('NODE_ENV') === 'development') {
        const pgError = error as { message?: string; code?: string; detail?: string; constraint?: string };
        const details = [
          pgError.message ? `message=${pgError.message}` : null,
          pgError.code ? `code=${pgError.code}` : null,
          pgError.constraint ? `constraint=${pgError.constraint}` : null,
          pgError.detail ? `detail=${pgError.detail}` : null
        ]
          .filter((value) => value !== null)
          .join(', ');

        throw new InternalServerErrorException(`Join code failed: ${details || 'unknown error'}`);
      }

      throw new InternalServerErrorException('Join code failed');
    }
  }

  @Get('admin/agents')
  async getAssignableAgents(@CurrentUser() user: UserContext): Promise<{ id: string; role: string; language: string }[]> {
    return this.teamService.getAssignableAgents(user);
  }

  @Post('admin/agents/:agentUserId/link-clerk')
  async linkAgentClerk(
    @CurrentUser() user: UserContext,
    @Param('agentUserId') agentUserId: string,
    @Body() body: unknown
  ): Promise<{ user_id: string; team_id: string; role: 'AGENT'; clerk_id: string; linked: true }> {
    return this.teamService.linkAgentClerkId(user, agentUserId, body);
  }

  @Get('admin/intake-queue')
  async getAdminIntakeQueue(@CurrentUser() user: UserContext): Promise<Record<string, unknown>[]> {
    return this.teamService.getAdminIntakeQueue(user);
  }

  @Get('admin/assigned-queue')
  async getAdminAssignedQueue(@CurrentUser() user: UserContext): Promise<Record<string, unknown>[]> {
    return this.teamService.getAdminAssignedQueue(user);
  }

  @Get('admin/reassign-queue')
  async getAdminReassignQueue(@CurrentUser() user: UserContext): Promise<Record<string, unknown>[]> {
    return this.teamService.getAdminReassignQueue(user);
  }

  @Get('admin/voice-lab/config')
  async getVoiceLabConfig(@CurrentUser() user: UserContext): Promise<Record<string, unknown>> {
    return this.voiceService.getVoiceLabConfig(user);
  }

  @Put('admin/voice-lab/config')
  async putVoiceLabConfig(@CurrentUser() user: UserContext, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.voiceService.updateVoiceLabConfig(user, body);
  }

  @Post('admin/voice-lab/sessions')
  async createVoiceLabSession(@CurrentUser() user: UserContext, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.voiceService.createManualVoiceSession(user, body);
  }

  @Get('admin/voice-lab/sessions')
  async listVoiceLabSessions(
    @CurrentUser() user: UserContext,
    @Query('lead_id') leadId?: string,
    @Query('limit') limit?: string
  ): Promise<Record<string, unknown>[]> {
    return this.voiceService.listVoiceLabSessions(user, { lead_id: leadId, limit });
  }

  @Get('admin/voice-lab/sessions/:sessionId/transcript')
  async getVoiceSessionTranscript(
    @CurrentUser() user: UserContext,
    @Param('sessionId') sessionId: string,
    @Query('reason') reason?: string
  ): Promise<Record<string, unknown>> {
    return this.voiceService.getVoiceSessionTranscript(user, sessionId, { reason });
  }

  @Post('admin/tasks/:taskId/assign')
  async assignAdminTask(
    @CurrentUser() user: UserContext,
    @Param('taskId') taskId: string,
    @Body() body: unknown
  ): Promise<{ task_id: string; lead_id: string; owner_agent_id: string }> {
    return this.teamService.assignBrokerTask(user, taskId, body);
  }

  @Put('rules')
  async putRules(@CurrentUser() user: UserContext, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.teamService.updateRules(user, body);
  }
}
