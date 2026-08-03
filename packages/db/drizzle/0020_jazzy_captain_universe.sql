CREATE TABLE "app_conversation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_conversation_messages_role_check" CHECK ("app_conversation_messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "app_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_conversations_local_date_unique" UNIQUE("local_date")
);
--> statement-breakpoint
ALTER TABLE "app_conversation_messages" ADD CONSTRAINT "app_conversation_messages_conversation_id_app_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."app_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_conversation_messages_conversation_idx" ON "app_conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "app_conversations_date_idx" ON "app_conversations" USING btree ("local_date");