import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Client } from "pg";

export function hasPendingMigration(migrationTimes: number[], latestAppliedAt: number | null): boolean {
  const latestBundledAt = migrationTimes.at(-1) ?? null;
  if (latestAppliedAt !== null && latestBundledAt !== null && latestAppliedAt > latestBundledAt) {
    throw new Error("Database migration history is newer than this application runtime; refusing to start an older build.");
  }
  return migrationTimes.some((migrationTime) => latestAppliedAt === null || migrationTime > latestAppliedAt);
}

export async function databaseHasPendingMigrations(client: Client, migrationsFolder: string): Promise<boolean> {
  const migrations = readMigrationFiles({ migrationsFolder });
  if (migrations.length === 0) return false;

  const tableResult = await client.query<{ migration_table: string | null }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS migration_table"
  );
  if (!tableResult.rows[0]?.migration_table) return true;

  const latestResult = await client.query<{ created_at: string | number | null }>(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1"
  );
  const latestValue = latestResult.rows[0]?.created_at;
  const latestAppliedAt = latestValue === null || latestValue === undefined ? null : Number(latestValue);
  if (latestAppliedAt !== null && !Number.isFinite(latestAppliedAt)) {
    throw new Error("Migration history contains an invalid created_at value.");
  }

  return hasPendingMigration(
    migrations.map((migration) => migration.folderMillis),
    latestAppliedAt
  );
}
