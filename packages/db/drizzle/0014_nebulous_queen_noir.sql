CREATE TABLE "health_sleep_analyses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_date" date NOT NULL,
	"source" varchar(16) DEFAULT 'user_upload' NOT NULL,
	"original_file_name" varchar(160) NOT NULL,
	"mime_type" varchar(32) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"analysis" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_sleep_analyses_source_check" CHECK ("health_sleep_analyses"."source" = 'user_upload'),
	CONSTRAINT "health_sleep_analyses_mime_check" CHECK ("health_sleep_analyses"."mime_type" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "health_sleep_analyses_sha256_check" CHECK (length("health_sleep_analyses"."sha256") = 64)
);
--> statement-breakpoint
CREATE INDEX "health_sleep_analyses_date_idx" ON "health_sleep_analyses" USING btree ("local_date","created_at");