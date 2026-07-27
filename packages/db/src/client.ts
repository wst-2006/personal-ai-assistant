import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import type { DatabaseConfig } from "./config.js";
import { assertMigrationTarget } from "./migration-guard.js";
import * as schema from "./schema.js";

export type AppDatabase = NodePgDatabase<typeof schema>;

export type DatabaseConnection = {
  client: Client;
  db: AppDatabase;
};

export async function connectVerifiedDatabase(config: DatabaseConfig): Promise<DatabaseConnection> {
  await assertMigrationTarget(config);

  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();

  return {
    client,
    db: drizzle(client, { schema })
  };
}
