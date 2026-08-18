CREATE TABLE "health_week_auto_generations" (
	"week_start" date PRIMARY KEY NOT NULL,
	"status" varchar(16) DEFAULT 'processing' NOT NULL,
	"plan_id" uuid,
	"failure_code" varchar(64),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_week_auto_generations_status_check" CHECK ("health_week_auto_generations"."status" in ('processing', 'completed', 'failed', 'skipped')),
	CONSTRAINT "health_week_auto_generations_result_check" CHECK (("health_week_auto_generations"."status" = 'completed' and "health_week_auto_generations"."plan_id" is not null and "health_week_auto_generations"."failure_code" is null) or ("health_week_auto_generations"."status" = 'failed' and "health_week_auto_generations"."plan_id" is null and "health_week_auto_generations"."failure_code" is not null) or ("health_week_auto_generations"."status" in ('processing', 'skipped') and "health_week_auto_generations"."plan_id" is null))
);
--> statement-breakpoint
ALTER TABLE "health_week_auto_generations" ADD CONSTRAINT "health_week_auto_generations_plan_id_health_week_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."health_week_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_week_auto_generations_status_idx" ON "health_week_auto_generations" USING btree ("status","updated_at");