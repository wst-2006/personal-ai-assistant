import { describe, expect, it } from "vitest";
import type { DatabaseConfig } from "./config.js";
import { migrationTargetMismatches } from "./migration-guard.js";

const config: DatabaseConfig = {
  DATABASE_URL: "postgresql://personal_ai_app:example@127.0.0.1:5432/personal_ai_assistant",
  EXPECTED_DB_HOST: "127.0.0.1",
  EXPECTED_DB_PORT: 5432,
  EXPECTED_DB_NAME: "personal_ai_assistant",
  EXPECTED_DB_USER: "personal_ai_app",
  EXPECTED_PG_MAJOR: 18
};

describe("migration target guard", () => {
  it("accepts only the configured development target", () => {
    expect(
      migrationTargetMismatches(config, {
        databaseName: "personal_ai_assistant",
        databaseUser: "personal_ai_app",
        serverAddress: "127.0.0.1/32",
        serverPort: 5432,
        serverVersionNum: "180004"
      })
    ).toEqual([]);
  });

  it("rejects a different database even on the same server", () => {
    expect(
      migrationTargetMismatches(config, {
        databaseName: "another_project",
        databaseUser: "personal_ai_app",
        serverAddress: "127.0.0.1",
        serverPort: 5432,
        serverVersionNum: "180004"
      })
    ).toContain("database name");
  });

  it("rejects a different server address", () => {
    expect(
      migrationTargetMismatches(config, {
        databaseName: "personal_ai_assistant",
        databaseUser: "personal_ai_app",
        serverAddress: "127.0.0.2/32",
        serverPort: 5432,
        serverVersionNum: "180004"
      })
    ).toContain("server address");
  });
});
