import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpException,
  InternalServerErrorException,
  Post
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { onboardingRegisterSchema } from '@mvp/shared-types';
import { ZodError } from 'zod';

import { JwtVerifierService } from '../../common/auth/jwt-verifier.service';
import { Public } from '../../common/auth/public.decorator';
import { OnboardingRegisterResult, OnboardingService } from './onboarding.service';

@Controller('onboarding')
@Public()
export class OnboardingController {
  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly jwtVerifierService: JwtVerifierService,
    private readonly configService: ConfigService
  ) {}

  @Post('register')
  async register(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown
  ): Promise<OnboardingRegisterResult> {
    try {
      const payload = onboardingRegisterSchema.parse(body);
      const clerkId = await this.jwtVerifierService.getSubjectFromAuthorizationHeader(authorization);
      return await this.onboardingService.register(clerkId, payload);
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }
      if (error instanceof ZodError) {
        throw new BadRequestException(error.flatten());
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

        throw new InternalServerErrorException(`Onboarding failed: ${details || 'unknown error'}`);
      }

      throw new InternalServerErrorException('Onboarding failed');
    }
  }
}
