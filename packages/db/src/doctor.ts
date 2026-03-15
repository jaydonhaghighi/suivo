import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { loadEnv } from './load-env';

const migrationsDir = join(__dirname, '..', 'migrations');
const migrationTable = 'schema_migrations';

interface MigrationRow {
  filename: string;
  checksum: string;
}

function buildConnectionHelp(databaseUrl: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const details: string[] = [`Database connection failed before migration checks: ${message}`];

  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname;
    const port = parsed.port || '5432';
    const database = parsed.pathname.replace(/^\//, '') || '(default)';

    details.push(`Target: host=${host} port=${port} db=${database}`);

    if ((host === '127.0.0.1' || host === 'localhost') && (port === '6432' || port === '5432')) {
      details.push(
        'This target expects local Postgres for dev. Run `pnpm infra:up:local` (or `pnpm infra:up:deps`) first.'
      );
      details.push('Then re-run `pnpm db:doctor`.');
    }
  } catch {
    details.push('DATABASE_URL could not be parsed. Verify DATABASE_URL in .env.');
  }

  return details.join('\n');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function listLocalMigrations(): Map<string, string> {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const map = new Map<string, string>();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    map.set(file, sha256(sql));
  }

  return map;
}

async function main(): Promise<void> {
  loadEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const localMigrations = listLocalMigrations();
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 8000
  });

  try {
    await client.connect();
  } catch (error) {
    throw new Error(buildConnectionHelp(databaseUrl, error));
  }

  try {
    const tableCheck = await client.query<{ table_name: string | null }>(
      `SELECT to_regclass('public.${migrationTable}')::text AS table_name`
    );

    const tableName = tableCheck.rows[0]?.table_name ?? null;
    if (!tableName) {
      throw new Error(
        `Missing ${migrationTable} table in database. Run \`pnpm db:migrate:shared\` once to establish tracked migration history.`
      );
    }

    const dbRows = await client.query<MigrationRow>(
      `SELECT filename, checksum
       FROM "${migrationTable}"
       ORDER BY filename ASC`
    );
    const dbMap = new Map(dbRows.rows.map((row) => [row.filename, row.checksum]));

    const missingInDb = [...localMigrations.keys()].filter((name) => !dbMap.has(name));
    const unknownInDb = [...dbMap.keys()].filter((name) => !localMigrations.has(name));
    const checksumMismatch = [...localMigrations.entries()].filter(([name, checksum]) => {
      const dbChecksum = dbMap.get(name);
      return typeof dbChecksum === 'string' && dbChecksum !== checksum;
    });

    if (missingInDb.length > 0 || unknownInDb.length > 0 || checksumMismatch.length > 0) {
      const lines: string[] = ['Database migration doctor failed.'];

      if (missingInDb.length > 0) {
        lines.push(`Missing in DB: ${missingInDb.join(', ')}`);
      }

      if (unknownInDb.length > 0) {
        lines.push(`Unknown in DB: ${unknownInDb.join(', ')}`);
      }

      if (checksumMismatch.length > 0) {
        lines.push(
          `Checksum mismatch: ${checksumMismatch
            .map(([name, checksum]) => `${name} (db=${dbMap.get(name)}, local=${checksum})`)
            .join(', ')}`
        );
      }

      throw new Error(lines.join('\n'));
    }

    process.stdout.write(
      `Database migration doctor passed (${localMigrations.size} tracked migrations are in sync).\n`
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
