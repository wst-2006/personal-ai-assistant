ALTER TABLE "feishu_intake_candidates" DROP CONSTRAINT "feishu_intake_candidates_state_check";--> statement-breakpoint
ALTER TABLE "focus_sessions" DROP CONSTRAINT "focus_sessions_state_check";--> statement-breakpoint
ALTER TABLE "reminder_jobs" DROP CONSTRAINT "reminder_jobs_kind_check";--> statement-breakpoint
DROP INDEX "focus_sessions_open_task_unique";--> statement-breakpoint
ALTER TABLE "feishu_intake_candidates" ADD COLUMN "last_source_message_id" varchar(128);--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD COLUMN "remote_message_id" varchar(128);--> statement-breakpoint
UPDATE "feishu_intake_candidates"
SET "last_source_message_id" = "source_message_id"
WHERE "last_source_message_id" IS NULL;--> statement-breakpoint
DELETE FROM "reminder_jobs" WHERE "kind" = 'task_follow_up';--> statement-breakpoint
INSERT INTO "reminder_jobs" (
  "id", "task_id", "channel", "kind", "schedule_revision", "status",
  "scheduled_at", "available_at", "attempts", "payload", "remote_message_id",
  "last_error", "sent_at", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(), task."id", 'feishu', stage."kind", task."schedule_revision", 'pending',
  task."start_at",
  CASE stage."kind"
    WHEN 'task_start' THEN task."start_at" - interval '15 minutes'
    WHEN 'task_start_ready' THEN task."start_at" - interval '1 minute'
    WHEN 'task_start_lapsed' THEN task."start_at"
    ELSE task."end_at"
  END,
  0,
  jsonb_build_object(
    'taskId', task."id",
    'title', task."title",
    'startAt', task."start_at",
    'endAt', task."end_at",
    'timeZone', task."time_zone",
    'scheduleRevision', task."schedule_revision"
  ),
  NULL, NULL, NULL, now(), now()
FROM "tasks" AS task
CROSS JOIN (VALUES
  ('task_start'),
  ('task_start_ready'),
  ('task_start_lapsed'),
  ('task_start_expire')
) AS stage("kind")
WHERE task."deleted_at" IS NULL
  AND task."record_kind" = 'formal'
  AND task."lifecycle_status" = 'open'
  AND task."schedule_kind" = 'exact'
  AND task."start_at" IS NOT NULL
  AND task."end_at" IS NOT NULL
  AND task."end_at" > now()
ON CONFLICT ("task_id", "channel", "kind") DO UPDATE SET
  "schedule_revision" = EXCLUDED."schedule_revision",
  "status" = 'pending',
  "scheduled_at" = EXCLUDED."scheduled_at",
  "available_at" = EXCLUDED."available_at",
  "attempts" = 0,
  "payload" = EXCLUDED."payload",
  "remote_message_id" = NULL,
  "last_error" = NULL,
  "sent_at" = NULL,
  "updated_at" = now();--> statement-breakpoint
CREATE UNIQUE INDEX "focus_sessions_open_task_unique" ON "focus_sessions" USING btree ("task_id") WHERE "focus_sessions"."state" in ('scheduled', 'reminded', 'preparing', 'armed', 'awaiting_late_start', 'awaiting_start', 'running', 'paused');--> statement-breakpoint
ALTER TABLE "feishu_intake_candidates" ADD CONSTRAINT "feishu_intake_candidates_state_check" CHECK ("feishu_intake_candidates"."state" in ('parsing', 'awaiting_duration', 'pending', 'confirming', 'confirmed', 'cancelled', 'needs_desktop', 'failed'));--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_state_check" CHECK ("focus_sessions"."state" in ('scheduled', 'reminded', 'preparing', 'armed', 'awaiting_late_start', 'awaiting_start', 'running', 'paused', 'ended', 'evaluated', 'stopped_no_response', 'stopped_for_change'));--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_kind_check" CHECK ("reminder_jobs"."kind" in ('task_start', 'task_start_ready', 'task_start_lapsed', 'task_start_expire'));
