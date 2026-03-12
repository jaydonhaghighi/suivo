import { Injectable } from '@nestjs/common';

import { RawContentCryptoService } from '../crypto/raw-content-crypto.service';
import { generateTeamCode, hashTeamCode, normalizeTeamCode } from './team-code';

export interface GeneratedTeamCode {
  code: string;
  hash: string;
  encrypted: Buffer;
}

@Injectable()
export class TeamCodeService {
  constructor(private readonly rawContentCryptoService: RawContentCryptoService) {}

  generate(): GeneratedTeamCode {
    const code = generateTeamCode();
    return {
      code,
      hash: hashTeamCode(code),
      encrypted: this.rawContentCryptoService.encrypt(code)
    };
  }

  normalize(code: string): string {
    return normalizeTeamCode(code);
  }

  hash(normalizedCode: string): string {
    return hashTeamCode(normalizedCode);
  }

  decrypt(encryptedCode: Buffer | null): string | null {
    return this.rawContentCryptoService.decrypt(encryptedCode);
  }
}

