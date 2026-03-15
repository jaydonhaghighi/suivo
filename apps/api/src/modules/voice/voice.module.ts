import { Module } from '@nestjs/common';

import { RawContentCryptoModule } from '../../common/crypto/raw-content-crypto.module';
import { VoiceService } from './voice.service';
import { TelnyxClient } from './telnyx.client';

@Module({
  imports: [RawContentCryptoModule],
  providers: [VoiceService, TelnyxClient],
  exports: [VoiceService]
})
export class VoiceModule {}
