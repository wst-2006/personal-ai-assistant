ALTER TABLE "user_profiles" ADD COLUMN "focus_theme" varchar(16) DEFAULT 'ink' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "desktop_focus_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "focus_preparation_window_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "focus_timer_window_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "focus_evaluation_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "feishu_task_cards_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "feishu_t15_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "health_page_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_focus_theme_check" CHECK ("user_profiles"."focus_theme" in ('ink', 'flip', 'nixie', 'vapor', 'cyber'));