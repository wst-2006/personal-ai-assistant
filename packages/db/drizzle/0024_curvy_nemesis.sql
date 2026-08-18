DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM focus_sessions
    WHERE state IN ('preparing', 'running', 'paused')
  ) THEN
    RAISE EXCEPTION 'focus_schema_v2 refused: an active focus session exists';
  END IF;
  IF EXISTS (SELECT 1 FROM focus_timer_jobs WHERE status = 'processing') THEN
    RAISE EXCEPTION 'focus_schema_v2 refused: a focus timer job is processing';
  END IF;
  IF EXISTS (SELECT 1 FROM reminder_jobs WHERE status = 'processing') THEN
    RAISE EXCEPTION 'focus_schema_v2 refused: a reminder job is processing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM focus_structures structure
    WHERE NOT EXISTS (
      SELECT 1 FROM focus_structure_segments segment
      WHERE segment.focus_structure_id = structure.id
        AND segment.segment_type = 'focus'
    )
  ) THEN
    RAISE EXCEPTION 'focus_schema_v2 refused: a structure has no focus segment';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "focus_structures" ADD COLUMN "mode" varchar(16);
--> statement-breakpoint
WITH structure_modes AS (
  SELECT
    structure.id,
    CASE
      WHEN count(*) FILTER (WHERE segment.segment_type = 'focus') = 1 THEN 'continuous'
      ELSE 'segmented'
    END AS mode
  FROM focus_structures structure
  JOIN focus_structure_segments segment ON segment.focus_structure_id = structure.id
  GROUP BY structure.id
)
UPDATE focus_structures structure
SET mode = structure_modes.mode
FROM structure_modes
WHERE structure.id = structure_modes.id
  AND structure.mode IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM focus_structures WHERE mode IS NULL) THEN
    RAISE EXCEPTION 'focus_schema_v2 refused: mode backfill left null rows';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "focus_structures" ALTER COLUMN "mode" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "focus_structure_segments" DROP CONSTRAINT "focus_structure_segments_duration_check";
--> statement-breakpoint
ALTER TABLE "focus_structure_segments" ADD CONSTRAINT "focus_structure_segments_duration_check"
  CHECK (("focus_structure_segments"."segment_type" = 'focus' and "focus_structure_segments"."duration_minutes" >= 25)
    or ("focus_structure_segments"."segment_type" = 'break' and "focus_structure_segments"."duration_minutes" between 5 and 15));
--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "paused_total_seconds" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "focus_session_segment_runs" ADD COLUMN "paused_seconds" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "focus_structures" ADD CONSTRAINT "focus_structures_mode_check"
  CHECK ("focus_structures"."mode" in ('continuous', 'segmented'));
--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_paused_total_seconds_check"
  CHECK ("focus_sessions"."paused_total_seconds" >= 0);
--> statement-breakpoint
ALTER TABLE "focus_session_segment_runs" ADD CONSTRAINT "focus_session_segment_runs_paused_seconds_check"
  CHECK ("focus_session_segment_runs"."paused_seconds" >= 0);
--> statement-breakpoint
CREATE TABLE "focus_session_operations" (
  "command_id" uuid PRIMARY KEY NOT NULL,
  "focus_session_id" uuid NOT NULL,
  "operation" varchar(32) NOT NULL,
  "expected_version" integer NOT NULL,
  "resulting_version" integer NOT NULL,
  "resulting_state" varchar(32) NOT NULL,
  "result_payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "focus_session_operations_operation_check" CHECK ("focus_session_operations"."operation" in ('pause', 'resume', 'end', 'reopen', 'skip_preparation', 'skip_final_break', 'other_arrangement')),
  CONSTRAINT "focus_session_operations_expected_version_check" CHECK ("focus_session_operations"."expected_version" > 0),
  CONSTRAINT "focus_session_operations_resulting_version_check" CHECK ("focus_session_operations"."resulting_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "focus_session_operations" ADD CONSTRAINT "focus_session_operations_focus_session_id_focus_sessions_id_fk"
  FOREIGN KEY ("focus_session_id") REFERENCES "public"."focus_sessions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "focus_session_operations_session_idx" ON "focus_session_operations" USING btree ("focus_session_id", "created_at");
--> statement-breakpoint
CREATE INDEX "focus_sessions_focus_structure_id_idx" ON "focus_sessions" USING btree ("focus_structure_id");
--> statement-breakpoint
CREATE INDEX "task_feedback_task_id_idx" ON "task_feedback" USING btree ("task_id");
