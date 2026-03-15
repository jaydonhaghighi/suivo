import { Module } from '@nestjs/common';

import { VoiceModule } from '../voice/voice.module';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

@Module({
  imports: [VoiceModule],
  controllers: [TeamController],
  providers: [TeamService]
})
export class TeamModule {}
