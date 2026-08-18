import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { logicalBackupFormat, logicalBackupFormatVersion, type BackupExporter } from "./backup-service.js";

const backupService: BackupExporter = {
  async export() {
    return {
      format: logicalBackupFormat,
      formatVersion: logicalBackupFormatVersion,
      exportedAt: "2026-08-02T12:34:56.789Z",
      data: {
        inboxEntries: [], feishuIntakeCandidates: [], healthProfiles: [], healthWeekConversations: [], healthWeekConversationMessages: [], healthWeekPlans: [], healthDailyReferences: [], healthSleepAnalyses: [], healthWeekAutoGenerations: [], tasks: [], taskLegacyMetadata: [], taskOutcomes: [], taskFeedback: [], taskLifecycleEvents: [], taskConflictAcceptances: [], reminderJobs: [], desktopCommandRequests: [], focusStructures: [], focusStructureSegments: [], focusSessions: [], focusSessionSegmentRuns: [], focusTimerJobs: [], longRangePlans: [], longRangePlanMilestones: [], longRangePlanTaskTreeCandidates: [], userProfiles: [], unscheduledTaskDayEndRuns: [], reviewSessions: [], reviewMessages: [], appConversations: [], appConversationMessages: [], dailyBriefs: [], cyberDiaries: []
      }
    };
  }
};

const app = buildApp({ backupService });

afterAll(async () => { await app.close(); });

describe("logical backup export route", () => {
  it("returns a user-downloadable, versioned JSON envelope without server configuration", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/backups/export" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-disposition"]).toMatch(/attachment; filename="personal-ai-assistant-backup-20260802T123456789Z\.json"/);
    expect(response.json()).toMatchObject({
      format: logicalBackupFormat,
      formatVersion: logicalBackupFormatVersion,
      data: { healthWeekConversations: [], healthWeekConversationMessages: [], tasks: [], longRangePlans: [], longRangePlanMilestones: [], longRangePlanTaskTreeCandidates: [], userProfiles: [], unscheduledTaskDayEndRuns: [], appConversations: [], appConversationMessages: [], cyberDiaries: [] }
    });
    expect(response.json()).not.toHaveProperty("databaseUrl");
    expect(response.json()).not.toHaveProperty("apiKey");
  });
});
