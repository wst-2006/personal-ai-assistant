import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  varchar
} from "drizzle-orm/pg-core";

export const inboxEntries = pgTable(
  "inbox_entries",
  {
    id: uuid("id").primaryKey(),
    entryKind: varchar("entry_kind", { length: 16 }).notNull(),
    content: varchar("content", { length: 200 }).notNull(),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("inbox_entries_active_idx").on(table.deletedAt, table.createdAt),
    check("inbox_entries_kind_check", sql`${table.entryKind} in ('idea', 'question')`),
    check("inbox_entries_version_check", sql`${table.version} > 0`)
  ]
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    sourceInboxEntryId: uuid("source_inbox_entry_id").references(() => inboxEntries.id),
    sourceLongRangePlanId: uuid("source_long_range_plan_id").references(() => longRangePlans.id),
    lifecycleStatus: varchar("lifecycle_status", { length: 32 }).notNull().default("open"),
    scheduleKind: varchar("schedule_kind", { length: 16 }).notNull().default("none"),
    currentOutcome: varchar("current_outcome", { length: 32 }),
    localDate: date("local_date", { mode: "string" }),
    daypart: varchar("daypart", { length: 16 }),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    timeZone: varchar("time_zone", { length: 64 }).notNull().default("Asia/Shanghai"),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    scheduleRevision: integer("schedule_revision").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("tasks_local_date_idx").on(table.localDate),
    index("tasks_exact_interval_idx").on(table.startAt, table.endAt),
    uniqueIndex("tasks_source_inbox_entry_id_unique").on(table.sourceInboxEntryId),
    index("tasks_source_long_range_plan_idx").on(table.sourceLongRangePlanId),
    check(
      "tasks_lifecycle_status_check",
      sql`${table.lifecycleStatus} in ('open', 'active', 'awaiting_outcome', 'closed', 'cancelled')`
    ),
    check("tasks_schedule_kind_check", sql`${table.scheduleKind} in ('none', 'daypart', 'exact')`),
    check(
      "tasks_current_outcome_check",
      sql`${table.currentOutcome} is null or ${table.currentOutcome} in ('not_completed', 'partial', 'complete')`
    ),
    check(
      "tasks_time_pair_check",
      sql`(${table.startAt} is null and ${table.endAt} is null) or (${table.startAt} is not null and ${table.endAt} is not null)`
    ),
    check(
      "tasks_exact_minimum_duration_check",
      sql`${table.deletedAt} is not null or ${table.endAt} is null or ${table.endAt} >= ${table.startAt} + interval '30 minutes'`
    ),
    check(
      "tasks_exact_half_hour_boundary_check",
      sql`${table.deletedAt} is not null or ${table.startAt} is null or (
        extract(minute from ${table.startAt} at time zone ${table.timeZone}) in (0, 30)
        and extract(second from ${table.startAt} at time zone ${table.timeZone}) = 0
        and extract(minute from ${table.endAt} at time zone ${table.timeZone}) in (0, 30)
        and extract(second from ${table.endAt} at time zone ${table.timeZone}) = 0
      )`
    ),
    check(
      "tasks_schedule_shape_check",
      sql`(
        (${table.scheduleKind} = 'none' and ${table.startAt} is null and ${table.endAt} is null and ${table.daypart} is null)
        or (${table.scheduleKind} = 'daypart' and ${table.localDate} is not null and ${table.daypart} in ('morning', 'afternoon', 'evening') and ${table.startAt} is null and ${table.endAt} is null)
        or (${table.scheduleKind} = 'exact' and ${table.localDate} is not null and ${table.startAt} is not null and ${table.endAt} is not null and ${table.daypart} is null)
      )`
    ),
    check("tasks_version_check", sql`${table.version} > 0`),
    check("tasks_schedule_revision_check", sql`${table.scheduleRevision} > 0`)
  ]
);

