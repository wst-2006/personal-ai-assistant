import { describe, expect, it } from "vitest";
import { migrationBackupFileName, migrationBlockers, pgDumpCommand } from "./migration-preflight.js";
import type { DatabaseConfig } from "./config.js";

const config: DatabaseConfig = {
  DATABASE_URL: "postgresql://personal_ai_app:test@127.0.0.1:5432/personal_ai_assistant",
  EXPECTED_DB_HOST: "127.0.0.1",
  EXPECTED_DB_PORT: 5432,
  EXPECTED_DB_NAME: "personal_ai_assistant",
  EXPECTED_DB_USER: "personal_ai_app",
  EXPECTED_PG_MAJOR: 18
};

describe("migration preflight", () => {
  it("blocks migrations while runtime state could be changed concurrently", () => {
    expect(migrationBlockers({ activeFocusSessions: 1, processingFocusTimerJobs: 0, processingReminderJobs: 0, otherApplicationConnections: 0 })).toEqual(["active focus sessions exist"]);
    expect(migrationBlockers({ activeFocusSessions: 0, processingFocusTimerJobs: 1, processingReminderJobs: 1, otherApplicationConnections: 1 })).toEqual([
      "focus timer jobs are processing",
      "reminder jobs are processing",
      "other application database connections are still open"
    ]);
    expect(migrationBlockers({ activeFocusSessions: 0, processingFocusTimerJobs: 0, processingReminderJobs: 0, otherApplicationConnections: 0 })).toEqual([]);
  });

  it("creates a filesystem-safe, unique-looking backup name", () => {
    expect(migrationBackupFileName(new Date("2026-08-10T12:34:56.789Z"))).toBe(
      "personal_ai_assistant_pre_migration_20260810T123456_789Z.backup"
    );
  });

  it("honors an explicit pg_dump path for installed desktop migrations", () => {
    const previous = process.env.PERSONAL_AI_PG_DUMP_PATH;
    process.env.PERSONAL_AI_PG_DUMP_PATH = "D:\\PostgreSQL\\bin\\pg_dump.exe";
    try {
      expect(pgDumpCommand(config)).toBe("D:\\PostgreSQL\\bin\\pg_dump.exe");
    } finally {
      if (previous === undefined) delete process.env.PERSONAL_AI_PG_DUMP_PATH;
      else process.env.PERSONAL_AI_PG_DUMP_PATH = previous;
    }
  });
});
