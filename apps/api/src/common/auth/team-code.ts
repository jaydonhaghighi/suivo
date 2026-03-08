import { createHash, randomBytes } from 'crypto';

const TEAM_CODE_LENGTH = 10;

export function normalizeTeamCode(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase();
}

export function hashTeamCode(normalizedCode: string): string {
  return createHash('sha256').update(normalizedCode).digest('hex');
}

export function generateTeamCode(): string {
  let code = '';
  while (code.length < TEAM_CODE_LENGTH) {
    code += randomBytes(8).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  return code.slice(0, TEAM_CODE_LENGTH);
}

