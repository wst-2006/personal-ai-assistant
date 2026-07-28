ALTER TABLE "cyber_diaries" ADD COLUMN "review_session_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_briefs" ADD COLUMN "review_session_id" uuid;--> statement-breakpoint
ALTER TABLE "cyber_diaries" ADD CONSTRAINT "cyber_diaries_review_session_id_review_sessions_id_fk" FOREIGN KEY ("review_session_id") REFERENCES "public"."review_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_briefs" ADD CONSTRAINT "daily_briefs_review_session_id_review_sessions_id_fk" FOREIGN KEY ("review_session_id") REFERENCES "public"."review_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_briefs_review_session_idx" ON "daily_briefs" USING btree ("review_session_id");--> statement-breakpoint
ALTER TABLE "daily_briefs" ADD CONSTRAINT "daily_briefs_state_check" CHECK ("daily_briefs"."state" in ('draft', 'confirmed'));