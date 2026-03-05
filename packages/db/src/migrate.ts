import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { loadEnv } from './load-env';

const migrationsDir = join(__dirname, '..', 'migrations');
const migrationTable = 'schema_migrations';
const migrationLockId = 834276451;

interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

interface AppliedMigrationRow {
  filename: string;
  checksum: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getMigrationFiles(): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(migrationsDir, filename), 'utf8');
      return {
        filename,
        sql,
        checksum: sha256(sql)
      };
    });
}

async function ensureMigrationTable(client: Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${migrationTable}" (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
  );
}

async function acquireMigrationLock(client: Client): Promise<void> {
  await client.query('SELECT pg_advisory_lock($1)', [migrationLockId]);
}

async function releaseMigrationLock(client: Client): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]);
}

async function getAppliedMigrations(client: Client): Promise<Map<string, AppliedMigrationRow>> {
  const rows = await client.query<AppliedMigrationRow>(
    `SELECT filename, checksum
     FROM "${migrationTable}"`
  );

  return new Map(rows.rows.map((row) => [row.filename, row]));
}

async function recordAppliedMigration(client: Client, filename: string, checksum: string): Promise<void> {
  await client.query(
    `INSERT INTO "${migrationTable}" (filename, checksum)
     VALUES ($1, $2)
     ON CONFLICT (filename) DO UPDATE
     SET checksum = EXCLUDED.checksum`,
    [filename, checksum]
  );
}

async function main(): Promise<void> {
  loadEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const mode = process.env.MVP_DB_MIGRATION_MODE ?? 'local';

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let lockAcquired = false;

  try {
    await ensureMigrationTable(client);
    await acquireMigrationLock(client);
    lockAcquired = true;

    process.stdout.write(`Migration mode: ${mode}\n`);

    const files = getMigrationFiles();
    const applied = await getAppliedMigrations(client);

    for (const file of files) {
      const existing = applied.get(file.filename);
      if (existing) {
        if (existing.checksum !== file.checksum) {
          throw new Error(
            `Checksum mismatch for ${file.filename}. Expected ${existing.checksum} in DB, got ${file.checksum} locally.`
          );
        }

        process.stdout.write(`Skipping migration ${file.filename} (already applied)\n`);
        continue;
      }

      const legacy = await alreadyAppliedLegacy(client, file.filename);
      if (legacy) {
        await recordAppliedMigration(client, file.filename, file.checksum);
        process.stdout.write(`Recorded legacy migration ${file.filename}\n`);
        continue;
      }

      process.stdout.write(`Applying migration ${file.filename}\n`);
      await client.query(file.sql);
      await recordAppliedMigration(client, file.filename, file.checksum);
    }

    process.stdout.write('Migrations applied successfully\n');
  } finally {
    if (lockAcquired) {
      await releaseMigrationLock(client);
    }
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});

async function alreadyAppliedLegacy(client: Client, filename: string): Promise<boolean> {
  if (filename.startsWith('001_')) {
    const check = await client.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'Team'
       LIMIT 1`
    );
    return Boolean(check.rowCount);
  }

  if (filename.startsWith('002_')) {
    const check = await client.query(
      `SELECT 1
       FROM pg_proc
       WHERE proname = 'app_user_id'
       LIMIT 1`
    );
    return Boolean(check.rowCount);
  }

  if (filename.startsWith('003_')) {
    const check = await client.query(
      `SELECT 1
       FROM pg_trigger
       WHERE tgname = 'trg_lead_updated_at'
       LIMIT 1`
    );
    return Boolean(check.rowCount);
  }

  if (filename.startsWith('004_')) {
    const check = await client.query<{ has_column: boolean; has_index: boolean }>(
      `SELECT
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'User'
             AND column_name = 'clerk_id'
         ) AS has_column,
         EXISTS (
           SELECT 1
           FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname = 'ux_user_clerk_id'
         ) AS has_index`
    );
    return Boolean(check.rows[0]?.has_column && check.rows[0]?.has_index);
  }

  if (filename.startsWith('005_')) {
    const check = await client.query<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity
       FROM pg_class
       WHERE oid = '"Lead"'::regclass`
    );
    return Boolean(check.rows[0]?.relforcerowsecurity);
  }

  if (filename.startsWith('006_')) {
    const check = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('ux_lead_team_primary_email', 'ux_lead_team_primary_phone')`
    );
    return Number(check.rows[0]?.count ?? 0) === 2;
  }

  if (filename.startsWith('007_')) {
    const check = await client.query(
      `SELECT 1
       FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'Team'
         AND policyname = 'team_insert_policy'
       LIMIT 1`
    );
    return Boolean(check.rowCount);
  }

  if (filename.startsWith('008_')) {
    const check = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'MailboxConnection'
         AND column_name IN (
           'oauth_access_token',
           'oauth_refresh_token',
           'oauth_token_expires_at',
           'oauth_scope'
         )`
    );
    return Number(check.rows[0]?.count ?? 0) === 4;
  }

  return false;
}
