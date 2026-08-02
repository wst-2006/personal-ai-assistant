ALTER TABLE "health_week_plans" ADD COLUMN "based_on_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "health_week_plans" ADD COLUMN "based_on_plan_version" integer;--> statement-breakpoint
ALTER TABLE "health_week_plans" ADD COLUMN "source_sleep_analysis_id" uuid;--> statement-breakpoint
ALTER TABLE "health_week_plans" ADD COLUMN "revision_reason" text;--> statement-breakpoint
ALTER TABLE "health_week_plans" ADD CONSTRAINT "health_week_plans_based_on_plan_id_health_week_plans_id_fk" FOREIGN KEY ("based_on_plan_id") REFERENCES "public"."health_week_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_week_plans" ADD CONSTRAINT "health_week_plans_source_sleep_analysis_id_health_sleep_analyses_id_fk" FOREIGN KEY ("source_sleep_analysis_id") REFERENCES "public"."health_sleep_analyses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_week_plans_base_plan_idx" ON "health_week_plans" USING btree ("based_on_plan_id");--> statement-breakpoint
ALTER TABLE "health_week_plans" ADD CONSTRAINT "health_week_plans_revision_base_check" CHECK (("health_week_plans"."based_on_plan_id" is null and "health_week_plans"."based_on_plan_version" is null) or ("health_week_plans"."based_on_plan_id" is not null and "health_week_plans"."based_on_plan_version" > 0));