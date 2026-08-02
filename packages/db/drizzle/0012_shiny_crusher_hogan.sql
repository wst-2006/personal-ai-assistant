CREATE TABLE "health_daily_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"health_week_plan_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"day_index" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_daily_references_day_index_check" CHECK ("health_daily_references"."day_index" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "health_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_profiles_version_check" CHECK ("health_profiles"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "health_week_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"state" varchar(16) DEFAULT 'candidate' NOT NULL,
	"source" varchar(16) NOT NULL,
	"profile_version" integer NOT NULL,
	"city" varchar(120) NOT NULL,
	"solar_term" varchar(32) NOT NULL,
	"special_context" text,
	"overview" text NOT NULL,
	"supplements" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_week_plans_state_check" CHECK ("health_week_plans"."state" in ('candidate', 'active', 'superseded', 'cancelled')),
	CONSTRAINT "health_week_plans_source_check" CHECK ("health_week_plans"."source" in ('template', 'ai', 'manual')),
	CONSTRAINT "health_week_plans_profile_version_check" CHECK ("health_week_plans"."profile_version" > 0),
	CONSTRAINT "health_week_plans_version_check" CHECK ("health_week_plans"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "health_daily_references" ADD CONSTRAINT "health_daily_references_health_week_plan_id_health_week_plans_id_fk" FOREIGN KEY ("health_week_plan_id") REFERENCES "public"."health_week_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "health_daily_references_plan_day_unique" ON "health_daily_references" USING btree ("health_week_plan_id","day_index");--> statement-breakpoint
CREATE INDEX "health_daily_references_date_idx" ON "health_daily_references" USING btree ("local_date");--> statement-breakpoint
CREATE INDEX "health_week_plans_week_idx" ON "health_week_plans" USING btree ("week_start","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "health_week_plans_active_week_unique" ON "health_week_plans" USING btree ("week_start") WHERE "health_week_plans"."state" = 'active';