export const taskLegacyMetadata = pgTable(
  "task_legacy_metadata",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    plannedEffortMinutes: integer("planned_effort_minutes"),
    difficulty: varchar("difficulty", { length: 16 }),
    taskType: varchar("task_type", { length: 80 }),
    requiresContinuousFocus: boolean("requires_continuous_focus"),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("task_legacy_metadata_task_unique").on(table.taskId),
    check("task_legacy_metadata_planned_effort_check", sql`${table.plannedEffortMinutes} is null or (${table.plannedEffortMinutes} between 1 and 1440)`)
  ]
);

export const focusStructures = pgTable(
  "focus_structures",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    taskScheduleRevision: integer("task_schedule_revision").notNull(),
    state: varchar("state", { length: 20 }).notNull().default("candidate"),
    source: varchar("source", { length: 16 }).notNull(),
    version: integer("version").notNull().default(1),
    totalStartAt: timestamp("total_start_at", { withTimezone: true }).notNull(),
    totalEndAt: timestamp("total_end_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("focus_structures_task_idx").on(table.taskId, table.createdAt),
    uniqueIndex("focus_structures_active_task_unique").on(table.taskId).where(sql`${table.state} = 'active'`),
    check("focus_structures_state_check", sql`${table.state} in ('candidate', 'active', 'superseded', 'invalidated', 'cancelled')`),
    check("focus_structures_source_check", sql`${table.source} in ('ai', 'template', 'manual')`),
    check("focus_structures_revision_check", sql`${table.taskScheduleRevision} > 0`),
    check("focus_structures_version_check", sql`${table.version} > 0`),
    check("focus_structures_interval_check", sql`${table.totalEndAt} > ${table.totalStartAt}`)
  ]
);

export const focusStructureSegments = pgTable(
  "focus_structure_segments",
  {
    id: uuid("id").primaryKey(),
    focusStructureId: uuid("focus_structure_id").notNull().references(() => focusStructures.id),
    position: integer("position").notNull(),
    segmentType: varchar("segment_type", { length: 16 }).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("focus_structure_segments_position_unique").on(table.focusStructureId, table.position),
    index("focus_structure_segments_structure_idx").on(table.focusStructureId, table.position),
    check("focus_structure_segments_position_check", sql`${table.position} >= 0`),
    check("focus_structure_segments_type_check", sql`${table.segmentType} in ('focus', 'break')`),
    check(
      "focus_structure_segments_duration_check",
      sql`(${table.segmentType} = 'focus' and ${table.durationMinutes} >= 30) or (${table.segmentType} = 'break' and ${table.durationMinutes} between 5 and 15)`
    )
  ]
);

