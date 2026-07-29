import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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
    lifecycleStatus: varchar("lifecycle_status", { length: 32 }).notNull().default("open"),
    scheduleKind: varchar("schedule_kind", { length: 16 }).notNull().default("none"),
    currentOutcome: varchar("current_outcome", { length: 32 }),
    localDate: date("local_date", { mode: "string" }),
    daypart: varchar("daypart", { length: 16 }),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    timeZone: varchar("time_zone", { length: 64 }).notNull().default("Asia/Shanghai"),
    plannedEffortMinutes: integer("planned_effort_minutes"),
    difficulty: varchar("difficulty", { length: 16 }),
    taskType: varchar("task_type", { length: 80 }),
    requiresContinuousFocus: boolean("requires_continuous_focus"),
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
      sql`${table.endAt} is null or ${table.endAt} >= ${table.startAt} + interval '5 minutes'`
    ),
    check(
      "tasks_planned_effort_check",
      sql`${table.plannedEffortMinutes} is null or (${table.plannedEffortMinutes} between 1 and 1440)`
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

export const focusSessions = pgTable(
  "focus_sessions",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    state: varchar("state", { length: 32 }).notNull(),
    plannedStartAt: timestamp("planned_start_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    preparingEndsAt: timestamp("preparing_ends_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    activeSinceAt: timestamp("active_since_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
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
    check("focus_sessions_version_check", sql`${table.version} > 0`)
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
