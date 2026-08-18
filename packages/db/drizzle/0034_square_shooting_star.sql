CREATE TABLE "health_week_conversation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"source" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_week_conversation_messages_role_check" CHECK ("health_week_conversation_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "health_week_conversation_messages_source_check" CHECK ("health_week_conversation_messages"."source" in ('app', 'feishu', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "health_week_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_week_conversations_week_start_unique" UNIQUE("week_start")
);
--> statement-breakpoint
ALTER TABLE "health_week_conversation_messages" ADD CONSTRAINT "health_week_conversation_messages_conversation_id_health_week_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."health_week_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_week_conversation_messages_conversation_idx" ON "health_week_conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "health_week_conversations_week_idx" ON "health_week_conversations" USING btree ("week_start");