import { asc, sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import {
  appConversationMessages,
  appConversations,
  cyberDiaries,
  dailyBriefs,
  focusSessionSegmentRuns,
  focusSessions,
  focusStructureSegments,
  focusStructures,
  focusTimerJobs,
  healthDailyReferences,
  healthProfiles,
  healthSleepAnalyses,
  healthWeekPlans,
  inboxEntries,
  reminderJobs,
  reviewMessages,
  reviewSessions,
  taskConflictAcceptances,
  taskFeedback,
  taskLegacyMetadata,
  taskLifecycleEvents,
  taskOutcomes,
  tasks
} from "@personal-ai/db/schema";

export const logicalBackupFormat = "personal-ai-assistant.backup" as const;
export const logicalBackupFormatVersion = 2 as const;

export type LogicalBackup = {
  format: typeof logicalBackupFormat;
  formatVersion: typeof logicalBackupFormatVersion;
  exportedAt: string;
  data: {
    inboxEntries: Array<typeof inboxEntries.$inferSelect>;
    healthProfiles: Array<typeof healthProfiles.$inferSelect>;
    healthWeekPlans: Array<typeof healthWeekPlans.$inferSelect>;
    healthDailyReferences: Array<typeof healthDailyReferences.$inferSelect>;
    healthSleepAnalyses: Array<typeof healthSleepAnalyses.$inferSelect>;
    tasks: Array<typeof tasks.$inferSelect>;
    taskLegacyMetadata: Array<typeof taskLegacyMetadata.$inferSelect>;
    taskOutcomes: Array<typeof taskOutcomes.$inferSelect>;
    taskFeedback: Array<typeof taskFeedback.$inferSelect>;
    taskLifecycleEvents: Array<typeof taskLifecycleEvents.$inferSelect>;
    taskConflictAcceptances: Array<typeof taskConflictAcceptances.$inferSelect>;
    reminderJobs: Array<typeof reminderJobs.$inferSelect>;
    focusStructures: Array<typeof focusStructures.$inferSelect>;
    focusStructureSegments: Array<typeof focusStructureSegments.$inferSelect>;
    focusSessions: Array<typeof focusSessions.$inferSelect>;
    focusSessionSegmentRuns: Array<typeof focusSessionSegmentRuns.$inferSelect>;
    focusTimerJobs: Array<typeof focusTimerJobs.$inferSelect>;
    reviewSessions: Array<typeof reviewSessions.$inferSelect>;
    reviewMessages: Array<typeof reviewMessages.$inferSelect>;
    appConversations: Array<typeof appConversations.$inferSelect>;
    appConversationMessages: Array<typeof appConversationMessages.$inferSelect>;
    dailyBriefs: Array<typeof dailyBriefs.$inferSelect>;
    cyberDiaries: Array<typeof cyberDiaries.$inferSelect>;
  };
};

export interface BackupExporter {
  export(): Promise<LogicalBackup>;
}

/** A portable snapshot of application records, deliberately excluding configuration and runtime files. */
export class BackupService implements BackupExporter {
  constructor(private readonly db: AppDatabase) {}

  async export(): Promise<LogicalBackup> {
    const exportedAt = new Date().toISOString();

    return this.db.transaction(async (transaction) => {
      // All reads share one PostgreSQL snapshot and cannot accidentally mutate product data.
      await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);

      // A transaction uses one PostgreSQL connection, so its snapshot reads must stay sequential.
      const inboxEntryRows = await transaction.select().from(inboxEntries).orderBy(asc(inboxEntries.createdAt), asc(inboxEntries.id));
      const healthProfileRows = await transaction.select().from(healthProfiles).orderBy(asc(healthProfiles.createdAt), asc(healthProfiles.id));
      const healthWeekPlanRows = await transaction.select().from(healthWeekPlans).orderBy(asc(healthWeekPlans.weekStart), asc(healthWeekPlans.createdAt), asc(healthWeekPlans.id));
      const healthDailyReferenceRows = await transaction.select().from(healthDailyReferences).orderBy(asc(healthDailyReferences.localDate), asc(healthDailyReferences.dayIndex), asc(healthDailyReferences.id));
      const healthSleepAnalysisRows = await transaction.select().from(healthSleepAnalyses).orderBy(asc(healthSleepAnalyses.localDate), asc(healthSleepAnalyses.createdAt), asc(healthSleepAnalyses.id));
      const taskRows = await transaction.select().from(tasks).orderBy(asc(tasks.createdAt), asc(tasks.id));
      const legacyMetadataRows = await transaction.select().from(taskLegacyMetadata).orderBy(asc(taskLegacyMetadata.archivedAt), asc(taskLegacyMetadata.id));
      const outcomeRows = await transaction.select().from(taskOutcomes).orderBy(asc(taskOutcomes.recordedAt), asc(taskOutcomes.id));
      const feedbackRows = await transaction.select().from(taskFeedback).orderBy(asc(taskFeedback.createdAt), asc(taskFeedback.id));
      const lifecycleEventRows = await transaction.select().from(taskLifecycleEvents).orderBy(asc(taskLifecycleEvents.createdAt), asc(taskLifecycleEvents.id));
      const conflictAcceptanceRows = await transaction.select().from(taskConflictAcceptances).orderBy(asc(taskConflictAcceptances.acceptedAt), asc(taskConflictAcceptances.taskIdLow), asc(taskConflictAcceptances.taskIdHigh));
      const reminderRows = await transaction.select().from(reminderJobs).orderBy(asc(reminderJobs.createdAt), asc(reminderJobs.id));
      const structureRows = await transaction.select().from(focusStructures).orderBy(asc(focusStructures.createdAt), asc(focusStructures.id));
      const structureSegmentRows = await transaction.select().from(focusStructureSegments).orderBy(asc(focusStructureSegments.focusStructureId), asc(focusStructureSegments.position));
      const focusSessionRows = await transaction.select().from(focusSessions).orderBy(asc(focusSessions.createdAt), asc(focusSessions.id));
      const segmentRunRows = await transaction.select().from(focusSessionSegmentRuns).orderBy(asc(focusSessionSegmentRuns.focusSessionId), asc(focusSessionSegmentRuns.position));
      const timerJobRows = await transaction.select().from(focusTimerJobs).orderBy(asc(focusTimerJobs.createdAt), asc(focusTimerJobs.id));
      const reviewSessionRows = await transaction.select().from(reviewSessions).orderBy(asc(reviewSessions.localDate));
      const reviewMessageRows = await transaction.select().from(reviewMessages).orderBy(asc(reviewMessages.createdAt), asc(reviewMessages.id));
      const conversationRows = await transaction.select().from(appConversations).orderBy(asc(appConversations.localDate));
      const conversationMessageRows = await transaction.select().from(appConversationMessages).orderBy(asc(appConversationMessages.createdAt), asc(appConversationMessages.id));
      const briefRows = await transaction.select().from(dailyBriefs).orderBy(asc(dailyBriefs.createdAt), asc(dailyBriefs.id));
      const diaryRows = await transaction.select().from(cyberDiaries).orderBy(asc(cyberDiaries.localDate), asc(cyberDiaries.id));

      return {
        format: logicalBackupFormat,
        formatVersion: logicalBackupFormatVersion,
        exportedAt,
        data: {
          inboxEntries: inboxEntryRows,
          healthProfiles: healthProfileRows,
          healthWeekPlans: healthWeekPlanRows,
          healthDailyReferences: healthDailyReferenceRows,
          healthSleepAnalyses: healthSleepAnalysisRows,
          tasks: taskRows,
          taskLegacyMetadata: legacyMetadataRows,
          taskOutcomes: outcomeRows,
          taskFeedback: feedbackRows,
          taskLifecycleEvents: lifecycleEventRows,
          taskConflictAcceptances: conflictAcceptanceRows,
          reminderJobs: reminderRows,
          focusStructures: structureRows,
          focusStructureSegments: structureSegmentRows,
          focusSessions: focusSessionRows,
          focusSessionSegmentRuns: segmentRunRows,
          focusTimerJobs: timerJobRows,
          reviewSessions: reviewSessionRows,
          reviewMessages: reviewMessageRows,
          appConversations: conversationRows,
          appConversationMessages: conversationMessageRows,
          dailyBriefs: briefRows,
          cyberDiaries: diaryRows
        }
      };
    });
  }
}
