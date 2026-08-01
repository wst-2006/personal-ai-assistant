import { describe, expect, it } from "vitest";
import { elapsedSeconds } from "./focus-service.js";

describe("focus timer fixed-end contract", () => {
  it("clips late-start elapsed time at the persisted planned end", () => {
    const session = {
      state: "running",
      rawActiveSeconds: 0,
      activeSinceAt: new Date("2026-07-27T02:00:00.000Z"),
      plannedEndAt: new Date("2026-07-27T03:00:00.000Z")
    } as never;
    expect(elapsedSeconds(session, new Date("2026-07-27T04:00:00.000Z"))).toBe(3600);
  });

  it("never produces elapsed time before a late start", () => {
    const session = {
      state: "running",
      rawActiveSeconds: 120,
      activeSinceAt: new Date("2026-07-27T03:00:00.000Z"),
      plannedEndAt: new Date("2026-07-27T04:00:00.000Z")
    } as never;
    expect(elapsedSeconds(session, new Date("2026-07-27T02:59:00.000Z"))).toBe(120);
  });
});
