CREATE TABLE "long_range_plan_milestones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"long_range_plan_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"target_date" date,
	"notes" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "long_range_plan_milestones_position_check" CHECK ("long_range_plan_milestones"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "long_range_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" varchar(16) NOT NULL,
	"title" varchar(200) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"description" text,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "long_range_plans_scope_check" CHECK ("long_range_plans"."scope" in ('month', 'semester', 'annual')),
	CONSTRAINT "long_range_plans_status_check" CHECK ("long_range_plans"."status" in ('active', 'archived')),
	CONSTRAINT "long_range_plans_period_check" CHECK ("long_range_plans"."period_end" >= "long_range_plans"."period_start"),
	CONSTRAINT "long_range_plans_version_check" CHECK ("long_range_plans"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "long_range_plan_milestones" ADD CONSTRAINT "long_range_plan_milestones_long_range_plan_id_long_range_plans_id_fk" FOREIGN KEY ("long_range_plan_id") REFERENCES "public"."long_range_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "long_range_plan_milestones_plan_idx" ON "long_range_plan_milestones" USING btree ("long_range_plan_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "long_range_plan_milestones_position_unique" ON "long_range_plan_milestones" USING btree ("long_range_plan_id","position");--> statement-breakpoint
CREATE INDEX "long_range_plans_scope_status_idx" ON "long_range_plans" USING btree ("scope","status","period_start");