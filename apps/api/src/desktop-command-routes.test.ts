import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { DesktopCommandService } from "./desktop-command-service.js";

const command = {
  id: "7f9a4ad8-4dc7-4d18-92df-1d8be780a1b1",
  kind: "open_task",
  taskId: "2d6f9a77-8cd3-44fe-bf19-7ee52062c5f2",
  scheduleRevision: 3,
  status: "claimed",
  claimedBy: "desktop-client",
  claimedAt: new Date("2026-08-04T12:00:00.000Z"),
  expiresAt: new Date("2026-08-04T12:10:00.000Z"),
  completedAt: null,
  createdAt: new Date("2026-08-04T12:00:00.000Z"),
  updatedAt: new Date("2026-08-04T12:00:00.000Z")
};
const service = {
  claimNext: vi.fn().mockResolvedValue(command),
  complete: vi.fn().mockResolvedValue(true)
};
const app = buildApp({ desktopCommandService: service as unknown as DesktopCommandService });

afterAll(async () => app.close());

describe("desktop command routes", () => {
  it("claims a pending command for one desktop client", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/desktop-commands/pending?clientId=desktop-client" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ command: { id: command.id, kind: "open_task", taskId: command.taskId } });
    expect(service.claimNext).toHaveBeenCalledWith("desktop-client");
  });

  it("completes the claimed command explicitly", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/desktop-commands/${command.id}/complete`,
      payload: { clientId: "desktop-client" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ completed: true });
    expect(service.complete).toHaveBeenCalledWith(command.id, "desktop-client");
  });
});
