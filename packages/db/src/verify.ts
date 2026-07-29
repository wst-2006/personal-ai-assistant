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
  const reminderColumnsResult = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'reminder_jobs'
      AND column_name IN ('schedule_revision', 'scheduled_at', 'available_at', 'payload')
    ORDER BY column_name
  `);
  const reminderContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = 'public.reminder_jobs'::regclass
      AND conname = 'reminder_jobs_schedule_revision_check'
    UNION ALL
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'reminder_jobs'
      AND indexname = 'reminder_jobs_task_channel_kind_unique'
    ORDER BY name
  `);
  const tableNames = tablesResult.rows.map((row) => row.table_name);
  const taskColumns = taskColumnsResult.rows.map((row) => row.column_name);
  const taskConstraints = taskConstraintsResult.rows.map((row) => row.conname);
  const reminderColumns = reminderColumnsResult.rows.map((row) => row.column_name);
  const reminderContract = reminderContractResult.rows.map((row) => row.name);
  const expectedTables = ["inbox_entries", "tasks"];
  const expectedColumns = ["planned_effort_minutes", "source_inbox_entry_id"];
  const expectedConstraints = [
    "tasks_exact_minimum_duration_check",
    "tasks_planned_effort_check",
    "tasks_schedule_shape_check"
  ];
  const expectedReminderColumns = ["available_at", "payload", "schedule_revision", "scheduled_at"];
  const expectedReminderContract = ["reminder_jobs_schedule_revision_check", "reminder_jobs_task_channel_kind_unique"];

  if (expectedTables.some((name) => !tableNames.includes(name))
    || expectedColumns.some((name) => !taskColumns.includes(name))
    || expectedConstraints.some((name) => !taskConstraints.includes(name))
    || expectedReminderColumns.some((name) => !reminderColumns.includes(name))
    || expectedReminderContract.some((name) => !reminderContract.includes(name))) {
    throw new Error("Database schema is missing the task, inbox, or reminder migration contract.");
  }

  console.log(JSON.stringify({
    target: targetResult.rows[0],
    privileges: privilegesResult.rows[0],
    tables: tableNames,
    taskColumns,
    taskConstraints,
    reminderColumns,
    reminderContract
  }, null, 2));
} finally {
  await client.end();
}
