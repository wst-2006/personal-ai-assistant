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
  const taskColumnsResult = await client.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tasks'
      AND column_name IN ('planned_effort_minutes', 'source_inbox_entry_id')
    ORDER BY column_name
  `);
  const taskConstraintsResult = await client.query<{ conname: string }>(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.tasks'::regclass
      AND conname IN (
        'tasks_exact_minimum_duration_check',
        'tasks_planned_effort_check',
        'tasks_schedule_shape_check'
      )
    ORDER BY conname
  `);
  const tableNames = tablesResult.rows.map((row) => row.table_name);
  const taskColumns = taskColumnsResult.rows.map((row) => row.column_name);
  const taskConstraints = taskConstraintsResult.rows.map((row) => row.conname);
  const expectedTables = ["inbox_entries", "tasks"];
  const expectedColumns = ["planned_effort_minutes", "source_inbox_entry_id"];
  const expectedConstraints = [
    "tasks_exact_minimum_duration_check",
    "tasks_planned_effort_check",
    "tasks_schedule_shape_check"
  ];

  if (expectedTables.some((name) => !tableNames.includes(name))
    || expectedColumns.some((name) => !taskColumns.includes(name))
    || expectedConstraints.some((name) => !taskConstraints.includes(name))) {
    throw new Error("Database schema is missing the formal-task and inbox migration contract.");
  }

  console.log(JSON.stringify({
    target: targetResult.rows[0],
    privileges: privilegesResult.rows[0],
    tables: tableNames,
    taskColumns,
    taskConstraints
  }, null, 2));
} finally {
  await client.end();
}
