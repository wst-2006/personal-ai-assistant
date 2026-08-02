CREATE TABLE "user_profiles" (
	"id" integer PRIMARY KEY NOT NULL,
	"personal_context" text DEFAULT '' NOT NULL,
	"ai_guidance" text DEFAULT '' NOT NULL,
	"share_with_ai" boolean DEFAULT true NOT NULL,
	"response_style" varchar(16) DEFAULT 'balanced' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_singleton_check" CHECK ("user_profiles"."id" = 1),
	CONSTRAINT "user_profiles_response_style_check" CHECK ("user_profiles"."response_style" in ('concise', 'balanced', 'detailed')),
	CONSTRAINT "user_profiles_version_check" CHECK ("user_profiles"."version" > 0)
);
--> statement-breakpoint
INSERT INTO "user_profiles" ("id", "personal_context", "ai_guidance", "share_with_ai", "response_style", "version")
VALUES (1, '', '', true, 'balanced', 1)
ON CONFLICT ("id") DO NOTHING;
