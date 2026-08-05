CREATE TABLE "desktop_command_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"task_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"claimed_by" varchar(128),
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_command_requests_kind_check" CHECK ("desktop_command_requests"."kind" in ('open_task')),
	CONSTRAINT "desktop_command_requests_status_check" CHECK ("desktop_command_requests"."status" in ('pending', 'claimed', 'completed', 'expired')),
	CONSTRAINT "desktop_command_requests_schedule_revision_check" CHECK ("desktop_command_requests"."schedule_revision" > 0),
	CONSTRAINT "desktop_command_requests_claimed_at_check" CHECK (("desktop_command_requests"."status" = 'pending' and "desktop_command_requests"."claimed_at" is null and "desktop_command_requests"."claimed_by" is null) or ("desktop_command_requests"."status" in ('claimed', 'completed') and "desktop_command_requests"."claimed_at" is not null and "desktop_command_requests"."claimed_by" is not null) or ("desktop_command_requests"."status" = 'expired')),
	CONSTRAINT "desktop_command_requests_completed_at_check" CHECK (("desktop_command_requests"."status" = 'completed') = ("desktop_command_requests"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "desktop_command_requests" ADD CONSTRAINT "desktop_command_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_command_requests_pending_idx" ON "desktop_command_requests" USING btree ("status","expires_at","created_at");--> statement-breakpoint
CREATE INDEX "desktop_command_requests_task_idx" ON "desktop_command_requests" USING btree ("task_id","created_at");
