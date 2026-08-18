ALTER TABLE "user_profiles" ADD COLUMN "recycle_retention_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "focus_flip_sound_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "focus_start_sound_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "break_start_sound_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "break_end_sound_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "focus_end_sound_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_recycle_retention_days_check" CHECK ("user_profiles"."recycle_retention_days" between 1 and 30);