import {
  desktopCommandRequests,
  focusSessionSegmentRuns,
  focusSessionOperations,
  focusSessions,
  focusStructureSegments,
  focusStructures,
  focusTimerJobs,
  feishuIntakeCandidates,
  healthDailyReferences,
  healthProfiles,
  healthSleepAnalyses,
  healthWeekAutoGenerations,
  healthWeekConversationMessages,
  healthWeekConversations,
  healthWeekPlans,
  inboxEntries,
  longRangePlanMilestones,
  longRangePlans,
  reminderJobs,
  taskLegacyMetadata,
  tasks,
  unscheduledTaskDayEndRuns,
  userProfiles
} from "./schema.js";
import { describe, expect, it } from "vitest";

describe("formal task and inbox schema contract", () => {
  it("keeps live task scheduling and task-source linkage explicit", () => {
    expect(tasks.sourceInboxEntryId.name).toBe("source_inbox_entry_id");
    expect(tasks.recordKind.name).toBe("record_kind");
    expect("estimatedMinutes" in tasks).toBe(false);
    expect("entryType" in tasks).toBe(false);
  });

  it("stores ideas and questions outside the task lifecycle table", () => {
    expect(inboxEntries.entryKind.name).toBe("entry_kind");
    expect(inboxEntries.convertedAt.name).toBe("converted_at");
    expect(inboxEntries.deletedAt.name).toBe("deleted_at");
  });

  it("persists Feishu intake candidates before an explicit confirmation creates data", () => {
    expect(feishuIntakeCandidates.sourceMessageId.name).toBe("source_message_id");
    expect(feishuIntakeCandidates.candidate.name).toBe("candidate");
    expect(feishuIntakeCandidates.targetTaskId.name).toBe("target_task_id");
    expect(feishuIntakeCandidates.targetInboxEntryId.name).toBe("target_inbox_entry_id");
  });

  it("binds reminder delivery to the current task schedule revision", () => {
    expect(reminderJobs.scheduleRevision.name).toBe("schedule_revision");
    expect(reminderJobs.scheduledAt.name).toBe("scheduled_at");
    expect(reminderJobs.availableAt.name).toBe("available_at");
  });

  it("persists local desktop navigation commands independently from reminder delivery", () => {
    expect(desktopCommandRequests.taskId.name).toBe("task_id");
    expect(desktopCommandRequests.scheduleRevision.name).toBe("schedule_revision");
    expect(desktopCommandRequests.claimedBy.name).toBe("claimed_by");
    expect(desktopCommandRequests.completedAt.name).toBe("completed_at");
  });

  it("keeps legacy task fields in an explicit archive and models confirmed focus structures", () => {
    expect(taskLegacyMetadata.taskId.name).toBe("task_id");
    expect(taskLegacyMetadata.plannedEffortMinutes.name).toBe("planned_effort_minutes");
    expect(focusStructures.taskScheduleRevision.name).toBe("task_schedule_revision");
    expect(focusStructures.totalStartAt.name).toBe("total_start_at");
    expect(focusStructures.totalEndAt.name).toBe("total_end_at");
    expect(focusStructures.mode.name).toBe("mode");
    expect(focusStructureSegments.segmentType.name).toBe("segment_type");
    expect(focusStructureSegments.durationMinutes.name).toBe("duration_minutes");
  });

  it("keeps execution position and durable timer jobs separate from task scheduling", () => {
    expect(focusSessions.focusStructureId.name).toBe("focus_structure_id");
    expect(focusSessions.plannedEndAt.name).toBe("planned_end_at");
    expect(focusSessions.currentSegmentPosition.name).toBe("current_segment_position");
    expect(focusSessions.confirmationDeadlineAt.name).toBe("confirmation_deadline_at");
    expect(focusSessionSegmentRuns.plannedDurationSeconds.name).toBe("planned_duration_seconds");
    expect(focusSessionSegmentRuns.pausedSeconds.name).toBe("paused_seconds");
    expect(focusSessions.pausedTotalSeconds.name).toBe("paused_total_seconds");
    expect(focusSessionOperations.commandId.name).toBe("command_id");
    expect(focusTimerJobs.expectedSessionVersion.name).toBe("expected_session_version");
    expect(focusTimerJobs.dueAt.name).toBe("due_at");
  });

  it("keeps health profiles and weekly references outside task and growth records", () => {
    expect(healthProfiles.profile.name).toBe("profile");
    expect(healthProfiles.version.name).toBe("version");
    expect(healthWeekPlans.weekStart.name).toBe("week_start");
    expect(healthWeekPlans.profileVersion.name).toBe("profile_version");
    expect(healthDailyReferences.healthWeekPlanId.name).toBe("health_week_plan_id");
    expect(healthDailyReferences.content.name).toBe("content");
    expect(healthSleepAnalyses.analysis.name).toBe("analysis");
    expect(healthSleepAnalyses.sha256.name).toBe("sha256");
    expect(healthWeekAutoGenerations.weekStart.name).toBe("week_start");
    expect(healthWeekAutoGenerations.status.name).toBe("status");
    expect(healthWeekAutoGenerations.planId.name).toBe("plan_id");
    expect(healthWeekConversations.weekStart.name).toBe("week_start");
    expect(healthWeekConversationMessages.conversationId.name).toBe("conversation_id");
    expect(healthWeekConversationMessages.source.name).toBe("source");
    expect(healthWeekConversationMessages.needsClarification.name).toBe("needs_clarification");
    expect(healthWeekConversationMessages.externalMessageId.name).toBe("external_message_id");
  });

  it("keeps monthly, semester, and annual plans outside the task lifecycle", () => {
    expect(longRangePlans.scope.name).toBe("scope");
    expect(longRangePlans.periodStart.name).toBe("period_start");
    expect(longRangePlans.periodEnd.name).toBe("period_end");
    expect(longRangePlans.version.name).toBe("version");
    expect(longRangePlanMilestones.longRangePlanId.name).toBe("long_range_plan_id");
    expect(longRangePlanMilestones.targetDate.name).toBe("target_date");
  });

  it("persists one explicit unscheduled-task policy and an idempotent day-end ledger", () => {
    expect(userProfiles.unscheduledTaskPolicy.name).toBe("unscheduled_task_policy");
    expect(userProfiles.recycleRetentionDays.name).toBe("recycle_retention_days");
    expect(userProfiles.focusFlipSoundEnabled.name).toBe("focus_flip_sound_enabled");
    expect(userProfiles.focusStartSoundEnabled.name).toBe("focus_start_sound_enabled");
    expect(userProfiles.breakStartSoundEnabled.name).toBe("break_start_sound_enabled");
    expect(userProfiles.breakEndSoundEnabled.name).toBe("break_end_sound_enabled");
    expect(userProfiles.focusEndSoundEnabled.name).toBe("focus_end_sound_enabled");
    expect(userProfiles.focusTheme.name).toBe("focus_theme");
    expect(userProfiles.desktopFocusEnabled.name).toBe("desktop_focus_enabled");
    expect(userProfiles.focusPreparationWindowEnabled.name).toBe("focus_preparation_window_enabled");
    expect(userProfiles.focusTimerWindowEnabled.name).toBe("focus_timer_window_enabled");
    expect(userProfiles.focusEvaluationEnabled.name).toBe("focus_evaluation_enabled");
    expect(userProfiles.feishuTaskCardsEnabled.name).toBe("feishu_task_cards_enabled");
    expect(userProfiles.feishuT15Enabled.name).toBe("feishu_t15_enabled");
    expect(userProfiles.healthPageEnabled.name).toBe("health_page_enabled");
    expect(unscheduledTaskDayEndRuns.localDate.name).toBe("local_date");
    expect(unscheduledTaskDayEndRuns.policy.name).toBe("policy");
    expect(unscheduledTaskDayEndRuns.carriedCount.name).toBe("carried_count");
    expect(unscheduledTaskDayEndRuns.deletedCount.name).toBe("deleted_count");
  });
});
