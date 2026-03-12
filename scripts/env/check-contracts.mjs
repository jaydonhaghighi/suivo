#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '..', '..');

const targets = [
  {
    name: 'api',
    contract: 'config/env/api.required',
    envFile: '.env',
    exampleFile: '.env.example'
  },
  {
    name: 'mobile',
    contract: 'config/env/mobile.required',
    envFile: 'apps/mobile/.env',
    exampleFile: 'apps/mobile/.env.example'
  },
  {
    name: 'web',
    contract: 'config/env/web.required',
    envFile: 'apps/web-admin/.env',
    exampleFile: 'apps/web-admin/.env.example'
  }
];

function readContractKeys(relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function readEnvKeys(relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  if (!existsSync(absolutePath)) {
    return null;
  }

  const keys = new Set();
  const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, eqIndex).trim();
    if (/^[A-Z0-9_]+$/.test(key)) {
      keys.add(key);
    }
  }

  return keys;
}

const errors = [];

for (const target of targets) {
  const requiredKeys = readContractKeys(target.contract);

  const envKeys = readEnvKeys(target.envFile);
  if (!envKeys) {
    errors.push(`${target.envFile} is missing. Run \`pnpm env:pull\`.`);
  } else {
    const missing = requiredKeys.filter((key) => !envKeys.has(key));
    if (missing.length > 0) {
      errors.push(
        `${target.envFile} is missing required keys: ${missing.join(', ')}`
      );
    }
  }

  const exampleKeys = readEnvKeys(target.exampleFile);
  if (!exampleKeys) {
    errors.push(`${target.exampleFile} is missing.`);
  } else {
    const undocumented = requiredKeys.filter((key) => !exampleKeys.has(key));
    if (undocumented.length > 0) {
      errors.push(
        `${target.exampleFile} is missing documented required keys: ${undocumented.join(', ')}`
      );
    }
  }
}

if (errors.length > 0) {
  console.error('Environment contract check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Environment contract check passed.');
