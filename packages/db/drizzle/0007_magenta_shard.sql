ALTER TABLE "reminder_jobs" ADD COLUMN "schedule_revision" integer;--> statement-breakpoint
UPDATE "reminder_jobs" AS job
SET "schedule_revision" = COALESCE(task."schedule_revision", 1)
FROM "tasks" AS task
WHERE job."task_id" = task."id";--> statement-breakpoint
UPDATE "reminder_jobs" SET "schedule_revision" = 1 WHERE "schedule_revision" IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "reminder_jobs"
    WHERE "task_id" IS NOT NULL
    GROUP BY "task_id", "channel", "kind"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'reminder_jobs contains duplicate task/channel/kind rows; migration stopped without deleting data';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ALTER COLUMN "schedule_revision" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_jobs_task_channel_kind_unique" ON "reminder_jobs" USING btree ("task_id","channel","kind");--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_schedule_revision_check" CHECK ("reminder_jobs"."schedule_revision" > 0);
