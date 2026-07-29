import { inboxEntries, reminderJobs, tasks } from "./schema.js";
import { describe, expect, it } from "vitest";

describe("formal task and inbox schema contract", () => {
  it("keeps planned effort and task-source linkage explicit", () => {
    expect(tasks.plannedEffortMinutes.name).toBe("planned_effort_minutes");
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
});
