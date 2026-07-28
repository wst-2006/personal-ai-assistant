ALTER TABLE "focus_sessions" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "preparing_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "active_since_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "stopped_reason" text;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "focus_sessions_current_idx" ON "focus_sessions" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_feedback_focus_session_unique" ON "task_feedback" USING btree ("focus_session_id");--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_state_check" CHECK ("focus_sessions"."state" in ('scheduled', 'reminded', 'preparing', 'awaiting_start', 'running', 'paused', 'ended', 'evaluated', 'stopped_no_response', 'stopped_for_change'));--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_raw_seconds_check" CHECK ("focus_sessions"."raw_active_seconds" >= 0);--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_effective_seconds_check" CHECK ("focus_sessions"."effective_focus_seconds" >= 0);--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_version_check" CHECK ("focus_sessions"."version" > 0);--> statement-breakpoint
ALTER TABLE "task_feedback" ADD CONSTRAINT "task_feedback_satisfaction_check" CHECK ("task_feedback"."satisfaction" in ('satisfied', 'neutral', 'dissatisfied'));