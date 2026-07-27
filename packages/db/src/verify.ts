import { Client } from "pg";
import { loadDatabaseConfig } from "./config.js";
import { assertMigrationTarget } from "./migration-guard.js";

const config = loadDatabaseConfig();
await assertMigrationTarget(config);

const client = new Client({ connectionString: config.DATABASE_URL });

try {
  await client.connect();
  const targetResult = await client.query(`
    SELECT
      current_database() AS database,
      current_user AS role,
      regexp_replace(inet_server_addr()::text, '/[0-9]+$', '') AS address,
      inet_server_port() AS port,
      current_setting('server_version') AS version
  `);
  const privilegesResult = await client.query(`
    SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `);
  const tablesResult = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);

  console.log(JSON.stringify({
    target: targetResult.rows[0],
    privileges: privilegesResult.rows[0],
    tables: tablesResult.rows.map((row) => row.table_name)
  }, null, 2));
} finally {
  await client.end();
}
