import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config as dotenvConfig } from 'dotenv';

const candidateEnvFiles = [
  '.env',
  '.env.local',
  '../../.env',
  '../../.env.local'
];

export function loadEnv(): void {
  if (process.env.DATABASE_URL) {
    return;
  }

  for (const relativePath of candidateEnvFiles) {
    const absolutePath = resolve(process.cwd(), relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }

    dotenvConfig({ path: absolutePath, override: false });

    if (process.env.DATABASE_URL) {
      return;
    }
  }
}
