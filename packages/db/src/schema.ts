import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar
} from "drizzle-orm/pg-core";

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    entryType: varchar("entry_type", { length: 16 }).notNull(),
    lifecycleStatus: varchar("lifecycle_status", { length: 32 }).notNull(),
    objectiveOutcome: varchar("objective_outcome", { length: 32 }),
    localDate: varchar("local_date", { length: 10 }),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    estimatedMinutes: integer("estimated_minutes"),
    difficulty: varchar("difficulty", { length: 16 }),
    taskType: varchar("task_type", { length: 80 }),
    requiresContinuousFocus: boolean("requires_continuous_focus"),
    schedulePrecision: varchar("schedule_precision", { length: 16 }),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("tasks_local_date_idx").on(table.localDate)]
);

export const focusSessions = pgTable(
  "focus_sessions",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    state: varchar("state", { length: 32 }).notNull(),
    plannedStartAt: timestamp("planned_start_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    rawActiveSeconds: integer("raw_active_seconds").notNull().default(0),
    effectiveFocusSeconds: integer("effective_focus_seconds").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("focus_sessions_task_id_idx").on(table.taskId)]
);

export const taskFeedback = pgTable("task_feedback", {
  id: uuid("id").primaryKey(),
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  focusSessionId: uuid("focus_session_id").references(() => focusSessions.id),
  satisfaction: varchar("satisfaction", { length: 16 }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

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
  state: varchar("state", { length: 32 }).notNull(),
  content: jsonb("content").notNull(),
  sources: jsonb("sources").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const cyberDiaries = pgTable("cyber_diaries", {
  id: uuid("id").primaryKey(),
  localDate: varchar("local_date", { length: 10 }).notNull().unique(),
  briefId: uuid("brief_id").notNull().references(() => dailyBriefs.id),
  content: jsonb("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
