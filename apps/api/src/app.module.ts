import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './common/auth/auth.module';
import { AuthGuard } from './common/auth/auth.guard';
import { RawContentCryptoModule } from './common/crypto/raw-content-crypto.module';
import { DatabaseModule } from './common/db/database.module';
import { RolesGuard } from './common/rbac/roles.guard';
import { validateEnv } from './env';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { AiModule } from './modules/ai/ai.module';
import { CallsModule } from './modules/calls/calls.module';
import { HealthModule } from './modules/health/health.module';
import { InternalModule } from './modules/internal/internal.module';
import { LeadsModule } from './modules/leads/leads.module';
import { MailboxesModule } from './modules/mailboxes/mailboxes.module';
import { MessagesModule } from './modules/messages/messages.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { TeamModule } from './modules/team/team.module';
import { UsersModule } from './modules/users/users.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env', '../../.env.local', '../../.env'],
      validate: validateEnv
    }),
    AuthModule,
    DatabaseModule,
    RawContentCryptoModule,
    HealthModule,
    AttachmentsModule,
    InternalModule,
    WebhooksModule,
    MailboxesModule,
    TasksModule,
    LeadsModule,
    MessagesModule,
    CallsModule,
    OnboardingModule,
    TeamModule,
    UsersModule,
    AiModule
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard
    }
  ]
})
export class AppModule {}
