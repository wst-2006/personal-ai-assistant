ALTER TABLE "tasks" ADD COLUMN "schedule_kind" varchar(16) DEFAULT 'none' NOT NULL;
ALTER TABLE "tasks" ADD COLUMN "current_outcome" varchar(32);
ALTER TABLE "tasks" ADD COLUMN "daypart" varchar(16);
ALTER TABLE "tasks" ADD COLUMN "time_zone" varchar(64) DEFAULT 'Asia/Shanghai' NOT NULL;
ALTER TABLE "tasks" ADD COLUMN "schedule_revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "tasks" ADD COLUMN "deleted_at" timestamp with time zone;

UPDATE "tasks"
SET "lifecycle_status" = CASE
  WHEN "lifecycle_status" IN ('active', 'awaiting_outcome', 'closed', 'cancelled') THEN "lifecycle_status"
  ELSE 'open'
END;

UPDATE "tasks"
SET "start_at" = NULL, "end_at" = NULL
WHERE "entry_type" <> 'task'
   OR "start_at" IS NULL
   OR "end_at" IS NULL
   OR "end_at" <= "start_at";

UPDATE "tasks"
SET
  "schedule_kind" = CASE
    WHEN "start_at" IS NOT NULL AND "end_at" IS NOT NULL THEN 'exact'
    WHEN "schedule_precision" IN ('morning', 'afternoon', 'evening') AND "local_date" IS NOT NULL THEN 'daypart'
    ELSE 'none'
  END,
  "daypart" = CASE
    WHEN "schedule_precision" IN ('morning', 'afternoon', 'evening') AND "local_date" IS NOT NULL
      THEN "schedule_precision"
    ELSE NULL
  END,
  "current_outcome" = "objective_outcome";

UPDATE "tasks"
SET "local_date" = to_char("start_at" AT TIME ZONE "time_zone", 'YYYY-MM-DD')
WHERE "schedule_kind" = 'exact';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "tasks" WHERE "current_outcome" IS NOT NULL) THEN
    RAISE EXCEPTION 'Migration requires current_outcome to be empty because legacy rows have no objective progress percentage.';
  END IF;
END $$;

ALTER TABLE "tasks" ALTER COLUMN "local_date" TYPE date USING "local_date"::date;
ALTER TABLE "tasks" ALTER COLUMN "lifecycle_status" SET DEFAULT 'open';
ALTER TABLE "tasks" DROP COLUMN "objective_outcome";
ALTER TABLE "tasks" DROP COLUMN "schedule_precision";

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lifecycle_status_check"
  CHECK ("lifecycle_status" IN ('open', 'active', 'awaiting_outcome', 'closed', 'cancelled'));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_schedule_kind_check"
  CHECK ("schedule_kind" IN ('none', 'daypart', 'exact'));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_outcome_check"
  CHECK ("current_outcome" IS NULL OR "current_outcome" IN ('not_completed', 'partial', 'complete'));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_time_pair_check"
  CHECK (("start_at" IS NULL AND "end_at" IS NULL) OR ("start_at" IS NOT NULL AND "end_at" IS NOT NULL));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_time_order_check"
  CHECK ("end_at" IS NULL OR "end_at" > "start_at");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_schedule_shape_check"
  CHECK (
    ("schedule_kind" = 'none' AND "start_at" IS NULL AND "end_at" IS NULL AND "daypart" IS NULL)
    OR ("schedule_kind" = 'daypart' AND "local_date" IS NOT NULL AND "daypart" IN ('morning', 'afternoon', 'evening') AND "start_at" IS NULL AND "end_at" IS NULL)
    OR ("schedule_kind" = 'exact' AND "start_at" IS NOT NULL AND "end_at" IS NOT NULL AND "daypart" IS NULL)
  );
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_exact_entry_type_check"
  CHECK ("schedule_kind" <> 'exact' OR "entry_type" = 'task');
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_version_check" CHECK ("version" > 0);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_schedule_revision_check" CHECK ("schedule_revision" > 0);

CREATE INDEX "tasks_exact_interval_idx" ON "tasks" ("start_at", "end_at");

CREATE TABLE "task_outcomes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "focus_session_id" uuid REFERENCES "focus_sessions"("id"),
  "outcome" varchar(32) NOT NULL,
  "progress_percent" integer NOT NULL,
  "source" varchar(16) NOT NULL,
  "note" text,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "task_outcomes_value_check" CHECK (
    ("outcome" = 'not_completed' AND "progress_percent" = 0)
    OR ("outcome" = 'partial' AND "progress_percent" BETWEEN 1 AND 99)
    OR ("outcome" = 'complete' AND "progress_percent" = 100)
  ),
  CONSTRAINT "task_outcomes_source_check" CHECK ("source" IN ('app', 'ai', 'feishu', 'system'))
);
CREATE INDEX "task_outcomes_task_id_idx" ON "task_outcomes" ("task_id", "recorded_at");

CREATE TABLE "task_lifecycle_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "from_status" varchar(32),
  "to_status" varchar(32) NOT NULL,
  "source" varchar(16) NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "task_lifecycle_events_from_status_check" CHECK (
    "from_status" IS NULL OR "from_status" IN ('open', 'active', 'awaiting_outcome', 'closed', 'cancelled')
  ),
  CONSTRAINT "task_lifecycle_events_to_status_check" CHECK (
    "to_status" IN ('open', 'active', 'awaiting_outcome', 'closed', 'cancelled', 'deleted')
  ),
  CONSTRAINT "task_lifecycle_events_source_check" CHECK ("source" IN ('app', 'ai', 'feishu', 'system'))
);
CREATE INDEX "task_lifecycle_events_task_id_idx" ON "task_lifecycle_events" ("task_id", "created_at");

INSERT INTO "task_lifecycle_events" ("id", "task_id", "from_status", "to_status", "source", "reason")
SELECT gen_random_uuid(), "id", NULL, "lifecycle_status", 'system', 'Lifecycle model migration baseline'
FROM "tasks";

CREATE TABLE "task_conflict_acceptances" (
  "task_id_low" uuid NOT NULL REFERENCES "tasks"("id"),
  "task_schedule_revision_low" integer NOT NULL,
  "task_id_high" uuid NOT NULL REFERENCES "tasks"("id"),
  "task_schedule_revision_high" integer NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "task_conflict_acceptances_pk" PRIMARY KEY (
    "task_id_low", "task_schedule_revision_low", "task_id_high", "task_schedule_revision_high"
  ),
  CONSTRAINT "task_conflict_acceptances_order_check" CHECK ("task_id_low" < "task_id_high"),
  CONSTRAINT "task_conflict_acceptances_revisions_check" CHECK (
    "task_schedule_revision_low" > 0 AND "task_schedule_revision_high" > 0
  )
);
CREATE INDEX "task_conflict_acceptances_high_idx"
  ON "task_conflict_acceptances" ("task_id_high", "task_schedule_revision_high");
