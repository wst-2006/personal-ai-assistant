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
      AND column_name IN ('planned_effort_minutes', 'difficulty', 'task_type', 'requires_continuous_focus', 'source_inbox_entry_id')
    ORDER BY column_name
  `);
  const taskConstraintsResult = await client.query<{ conname: string }>(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.tasks'::regclass
      AND conname IN (
        'tasks_exact_half_hour_boundary_check',
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
  const focusTablesResult = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('task_legacy_metadata', 'focus_structures', 'focus_structure_segments', 'focus_session_segment_runs', 'focus_timer_jobs')
    ORDER BY table_name
  `);
  const focusColumnsResult = await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'focus_structures' AND column_name IN ('task_schedule_revision', 'state', 'source', 'total_start_at', 'total_end_at'))
        OR (table_name = 'focus_sessions' AND column_name IN ('focus_structure_id', 'planned_end_at', 'current_segment_position', 'confirmation_deadline_at'))
        OR (table_name = 'focus_timer_jobs' AND column_name IN ('expected_session_version', 'due_at', 'status')))
    ORDER BY table_name, column_name
  `);
  const healthColumnsResult = await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'health_profiles' AND column_name IN ('profile', 'version'))
        OR (table_name = 'health_week_plans' AND column_name IN ('week_start', 'state', 'source', 'profile_version', 'city', 'solar_term', 'version'))
        OR (table_name = 'health_daily_references' AND column_name IN ('health_week_plan_id', 'local_date', 'day_index', 'content')))
    ORDER BY table_name, column_name
  `);
  const tableNames = tablesResult.rows.map((row) => row.table_name);
  const taskColumns = taskColumnsResult.rows.map((row) => row.column_name);
  const taskConstraints = taskConstraintsResult.rows.map((row) => row.conname);
  const reminderColumns = reminderColumnsResult.rows.map((row) => row.column_name);
  const reminderContract = reminderContractResult.rows.map((row) => row.name);
  const focusTables = focusTablesResult.rows.map((row) => row.table_name);
  const focusColumns = focusColumnsResult.rows.map((row) => `${row.table_name}.${row.column_name}`);
  const healthColumns = healthColumnsResult.rows.map((row) => `${row.table_name}.${row.column_name}`);
  const expectedTables = ["health_daily_references", "health_profiles", "health_week_plans", "inbox_entries", "tasks"];
  const expectedColumns = ["source_inbox_entry_id"];
  const retiredTaskColumns = ["planned_effort_minutes", "difficulty", "task_type", "requires_continuous_focus"];
  const expectedConstraints = [
    "tasks_exact_half_hour_boundary_check",
    "tasks_exact_minimum_duration_check",
    "tasks_schedule_shape_check"
  ];
  const retiredTaskConstraints = ["tasks_planned_effort_check"];
  const expectedReminderColumns = ["available_at", "payload", "schedule_revision", "scheduled_at"];
  const expectedReminderContract = ["reminder_jobs_schedule_revision_check", "reminder_jobs_task_channel_kind_unique"];
  const expectedFocusTables = ["focus_session_segment_runs", "focus_structure_segments", "focus_structures", "focus_timer_jobs", "task_legacy_metadata"];
  const expectedFocusColumns = [
    "focus_structures.task_schedule_revision",
    "focus_structures.state",
    "focus_structures.source",
    "focus_structures.total_start_at",
    "focus_structures.total_end_at",
    "focus_sessions.focus_structure_id",
    "focus_sessions.planned_end_at",
    "focus_sessions.current_segment_position",
    "focus_sessions.confirmation_deadline_at",
    "focus_timer_jobs.expected_session_version",
    "focus_timer_jobs.due_at",
    "focus_timer_jobs.status"
  ];
  const expectedHealthColumns = [
    "health_profiles.profile",
    "health_profiles.version",
    "health_week_plans.week_start",
    "health_week_plans.state",
    "health_week_plans.source",
    "health_week_plans.profile_version",
    "health_week_plans.city",
    "health_week_plans.solar_term",
    "health_week_plans.version",
    "health_daily_references.health_week_plan_id",
    "health_daily_references.local_date",
    "health_daily_references.day_index",
    "health_daily_references.content"
  ];

  if (expectedTables.some((name) => !tableNames.includes(name))
    || expectedColumns.some((name) => !taskColumns.includes(name))
    || expectedConstraints.some((name) => !taskConstraints.includes(name))
    || retiredTaskColumns.some((name) => taskColumns.includes(name))
    || retiredTaskConstraints.some((name) => taskConstraints.includes(name))
    || expectedReminderColumns.some((name) => !reminderColumns.includes(name))
    || expectedReminderContract.some((name) => !reminderContract.includes(name))
    || expectedFocusTables.some((name) => !focusTables.includes(name))
    || expectedFocusColumns.some((name) => !focusColumns.includes(name))
    || expectedHealthColumns.some((name) => !healthColumns.includes(name))) {
    throw new Error("Database schema does not match the live task, focus structure, inbox, reminder, or health migration contract.");
  }

  console.log(JSON.stringify({
    target: targetResult.rows[0],
    privileges: privilegesResult.rows[0],
    tables: tableNames,
    taskColumns,
    taskConstraints,
    reminderColumns,
    reminderContract,
    focusTables,
    focusColumns,
    healthColumns
  }, null, 2));
} finally {
  await client.end();
}
