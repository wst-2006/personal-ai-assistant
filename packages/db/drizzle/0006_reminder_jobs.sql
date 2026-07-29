CREATE TABLE "reminder_jobs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "task_id" uuid,
  "channel" varchar(32) NOT NULL,
  "kind" varchar(32) NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "scheduled_at" timestamp with time zone NOT NULL,
  "available_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "payload" jsonb NOT NULL,
  "last_error" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "reminder_jobs_due_idx" ON "reminder_jobs" USING btree ("status", "available_at");
--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_channel_check" CHECK ("reminder_jobs"."channel" in ('feishu'));
--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_kind_check" CHECK ("reminder_jobs"."kind" in ('task_start', 'task_follow_up'));
--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_status_check" CHECK ("reminder_jobs"."status" in ('pending', 'processing', 'sent', 'failed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_attempts_check" CHECK ("reminder_jobs"."attempts" >= 0);
