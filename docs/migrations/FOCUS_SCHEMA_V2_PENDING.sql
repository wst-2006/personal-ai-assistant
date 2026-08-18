-- REVIEWED DRAFT ONLY. This file is not in packages/db/drizzle and is not
-- applied automatically. The final Drizzle migration must preserve this order.

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

ALTER TABLE focus_structures ADD COLUMN IF NOT EXISTS mode varchar(16);

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

ALTER TABLE focus_structures ALTER COLUMN mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.focus_structures'::regclass
      AND conname = 'focus_structures_mode_check'
  ) THEN
    ALTER TABLE focus_structures
      ADD CONSTRAINT focus_structures_mode_check
      CHECK (mode IN ('continuous', 'segmented'));
  END IF;
END $$;

ALTER TABLE focus_structure_segments
  DROP CONSTRAINT IF EXISTS focus_structure_segments_duration_check;

ALTER TABLE focus_structure_segments
  ADD CONSTRAINT focus_structure_segments_duration_check
  CHECK (
    (segment_type = 'focus' AND duration_minutes >= 25)
    OR (segment_type = 'break' AND duration_minutes BETWEEN 5 AND 15)
  );

ALTER TABLE focus_sessions
  ADD COLUMN IF NOT EXISTS paused_total_seconds integer NOT NULL DEFAULT 0;

ALTER TABLE focus_session_segment_runs
  ADD COLUMN IF NOT EXISTS paused_seconds integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.focus_sessions'::regclass
      AND conname = 'focus_sessions_paused_total_seconds_check'
  ) THEN
    ALTER TABLE focus_sessions
      ADD CONSTRAINT focus_sessions_paused_total_seconds_check
      CHECK (paused_total_seconds >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.focus_session_segment_runs'::regclass
      AND conname = 'focus_session_segment_runs_paused_seconds_check'
  ) THEN
    ALTER TABLE focus_session_segment_runs
      ADD CONSTRAINT focus_session_segment_runs_paused_seconds_check
      CHECK (paused_seconds >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS focus_session_operations (
  command_id uuid PRIMARY KEY,
  focus_session_id uuid NOT NULL REFERENCES focus_sessions(id) ON DELETE NO ACTION,
  operation varchar(32) NOT NULL,
  expected_version integer NOT NULL,
  resulting_version integer NOT NULL,
  resulting_state varchar(32) NOT NULL,
  result_payload jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT focus_session_operations_operation_check
    CHECK (operation IN (
      'create', 'begin', 'skip_preparation', 'respond_start', 'other_arrangement',
      'end', 'skip_final_break', 'evaluate'
    )),
  CONSTRAINT focus_session_operations_expected_version_check CHECK (expected_version > 0),
  CONSTRAINT focus_session_operations_resulting_version_check CHECK (resulting_version > 0)
);

CREATE INDEX IF NOT EXISTS focus_session_operations_session_idx
  ON focus_session_operations (focus_session_id, created_at);
CREATE INDEX IF NOT EXISTS focus_sessions_focus_structure_id_idx
  ON focus_sessions (focus_structure_id);
CREATE INDEX IF NOT EXISTS task_feedback_task_id_idx
  ON task_feedback (task_id);
CREATE INDEX IF NOT EXISTS task_outcomes_focus_session_id_idx
  ON task_outcomes (focus_session_id);
