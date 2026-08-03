import { describe, expect, it, vi } from "vitest";
import type { FocusService } from "./focus-service.js";
import {
  FeishuActionAuthError,
  FeishuCardActionService,
  loadFeishuCardActionConfig
} from "./feishu-card-actions.js";
import type { TaskService } from "./task-service.js";

const taskId = "7f9a4ad8-4dc7-4d18-92df-1d8be780a1b1";

function service() {
  const taskService = { get: vi.fn().mockResolvedValue({ task: { id: taskId, version: 8, scheduleRevision: 3 } }) };
  const focusService = {
    create: vi.fn().mockResolvedValue({ id: "focus-1", version: 1 }),
    respondToReminder: vi.fn().mockResolvedValue({ id: "focus-1", version: 2 })
  };
  return {
    focusService,
    actions: new FeishuCardActionService(
      { targetOpenId: "ou_owner" },
      taskService as unknown as TaskService,
      focusService as unknown as FocusService
    )
  };
}

describe("Feishu card actions", () => {
  it("loads only the configured single-user target", () => {
    expect(loadFeishuCardActionConfig({ FEISHU_TARGET_OPEN_ID: "  ou_owner  " })).toEqual({ targetOpenId: "ou_owner" });
    expect(loadFeishuCardActionConfig({})).toBeNull();
  });

  it("rejects any operator except the configured owner", async () => {
    const { actions } = service();
    await expect(actions.handle("ou_other", { action: "start", taskId, scheduleRevision: 3 }))
      .rejects.toBeInstanceOf(FeishuActionAuthError);
  });

  it("starts preparation without bypassing task and schedule versions", async () => {
    const { actions, focusService } = service();
    await expect(actions.handle("ou_owner", { action: "start", taskId, scheduleRevision: 3 }))
      .resolves.toEqual({ type: "success", message: expect.stringContaining("1 分钟准备") });
    expect(focusService.create).toHaveBeenCalledWith(taskId, 8, "prepare");
  });

  it("records other arrangement while retaining the scheduled task", async () => {
    const { actions, focusService } = service();
    await expect(actions.handle("ou_owner", { action: "other_arrangement", taskId, scheduleRevision: 3 }))
      .resolves.toEqual({ type: "success", message: expect.stringContaining("任务仍保留") });
    expect(focusService.create).toHaveBeenCalledWith(taskId, 8, "remind");
    expect(focusService.respondToReminder).toHaveBeenCalledWith("focus-1", 1, "other_arrangement");
  });
});
