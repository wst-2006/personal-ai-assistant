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
      AND column_name IN ('planned_effort_minutes', 'difficulty', 'task_type', 'requires_continuous_focus', 'source_inbox_entry_id', 'source_long_range_plan_id', 'record_kind')
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
        'tasks_record_kind_check',
        'tasks_schedule_shape_check'
      )
    ORDER BY conname
  `);
  const taskIndexesResult = await client.query<{ indexname: string }>(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'tasks'
      AND indexname = 'tasks_record_kind_local_date_idx'
    ORDER BY indexname
  `);
  const reminderColumnsResult = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'reminder_jobs'
      AND column_name IN ('schedule_revision', 'scheduled_at', 'available_at', 'payload', 'remote_message_id')
    ORDER BY column_name
  `);
  const reminderContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = 'public.reminder_jobs'::regclass
      AND conname IN ('reminder_jobs_schedule_revision_check', 'reminder_jobs_kind_check')
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
      AND table_name IN ('task_legacy_metadata', 'focus_structures', 'focus_structure_segments', 'focus_session_segment_runs', 'focus_session_operations', 'focus_timer_jobs')
    ORDER BY table_name
  `);
  const focusColumnsResult = await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'focus_structures' AND column_name IN ('task_schedule_revision', 'state', 'source', 'mode', 'total_start_at', 'total_end_at'))
        OR (table_name = 'focus_sessions' AND column_name IN ('focus_structure_id', 'planned_end_at', 'current_segment_position', 'confirmation_deadline_at', 'paused_total_seconds'))
        OR (table_name = 'focus_session_segment_runs' AND column_name IN ('paused_seconds'))
        OR (table_name = 'focus_session_operations' AND column_name IN ('command_id', 'focus_session_id', 'operation', 'expected_version', 'resulting_version', 'resulting_state', 'result_payload'))
        OR (table_name = 'focus_timer_jobs' AND column_name IN ('expected_session_version', 'due_at', 'status')))
    ORDER BY table_name, column_name
  `);
  const focusContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE (conrelid = 'public.focus_structures'::regclass AND conname = 'focus_structures_mode_check')
       OR (conrelid = 'public.focus_sessions'::regclass AND conname = 'focus_sessions_paused_total_seconds_check')
       OR (conrelid = 'public.focus_session_segment_runs'::regclass AND conname = 'focus_session_segment_runs_paused_seconds_check')
       OR (conrelid = 'public.focus_session_operations'::regclass AND conname IN (
         'focus_session_operations_operation_check',
         'focus_session_operations_expected_version_check',
         'focus_session_operations_resulting_version_check'
       ))
    UNION ALL
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public' AND (
      (tablename = 'focus_session_operations' AND indexname = 'focus_session_operations_session_idx')
      OR (tablename = 'focus_sessions' AND indexname = 'focus_sessions_focus_structure_id_idx')
      OR (tablename = 'task_feedback' AND indexname = 'task_feedback_task_id_idx')
      OR (tablename = 'task_outcomes' AND indexname = 'task_outcomes_focus_session_id_idx')
    )
    ORDER BY name
  `);
  const healthColumnsResult = await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'health_profiles' AND column_name IN ('profile', 'version'))
        OR (table_name = 'health_week_plans' AND column_name IN ('week_start', 'state', 'source', 'profile_version', 'city', 'solar_term', 'based_on_plan_id', 'based_on_plan_version', 'source_sleep_analysis_id', 'revision_reason', 'version'))
        OR (table_name = 'health_daily_references' AND column_name IN ('health_week_plan_id', 'local_date', 'day_index', 'content'))
        OR (table_name = 'health_week_auto_generations' AND column_name IN ('week_start', 'status', 'plan_id', 'failure_code', 'started_at', 'completed_at', 'updated_at'))
        OR (table_name = 'health_sleep_analyses' AND column_name IN ('local_date', 'source', 'original_file_name', 'mime_type', 'sha256', 'analysis')))
    ORDER BY table_name, column_name
  `);
  const healthContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = 'public.health_week_plans'::regclass
      AND conname = 'health_week_plans_revision_base_check'
    UNION ALL
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'health_week_plans'
      AND indexname = 'health_week_plans_base_plan_idx'
    UNION ALL
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = 'public.health_week_auto_generations'::regclass
      AND conname IN ('health_week_auto_generations_status_check', 'health_week_auto_generations_result_check')
    UNION ALL
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'health_week_auto_generations'
      AND indexname = 'health_week_auto_generations_status_idx'
    ORDER BY name
  `);
  const healthConversationColumnsResult = await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'health_week_conversations' AND column_name IN ('week_start', 'created_at', 'updated_at'))
        OR (table_name = 'health_week_conversation_messages' AND column_name IN (
          'conversation_id', 'role', 'source', 'content', 'needs_clarification', 'external_message_id', 'created_at'
        )))
    ORDER BY table_name, column_name
  `);
  const healthConversationContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = to_regclass('public.health_week_conversation_messages')
      AND conname IN (
        'health_week_conversation_messages_role_check',
        'health_week_conversation_messages_source_check',
        'health_week_conversation_messages_clarification_check'
      )
    UNION ALL
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public'
      AND ((tablename = 'health_week_conversations' AND indexname = 'health_week_conversations_week_idx')
        OR (tablename = 'health_week_conversation_messages' AND indexname IN (
          'health_week_conversation_messages_conversation_idx',
          'health_week_conversation_messages_external_unique'
        )))
    ORDER BY name
  `);
  const longRangeColumnsResult = await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'long_range_plans' AND column_name IN ('scope', 'period_start', 'period_end', 'status', 'version'))
        OR (table_name = 'long_range_plan_milestones' AND column_name IN ('long_range_plan_id', 'target_date', 'position')))
    ORDER BY table_name, column_name
  `);
  const longRangeContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = to_regclass('public.long_range_plans')
      AND conname IN ('long_range_plans_scope_check', 'long_range_plans_period_check')
    UNION ALL
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'long_range_plan_milestones'
      AND indexname = 'long_range_plan_milestones_position_unique'
    ORDER BY name
  `);
  const taskTreeColumnsResult = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'long_range_plan_task_tree_candidates'
      AND column_name IN ('long_range_plan_id', 'long_range_plan_version', 'state', 'proposal', 'created_task_ids', 'version', 'confirmed_at', 'cancelled_at')
    ORDER BY column_name
  `);
  const taskTreeContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = to_regclass('public.long_range_plan_task_tree_candidates')
      AND conname IN (
        'long_range_plan_task_tree_candidates_state_check',
        'long_range_plan_task_tree_candidates_version_check',
        'long_range_plan_task_tree_candidates_plan_version_check'
      )
    UNION ALL
    SELECT 'long_range_plan_task_tree_candidates_plan_fk' AS name
    WHERE EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.long_range_plan_task_tree_candidates')
        AND confrelid = to_regclass('public.long_range_plans')
        AND contype = 'f'
    )
    UNION ALL
    SELECT 'tasks_source_long_range_plan_fk' AS name
    WHERE EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.tasks')
        AND confrelid = to_regclass('public.long_range_plans')
        AND contype = 'f'
    )
    ORDER BY name
  `);
  const userProfileColumnsResult = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_profiles'
      AND column_name IN (
        'personal_context', 'ai_guidance', 'share_with_ai', 'response_style',
        'unscheduled_task_policy', 'recycle_retention_days',
        'focus_flip_sound_enabled', 'focus_start_sound_enabled',
        'break_start_sound_enabled', 'break_end_sound_enabled',
        'focus_end_sound_enabled', 'focus_theme', 'desktop_focus_enabled',
        'focus_preparation_window_enabled', 'focus_timer_window_enabled',
        'focus_evaluation_enabled', 'feishu_task_cards_enabled',
        'feishu_t15_enabled', 'health_page_enabled', 'version'
      )
    ORDER BY column_name
  `);
  const userProfileContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = to_regclass('public.user_profiles')
      AND conname IN (
        'user_profiles_singleton_check', 'user_profiles_response_style_check',
        'user_profiles_unscheduled_task_policy_check',
        'user_profiles_recycle_retention_days_check', 'user_profiles_focus_theme_check',
        'user_profiles_version_check'
      )
    UNION ALL
    SELECT 'user_profiles_initialized' AS name
    WHERE EXISTS (SELECT 1 FROM public.user_profiles WHERE id = 1 AND version > 0)
    ORDER BY name
  `);
  const unscheduledDayEndColumnsResult = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'unscheduled_task_day_end_runs'
      AND column_name IN ('local_date', 'policy', 'carried_count', 'deleted_count', 'completed_at', 'created_at')
    ORDER BY column_name
  `);
  const unscheduledDayEndContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = to_regclass('public.unscheduled_task_day_end_runs')
      AND conname IN ('unscheduled_task_day_end_runs_pkey', 'unscheduled_task_day_end_runs_policy_check', 'unscheduled_task_day_end_runs_counts_check')
    ORDER BY name
  `);
  const conversationTablesResult = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('app_conversations', 'app_conversation_messages')
    ORDER BY table_name
  `);
  const conversationColumnsResult = await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'app_conversations' AND column_name IN ('local_date', 'updated_at'))
        OR (table_name = 'app_conversation_messages' AND column_name IN ('conversation_id', 'role', 'content')))
    ORDER BY table_name, column_name
  `);
  const conversationContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = to_regclass('public.app_conversation_messages')
      AND conname = 'app_conversation_messages_role_check'
    UNION ALL
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'app_conversation_messages'
      AND indexname = 'app_conversation_messages_conversation_idx'
    ORDER BY name
  `);
  const feishuIntakeColumnsResult = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'feishu_intake_candidates'
      AND column_name IN ('chat_id', 'operator_open_id', 'source_message_id', 'last_source_message_id', 'raw_text', 'candidate', 'state', 'version', 'target_task_id', 'target_inbox_entry_id', 'last_error', 'resolved_at')
    ORDER BY column_name
  `);
  const feishuIntakeContractResult = await client.query<{ name: string }>(`
    SELECT conname AS name FROM pg_constraint
    WHERE conrelid = to_regclass('public.feishu_intake_candidates')
      AND conname IN (
        'feishu_intake_candidates_state_check',
        'feishu_intake_candidates_version_check',
        'feishu_intake_candidates_target_check',
        'feishu_intake_candidates_confirmed_target_check'
      )
    UNION ALL
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'feishu_intake_candidates'
      AND indexname IN ('feishu_intake_candidates_source_message_unique', 'feishu_intake_candidates_active_idx')
    ORDER BY name
  `);
  const tableNames = tablesResult.rows.map((row) => row.table_name);
  const taskColumns = taskColumnsResult.rows.map((row) => row.column_name);
  const taskConstraints = taskConstraintsResult.rows.map((row) => row.conname);
  const taskIndexes = taskIndexesResult.rows.map((row) => row.indexname);
  const reminderColumns = reminderColumnsResult.rows.map((row) => row.column_name);
  const reminderContract = reminderContractResult.rows.map((row) => row.name);
  const focusTables = focusTablesResult.rows.map((row) => row.table_name);
  const focusColumns = focusColumnsResult.rows.map((row) => `${row.table_name}.${row.column_name}`);
  const healthColumns = healthColumnsResult.rows.map((row) => `${row.table_name}.${row.column_name}`);
  const healthContract = healthContractResult.rows.map((row) => row.name);
  const healthConversationColumns = healthConversationColumnsResult.rows.map((row) => `${row.table_name}.${row.column_name}`);
  const healthConversationContract = healthConversationContractResult.rows.map((row) => row.name);
  const longRangeColumns = longRangeColumnsResult.rows.map((row) => `${row.table_name}.${row.column_name}`);
  const longRangeContract = longRangeContractResult.rows.map((row) => row.name);
  const taskTreeColumns = taskTreeColumnsResult.rows.map((row) => row.column_name);
  const taskTreeContract = taskTreeContractResult.rows.map((row) => row.name);
  const userProfileColumns = userProfileColumnsResult.rows.map((row) => row.column_name);
  const userProfileContract = userProfileContractResult.rows.map((row) => row.name);
  const unscheduledDayEndColumns = unscheduledDayEndColumnsResult.rows.map((row) => row.column_name);
  const unscheduledDayEndContract = unscheduledDayEndContractResult.rows.map((row) => row.name);
  const conversationTables = conversationTablesResult.rows.map((row) => row.table_name);
  const conversationColumns = conversationColumnsResult.rows.map((row) => `${row.table_name}.${row.column_name}`);
  const conversationContract = conversationContractResult.rows.map((row) => row.name);
  const feishuIntakeColumns = feishuIntakeColumnsResult.rows.map((row) => row.column_name);
  const feishuIntakeContract = feishuIntakeContractResult.rows.map((row) => row.name);
  const expectedTables = ["feishu_intake_candidates", "health_daily_references", "health_profiles", "health_sleep_analyses", "health_week_auto_generations", "health_week_conversation_messages", "health_week_conversations", "health_week_plans", "inbox_entries", "long_range_plan_milestones", "long_range_plan_task_tree_candidates", "long_range_plans", "tasks", "unscheduled_task_day_end_runs", "user_profiles"];
  const expectedColumns = ["record_kind", "source_inbox_entry_id", "source_long_range_plan_id"];
  const retiredTaskColumns = ["planned_effort_minutes", "difficulty", "task_type", "requires_continuous_focus"];
  const expectedConstraints = [
    "tasks_exact_half_hour_boundary_check",
    "tasks_exact_minimum_duration_check",
    "tasks_record_kind_check",
    "tasks_schedule_shape_check"
  ];
  const retiredTaskConstraints = ["tasks_planned_effort_check"];
  const expectedTaskIndexes = ["tasks_record_kind_local_date_idx"];
  const expectedReminderColumns = ["available_at", "payload", "remote_message_id", "schedule_revision", "scheduled_at"];
  const expectedReminderContract = ["reminder_jobs_kind_check", "reminder_jobs_schedule_revision_check", "reminder_jobs_task_channel_kind_unique"];
  const focusContract = focusContractResult.rows.map((row) => row.name);
  const expectedFocusTables = ["focus_session_operations", "focus_session_segment_runs", "focus_structure_segments", "focus_structures", "focus_timer_jobs", "task_legacy_metadata"];
  const expectedFocusColumns = [
    "focus_session_operations.command_id",
    "focus_session_operations.expected_version",
    "focus_session_operations.focus_session_id",
    "focus_session_operations.operation",
    "focus_session_operations.result_payload",
    "focus_session_operations.resulting_state",
    "focus_session_operations.resulting_version",
    "focus_session_segment_runs.paused_seconds",
    "focus_sessions.paused_total_seconds",
    "focus_structures.task_schedule_revision",
    "focus_structures.state",
    "focus_structures.source",
    "focus_structures.mode",
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
  const expectedFocusContract = [
    "focus_session_operations_expected_version_check",
    "focus_session_operations_operation_check",
    "focus_session_operations_resulting_version_check",
    "focus_session_operations_session_idx",
    "focus_session_segment_runs_paused_seconds_check",
    "focus_sessions_focus_structure_id_idx",
    "focus_sessions_paused_total_seconds_check",
    "focus_structures_mode_check",
    "task_feedback_task_id_idx",
    "task_outcomes_focus_session_id_idx"
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
    "health_week_plans.based_on_plan_id",
    "health_week_plans.based_on_plan_version",
    "health_week_plans.source_sleep_analysis_id",
    "health_week_plans.revision_reason",
    "health_week_plans.version",
    "health_daily_references.health_week_plan_id",
    "health_daily_references.local_date",
    "health_daily_references.day_index",
    "health_daily_references.content",
    "health_week_auto_generations.week_start",
    "health_week_auto_generations.status",
    "health_week_auto_generations.plan_id",
    "health_week_auto_generations.failure_code",
    "health_week_auto_generations.started_at",
    "health_week_auto_generations.completed_at",
    "health_week_auto_generations.updated_at",
    "health_sleep_analyses.local_date",
    "health_sleep_analyses.source",
    "health_sleep_analyses.original_file_name",
    "health_sleep_analyses.mime_type",
    "health_sleep_analyses.sha256",
    "health_sleep_analyses.analysis"
  ];
  const expectedHealthConversationColumns = [
    "health_week_conversation_messages.content",
    "health_week_conversation_messages.conversation_id",
    "health_week_conversation_messages.created_at",
    "health_week_conversation_messages.external_message_id",
    "health_week_conversation_messages.needs_clarification",
    "health_week_conversation_messages.role",
    "health_week_conversation_messages.source",
    "health_week_conversations.created_at",
    "health_week_conversations.updated_at",
    "health_week_conversations.week_start"
  ];
  const expectedHealthConversationContract = [
    "health_week_conversation_messages_clarification_check",
    "health_week_conversation_messages_conversation_idx",
    "health_week_conversation_messages_external_unique",
    "health_week_conversation_messages_role_check",
    "health_week_conversation_messages_source_check",
    "health_week_conversations_week_idx"
  ];
  const expectedLongRangeColumns = [
    "long_range_plans.scope",
    "long_range_plans.period_start",
    "long_range_plans.period_end",
    "long_range_plans.status",
    "long_range_plans.version",
    "long_range_plan_milestones.long_range_plan_id",
    "long_range_plan_milestones.target_date",
    "long_range_plan_milestones.position"
  ];
  const expectedTaskTreeColumns = [
    "long_range_plan_id",
    "long_range_plan_version",
    "state",
    "proposal",
    "created_task_ids",
    "version",
    "confirmed_at",
    "cancelled_at"
  ];
  const expectedTaskTreeContract = [
    "long_range_plan_task_tree_candidates_state_check",
    "long_range_plan_task_tree_candidates_version_check",
    "long_range_plan_task_tree_candidates_plan_version_check",
    "long_range_plan_task_tree_candidates_plan_fk",
    "tasks_source_long_range_plan_fk"
  ];
  const expectedUserProfileColumns = [
    "personal_context", "ai_guidance", "share_with_ai", "response_style",
    "unscheduled_task_policy", "recycle_retention_days",
    "focus_flip_sound_enabled", "focus_start_sound_enabled",
    "break_start_sound_enabled", "break_end_sound_enabled",
    "focus_end_sound_enabled", "focus_theme", "desktop_focus_enabled",
    "focus_preparation_window_enabled", "focus_timer_window_enabled",
    "focus_evaluation_enabled", "feishu_task_cards_enabled", "feishu_t15_enabled",
    "health_page_enabled", "version"
  ];
  const expectedUserProfileContract = [
    "user_profiles_singleton_check", "user_profiles_response_style_check",
    "user_profiles_unscheduled_task_policy_check",
    "user_profiles_recycle_retention_days_check", "user_profiles_focus_theme_check",
    "user_profiles_version_check",
    "user_profiles_initialized"
  ];
  const expectedUnscheduledDayEndColumns = ["carried_count", "completed_at", "created_at", "deleted_count", "local_date", "policy"];
  const expectedUnscheduledDayEndContract = ["unscheduled_task_day_end_runs_counts_check", "unscheduled_task_day_end_runs_pkey", "unscheduled_task_day_end_runs_policy_check"];
  const expectedConversationTables = ["app_conversation_messages", "app_conversations"];
  const expectedConversationColumns = [
    "app_conversations.local_date",
    "app_conversations.updated_at",
    "app_conversation_messages.conversation_id",
    "app_conversation_messages.role",
    "app_conversation_messages.content"
  ];
  const expectedConversationContract = ["app_conversation_messages_conversation_idx", "app_conversation_messages_role_check"];
  const expectedFeishuIntakeColumns = ["candidate", "chat_id", "last_error", "last_source_message_id", "operator_open_id", "raw_text", "resolved_at", "source_message_id", "state", "target_inbox_entry_id", "target_task_id", "version"];
  const expectedFeishuIntakeContract = [
    "feishu_intake_candidates_active_idx",
    "feishu_intake_candidates_confirmed_target_check",
    "feishu_intake_candidates_source_message_unique",
    "feishu_intake_candidates_state_check",
    "feishu_intake_candidates_target_check",
    "feishu_intake_candidates_version_check"
  ];

  if (expectedTables.some((name) => !tableNames.includes(name))
    || expectedColumns.some((name) => !taskColumns.includes(name))
    || expectedConstraints.some((name) => !taskConstraints.includes(name))
    || expectedTaskIndexes.some((name) => !taskIndexes.includes(name))
    || retiredTaskColumns.some((name) => taskColumns.includes(name))
    || retiredTaskConstraints.some((name) => taskConstraints.includes(name))
    || expectedReminderColumns.some((name) => !reminderColumns.includes(name))
    || expectedReminderContract.some((name) => !reminderContract.includes(name))
    || expectedFocusTables.some((name) => !focusTables.includes(name))
    || expectedFocusColumns.some((name) => !focusColumns.includes(name))
    || expectedFocusContract.some((name) => !focusContract.includes(name))
    || expectedHealthColumns.some((name) => !healthColumns.includes(name))
    || ["health_week_plans_base_plan_idx", "health_week_plans_revision_base_check", "health_week_auto_generations_status_check", "health_week_auto_generations_result_check", "health_week_auto_generations_status_idx"].some((name) => !healthContract.includes(name))
    || expectedHealthConversationColumns.some((name) => !healthConversationColumns.includes(name))
    || expectedHealthConversationContract.some((name) => !healthConversationContract.includes(name))
    || expectedLongRangeColumns.some((name) => !longRangeColumns.includes(name))
    || ["long_range_plans_scope_check", "long_range_plans_period_check", "long_range_plan_milestones_position_unique"].some((name) => !longRangeContract.includes(name))
    || expectedTaskTreeColumns.some((name) => !taskTreeColumns.includes(name))
    || expectedTaskTreeContract.some((name) => !taskTreeContract.includes(name))
    || expectedUserProfileColumns.some((name) => !userProfileColumns.includes(name))
    || expectedUserProfileContract.some((name) => !userProfileContract.includes(name))
    || expectedUnscheduledDayEndColumns.some((name) => !unscheduledDayEndColumns.includes(name))
    || expectedUnscheduledDayEndContract.some((name) => !unscheduledDayEndContract.includes(name))
    || expectedConversationTables.some((name) => !conversationTables.includes(name))
    || expectedConversationColumns.some((name) => !conversationColumns.includes(name))
    || expectedConversationContract.some((name) => !conversationContract.includes(name))
    || expectedFeishuIntakeColumns.some((name) => !feishuIntakeColumns.includes(name))
    || expectedFeishuIntakeContract.some((name) => !feishuIntakeContract.includes(name))) {
    throw new Error("Database schema does not match the live task, focus structure, inbox, Feishu intake, reminder, health, long-range plan, task-tree, user-profile, or conversation migration contract.");
  }

  console.log(JSON.stringify({
    target: targetResult.rows[0],
    privileges: privilegesResult.rows[0],
    tables: tableNames,
    taskColumns,
    taskConstraints,
    taskIndexes,
    reminderColumns,
    reminderContract,
    focusTables,
    focusColumns,
    focusContract,
    healthColumns,
    healthContract,
    healthConversationColumns,
    healthConversationContract,
    longRangeColumns,
    longRangeContract,
    taskTreeColumns,
    taskTreeContract,
    userProfileColumns,
    userProfileContract,
    unscheduledDayEndColumns,
    unscheduledDayEndContract,
    conversationTables,
    conversationColumns,
    conversationContract,
    feishuIntakeColumns,
    feishuIntakeContract
  }, null, 2));
} finally {
  await client.end();
}
