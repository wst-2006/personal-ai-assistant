import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { DatabaseConfig } from "./config.js";
import { assertMigrationTarget } from "./migration-guard.js";
import * as schema from "./schema.js";

export type AppDatabase = NodePgDatabase<typeof schema>;

export type DatabaseConnection = {
  client: Pool;
  db: AppDatabase;
};

export async function connectVerifiedDatabase(config: DatabaseConfig): Promise<DatabaseConnection> {
  await assertMigrationTarget(config);

  const client = new Pool({ connectionString: config.DATABASE_URL });

  return {
    client,
    db: drizzle(client, { schema })
  };
}
