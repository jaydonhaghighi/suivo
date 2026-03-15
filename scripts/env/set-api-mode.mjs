#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const mode = (process.argv[2] ?? '').trim().toLowerCase();
if (mode !== 'local' && mode !== 'hosted') {
  console.error('Usage: node scripts/env/set-api-mode.mjs <local|hosted>');
  process.exit(1);
}

const presets = {
  local: {
    rootApiBaseUrl: 'http://localhost:3001',
    webApiBaseUrl: 'http://localhost:3001/v1',
    mobileApiBaseUrl: 'http://localhost:3001/v1',
    googleRedirectUri: 'http://localhost:3001/v1/mailboxes/oauth/gmail/callback',
    microsoftRedirectUri: 'http://localhost:3001/v1/mailboxes/oauth/outlook/callback'
  },
  hosted: {
    rootApiBaseUrl: 'https://api.suivo.ca',
    webApiBaseUrl: 'https://api.suivo.ca/v1',
    mobileApiBaseUrl: 'https://api.suivo.ca/v1',
    googleRedirectUri: 'https://api.suivo.ca/v1/mailboxes/oauth/gmail/callback',
    microsoftRedirectUri: 'https://api.suivo.ca/v1/mailboxes/oauth/outlook/callback'
  }
};

const selected = presets[mode];
const repoRoot = process.cwd();

const targets = [
  {
    relativePath: '.env',
    values: {
      API_BASE_URL: selected.rootApiBaseUrl,
      GOOGLE_REDIRECT_URI: selected.googleRedirectUri,
      MICROSOFT_REDIRECT_URI: selected.microsoftRedirectUri
    }
  },
  {
    relativePath: 'apps/mobile/.env',
    values: {
      EXPO_PUBLIC_API_BASE_URL: selected.mobileApiBaseUrl
    }
  },
  {
    relativePath: 'apps/web-admin/.env',
    values: {
      API_BASE_URL: selected.webApiBaseUrl,
      GOOGLE_REDIRECT_URI: selected.googleRedirectUri,
      MICROSOFT_REDIRECT_URI: selected.microsoftRedirectUri
    }
  }
];

function updateEnvFile(relativePath, replacements) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Missing ${relativePath}. Run pnpm env:pull first.`);
  }

  const content = fs.readFileSync(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const seen = new Set();
  const output = [];

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) {
      output.push(line);
      continue;
    }

    const key = match[1];
    if (!(key in replacements)) {
      output.push(line);
      continue;
    }

    if (seen.has(key)) {
      continue;
    }

    output.push(`${key}=${replacements[key]}`);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(replacements)) {
    if (!seen.has(key)) {
      output.push(`${key}=${value}`);
    }
  }

  const normalized = `${output.join('\n').replace(/\n+$/, '\n')}`;
  fs.writeFileSync(absolutePath, normalized, 'utf8');
  console.log(`Updated ${relativePath}`);
}

for (const target of targets) {
  updateEnvFile(target.relativePath, target.values);
}

if (mode === 'local') {
  console.log('\nMode set to LOCAL.');
  console.log('Next: pnpm dev:local:simulator (or pnpm dev:local:device).');
} else {
  console.log('\nMode set to HOSTED API.');
  console.log('Next: pnpm dev:hosted:simulator (or pnpm dev:hosted:device).');
}
