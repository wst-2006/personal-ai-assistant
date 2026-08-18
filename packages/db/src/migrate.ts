import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDatabaseConfig } from "./config.js";
import { assertMigrationTarget } from "./migration-guard.js";
import { runMigrationPreflight } from "./migration-preflight.js";
import { databaseHasPendingMigrations } from "./migration-status.js";

const config = loadDatabaseConfig();
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(sourceDirectory, "../drizzle");

await assertMigrationTarget(config);
const statusClient = new Client({ connectionString: config.DATABASE_URL });
let pending = false;
try {
  await statusClient.connect();
  pending = await databaseHasPendingMigrations(statusClient, migrationsFolder);
} finally {
  await statusClient.end();
}

if (!pending) {
  console.log("Database schema is already current; no backup or migration was required.");
  process.exit(0);
}

const configuredBackupDirectory = process.env.PERSONAL_AI_MIGRATION_BACKUP_DIR?.trim();
const preflight = await runMigrationPreflight(
  config,
  configuredBackupDirectory ? resolve(configuredBackupDirectory) : undefined
);
console.log(`Migration backup created at ${preflight.backupPath}.`);

const client = new Client({ connectionString: config.DATABASE_URL });

try {
  await client.connect();
  await migrate(drizzle(client), {
    migrationsFolder
  });
  console.log("Migrations applied to personal_ai_assistant.");
} finally {
  await client.end();
}
