CREATE TABLE "unscheduled_task_day_end_runs" (
	"local_date" date PRIMARY KEY NOT NULL,
	"policy" varchar(32) NOT NULL,
	"carried_count" integer DEFAULT 0 NOT NULL,
	"deleted_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unscheduled_task_day_end_runs_policy_check" CHECK ("unscheduled_task_day_end_runs"."policy" in ('carry_forward', 'delete_at_day_end')),
	CONSTRAINT "unscheduled_task_day_end_runs_counts_check" CHECK ("unscheduled_task_day_end_runs"."carried_count" >= 0 and "unscheduled_task_day_end_runs"."deleted_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "unscheduled_task_policy" varchar(32) DEFAULT 'carry_forward' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_unscheduled_task_policy_check" CHECK ("user_profiles"."unscheduled_task_policy" in ('carry_forward', 'delete_at_day_end'));