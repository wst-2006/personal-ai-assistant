-- DESTRUCTIVE ROLLBACK DRAFT. Never run automatically.
-- It is permitted only before any V2 operation or 25-29 minute focus segment
-- has been written. Otherwise restore the pre-migration custom backup.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM focus_session_operations) THEN
    RAISE EXCEPTION 'focus_schema_v2 rollback refused: V2 operations already exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM focus_structure_segments
    WHERE segment_type = 'focus' AND duration_minutes < 30
  ) THEN
    RAISE EXCEPTION 'focus_schema_v2 rollback refused: V2 focus segments already exist';
  END IF;
END $$;

DROP INDEX IF EXISTS task_outcomes_focus_session_id_idx;
DROP INDEX IF EXISTS task_feedback_task_id_idx;
DROP INDEX IF EXISTS focus_sessions_focus_structure_id_idx;
DROP INDEX IF EXISTS focus_session_operations_session_idx;
DROP TABLE IF EXISTS focus_session_operations;

ALTER TABLE focus_session_segment_runs
  DROP CONSTRAINT IF EXISTS focus_session_segment_runs_paused_seconds_check;
ALTER TABLE focus_session_segment_runs DROP COLUMN IF EXISTS paused_seconds;

ALTER TABLE focus_sessions
  DROP CONSTRAINT IF EXISTS focus_sessions_paused_total_seconds_check;
ALTER TABLE focus_sessions DROP COLUMN IF EXISTS paused_total_seconds;

ALTER TABLE focus_structure_segments
  DROP CONSTRAINT IF EXISTS focus_structure_segments_duration_check;
ALTER TABLE focus_structure_segments
  ADD CONSTRAINT focus_structure_segments_duration_check
  CHECK (
    (segment_type = 'focus' AND duration_minutes >= 30)
    OR (segment_type = 'break' AND duration_minutes BETWEEN 5 AND 15)
  );

ALTER TABLE focus_structures DROP CONSTRAINT IF EXISTS focus_structures_mode_check;
ALTER TABLE focus_structures DROP COLUMN IF EXISTS mode;
