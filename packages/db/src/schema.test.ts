import {
  focusSessionSegmentRuns,
  focusSessions,
  focusStructureSegments,
  focusStructures,
  focusTimerJobs,
  inboxEntries,
  reminderJobs,
  taskLegacyMetadata,
  tasks
} from "./schema.js";
import { describe, expect, it } from "vitest";

describe("formal task and inbox schema contract", () => {
  it("keeps live task scheduling and task-source linkage explicit", () => {
    expect(tasks.sourceInboxEntryId.name).toBe("source_inbox_entry_id");
    expect("estimatedMinutes" in tasks).toBe(false);
    expect("entryType" in tasks).toBe(false);
  });

  it("stores ideas and questions outside the task lifecycle table", () => {
    expect(inboxEntries.entryKind.name).toBe("entry_kind");
    expect(inboxEntries.convertedAt.name).toBe("converted_at");
    expect(inboxEntries.deletedAt.name).toBe("deleted_at");
  });

  it("binds reminder delivery to the current task schedule revision", () => {
    expect(reminderJobs.scheduleRevision.name).toBe("schedule_revision");
    expect(reminderJobs.scheduledAt.name).toBe("scheduled_at");
    expect(reminderJobs.availableAt.name).toBe("available_at");
  });

  it("keeps legacy task fields in an explicit archive and models confirmed focus structures", () => {
    expect(taskLegacyMetadata.taskId.name).toBe("task_id");
    expect(taskLegacyMetadata.plannedEffortMinutes.name).toBe("planned_effort_minutes");
    expect(focusStructures.taskScheduleRevision.name).toBe("task_schedule_revision");
    expect(focusStructures.totalStartAt.name).toBe("total_start_at");
    expect(focusStructures.totalEndAt.name).toBe("total_end_at");
    expect(focusStructureSegments.segmentType.name).toBe("segment_type");
    expect(focusStructureSegments.durationMinutes.name).toBe("duration_minutes");
  });

  it("keeps execution position and durable timer jobs separate from task scheduling", () => {
    expect(focusSessions.focusStructureId.name).toBe("focus_structure_id");
    expect(focusSessions.plannedEndAt.name).toBe("planned_end_at");
    expect(focusSessions.currentSegmentPosition.name).toBe("current_segment_position");
    expect(focusSessions.confirmationDeadlineAt.name).toBe("confirmation_deadline_at");
    expect(focusSessionSegmentRuns.plannedDurationSeconds.name).toBe("planned_duration_seconds");
    expect(focusTimerJobs.expectedSessionVersion.name).toBe("expected_session_version");
    expect(focusTimerJobs.dueAt.name).toBe("due_at");
  });
});
