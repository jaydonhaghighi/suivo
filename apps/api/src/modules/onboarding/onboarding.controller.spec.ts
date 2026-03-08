import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OnboardingController } from './onboarding.controller';

describe('OnboardingController.register', () => {
  it('wraps async onboarding failures as 500 errors in development mode', async () => {
    const onboardingService = {
      register: jest.fn().mockRejectedValue({
        message: 'duplicate key value violates unique constraint "User_clerk_id_key"',
        code: '23505',
        constraint: 'User_clerk_id_key'
      })
    };
    const jwtVerifierService = {
      getSubjectFromAuthorizationHeader: jest.fn().mockResolvedValue('clerk-1')
    };
    const configService = {
      get: jest.fn().mockReturnValue('development')
    } as unknown as ConfigService;

    const controller = new OnboardingController(
      onboardingService as never,
      jwtVerifierService as never,
      configService
    );

    await expect(controller.register('Bearer token', { role: 'TEAM_LEAD' })).rejects.toBeInstanceOf(
      InternalServerErrorException
    );
  });
});
