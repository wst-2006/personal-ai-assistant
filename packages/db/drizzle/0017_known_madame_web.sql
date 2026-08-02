CREATE TABLE "long_range_plan_task_tree_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"long_range_plan_id" uuid NOT NULL,
	"long_range_plan_version" integer NOT NULL,
	"state" varchar(16) DEFAULT 'candidate' NOT NULL,
	"instructions" text,
	"proposal" jsonb NOT NULL,
	"created_task_ids" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "long_range_plan_task_tree_candidates_state_check" CHECK ("long_range_plan_task_tree_candidates"."state" in ('candidate', 'confirmed', 'cancelled')),
	CONSTRAINT "long_range_plan_task_tree_candidates_version_check" CHECK ("long_range_plan_task_tree_candidates"."version" > 0),
	CONSTRAINT "long_range_plan_task_tree_candidates_plan_version_check" CHECK ("long_range_plan_task_tree_candidates"."long_range_plan_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source_long_range_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "long_range_plan_task_tree_candidates" ADD CONSTRAINT "long_range_plan_task_tree_candidates_long_range_plan_id_long_range_plans_id_fk" FOREIGN KEY ("long_range_plan_id") REFERENCES "public"."long_range_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "long_range_plan_task_tree_candidates_plan_idx" ON "long_range_plan_task_tree_candidates" USING btree ("long_range_plan_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_source_long_range_plan_idx" ON "tasks" USING btree ("source_long_range_plan_id");