CREATE TABLE "focus_session_segment_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"focus_session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"segment_type" varchar(16) NOT NULL,
	"planned_duration_seconds" integer NOT NULL,
	"elapsed_seconds" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_session_segment_runs_position_check" CHECK ("focus_session_segment_runs"."position" >= 0),
	CONSTRAINT "focus_session_segment_runs_type_check" CHECK ("focus_session_segment_runs"."segment_type" in ('focus', 'break')),
	CONSTRAINT "focus_session_segment_runs_duration_check" CHECK ("focus_session_segment_runs"."planned_duration_seconds" > 0),
	CONSTRAINT "focus_session_segment_runs_elapsed_check" CHECK ("focus_session_segment_runs"."elapsed_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "focus_structure_segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"focus_structure_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"segment_type" varchar(16) NOT NULL,
	"duration_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_structure_segments_position_check" CHECK ("focus_structure_segments"."position" >= 0),
	CONSTRAINT "focus_structure_segments_type_check" CHECK ("focus_structure_segments"."segment_type" in ('focus', 'break')),
	CONSTRAINT "focus_structure_segments_duration_check" CHECK (("focus_structure_segments"."segment_type" = 'focus' and "focus_structure_segments"."duration_minutes" >= 30) or ("focus_structure_segments"."segment_type" = 'break' and "focus_structure_segments"."duration_minutes" between 5 and 15))
);
--> statement-breakpoint
CREATE TABLE "focus_structures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"task_schedule_revision" integer NOT NULL,
	"state" varchar(20) DEFAULT 'candidate' NOT NULL,
	"source" varchar(16) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"total_start_at" timestamp with time zone NOT NULL,
	"total_end_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_structures_state_check" CHECK ("focus_structures"."state" in ('candidate', 'active', 'superseded', 'invalidated', 'cancelled')),
	CONSTRAINT "focus_structures_source_check" CHECK ("focus_structures"."source" in ('ai', 'template', 'manual')),
	CONSTRAINT "focus_structures_revision_check" CHECK ("focus_structures"."task_schedule_revision" > 0),
	CONSTRAINT "focus_structures_version_check" CHECK ("focus_structures"."version" > 0),
	CONSTRAINT "focus_structures_interval_check" CHECK ("focus_structures"."total_end_at" > "focus_structures"."total_start_at")
);
--> statement-breakpoint
CREATE TABLE "focus_timer_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"focus_session_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"expected_session_version" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_timer_jobs_kind_check" CHECK ("focus_timer_jobs"."kind" in ('preparation_complete', 'confirmation_timeout', 'segment_transition')),
	CONSTRAINT "focus_timer_jobs_status_check" CHECK ("focus_timer_jobs"."status" in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "focus_timer_jobs_version_check" CHECK ("focus_timer_jobs"."expected_session_version" > 0),
	CONSTRAINT "focus_timer_jobs_attempts_check" CHECK ("focus_timer_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_legacy_metadata" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"planned_effort_minutes" integer,
	"difficulty" varchar(16),
	"task_type" varchar(80),
	"requires_continuous_focus" boolean,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_legacy_metadata_planned_effort_check" CHECK ("task_legacy_metadata"."planned_effort_minutes" is null or ("task_legacy_metadata"."planned_effort_minutes" between 1 and 1440))
);
--> statement-breakpoint
INSERT INTO "task_legacy_metadata" ("id", "task_id", "planned_effort_minutes", "difficulty", "task_type", "requires_continuous_focus")
SELECT "id", "id", "planned_effort_minutes", "difficulty", "task_type", "requires_continuous_focus"
FROM "tasks";
--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "focus_structure_id" uuid;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "focus_structure_version" integer;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "focus_structure_schedule_revision" integer;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "current_segment_position" integer;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "current_segment_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "current_segment_elapsed_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "confirmation_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "focus_session_segment_runs" ADD CONSTRAINT "focus_session_segment_runs_focus_session_id_focus_sessions_id_fk" FOREIGN KEY ("focus_session_id") REFERENCES "public"."focus_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_structure_segments" ADD CONSTRAINT "focus_structure_segments_focus_structure_id_focus_structures_id_fk" FOREIGN KEY ("focus_structure_id") REFERENCES "public"."focus_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_structures" ADD CONSTRAINT "focus_structures_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_timer_jobs" ADD CONSTRAINT "focus_timer_jobs_focus_session_id_focus_sessions_id_fk" FOREIGN KEY ("focus_session_id") REFERENCES "public"."focus_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_legacy_metadata" ADD CONSTRAINT "task_legacy_metadata_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "focus_session_segment_runs_position_unique" ON "focus_session_segment_runs" USING btree ("focus_session_id","position");--> statement-breakpoint
CREATE INDEX "focus_session_segment_runs_session_idx" ON "focus_session_segment_runs" USING btree ("focus_session_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "focus_structure_segments_position_unique" ON "focus_structure_segments" USING btree ("focus_structure_id","position");--> statement-breakpoint
CREATE INDEX "focus_structure_segments_structure_idx" ON "focus_structure_segments" USING btree ("focus_structure_id","position");--> statement-breakpoint
CREATE INDEX "focus_structures_task_idx" ON "focus_structures" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "focus_structures_active_task_unique" ON "focus_structures" USING btree ("task_id") WHERE "focus_structures"."state" = 'active';--> statement-breakpoint
CREATE INDEX "focus_timer_jobs_due_idx" ON "focus_timer_jobs" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "focus_timer_jobs_open_unique" ON "focus_timer_jobs" USING btree ("focus_session_id","kind") WHERE "focus_timer_jobs"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "task_legacy_metadata_task_unique" ON "task_legacy_metadata" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_focus_structure_id_focus_structures_id_fk" FOREIGN KEY ("focus_structure_id") REFERENCES "public"."focus_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_segment_position_check" CHECK ("focus_sessions"."current_segment_position" is null or "focus_sessions"."current_segment_position" >= 0);--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_segment_elapsed_check" CHECK ("focus_sessions"."current_segment_elapsed_seconds" >= 0);--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_structure_version_check" CHECK ("focus_sessions"."focus_structure_version" is null or "focus_sessions"."focus_structure_version" > 0);--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_structure_revision_check" CHECK ("focus_sessions"."focus_structure_schedule_revision" is null or "focus_sessions"."focus_structure_schedule_revision" > 0);
