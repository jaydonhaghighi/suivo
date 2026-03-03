import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { loadEnv } from './load-env';

const migrationsDir = join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  loadEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const skip = await alreadyApplied(client, file);
      if (skip) {
        process.stdout.write(`Skipping migration ${file} (already applied)\n`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      process.stdout.write(`Applying migration ${file}\n`);
      await client.query(sql);
    }

    process.stdout.write('Migrations applied successfully\n');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});

async function alreadyApplied(client: Client, filename: string): Promise<boolean> {
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