export const focusSessions = pgTable(
  "focus_sessions",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    focusStructureId: uuid("focus_structure_id").references(() => focusStructures.id),
    focusStructureVersion: integer("focus_structure_version"),
    focusStructureScheduleRevision: integer("focus_structure_schedule_revision"),
    state: varchar("state", { length: 32 }).notNull(),
    plannedStartAt: timestamp("planned_start_at", { withTimezone: true }),
    plannedEndAt: timestamp("planned_end_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    preparingEndsAt: timestamp("preparing_ends_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    activeSinceAt: timestamp("active_since_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    currentSegmentPosition: integer("current_segment_position"),
    currentSegmentStartedAt: timestamp("current_segment_started_at", { withTimezone: true }),
    currentSegmentElapsedSeconds: integer("current_segment_elapsed_seconds").notNull().default(0),
    confirmationDeadlineAt: timestamp("confirmation_deadline_at", { withTimezone: true }),
    stoppedReason: text("stopped_reason"),
    rawActiveSeconds: integer("raw_active_seconds").notNull().default(0),
    effectiveFocusSeconds: integer("effective_focus_seconds").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("focus_sessions_task_id_idx").on(table.taskId),
    index("focus_sessions_current_idx").on(table.state, table.updatedAt),
    uniqueIndex("focus_sessions_open_task_unique").on(table.taskId).where(sql`${table.state} in ('scheduled', 'reminded', 'preparing', 'awaiting_start', 'running', 'paused')`),
    check("focus_sessions_state_check", sql`${table.state} in ('scheduled', 'reminded', 'preparing', 'awaiting_start', 'running', 'paused', 'ended', 'evaluated', 'stopped_no_response', 'stopped_for_change')`),
    check("focus_sessions_raw_seconds_check", sql`${table.rawActiveSeconds} >= 0`),
    check("focus_sessions_effective_seconds_check", sql`${table.effectiveFocusSeconds} >= 0`),
    check("focus_sessions_segment_position_check", sql`${table.currentSegmentPosition} is null or ${table.currentSegmentPosition} >= 0`),
    check("focus_sessions_segment_elapsed_check", sql`${table.currentSegmentElapsedSeconds} >= 0`),
    check("focus_sessions_structure_version_check", sql`${table.focusStructureVersion} is null or ${table.focusStructureVersion} > 0`),
    check("focus_sessions_structure_revision_check", sql`${table.focusStructureScheduleRevision} is null or ${table.focusStructureScheduleRevision} > 0`),
    check("focus_sessions_planned_interval_check", sql`${table.plannedStartAt} is null or ${table.plannedEndAt} is null or ${table.plannedEndAt} > ${table.plannedStartAt}`),
    check("focus_sessions_version_check", sql`${table.version} > 0`)
  ]
);

export const focusSessionSegmentRuns = pgTable(
  "focus_session_segment_runs",
  {
    id: uuid("id").primaryKey(),
    focusSessionId: uuid("focus_session_id").notNull().references(() => focusSessions.id),
    position: integer("position").notNull(),
    segmentType: varchar("segment_type", { length: 16 }).notNull(),
    plannedDurationSeconds: integer("planned_duration_seconds").notNull(),
    elapsedSeconds: integer("elapsed_seconds").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("focus_session_segment_runs_position_unique").on(table.focusSessionId, table.position),
    index("focus_session_segment_runs_session_idx").on(table.focusSessionId, table.position),
    check("focus_session_segment_runs_position_check", sql`${table.position} >= 0`),
    check("focus_session_segment_runs_type_check", sql`${table.segmentType} in ('focus', 'break')`),
    check("focus_session_segment_runs_duration_check", sql`${table.plannedDurationSeconds} > 0`),
    check("focus_session_segment_runs_elapsed_check", sql`${table.elapsedSeconds} >= 0`)
  ]
);

export const focusTimerJobs = pgTable(
  "focus_timer_jobs",
  {
    id: uuid("id").primaryKey(),
    focusSessionId: uuid("focus_session_id").notNull().references(() => focusSessions.id),
    kind: varchar("kind", { length: 32 }).notNull(),
    expectedSessionVersion: integer("expected_session_version").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("focus_timer_jobs_due_idx").on(table.status, table.dueAt),
    uniqueIndex("focus_timer_jobs_open_unique").on(table.focusSessionId, table.kind).where(sql`${table.status} in ('pending', 'processing')`),
    check("focus_timer_jobs_kind_check", sql`${table.kind} in ('preparation_complete', 'confirmation_timeout', 'segment_transition')`),
    check("focus_timer_jobs_status_check", sql`${table.status} in ('pending', 'processing', 'completed', 'failed', 'cancelled')`),
    check("focus_timer_jobs_version_check", sql`${table.expectedSessionVersion} > 0`),
    check("focus_timer_jobs_attempts_check", sql`${table.attempts} >= 0`)
  ]
);

export const taskFeedback = pgTable("task_feedback", {
  id: uuid("id").primaryKey(),
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  focusSessionId: uuid("focus_session_id").references(() => focusSessions.id),
  satisfaction: varchar("satisfaction", { length: 16 }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("task_feedback_focus_session_unique").on(table.focusSessionId),
  check("task_feedback_satisfaction_check", sql`${table.satisfaction} in ('satisfied', 'neutral', 'dissatisfied')`)
]);

export const taskOutcomes = pgTable(
  "task_outcomes",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    focusSessionId: uuid("focus_session_id").references(() => focusSessions.id),
    outcome: varchar("outcome", { length: 32 }).notNull(),
    progressPercent: integer("progress_percent").notNull(),
    source: varchar("source", { length: 16 }).notNull(),
    note: text("note"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("task_outcomes_task_id_idx").on(table.taskId, table.recordedAt),
    check(
      "task_outcomes_value_check",
      sql`(${table.outcome} = 'not_completed' and ${table.progressPercent} = 0)
        or (${table.outcome} = 'partial' and ${table.progressPercent} between 1 and 99)
        or (${table.outcome} = 'complete' and ${table.progressPercent} = 100)`
    ),
    check("task_outcomes_source_check", sql`${table.source} in ('app', 'ai', 'feishu', 'system')`)
  ]
);

export const taskLifecycleEvents = pgTable(
  "task_lifecycle_events",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    fromStatus: varchar("from_status", { length: 32 }),
    toStatus: varchar("to_status", { length: 32 }).notNull(),
    source: varchar("source", { length: 16 }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("task_lifecycle_events_task_id_idx").on(table.taskId, table.createdAt),
    check(
      "task_lifecycle_events_from_status_check",
      sql`${table.fromStatus} is null or ${table.fromStatus} in ('open', 'active', 'awaiting_outcome', 'closed', 'cancelled')`
    ),
    check(
      "task_lifecycle_events_to_status_check",
      sql`${table.toStatus} in ('open', 'active', 'awaiting_outcome', 'closed', 'cancelled', 'deleted')`
    ),
    check("task_lifecycle_events_source_check", sql`${table.source} in ('app', 'ai', 'feishu', 'system')`)
  ]
);

export const taskConflictAcceptances = pgTable(
  "task_conflict_acceptances",
  {
    taskIdLow: uuid("task_id_low").notNull().references(() => tasks.id),
    taskScheduleRevisionLow: integer("task_schedule_revision_low").notNull(),
    taskIdHigh: uuid("task_id_high").notNull().references(() => tasks.id),
    taskScheduleRevisionHigh: integer("task_schedule_revision_high").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({
      name: "task_conflict_acceptances_pk",
      columns: [
        table.taskIdLow,
        table.taskScheduleRevisionLow,
        table.taskIdHigh,
        table.taskScheduleRevisionHigh
      ]
    }),
    index("task_conflict_acceptances_high_idx").on(table.taskIdHigh, table.taskScheduleRevisionHigh),
    check("task_conflict_acceptances_order_check", sql`${table.taskIdLow} < ${table.taskIdHigh}`),
    check(
      "task_conflict_acceptances_revisions_check",
      sql`${table.taskScheduleRevisionLow} > 0 and ${table.taskScheduleRevisionHigh} > 0`
    )
  ]
);

export const longRangePlans = pgTable(
  "long_range_plans",
  {
    id: uuid("id").primaryKey(),
    scope: varchar("scope", { length: 16 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("long_range_plans_scope_status_idx").on(table.scope, table.status, table.periodStart),
    check("long_range_plans_scope_check", sql`${table.scope} in ('month', 'semester', 'annual')`),
    check("long_range_plans_status_check", sql`${table.status} in ('active', 'archived')`),
    check("long_range_plans_period_check", sql`${table.periodEnd} >= ${table.periodStart}`),
    check("long_range_plans_version_check", sql`${table.version} > 0`)
  ]
);

export const longRangePlanMilestones = pgTable(
  "long_range_plan_milestones",
  {
    id: uuid("id").primaryKey(),
    longRangePlanId: uuid("long_range_plan_id").notNull().references(() => longRangePlans.id),
    title: varchar("title", { length: 200 }).notNull(),
    targetDate: date("target_date", { mode: "string" }),
    notes: text("notes"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("long_range_plan_milestones_plan_idx").on(table.longRangePlanId, table.position),
    uniqueIndex("long_range_plan_milestones_position_unique").on(table.longRangePlanId, table.position),
    check("long_range_plan_milestones_position_check", sql`${table.position} >= 0`)
  ]
);

export const longRangePlanTaskTreeCandidates = pgTable(
  "long_range_plan_task_tree_candidates",
  {
    id: uuid("id").primaryKey(),
    longRangePlanId: uuid("long_range_plan_id").notNull().references(() => longRangePlans.id),
    longRangePlanVersion: integer("long_range_plan_version").notNull(),
    state: varchar("state", { length: 16 }).notNull().default("candidate"),
    instructions: text("instructions"),
    proposal: jsonb("proposal").notNull(),
    createdTaskIds: jsonb("created_task_ids"),
    version: integer("version").notNull().default(1),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("long_range_plan_task_tree_candidates_plan_idx").on(table.longRangePlanId, table.createdAt),
    check("long_range_plan_task_tree_candidates_state_check", sql`${table.state} in ('candidate', 'confirmed', 'cancelled')`),
    check("long_range_plan_task_tree_candidates_version_check", sql`${table.version} > 0`),
    check("long_range_plan_task_tree_candidates_plan_version_check", sql`${table.longRangePlanVersion} > 0`)
  ]
);

export const userProfiles = pgTable(
  "user_profiles",
  {
    id: integer("id").primaryKey(),
    personalContext: text("personal_context").notNull().default(""),
    aiGuidance: text("ai_guidance").notNull().default(""),
    shareWithAi: boolean("share_with_ai").notNull().default(true),
    responseStyle: varchar("response_style", { length: 16 }).notNull().default("balanced"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("user_profiles_singleton_check", sql`${table.id} = 1`),
    check("user_profiles_response_style_check", sql`${table.responseStyle} in ('concise', 'balanced', 'detailed')`),
    check("user_profiles_version_check", sql`${table.version} > 0`)
  ]
);

export const reviewSessions = pgTable("review_sessions", {
  id: uuid("id").primaryKey(),
  localDate: varchar("local_date", { length: 10 }).notNull().unique(),
  state: varchar("state", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const reviewMessages = pgTable(
  "review_messages",
  {
    id: uuid("id").primaryKey(),
    reviewSessionId: uuid("review_session_id").notNull().references(() => reviewSessions.id),
    source: varchar("source", { length: 16 }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("review_messages_session_idx").on(table.reviewSessionId)]
);

export const dailyBriefs = pgTable("daily_briefs", {
  id: uuid("id").primaryKey(),
  localDate: varchar("local_date", { length: 10 }).notNull(),
  reviewSessionId: uuid("review_session_id").references(() => reviewSessions.id),
  state: varchar("state", { length: 32 }).notNull(),
  content: jsonb("content").notNull(),
  sources: jsonb("sources").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index("daily_briefs_review_session_idx").on(table.reviewSessionId),
  check("daily_briefs_state_check", sql`${table.state} in ('draft', 'confirmed')`)
]);

export const cyberDiaries = pgTable("cyber_diaries", {
  id: uuid("id").primaryKey(),
  localDate: varchar("local_date", { length: 10 }).notNull().unique(),
  reviewSessionId: uuid("review_session_id").notNull().references(() => reviewSessions.id),
  briefId: uuid("brief_id").notNull().references(() => dailyBriefs.id),
  content: jsonb("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const reminderJobs = pgTable("reminder_jobs", {
  id: uuid("id").primaryKey(),
  taskId: uuid("task_id").references(() => tasks.id),
  channel: varchar("channel", { length: 32 }).notNull(),
  kind: varchar("kind", { length: 32 }).notNull(),
  scheduleRevision: integer("schedule_revision").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  payload: jsonb("payload").notNull(),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index("reminder_jobs_due_idx").on(table.status, table.availableAt),
  uniqueIndex("reminder_jobs_task_channel_kind_unique").on(table.taskId, table.channel, table.kind),
  check("reminder_jobs_channel_check", sql`${table.channel} in ('feishu')`),
  check("reminder_jobs_kind_check", sql`${table.kind} in ('task_start', 'task_follow_up')`),
  check("reminder_jobs_status_check", sql`${table.status} in ('pending', 'processing', 'sent', 'failed', 'cancelled')`),
  check("reminder_jobs_attempts_check", sql`${table.attempts} >= 0`),
  check("reminder_jobs_schedule_revision_check", sql`${table.scheduleRevision} > 0`)
]);

export const healthProfiles = pgTable("health_profiles", {
  id: uuid("id").primaryKey(),
  profile: jsonb("profile").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [check("health_profiles_version_check", sql`${table.version} > 0`)]);

export const healthWeekPlans = pgTable(
  "health_week_plans",
  {
    id: uuid("id").primaryKey(),
    weekStart: date("week_start", { mode: "string" }).notNull(),
    state: varchar("state", { length: 16 }).notNull().default("candidate"),
    source: varchar("source", { length: 16 }).notNull(),
    profileVersion: integer("profile_version").notNull(),
    city: varchar("city", { length: 120 }),
    solarTerm: varchar("solar_term", { length: 32 }).notNull(),
    specialContext: text("special_context"),
    basedOnPlanId: uuid("based_on_plan_id"),
    basedOnPlanVersion: integer("based_on_plan_version"),
    sourceSleepAnalysisId: uuid("source_sleep_analysis_id").references(() => healthSleepAnalyses.id),
    revisionReason: text("revision_reason"),
    overview: text("overview").notNull(),
    supplements: jsonb("supplements").notNull(),
    version: integer("version").notNull().default(1),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("health_week_plans_week_idx").on(table.weekStart, table.createdAt),
    index("health_week_plans_base_plan_idx").on(table.basedOnPlanId),
    foreignKey({ columns: [table.basedOnPlanId], foreignColumns: [table.id], name: "health_week_plans_based_on_plan_id_health_week_plans_id_fk" }),
    uniqueIndex("health_week_plans_active_week_unique").on(table.weekStart).where(sql`${table.state} = 'active'`),
    check("health_week_plans_state_check", sql`${table.state} in ('candidate', 'active', 'superseded', 'cancelled')`),
    check("health_week_plans_source_check", sql`${table.source} in ('template', 'ai', 'manual')`),
    check("health_week_plans_profile_version_check", sql`${table.profileVersion} > 0`),
    check("health_week_plans_version_check", sql`${table.version} > 0`),
    check("health_week_plans_revision_base_check", sql`(${table.basedOnPlanId} is null and ${table.basedOnPlanVersion} is null) or (${table.basedOnPlanId} is not null and ${table.basedOnPlanVersion} > 0)`)
  ]
);

export const healthDailyReferences = pgTable(
  "health_daily_references",
  {
    id: uuid("id").primaryKey(),
    healthWeekPlanId: uuid("health_week_plan_id").notNull().references(() => healthWeekPlans.id),
    localDate: date("local_date", { mode: "string" }).notNull(),
    dayIndex: integer("day_index").notNull(),
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("health_daily_references_plan_day_unique").on(table.healthWeekPlanId, table.dayIndex),
    index("health_daily_references_date_idx").on(table.localDate),
    check("health_daily_references_day_index_check", sql`${table.dayIndex} between 0 and 6`)
  ]
);

export const healthSleepAnalyses = pgTable(
  "health_sleep_analyses",
  {
    id: uuid("id").primaryKey(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    source: varchar("source", { length: 16 }).notNull().default("user_upload"),
    originalFileName: varchar("original_file_name", { length: 160 }).notNull(),
    mimeType: varchar("mime_type", { length: 32 }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    analysis: jsonb("analysis").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("health_sleep_analyses_date_idx").on(table.localDate, table.createdAt),
    check("health_sleep_analyses_source_check", sql`${table.source} = 'user_upload'`),
    check("health_sleep_analyses_mime_check", sql`${table.mimeType} in ('image/png', 'image/jpeg', 'image/webp')`),
    check("health_sleep_analyses_sha256_check", sql`length(${table.sha256}) = 64`)
  ]
);
