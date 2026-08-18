ALTER TABLE "tasks" ADD COLUMN "record_kind" varchar(16) DEFAULT 'formal' NOT NULL;--> statement-breakpoint
UPDATE "tasks"
SET "record_kind" = 'backfill'
WHERE EXISTS (
	SELECT 1
	FROM "task_lifecycle_events"
	WHERE "task_lifecycle_events"."task_id" = "tasks"."id"
		AND "task_lifecycle_events"."reason" = 'same-day task backfill'
);--> statement-breakpoint
CREATE INDEX "tasks_record_kind_local_date_idx" ON "tasks" USING btree ("record_kind","local_date");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_record_kind_check" CHECK ("tasks"."record_kind" in ('formal', 'backfill'));
