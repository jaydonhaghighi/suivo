import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query
} from '@nestjs/common';

import { CurrentUser } from '../../common/auth/current-user.decorator';
import { UserContext } from '../../common/auth/user-context';
import { Roles } from '../../common/rbac/roles.decorator';
import { reassignSchema } from './leads.contracts';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get(':id/derived')
  async getDerived(@CurrentUser() user: UserContext, @Param('id') leadId: string): Promise<Record<string, unknown>> {
    return this.leadsService.getDerivedProfile(user, leadId);
  }

  @Get(':id/events/metadata')
  async getMetadata(@CurrentUser() user: UserContext, @Param('id') leadId: string): Promise<Record<string, unknown>[]> {
    return this.leadsService.getEventMetadata(user, leadId);
  }

  @Get(':id/events/raw')
  async getRaw(
    @CurrentUser() user: UserContext,
    @Param('id') leadId: string,
    @Query('reason') reason?: string
  ): Promise<Record<string, unknown>> {
    return this.leadsService.getRawEvents(user, leadId, reason);
  }

  @Roles('TEAM_LEAD')
  @Post(':id/reassign')
  async reassign(
    @CurrentUser() user: UserContext,
    @Param('id') leadId: string,
    @Body() body: unknown
  ): Promise<{ lead_id: string; owner_agent_id: string }> {
    const payload = reassignSchema.parse(body);
    return this.leadsService.reassignLead(user, leadId, payload.owner_agent_id);
  }
}
