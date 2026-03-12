import { Global, Module } from '@nestjs/common';

import { RawContentCryptoModule } from '../crypto/raw-content-crypto.module';
import { JwtVerifierService } from './jwt-verifier.service';
import { TeamCodeService } from './team-code.service';

@Global()
@Module({
  imports: [RawContentCryptoModule],
  providers: [JwtVerifierService, TeamCodeService],
  exports: [JwtVerifierService, TeamCodeService]
})
export class AuthModule {}
