ALTER TABLE "focus_timer_jobs" DROP CONSTRAINT "focus_timer_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "focus_timer_jobs" ADD CONSTRAINT "focus_timer_jobs_kind_check" CHECK ("focus_timer_jobs"."kind" in ('preparation_start', 'preparation_complete', 'confirmation_timeout', 'segment_transition'));--> statement-breakpoint
INSERT INTO "reminder_jobs" (
  "id", "task_id", "channel", "kind", "schedule_revision", "status",
  "scheduled_at", "available_at", "attempts", "payload", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(), "id", 'feishu', 'task_follow_up', "schedule_revision", 'pending',
  "start_at", "start_at" + interval '5 minutes', 0,
  jsonb_build_object(
    'taskId', "id",
    'title', "title",
    'startAt', to_char("start_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endAt', to_char("end_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'timeZone', "time_zone",
    'scheduleRevision', "schedule_revision"
  ),
  now(), now()
FROM "tasks"
WHERE "deleted_at" IS NULL
  AND "lifecycle_status" = 'open'
  AND "schedule_kind" = 'exact'
  AND "start_at" IS NOT NULL
  AND "end_at" > now()
ON CONFLICT ("task_id", "channel", "kind") DO UPDATE SET
  "schedule_revision" = EXCLUDED."schedule_revision",
  "status" = 'pending',
  "scheduled_at" = EXCLUDED."scheduled_at",
  "available_at" = EXCLUDED."available_at",
  "attempts" = 0,
  "payload" = EXCLUDED."payload",
  "last_error" = NULL,
  "sent_at" = NULL,
  "updated_at" = now();
