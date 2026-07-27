CREATE TABLE "inbox_entries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "entry_kind" varchar(16) NOT NULL,
  "content" varchar(200) NOT NULL,
  "notes" text,
  "version" integer DEFAULT 1 NOT NULL,
  "converted_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inbox_entries_kind_check" CHECK ("entry_kind" IN ('idea', 'question')),
  CONSTRAINT "inbox_entries_version_check" CHECK ("version" > 0)
);
CREATE INDEX "inbox_entries_active_idx" ON "inbox_entries" ("deleted_at", "created_at");

DO $$
DECLARE
  legacy_count integer;
  copied_count integer;
  formal_task_count integer;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "tasks"
    WHERE "entry_type" NOT IN ('task', 'idea', 'question')
  ) THEN
    RAISE EXCEPTION 'Migration refused: tasks contains an unknown entry_type.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "tasks" AS task
    WHERE task."entry_type" IN ('idea', 'question')
      AND (
        EXISTS (SELECT 1 FROM "focus_sessions" WHERE "task_id" = task."id")
        OR EXISTS (SELECT 1 FROM "task_feedback" WHERE "task_id" = task."id")
        OR EXISTS (SELECT 1 FROM "task_outcomes" WHERE "task_id" = task."id")
        OR EXISTS (
          SELECT 1
          FROM "task_conflict_acceptances"
          WHERE "task_id_low" = task."id" OR "task_id_high" = task."id"
        )
      )
  ) THEN
    RAISE EXCEPTION 'Migration refused: legacy ideas/questions have task-only dependent records.';
  END IF;

  SELECT count(*)::integer
  INTO legacy_count
  FROM "tasks"
  WHERE "entry_type" IN ('idea', 'question');

  SELECT count(*)::integer
  INTO formal_task_count
  FROM "tasks"
  WHERE "entry_type" = 'task';

  INSERT INTO "inbox_entries" (
    "id",
    "entry_kind",
    "content",
    "notes",
    "version",
    "converted_at",
    "deleted_at",
    "created_at",
    "updated_at"
  )
  SELECT
    "id",
    "entry_type",
    "title",
    "notes",
    "version",
    NULL,
    "deleted_at",
    "created_at",
    "updated_at"
  FROM "tasks"
  WHERE "entry_type" IN ('idea', 'question');

  GET DIAGNOSTICS copied_count = ROW_COUNT;
  IF copied_count <> legacy_count THEN
    RAISE EXCEPTION 'Migration refused: copied % inbox entries, expected %.', copied_count, legacy_count;
  END IF;

  DELETE FROM "task_lifecycle_events"
  WHERE "task_id" IN (
    SELECT "id"
    FROM "tasks"
    WHERE "entry_type" IN ('idea', 'question')
  );

  DELETE FROM "tasks"
  WHERE "entry_type" IN ('idea', 'question');

  IF (SELECT count(*)::integer FROM "tasks") <> formal_task_count THEN
    RAISE EXCEPTION 'Migration refused: formal task count changed during inbox migration.';
  END IF;
END $$;

ALTER TABLE "tasks" DROP CONSTRAINT "tasks_exact_entry_type_check";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_time_order_check";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_schedule_shape_check";
ALTER TABLE "tasks" RENAME COLUMN "estimated_minutes" TO "planned_effort_minutes";
ALTER TABLE "tasks" ADD COLUMN "source_inbox_entry_id" uuid REFERENCES "inbox_entries"("id");
ALTER TABLE "tasks" DROP COLUMN "entry_type";

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_exact_minimum_duration_check"
  CHECK ("end_at" IS NULL OR "end_at" >= "start_at" + interval '5 minutes');
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_planned_effort_check"
  CHECK ("planned_effort_minutes" IS NULL OR "planned_effort_minutes" BETWEEN 1 AND 1440);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_schedule_shape_check"
  CHECK (
    ("schedule_kind" = 'none' AND "start_at" IS NULL AND "end_at" IS NULL AND "daypart" IS NULL)
    OR ("schedule_kind" = 'daypart' AND "local_date" IS NOT NULL AND "daypart" IN ('morning', 'afternoon', 'evening') AND "start_at" IS NULL AND "end_at" IS NULL)
    OR ("schedule_kind" = 'exact' AND "local_date" IS NOT NULL AND "start_at" IS NOT NULL AND "end_at" IS NOT NULL AND "daypart" IS NULL)
  );
CREATE UNIQUE INDEX "tasks_source_inbox_entry_id_unique" ON "tasks" ("source_inbox_entry_id");
