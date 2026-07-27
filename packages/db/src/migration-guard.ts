import { Client } from "pg";
import type { DatabaseConfig } from "./config.js";

type ConnectedTarget = {
  databaseName: string;
  databaseUser: string;
  serverAddress: string | null;
  serverPort: number;
  serverVersionNum: string;
};

function majorVersion(versionNumber: string): number {
  return Math.floor(Number(versionNumber) / 10000);
}

function normalizeServerAddress(address: string | null): string | null {
  return address?.replace(/\/\d+$/, "") ?? null;
}

export function migrationTargetMismatches(config: DatabaseConfig, target: ConnectedTarget): string[] {
  const mismatches: string[] = [];

  if (target.databaseName !== config.EXPECTED_DB_NAME) mismatches.push("database name");
  if (target.databaseUser !== config.EXPECTED_DB_USER) mismatches.push("database user");
  if (normalizeServerAddress(target.serverAddress) !== normalizeServerAddress(config.EXPECTED_DB_HOST)) {
    mismatches.push("server address");
  }
  if (target.serverPort !== config.EXPECTED_DB_PORT) mismatches.push("server port");
  if (majorVersion(target.serverVersionNum) !== config.EXPECTED_PG_MAJOR) {
    mismatches.push("PostgreSQL major version");
  }

  return mismatches;
}

export async function assertMigrationTarget(config: DatabaseConfig): Promise<void> {
  const client = new Client({ connectionString: config.DATABASE_URL });

  try {
    await client.connect();
    const result = await client.query<ConnectedTarget>(`
      SELECT
        current_database() AS "databaseName",
        current_user AS "databaseUser",
        inet_server_addr()::text AS "serverAddress",
        inet_server_port() AS "serverPort",
        current_setting('server_version_num') AS "serverVersionNum"
    `);
    const target = result.rows[0];

    if (!target) {
      throw new Error("Migration guard received no PostgreSQL target information.");
    }

    const mismatches = migrationTargetMismatches(config, target);

    if (mismatches.length > 0) {
      throw new Error(
        `Refusing migration (${mismatches.join(", ")}): connected to ${target.databaseUser}@${target.serverAddress}:${target.serverPort}/${target.databaseName} on PostgreSQL ${target.serverVersionNum}.`
      );
    }
  } finally {
    await client.end();
  }
}
