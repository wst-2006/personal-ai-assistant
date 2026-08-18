import { describe, expect, it } from "vitest";
import { hasPendingMigration } from "./migration-status.js";

describe("migration status", () => {
  it("reports pending work for a database without migration history", () => {
    expect(hasPendingMigration([100, 200], null)).toBe(true);
  });

  it("reports pending work only when the journal is newer than the database", () => {
    expect(hasPendingMigration([100, 200, 300], 200)).toBe(true);
    expect(hasPendingMigration([100, 200, 300], 300)).toBe(false);
    expect(hasPendingMigration([], null)).toBe(false);
  });

  it("rejects an older application runtime instead of silently running against a newer schema", () => {
    expect(() => hasPendingMigration([100, 200], 300)).toThrow(/newer than this application runtime/);
  });
});
