CREATE TABLE "feishu_intake_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_id" varchar(128) NOT NULL,
	"operator_open_id" varchar(128) NOT NULL,
	"source_message_id" varchar(128) NOT NULL,
	"raw_text" text NOT NULL,
	"candidate" jsonb,
	"state" varchar(32) DEFAULT 'parsing' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"target_task_id" uuid,
	"target_inbox_entry_id" uuid,
	"last_error" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_intake_candidates_state_check" CHECK ("feishu_intake_candidates"."state" in ('parsing', 'pending', 'confirming', 'confirmed', 'cancelled', 'needs_desktop', 'failed')),
	CONSTRAINT "feishu_intake_candidates_version_check" CHECK ("feishu_intake_candidates"."version" > 0),
	CONSTRAINT "feishu_intake_candidates_target_check" CHECK ("feishu_intake_candidates"."target_task_id" is null or "feishu_intake_candidates"."target_inbox_entry_id" is null),
	CONSTRAINT "feishu_intake_candidates_confirmed_target_check" CHECK ("feishu_intake_candidates"."state" <> 'confirmed' or ("feishu_intake_candidates"."target_task_id" is not null or "feishu_intake_candidates"."target_inbox_entry_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_intake_candidates_source_message_unique" ON "feishu_intake_candidates" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "feishu_intake_candidates_active_idx" ON "feishu_intake_candidates" USING btree ("state","created_at");