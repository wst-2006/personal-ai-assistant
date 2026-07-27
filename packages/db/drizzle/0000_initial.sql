CREATE TABLE "tasks" (
  "id" uuid PRIMARY KEY NOT NULL,
  "title" varchar(200) NOT NULL,
  "entry_type" varchar(16) NOT NULL,
  "lifecycle_status" varchar(32) NOT NULL,
  "objective_outcome" varchar(32),
  "local_date" varchar(10),
  "start_at" timestamp with time zone,
  "end_at" timestamp with time zone,
  "estimated_minutes" integer,
  "difficulty" varchar(16),
  "task_type" varchar(80),
  "requires_continuous_focus" boolean,
  "schedule_precision" varchar(16),
  "notes" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "tasks_local_date_idx" ON "tasks" ("local_date");

CREATE TABLE "focus_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "state" varchar(32) NOT NULL,
  "planned_start_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "raw_active_seconds" integer DEFAULT 0 NOT NULL,
  "effective_focus_seconds" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "focus_sessions_task_id_idx" ON "focus_sessions" ("task_id");

CREATE TABLE "task_feedback" (
  "id" uuid PRIMARY KEY NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "focus_session_id" uuid REFERENCES "focus_sessions"("id"),
  "satisfaction" varchar(16) NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "review_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "local_date" varchar(10) NOT NULL UNIQUE,
  "state" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "review_messages" (
  "id" uuid PRIMARY KEY NOT NULL,
  "review_session_id" uuid NOT NULL REFERENCES "review_sessions"("id"),
  "source" varchar(16) NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "review_messages_session_idx" ON "review_messages" ("review_session_id");

CREATE TABLE "daily_briefs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "local_date" varchar(10) NOT NULL,
  "state" varchar(32) NOT NULL,
  "content" jsonb NOT NULL,
  "sources" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "cyber_diaries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "local_date" varchar(10) NOT NULL UNIQUE,
  "brief_id" uuid NOT NULL REFERENCES "daily_briefs"("id"),
  "content" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
