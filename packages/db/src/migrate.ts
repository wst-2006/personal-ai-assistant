import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDatabaseConfig } from "./config.js";
import { assertMigrationTarget } from "./migration-guard.js";

const config = loadDatabaseConfig();
await assertMigrationTarget(config);

const client = new Client({ connectionString: config.DATABASE_URL });
const sourceDirectory = dirname(fileURLToPath(import.meta.url));

try {
  await client.connect();
  await migrate(drizzle(client), {
    migrationsFolder: resolve(sourceDirectory, "../drizzle")
  });
  console.log("Migrations applied to personal_ai_assistant.");
} finally {
  await client.end();
}
